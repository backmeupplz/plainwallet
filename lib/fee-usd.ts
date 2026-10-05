// Display only. No account, wallet client, signing, third-party price API, or cross-chain RPC.
import { createPublicClient, http, isAddress, parseAbi, type ContractFunctionParameters } from 'viem'
import type { Network } from './store'

// Vetted proxies and heartbeat bounds: docs/fee-prices.md. Never infer a feed from a symbol.
const feeds: Record<number, { symbol: string; address: `0x${string}`; decimals: number; maxAge: number; sequencer?: `0x${string}` }> = {
  1: { symbol: 'ETH', address: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', decimals: 8, maxAge: 3600 },
  8453: { symbol: 'ETH', address: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', decimals: 8, maxAge: 1200, sequencer: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433' },
  42161: { symbol: 'ETH', address: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', decimals: 8, maxAge: 1755, sequencer: '0xFdB631F5EE196F0ed6FAa767959853A9F217697D' },
  10: { symbol: 'ETH', address: '0x13e3Ee699D1909E989722E753853AE30b17e08c5', decimals: 8, maxAge: 1200, sequencer: '0x371EAD81c9102C9BF4874A9075FFFf170F2Ee389' },
  137: { symbol: 'POL', address: '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0', decimals: 8, maxAge: 27 },
  56: { symbol: 'BNB', address: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE', decimals: 8, maxAge: 27 },
  43114: { symbol: 'AVAX', address: '0x0A77230d17318075983913bC2145DB16C7366156', decimals: 8, maxAge: 120 },
  // Gnosis: DAI/USD does not measure the native bridged xDAI's redemption/bridge risk. No $1 assumption.
}
const abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])
type Round = readonly [bigint, bigint, bigint, bigint, bigint]
export type Quote = { answer: bigint; decimals: number; receivedAt: number; expiresAt: number }
// Multicall3, as in lib/chain.ts: deployed at this address on every chain above.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const CACHE_MS = 30_000
const TIMEOUT_MS = 5_000
const cache = new Map<string, { until: number; promise: Promise<Quote | undefined> }>()

function validRound(round: Round, now: bigint) {
  const [id, , started, updated, answered] = round
  return id > 0n && started > 0n && started <= updated && updated <= now && answered >= id
}

/** Validated with local time too: a stalled chain must not make an old price look fresh. */
export function validateQuote(decimals: number, round: Round, expectedDecimals: number, maxAge: number, now: number, sequencer?: Round): Quote | undefined {
  const seconds = BigInt(Math.floor(now / 1000))
  if (decimals !== expectedDecimals || !Number.isInteger(decimals) || decimals < 0 || decimals > 36 ||
      !validRound(round, seconds) || round[1] <= 0n || seconds - round[3] >= BigInt(maxAge)) return
  // Uptime rounds only change on status changes; do NOT apply price heartbeat staleness to them.
  if (sequencer && (!validRound(sequencer, seconds) || sequencer[1] !== 0n || seconds - sequencer[2] <= 3600n)) return
  return { answer: round[1], decimals, receivedAt: now, expiresAt: Math.min(now + CACHE_MS, Number(round[3] + BigInt(maxAge)) * 1000) }
}
export const freshQuote = (quote: Quote, now = Date.now()) => now >= quote.receivedAt && now < quote.expiresAt

/** Integer multiplication before rounding, even below a thousandth of a dollar or above Number.MAX_SAFE_INTEGER. */
export function formatFeeUsd(fee: bigint, nativeDecimals: number, answer: bigint, oracleDecimals: number): string {
  if (fee < 0n || answer <= 0n || [nativeDecimals, oracleDecimals].some((d) => !Number.isInteger(d) || d < 0 || d > 36)) throw new Error('Invalid fee or price')
  if (fee === 0n) return '$0'
  const numerator = fee * answer, denominator = 10n ** BigInt(nativeDecimals + oracleDecimals)
  if (numerator * 1000n < denominator) return '<$0.001'
  // Four significant figures below $1, cents above. No conversion of money to floating point.
  const digits = numerator >= denominator ? 2 : numerator * 10n >= denominator ? 4 : numerator * 100n >= denominator ? 5 : 6
  const scale = 10n ** BigInt(digits)
  const rounded = (numerator * scale * 2n + denominator) / (denominator * 2n)
  const whole = (rounded / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  let fraction = (rounded % scale).toString().padStart(digits, '0')
  if (numerator < denominator) fraction = fraction.replace(/0+$/, '')
  return '$' + whole + (fraction ? '.' + fraction : '')
}

/** Cache is scoped to chain + RPC + native symbol, bounded in size and time (including failures/in-flight reads). */
export function nativeUsd(network: Network): Promise<Quote | undefined> {
  network = { ...network } // caller mutations must not change validation while reads are in flight
  const feed = feeds[network.id]
  if (!feed || network.symbol !== feed.symbol || !isAddress(feed.address) || (feed.sequencer && !isAddress(feed.sequencer))) return Promise.resolve(undefined)
  const key = JSON.stringify([network.id, network.rpc, network.symbol]), now = Date.now()
  const previous = cache.get(key)
  if (previous && previous.until > now && previous.until - CACHE_MS <= now) return previous.promise.then((q) => q && freshQuote(q) ? q : undefined)
  const stop = new AbortController()
  const reads = () => {
    if (stop.signal.aborted) return Promise.reject(stop.signal.reason)
    const attempt = new AbortController()
    stop.signal.addEventListener('abort', () => attempt.abort(), { once: true })
    const c = createPublicClient({ ccipRead: false, transport: http(network.rpc, {
      retryCount: 0, timeout: TIMEOUT_MS, fetchOptions: { redirect: 'error', credentials: 'omit', signal: attempt.signal },
    }) })
    const round = (address: `0x${string}`) => ({ address, abi, functionName: 'latestRoundData' }) as const
    return Promise.all([
      c.getChainId(),
      c.multicall({ multicallAddress: MULTICALL3, allowFailure: false, contracts: [
        { address: feed.address, abi, functionName: 'decimals' }, round(feed.address), ...(feed.sequencer ? [round(feed.sequencer)] : []),
      ] as ContractFunctionParameters[] }) as Promise<[number, Round, Round?]>,
    ]).then(([chainId, [decimals, price, sequencer]]) => [chainId, decimals, price, sequencer] as const)
      .finally(() => attempt.abort()) // Promise.all can reject while a sibling response body is still pending.
  }
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => { stop.abort(); resolve(undefined) }, TIMEOUT_MS) })
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  // Public RPCs ration eth_call per IP (mainnet.base.org: -32016 "over rate limit"), and a review screen opening spends
  // some: one eth_call for all three reads, retried while the timeout allows.
  const request = reads().catch(() => pause(1000).then(reads)).catch(() => pause(2000).then(reads))
    .then(([chainId, decimals, round, sequencer]) => chainId === network.id
    ? validateQuote(decimals, round, feed.decimals, feed.maxAge, Date.now(), sequencer) : undefined)
  const promise = Promise.race([request, timeout]).catch(() => undefined).finally(() => {
    stop.abort()
    clearTimeout(timer)
  })
  if (cache.size >= 16) cache.delete(cache.keys().next().value!)
  const entry = { until: now + CACHE_MS, promise }
  cache.set(key, entry)
  void promise.then((quote) => { if (quote) entry.until = Math.min(entry.until, quote.expiresAt) })
  return promise
}

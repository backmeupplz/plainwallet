// Talking to a network's RPC. Shared by the background (dapp requests) and the popup (balances, sending).
import { createWalletClient, defineChain, erc20Abi, ethAddress, formatUnits, http, keccak256, parseTransaction, recoverTransactionAddress, type BaseError, type LocalAccount, type TransactionSerializable } from 'viem'
import { estimateFeesPerGas, estimateGas, getBalance, getChainId, getTransactionCount, getTransactionReceipt, multicall, readContract, simulateCalls, waitForTransactionReceipt } from 'viem/actions'
import { estimateL1Fee } from 'viem/op-stack'
import { browser } from 'wxt/browser'
import { clean, parseAddress } from './describe'
import { problem, t } from './i18n.ts'
import { keepSent, type Network, type Sent, type Token } from './store'

// An RPC may not redirect: a dapp-supplied https URL could otherwise bounce the extension's requests (sent with its
// own host permissions) to a device on the user's network.
export const noRedirect = { redirect: 'error' } as const

export const client = (network: Network, account?: `0x${string}`) => createWalletClient({
  account,
  // No EIP-3668 offchain lookups: a contract (a dapp's, or a token's) could name any URL, and reading its symbol for
  // an approval would fetch it, past noRedirect and the public-RPC check, from the extension with its host permissions.
  ccipRead: false,
  chain: defineChain({
    id: network.id,
    name: network.name,
    nativeCurrency: { name: network.symbol, symbol: network.symbol, decimals: 18 },
    rpcUrls: { default: { http: [network.rpc] } },
  }),
  transport: http(network.rpc, { fetchOptions: noRedirect }),
})

/** Fully prepared before the user sees it, and exactly this gets signed: nothing can change after the click. */
export async function prepare(network: Network, from: `0x${string}`, tx: { to?: `0x${string}`; data?: `0x${string}`; value?: bigint; gas?: bigint }) {
  // Otherwise viem's "HTTP request failed … Failed to fetch".
  if (!navigator.onLine) throw problem('This device is offline: preparing a transaction needs {network}’s RPC', { network: network.name })
  const c = client(network, from)
  // viem only asks the RPC which chain it serves when the RPC implements eth_fillTransaction (whose answer it then
  // uses): ask every time, and sign offline, so the signature is only ever valid on the chain the user sees.
  const [request, served] = await Promise.all([c.prepareTransactionRequest(tx), getChainId(c)])
  for (const id of [served, request.chainId]) if (id !== network.id) throw problem('RPC serves chain {served}, not {network} ({id})', { served: id, network: network.name, id: network.id })
  // OP-stack chains (Base, Optimism, ...) also charge for posting the transaction to Ethereum. Elsewhere there is no
  // gas price oracle at this address and the call adds nothing.
  const l1 = await estimateL1Fee(c, { ...request, gasPriceOracleAddress: '0x420000000000000000000000000000000000000F' } as any).catch(() => 0n)
  return { request, fee: request.gas * (request.maxFeePerGas ?? request.gasPrice ?? 0n) + l1 }
}

type Prepared = Awaited<ReturnType<typeof prepare>>['request']
/** What gets signed. `fresh`: only the nonce is refreshed after the click (it isn't shown and can't redirect funds):
 * requests queued together were all prepared at the same nonce. */
export async function unsigned(network: Network, from: `0x${string}`, request: Prepared, fresh = true) {
  const nonce = fresh ? await getTransactionCount(client(network), { address: from, blockTag: 'pending' }) : request.nonce
  const { account: _, from: __, ...tx } = { ...request, nonce }
  return tx as TransactionSerializable
}

/** `site`: the origin that asked, for the wallet's list of sent transactions; none for the wallet's own sends. */
export async function send(network: Network, account: LocalAccount, request: Prepared, site?: string) {
  return broadcast(network, await account.signTransaction(await unsigned(network, account.address, request)), site)
}

/** Why a node refused a transaction for its fee, if it did: 'replace' when one already waits at its nonce (an RPC may
 * not even list that one as pending), 'fees' when the network now charges more than it offers. */
export function feeRefusal(e: unknown): 'replace' | 'fees' | undefined {
  const text = `${(e as BaseError)?.details ?? ''} ${(e as Error)?.message ?? ''}`
  if (/replacement transaction underpriced|replacement fee too low/i.test(text)) return 'replace'
  if (/max fee per gas less than block base fee|fee cap less than block base fee|transaction underpriced|fee too low/i.test(text)) return 'fees'
}

type Fees = { gasPrice?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }
/** `prepared` at fees that work: at least what the network charges `now`, and for a replacement also 25% over the
 * last try on every fee field (nodes replace a waiting transaction for at least 10% more). */
export function raise({ request, fee }: { request: Prepared; fee: bigint }, now: Fees, replace: boolean) {
  const up = (v?: bigint) => (v == null || !replace ? v : (v * 125n) / 100n)
  const top = (a?: bigint, b?: bigint) => (a == null ? a : b != null && b > a ? b : a)
  // every field there is: viem fills in gasPrice next to the EIP-1559 ones too
  const next = { ...request, gasPrice: top(up(request.gasPrice), now.gasPrice ?? now.maxFeePerGas), maxFeePerGas: top(up(request.maxFeePerGas), now.maxFeePerGas),
    maxPriorityFeePerGas: top(up(request.maxPriorityFeePerGas), now.maxPriorityFeePerGas) } as Prepared
  const per = (r: Prepared) => r.maxFeePerGas ?? r.gasPrice ?? 0n
  return { request: next, fee: fee + request.gas * (per(next) - per(request)) }
}

/** Asked for again before it's signed, like any fee. */
export async function refee(network: Network, prepared: { request: Prepared; fee: bigint }, replace: boolean) {
  const now = await estimateFeesPerGas(client(network), { type: prepared.request.maxFeePerGas != null ? 'eip1559' : 'legacy' })
  return raise(prepared, now, replace)
}

/** A signed transaction names its chain itself: an RPC serving another one refuses it. Every transaction the wallet
 * sends goes through here, and lands in its list of sent transactions (store.ts). */
export async function broadcast(network: Network, signed: `0x${string}`, site?: string) {
  const hash = await client(network).sendRawTransaction({ serializedTransaction: signed as any }).catch((e) => {
    // The node already holds these exact bytes (an earlier try at the same nonce and fees signs identically): it's
    // submitted, just not included yet, so it gets its hash like any other, and can be sped up from the list.
    if (/already known|known transaction|already imported/i.test(`${(e as BaseError)?.details ?? ''} ${(e as Error)?.message ?? ''}`)) return keccak256(signed)
    throw e
  })
  await keepSent({ raw: signed, network: network.name, ...(site && { site }), at: Date.now() }).catch(() => {}) // it's out either way
  return hash
}

/** Where a sent transaction stands: its receipt, or without one, whether its nonce is taken (by a replacement, or by
 * another transaction from the same account) or it's still waiting. */
export async function sentStatus(network: Network, raw: `0x${string}`): Promise<'pending' | NonNullable<Sent['done']>> {
  const c = client(network)
  const receipt = () => getTransactionReceipt(c, { hash: keccak256(raw) }).catch(() => null)
  let r = await receipt()
  if (!r) {
    const used = await getTransactionCount(c, { address: await recoverTransactionAddress({ serializedTransaction: raw as any }), blockTag: 'latest' })
    if (used <= (parseTransaction(raw).nonce ?? 0)) return 'pending'
    if (!(r = await receipt())) return 'replaced' // asked again: it may have been included in between
  }
  return r.status === 'success' ? 'confirmed' : 'failed'
}

/** A waiting transaction again at its nonce, for current fees and at least 25% more than it paid (refee): the same
 * one, or with `cancel` a transfer of nothing to its own sender, which uses the nonce up so the original never runs. */
export async function replacement(network: Network, raw: `0x${string}`, cancel: boolean) {
  const from = await recoverTransactionAddress({ serializedTransaction: raw as any })
  const { r: _, s: __, v: ___, yParity: ____, ...tx } = parseTransaction(raw)
  const request = cancel
    // the gas a plain transfer takes, asked rather than assumed: some chains (Arbitrum) count more than 21000
    ? { ...tx, to: from, value: 0n, data: undefined, accessList: undefined, authorizationList: undefined, gas: await estimateGas(client(network), { account: from, to: from, value: 0n }) }
    : tx
  const prepared = await refee(network, { request: request as Prepared, fee: request.gas! * (request.maxFeePerGas ?? request.gasPrice ?? 0n) }, true)
  return { from, ...prepared, request: prepared.request as TransactionSerializable }
}

/** Resolves with the receipt once `hash` is in a block. Open wallet views then refetch balances, instead of polling. */
export async function mined(network: Network, hash: `0x${string}`) {
  const receipt = await waitForTransactionReceipt(client(network), { hash, timeout: 600_000 })
  await browser.storage.session.set({ mined: hash })
  return receipt
}

// Multicall3's address on nearly every EVM chain: one eth_call for all tokens, gentle on public RPC rate limits.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'

/** Native balance, then one per token; undefined where the RPC or the token didn't answer. */
export async function balances(network: Network, address: `0x${string}`, tokens: Token[]) {
  const c = client(network)
  const contracts = tokens.map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }) as const)
  const each = () => Promise.all(contracts.map((x) => readContract(c, x).catch(() => undefined))) // chains without Multicall3
  const [native, rest] = await Promise.all([
    getBalance(c, { address }).catch(() => undefined),
    contracts.length ? multicall(c, { contracts, multicallAddress: MULTICALL3 }).then((r) => r.map((x) => x.result), each) : [],
  ])
  return [native, ...rest]
}

/** Symbol and decimals as the contract reports them. Anyone can deploy a token that calls itself "USDC". */
export async function tokenInfo(network: Network, input: string): Promise<Token> {
  const address = parseAddress(input)
  const c = client(network)
  const [symbol, decimals] = await Promise.all([
    readContract(c, { address, abi: erc20Abi, functionName: 'symbol' }),
    readContract(c, { address, abi: erc20Abi, functionName: 'decimals' }),
  ]).catch(() => { throw new Error(navigator.onLine ? t('Couldn’t read an ERC-20 token at this address on {network}', { network: network.name }) : t('This device is offline')) })
  return { address, symbol: clean(symbol, 12) || '?', decimals }
}

export type Simulation = { summary: string; details: [label: string, value: string][]; failed?: boolean; text?: string }

/** How `from`'s balances would change if the transaction ran on the latest block (the fee aside): a rounded `summary`,
 * exact `details`, and `text` for Jev when it ran (in English, whatever the wallet's language). Needs an RPC with eth_simulateV1. Symbols come from the token
 * contracts, so a fake "USDC" reads as USDC too: the details carry each token's address. */
export async function simulate(network: Network, from: `0x${string}`, tx: { to: `0x${string}`; data?: `0x${string}`; value?: bigint }): Promise<Simulation> {
  let simulated
  for (let attempt = 1; !simulated; attempt++) {
    try {
      simulated = await simulateCalls(client(network), { account: from, calls: [tx], traceAssetChanges: true })
    } catch (e) {
      const why = (e as BaseError).details || (e as BaseError).shortMessage || String(e)
      // It takes a burst of calls right after preparing the transaction, and public RPCs rate-limit bursts, some (Base:
      // "over rate limit", -32016) with codes viem doesn't retry.
      if (attempt < 3 && /rate.?limit|too many/i.test(why)) await new Promise((done) => setTimeout(done, 1500 * attempt))
      else return { summary: t('unavailable'), details: [[t('RPC error'), clean(why, 120)]] }
    }
  }
  const { results: [result], assetChanges } = simulated
  if (result!.status === 'failure') {
    const reason = clean(((result!.error as BaseError).shortMessage ?? result!.error.message).replace(/^.*reverted with the following reason:/s, ''), 160)
    return { summary: t('fails'), failed: true, details: [[t('Reverts'), t('{reason}. Sending it anyway would only spend the fee.', { reason })]], text: `Fails: ${reason}` }
  }
  const moves = assetChanges.filter((a) => a.value.diff).map(({ token, value: { diff } }) => {
    const native = token.address === ethAddress
    const exact = token.decimals == null ? String(diff < 0n ? -diff : diff) : formatUnits(diff < 0n ? -diff : diff, token.decimals)
    const n = Number(exact)
    const rounded = n.toLocaleString('en-US', n >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 })
    const symbol = native ? network.symbol : token.symbol ? clean(token.symbol, 12) : 'tokens'
    const shown = native || token.symbol ? symbol : t('tokens')
    const sign = diff < 0n ? '−' : '+'
    return {
      short: `${sign}${rounded} ${shown}`,
      exact: [diff < 0n ? t('Sends') : t('Receives'), `${exact} ${shown}${token.decimals == null ? ` ${t('(raw units or NFTs)')}` : ''}${native ? '' : `, ${t('token {address}', { address: token.address })}`}`] as [string, string],
      text: `${diff < 0n ? 'sends' : 'receives'} ${exact} ${symbol}`,
    }
  })
  return moves.length
    ? { summary: moves.map((m) => m.short).join(', '), details: moves.map((m) => m.exact), text: `The account ${moves.map((m) => m.text).join(', ')}` }
    : { summary: t('no balance changes'), details: [], text: 'No balance changes for the account' }
}

// Talking to a network's RPC. Shared by the background (dapp requests) and the popup (balances, sending).
import { createWalletClient, defineChain, erc20Abi, ethAddress, formatUnits, http, type BaseError, type LocalAccount, type TransactionSerializable } from 'viem'
import { getBalance, getChainId, getTransactionCount, multicall, readContract, simulateCalls, waitForTransactionReceipt } from 'viem/actions'
import { estimateL1Fee } from 'viem/op-stack'
import { browser } from 'wxt/browser'
import { clean, parseAddress } from './describe'
import type { Network, Token } from './store'

// An RPC may not redirect: a dapp-supplied https URL could otherwise bounce the extension's requests (sent with its
// own host permissions) to a device on the user's network.
export const noRedirect = { redirect: 'error' } as const

export const client = (network: Network, account?: `0x${string}`) => createWalletClient({
  account,
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
  const c = client(network, from)
  // viem only asks the RPC which chain it serves when the RPC implements eth_fillTransaction (whose answer it then
  // uses): ask every time, and sign offline, so the signature is only ever valid on the chain the user sees.
  const [request, served] = await Promise.all([c.prepareTransactionRequest(tx), getChainId(c)])
  for (const id of [served, request.chainId]) if (id !== network.id) throw new Error(`RPC serves chain ${id}, not ${network.name} (${network.id})`)
  // OP-stack chains (Base, Optimism, ...) also charge for posting the transaction to Ethereum. Elsewhere there is no
  // gas price oracle at this address and the call adds nothing.
  const l1 = await estimateL1Fee(c, { ...request, gasPriceOracleAddress: '0x420000000000000000000000000000000000000F' } as any).catch(() => 0n)
  return { request, fee: request.gas * (request.maxFeePerGas ?? request.gasPrice ?? 0n) + l1 }
}

export async function send(network: Network, account: LocalAccount, request: Awaited<ReturnType<typeof prepare>>['request']) {
  const c = client(network)
  // Only the nonce is refreshed after the click (it isn't shown and can't redirect funds): requests queued
  // together were all prepared at the same nonce.
  const nonce = await getTransactionCount(c, { address: account.address, blockTag: 'pending' })
  const { account: _, ...unsigned } = { ...request, nonce }
  return c.sendRawTransaction({ serializedTransaction: await account.signTransaction(unsigned as TransactionSerializable) })
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
  ]).catch(() => { throw new Error(`Couldn't read an ERC-20 token at this address on ${network.name}`) })
  return { address, symbol: clean(symbol, 12) || '?', decimals }
}

export type Simulation = { summary: string; details: [label: string, value: string][]; failed?: boolean; text?: string }

/** How `from`'s balances would change if the transaction ran on the latest block (the fee aside): a rounded `summary`,
 * exact `details`, and `text` for Jev when it ran. Needs an RPC with eth_simulateV1. Symbols come from the token
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
      else return { summary: 'unavailable', details: [['RPC error', clean(why, 120)]] }
    }
  }
  const { results: [result], assetChanges } = simulated
  if (result!.status === 'failure') {
    const reason = clean(((result!.error as BaseError).shortMessage ?? result!.error.message).replace(/^.*reverted with the following reason:/s, ''), 160)
    return { summary: 'fails', failed: true, details: [['Reverts', `${reason}. Sending it anyway would only spend the fee.`]], text: `Fails: ${reason}` }
  }
  const moves = assetChanges.filter((a) => a.value.diff).map(({ token, value: { diff } }) => {
    const native = token.address === ethAddress
    const exact = token.decimals == null ? String(diff < 0n ? -diff : diff) : formatUnits(diff < 0n ? -diff : diff, token.decimals)
    const n = Number(exact)
    const rounded = n.toLocaleString('en-US', n >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 })
    const symbol = native ? network.symbol : token.symbol ? clean(token.symbol, 12) : 'tokens'
    const sign = diff < 0n ? '−' : '+'
    return {
      short: `${sign}${rounded} ${symbol}`,
      exact: [diff < 0n ? 'Sends' : 'Receives', `${exact} ${symbol}${token.decimals == null ? ' (raw units or NFTs)' : ''}${native ? '' : `, token ${token.address}`}`] as [string, string],
      text: `${diff < 0n ? 'sends' : 'receives'} ${exact} ${symbol}`,
    }
  })
  return moves.length
    ? { summary: moves.map((m) => m.short).join(', '), details: moves.map((m) => m.exact), text: `The account ${moves.map((m) => m.text).join(', ')}` }
    : { summary: 'no balance changes', details: [], text: 'No balance changes for the account' }
}

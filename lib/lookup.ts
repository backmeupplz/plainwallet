// Public facts about the contracts and spenders a request involves; only asked with a Jev key set. Blockscout is free
// and keyless, and counts contracts verified on it, on Sourcify, or matching bytecode verified there: Etherscan-only
// verifications don't show. For calls to contracts no one verified, Sourcify's signature database names the function.
import { decodeFunctionData, encodeFunctionData, getAbiItem, parseAbiItem, type Abi } from 'viem'
import { formatAbiItem } from 'viem/utils'
import { clean } from './describe'
import { msg, msgn, type Text } from './i18n.ts'

// ponytail: the default networks' public Blockscout instances only (BNB Chain and Avalanche have none, Gnosis's redirects
// to Gnosisscan); chains.blockscout.com lists the rest if custom networks need it
const BLOCKSCOUT: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  10: 'https://explorer.optimism.io',
  137: 'https://polygon.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
}

const json = (url: string): Promise<any> =>
  fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).then((r) => r.ok ? r.json() : undefined).catch(() => undefined)

export type Level = 'ok' | 'warn' | 'bad'
/** `about` is what Jev reads (in English) and the popup shows (translated); `level` colors it: flagged is bad,
 * unverified or under a month old is a warning. Names and tags come from Blockscout as they are. */
export type Party = { address: string; name: Text; about: Text[]; level: Level; abiFrom?: string }

const DAY = 86_400_000
const ago = (ms: number) => ms < DAY ? msgn(Math.max(1, Math.round(ms / 3_600_000)), 'deployed {n} hour ago', 'deployed {n} hours ago')
  : ms < 60 * DAY ? msgn(Math.round(ms / DAY), 'deployed {n} day ago', 'deployed {n} days ago')
  : ms < 730 * DAY ? msgn(Math.round(ms / (30 * DAY)), 'deployed {n} month ago', 'deployed {n} months ago')
  : msgn(Math.round(ms / (365 * DAY)), 'deployed {n} year ago', 'deployed {n} years ago')

/** `spender`: whoever would get to move the account's assets. That being a regular account is a warning in itself. */
async function party(api: string, address: string, spender: boolean): Promise<Party | undefined> {
  const a = await json(`${api}/api/v2/addresses/${address}`)
  if (!a) return
  const flagged = !!a.is_scam || (!!a.reputation && a.reputation !== 'ok')
  const tags: string[] = (a.metadata?.tags ?? []).map((t: any) => clean(t.name, 40))
  const extra: Text[] = [...tags, ...(flagged ? [msg('flagged as a scam by Blockscout')] : [])]
  if (!a.is_contract) {
    const name = a.ens_domain_name ? clean(a.ens_domain_name, 40) : msg('Regular account')
    return { address, name, about: [msg('a regular account, not a contract'), ...extra], level: flagged ? 'bad' : spender ? 'warn' : 'ok' }
  }
  const impl = a.implementations?.[0]
  const created = a.creation_transaction_hash ? await json(`${api}/api/v2/transactions/${a.creation_transaction_hash}`) : undefined
  const age = created?.timestamp ? Date.now() - Date.parse(created.timestamp) : undefined
  const token = a.token
  const about: Text[] = [
    ...(impl ? [msg('upgradeable proxy')] : []),
    a.is_verified ? msg('verified source') : msg('unverified source'),
    ...(age == null ? [] : [ago(age)]),
    ...(token ? [msgn(Number(token.holders_count ?? 0), 'token {name} ({symbol}) with {n} holder', 'token {name} ({symbol}) with {n} holders',
      { name: clean(token.name ?? '?', 40), symbol: clean(token.symbol ?? '?', 12) })] : []),
    ...extra,
  ]
  const named = token?.name || impl?.name || a.name
  return {
    address, about,
    name: named ? clean(named, 40) : msg('Unnamed contract'),
    level: flagged ? 'bad' : !a.is_verified || (age ?? Infinity) < 30 * DAY ? 'warn' : 'ok',
    abiFrom: a.is_verified ? impl?.address_hash ?? address : undefined,
  }
}

/** The function calldata calls, from Sourcify's signature database. Anyone can publish a signature for any selector
 * (4 bytes are cheap to collide), so a candidate only counts if it decodes the calldata and encodes back to exactly it,
 * and ones seen in verified contracts go first. */
export async function functionName(data: `0x${string}`) {
  const selector = data.slice(0, 10).toLowerCase()
  const found = await json(`https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=${selector}&filter=true`)
  if (!found) return
  const candidates: { name: string; hasVerifiedContract?: boolean }[] = found.result?.function?.[selector] ?? []
  for (const { name } of candidates.toSorted((a, b) => Number(!!b.hasVerifiedContract) - Number(!!a.hasVerifiedContract))) {
    try {
      const abi = [parseAbiItem(`function ${name}`)] as const
      const { args } = decodeFunctionData({ abi, data })
      if (encodeFunctionData({ abi, args } as any) === data.toLowerCase()) return msg('{function}, named by a public signature list', { function: clean(name, 200) })
    } catch {}
  }
  return msg('No public signature matches the calldata')
}

export type Lookup = { contract?: Party; spender?: Party; call?: Text }

/** Everything at once; any part Blockscout or Sourcify couldn't answer is left out. */
export async function lookup(chainId: number, { contract, spender, data }: { contract?: string; spender?: string; data?: `0x${string}` }): Promise<Lookup> {
  const api = BLOCKSCOUT[chainId]
  const [c, s] = await Promise.all([api && contract ? party(api, contract, false) : undefined, api && spender ? party(api, spender, true) : undefined])
  let call: Text | undefined
  if (data) {
    // A verified contract's own ABI names the function and its parameters exactly.
    const abi: Abi | undefined = c?.abiFrom ? (await json(`${api}/api/v2/smart-contracts/${c.abiFrom}`))?.abi : undefined
    try {
      const item = abi && getAbiItem({ abi, name: data.slice(0, 10) as `0x${string}` })
      if (item?.type === 'function') call = clean(formatAbiItem(item, { includeName: true }), 300)
    } catch {}
    call ??= await functionName(data)
  }
  return { contract: c, spender: s, call }
}

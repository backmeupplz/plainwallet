// Turns what a dapp asks you to sign, and what you type to send, into something a person can check. Pure, so
// `npm test` covers it.
import { decodeFunctionData, formatUnits, getAddress, getTypesForEIP712Domain, isAddress, parseAbi, parseUnits } from 'viem'

export const clean = (v: unknown, max: number) => String(v).replace(/\s+/g, ' ').trim().slice(0, max)

// The calls that hand over or move tokens, i.e. the ones a drainer needs you to sign.
const CALLS = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function increaseAllowance(address spender, uint256 amount)',
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
])

/** One sentence for token-moving calldata. `token` comes from the RPC, so treat symbol/decimals as a hint only. */
export function describeCall(data?: `0x${string}`, token: { symbol?: string; decimals?: number } = {}): string | undefined {
  if (!data || data === '0x') return
  let call
  try {
    call = decodeFunctionData({ abi: CALLS, data })
  } catch {
    return `Contract call ${data.slice(0, 10)} (not decoded)`
  }
  const name = token.symbol ? clean(token.symbol, 12) : 'tokens'
  // ponytail: anything >= 2^96-1 reads as unlimited; covers uint96/uint160/uint256 max approvals
  const amount = (v: bigint) =>
    v >= 2n ** 96n - 1n ? 'UNLIMITED' : token.decimals == null ? `${v} (raw units, or NFT #${v})` : formatUnits(v, token.decimals)
  const a = call.args as readonly any[]
  switch (call.functionName) {
    case 'approve':
    case 'increaseAllowance':
      return `Lets ${a[0]} spend ${amount(a[1])} ${name} of yours`
    case 'transfer':
      return `Sends ${amount(a[1])} ${name} to ${a[0]}`
    case 'transferFrom':
      return `Moves ${amount(a[2])} ${name} from ${a[0]} to ${a[1]}`
    case 'setApprovalForAll':
      return a[1] ? `Lets ${a[0]} move ALL your NFTs in this collection` : `Revokes ${a[0]}'s access to this collection`
  }
}

/** Typed data reduced to exactly what gets hashed: keys a dapp adds outside `types` are not signed, so not shown. */
export function signedView(td: any) {
  // Without an EIP712Domain type, viem hashes only the domain fields it recognizes (e.g. a chainId given as a string is
  // dropped): derive the type the same way, so a field that isn't signed can't be shown as if it were.
  const types = { EIP712Domain: getTypesForEIP712Domain({ domain: td.domain }), ...td.types }
  const walk = (type: string, value: any): unknown => {
    const array = type.match(/^(.*)\[\d*\]$/)
    if (array) return Array.isArray(value) ? value.map((v) => walk(array[1]!, v)) : value
    const fields: { name: string; type: string }[] | undefined = types[type]
    return fields ? Object.fromEntries(fields.map((f) => [f.name, walk(f.type, value?.[f.name])])) : value
  }
  const primaryType = String(td.primaryType)
  const view = { primaryType, domain: walk('EIP712Domain', td.domain), message: primaryType === 'EIP712Domain' ? {} : walk(primaryType, td.message) }
  // Permits, transfer authorizations, marketplace orders, Safe transactions: signatures that hand over assets.
  const risky = /permit|order|transfer|authoriz|approv|safetx|delegat/i.test(primaryType) || /"(spender|operator|offer|consideration)"/.test(JSON.stringify(view.message))
  return { view, summary: risky ? 'Can move or approve your assets: whoever gets this signature can use it without asking you again' : undefined }
}

/** A typed address, checksummed. Mixed case must carry a valid EIP-55 checksum: that is what catches typos. */
export function parseAddress(text: string) {
  const t = text.trim()
  if (isAddress(t)) return getAddress(t)
  throw new Error(isAddress(t, { strict: false }) ? 'Address checksum does not match; check it for a typo' : 'Enter a valid 0x address')
}

/** EIP-4361 has wallets match a sign-in message's domain to the site asking. Returns the other domain, if it isn't. */
export function foreignSignIn(message: string, origin: string) {
  const { protocol, host } = new URL(origin)
  // Every occurrence, not just the first line: a lenient verifier might not insist on the message starting with it.
  for (const [, scheme, domain] of message.matchAll(/(?:^|\n)\s*(?:([a-z][a-z0-9+.-]*):\/\/)?(\S+) wants you to sign in with your Ethereum account:/gi))
    if (domain!.toLowerCase() !== host || (scheme && `${scheme.toLowerCase()}:` !== protocol)) return scheme ? `${scheme}://${domain}` : domain
}

/** RPCs a dapp adds must be public https: the wallet fetches them with its own host permissions and passes answers back
 * to the site, so localhost, private and raw IP addresses would make it a proxy into your network. */
export function publicRpc(url: unknown) {
  // ponytail: a public name that resolves to a private address (DNS rebinding) still gets through; browsers offer no resolver to check
  if (typeof url !== 'string' || !URL.canParse(url)) return false
  const { protocol, hostname, username, password } = new URL(url)
  const host = hostname.replace(/\.$/, '') // "localhost." is localhost
  return protocol === 'https:' && !username && !password && host.includes('.') && !/^[\d.]+$|^\[|\.(localhost|local|internal|lan|home|arpa|test|invalid|example|onion)$/i.test(host)
}

/** A typed amount in base units. Refuses extra decimals instead of letting parseUnits round them away. */
export function parseAmount(text: string, decimals: number) {
  const t = text.trim()
  if (!/^\d*\.?\d*$/.test(t) || !/\d/.test(t)) throw new Error('Enter an amount like 1.5')
  if ((t.split('.')[1] ?? '').length > decimals) throw new Error(`At most ${decimals} decimals`)
  const value = parseUnits(t, decimals)
  if (!value) throw new Error('Enter an amount above zero')
  return value
}

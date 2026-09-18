// Turns what a dapp asks you to sign into something a person can check. Pure, so `npm test` covers it.
import { decodeFunctionData, formatUnits, parseAbi } from 'viem'

export const clean = (v: unknown, max: number) => String(v).replace(/\s+/g, ' ').trim().slice(0, max)

export const TOKEN_ABI = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])
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
  const walk = (type: string, value: any): unknown => {
    const array = type.match(/^(.*)\[\d*\]$/)
    if (array) return Array.isArray(value) ? value.map((v) => walk(array[1]!, v)) : value
    const fields: { name: string; type: string }[] | undefined = td.types?.[type]
    return fields ? Object.fromEntries(fields.map((f) => [f.name, walk(f.type, value?.[f.name])])) : value
  }
  const standard = ['name', 'version', 'chainId', 'verifyingContract', 'salt'].filter((k) => td.domain?.[k] != null)
  const domain = td.types?.EIP712Domain ? walk('EIP712Domain', td.domain) : Object.fromEntries(standard.map((k) => [k, td.domain[k]]))
  const view = { primaryType: String(td.primaryType), domain, message: walk(td.primaryType, td.message) }
  const permit = /permit/i.test(view.primaryType) || JSON.stringify(view.message).includes('"spender"')
  return { view, summary: permit ? 'Token approval: the spender can take the tokens below with no further confirmation from you' : undefined }
}

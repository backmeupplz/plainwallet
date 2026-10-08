// Watch-only accounts: what goes to the device with the key, and the check on what comes back. Pure, so `npm test`
// covers it.
import { getAddress, isAddress, parseTransaction, recoverTransactionAddress, serializeTransaction, verifyMessage, verifyTypedData } from 'viem'

type Hex = `0x${string}`
/** `origin`: the site that asked, as the online device saw it. */
export type OfflineRequest = { from: Hex; origin?: string } & ({ transaction: Hex } | { message: string | { raw: Hex } } | { typedData: any })

export const requestText = (r: OfflineRequest) => JSON.stringify({ plainwallet: 'sign', ...r })

/** A pasted request, checked; throws on anything else. */
export function parseRequest(text: string): OfflineRequest {
  let r
  try { r = JSON.parse(text.trim()) } catch {}
  if (r?.plainwallet !== 'sign' || typeof r.from !== 'string' || !isAddress(r.from)) throw new Error('This isn’t a Plain Wallet signing request')
  const base = { from: getAddress(r.from), ...(typeof r.origin === 'string' && { origin: r.origin }) }
  const kinds = ['transaction', 'message', 'typedData'].filter((k) => k in r)
  if (kinds.length !== 1) throw new Error('This isn’t a Plain Wallet signing request')
  if ('transaction' in r) {
    let tx
    try { tx = parseTransaction(r.transaction) } catch { throw new Error('The transaction in this request can’t be read') }
    if (tx.r || tx.s) throw new Error('This transaction is already signed')
    // The kinds this wallet makes: blob and EIP-7702 transactions carry more than the review shows.
    if (!['legacy', 'eip2930', 'eip1559'].includes(tx.type!)) throw new Error(`Plain Wallet doesn’t sign ${tx.type} transactions`)
    // Without a chain id (pre-EIP-155) the signature would be valid on every chain.
    if (!tx.chainId) throw new Error('This transaction names no chain, so a signature would be valid on any of them')
    // Exactly what the signed one is compared against, byte for byte.
    if (serializeTransaction(tx) !== r.transaction) throw new Error('The transaction in this request isn’t in canonical form')
    return { ...base, transaction: r.transaction }
  }
  if ('message' in r) {
    const m = r.message
    if (typeof m !== 'string' && !(typeof m?.raw === 'string' && /^0x([0-9a-f]{2})*$/i.test(m.raw))) throw new Error('The message in this request can’t be read')
    return { ...base, message: typeof m === 'string' ? m : { raw: m.raw } }
  }
  if (typeof r.typedData?.primaryType !== 'string' || typeof r.typedData.types !== 'object') throw new Error('The typed data in this request can’t be read')
  return { ...base, typedData: r.typedData }
}

/** The signed transaction or signature pasted back, if it is exactly what `r` asked for, signed by `r.from`. */
export async function checkResponse(r: OfflineRequest, text: string): Promise<Hex> {
  const signed = text.trim() as Hex
  if (!/^0x([0-9a-f]{2})+$/i.test(signed)) throw new Error('Paste what the other device signed: 0x followed by hex')
  if ('transaction' in r) {
    let tx
    try { tx = parseTransaction(signed) } catch { throw new Error('That isn’t a signed transaction') }
    const { r: _r, s, v, yParity, ...unsigned } = tx
    if (!_r || !s) throw new Error('That transaction isn’t signed')
    if (serializeTransaction(unsigned) !== r.transaction) throw new Error('That is a different transaction from the one in the request')
    if (getAddress(await recoverTransactionAddress({ serializedTransaction: signed as any })) !== r.from) throw new Error(`That wasn’t signed by ${r.from}`)
    return signed
  }
  if (signed.length !== 132) throw new Error('That isn’t a signature')
  const ok = await ('message' in r ? verifyMessage({ address: r.from, message: r.message, signature: signed })
    : verifyTypedData({ address: r.from, ...r.typedData, signature: signed })).catch(() => false)
  if (!ok) throw new Error(`That isn’t ${r.from}’s signature of this ${'message' in r ? 'message' : 'typed data'}`)
  return signed
}

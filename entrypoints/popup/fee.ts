import { formatUnits, parseUnits } from 'viem'
import { formatFeeUsd, freshQuote, nativeUsd, type Quote } from '@/lib/fee-usd'
import type { Network } from '@/lib/store'

/** Each review owns its node, immutable fee and network snapshot. Late replies cannot fill another review. */
export function feeValue(network: Network, fee: bigint | string): HTMLElement {
  const value = document.createElement('span')
  const native = typeof fee === 'bigint' ? formatUnits(fee, 18) : fee
  const fiat = document.createElement('span')
  fiat.textContent = 'USD loading…'
  fiat.title = 'Approximate USD from Chainlink on this network’s RPC. Not the final charge.'
  value.append(native + ' ' + network.symbol + ' (', fiat, ')')
  // Snapshot before starting any asynchronous work; no global current-network/account/transaction state.
  const snapshot = { ...network }
  // A quote lives at most 30 seconds; re-read it instead of leaving the review on "USD unavailable".
  let shown: Quote | undefined, reads = 0
  const read = () => {
    const mine = ++reads
    shown = undefined
    void nativeUsd(snapshot).then((quote) => {
      if (mine !== reads || !value.isConnected) return
      if (!quote || !freshQuote(quote)) { fiat.textContent = 'USD unavailable'; return }
      try {
        fiat.textContent = '≈ ' + formatFeeUsd(typeof fee === 'bigint' ? fee : parseUnits(fee, 18), 18, quote.answer, quote.decimals)
      } catch { fiat.textContent = 'USD unavailable'; return }
      shown = quote
      setTimeout(expire, quote.expiresAt - Date.now())
    }, () => { if (mine === reads && value.isConnected) fiat.textContent = 'USD unavailable' })
  }
  // Timers can be throttled while hidden: also check on focus. Never keep stale dollars as current.
  const expire = () => {
    if (!value.isConnected) { removeEventListener('focus', expire); document.removeEventListener('visibilitychange', expire); return }
    if (shown && freshQuote(shown)) return
    if (shown) fiat.textContent = 'USD loading…'
    read()
  }
  read()
  addEventListener('focus', expire)
  document.addEventListener('visibilitychange', expire)
  return value
}

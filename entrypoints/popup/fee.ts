import { formatUnits, parseUnits } from 'viem'
import { formatFeeUsd, freshQuote, nativeUsd } from '@/lib/fee-usd'
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
  void nativeUsd(snapshot).then((quote) => {
    if (!value.isConnected) return
    if (!quote || !freshQuote(quote)) { fiat.textContent = 'USD unavailable'; return }
    try {
      fiat.textContent = '≈ ' + formatFeeUsd(typeof fee === 'bigint' ? fee : parseUnits(fee, 18), 18, quote.answer, quote.decimals)
    } catch { fiat.textContent = 'USD unavailable'; return }
    // Expire even if the user leaves the same approval open. Never keep stale dollars as current.
    const expire = () => { if (!freshQuote(quote)) fiat.textContent = 'USD unavailable' }
    setTimeout(() => { fiat.textContent = 'USD unavailable'; removeEventListener('focus', expire); document.removeEventListener('visibilitychange', expire) }, quote.expiresAt - Date.now())
    addEventListener('focus', expire)
    document.addEventListener('visibilitychange', expire)
    // A short-lived timer owns no wallet state and stops within 30 seconds, even after the row is detached.
  }, () => { if (value.isConnected) fiat.textContent = 'USD unavailable' })
  return value
}

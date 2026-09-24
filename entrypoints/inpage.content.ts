import iconSvg from '@/assets/icon.svg?raw'

// Runs in the page's own JS world: the EIP-1193 provider dapps talk to. Holds no secrets;
// every request goes page -> bridge content script -> background.
export default defineContentScript({
  matches: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'], // no plain-http sites: see background.ts
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    const listeners: Record<string, Set<(data: unknown) => void>> = {}
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
    let nextId = 1

    window.addEventListener('message', ({ source, data }) => {
      if (source !== window || data?.target !== 'plainwallet-inpage') return
      if (data.event === 'accountsChanged') provider.selectedAddress = (data.data as string[])?.[0] ?? null
      if (data.event) return listeners[data.event]?.forEach((fn) => fn(data.data))
      const w = waiting.get(data.id)
      waiting.delete(data.id)
      if (data.error) w?.reject(Object.assign(new Error(data.error.message), data.error))
      else w?.resolve(data.result)
    })

    const provider = {
      isPlainWallet: true,
      // Deprecated MetaMask field that some sites (chainlist.org) still read to tell whether they're connected.
      selectedAddress: null as string | null,
      request: ({ method, params }: { method: string; params?: unknown[] }) =>
        new Promise((resolve, reject) => {
          const id = nextId++
          waiting.set(id, { resolve, reject })
          window.postMessage({ target: 'plainwallet-bridge', id, method, params }, location.origin)
        }).then((result) => {
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') provider.selectedAddress = (result as string[])[0] ?? null
          return result
        }),
      on(event: string, fn: (data: unknown) => void) {
        ;(listeners[event] ??= new Set()).add(fn)
        return provider
      },
      removeListener(event: string, fn: (data: unknown) => void) {
        listeners[event]?.delete(fn)
        return provider
      },
    }

    // EIP-6963: how modern dapps discover wallets
    const icon = `data:image/svg+xml,${encodeURIComponent(iconSvg)}`
    // UUIDv4 by hand: crypto.randomUUID is https-only and this must not crash on http:// pages
    const hex = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b, i) => (i === 6 ? (b & 15) | 64 : i === 8 ? (b & 63) | 128 : b).toString(16).padStart(2, '0'))
      .join('')
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    const detail = Object.freeze({
      info: Object.freeze({ uuid, name: 'Plain Wallet', icon, rdns: 'com.github.backmeupplz.plainwallet' }),
      provider,
    })
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()

    // Legacy discovery; don't fight another wallet that already claimed it
    try {
      ;(window as any).ethereum ??= provider
    } catch {}
  },
})

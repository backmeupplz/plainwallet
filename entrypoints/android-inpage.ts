import inpage from './inpage.content'

// Android app only (android/): injected at document start into pages in the app's browser (MainActivity.java). The
// extension's provider, unchanged; this does bridge.content.ts's job, relaying to the app, which takes the origin from
// the WebView, never from here. Holds nothing either.
export default defineUnlistedScript({
  include: ['android'],
  main() {
    const native = (globalThis as any).plainwalletNative
    // Where the extension's content scripts run: top frames on https and local dev servers (see background.ts).
    if (!native || window !== top || !(location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) return
    const post = (msg: object) => window.postMessage({ target: 'plainwallet-inpage', ...msg }, location.origin)
    const send = (msg: object) => native.postMessage(JSON.stringify(msg))
    // This bridge's own requests count down, the provider's count up from 1.
    const asking = new Map<number, (response: { result?: unknown }) => void>()
    let nextId = 0
    const rpc = (method: string) => new Promise<{ result?: unknown }>((resolve) => {
      asking.set(--nextId, resolve)
      send({ id: nextId, method })
    })

    native.onmessage = ({ data }: { data: string }) => {
      const msg = JSON.parse(data)
      if ('id' in msg) {
        const own = asking.get(msg.id)
        asking.delete(msg.id)
        return own ? own(msg) : post(msg)
      }
      // The app says *that* something changed; what this origin may see is still decided by the wallet.
      if (msg.chain) rpc('eth_chainId').then((r) => post({ event: 'chainChanged', data: r.result }))
      if (msg.accounts) rpc('eth_accounts').then((r) => post({ event: 'accountsChanged', data: r.result }))
    }
    window.addEventListener('message', ({ source, data }) => {
      if (source !== window || data?.target !== 'plainwallet-bridge') return
      send({ id: data.id, method: data.method, params: data.params })
    })
    send({ hello: true }) // lets the app push chainChanged / accountsChanged to this page
    inpage.main(undefined as never)
  },
})

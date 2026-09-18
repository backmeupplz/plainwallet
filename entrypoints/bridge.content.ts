// Isolated-world relay between the inpage provider and the background.
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',
  main() {
    const post = (msg: object) => window.postMessage({ target: 'plainwallet-inpage', ...msg }, location.origin)
    const rpc = (method: string, params?: unknown[]) =>
      browser.runtime
        .sendMessage({ method, params })
        .catch((e) => ({ error: { code: -32603, message: String(e?.message ?? e) } }))

    window.addEventListener('message', async ({ source, data }) => {
      if (source !== window || data?.target !== 'plainwallet-bridge') return
      post({ id: data.id, ...(await rpc(data.method, data.params)) })
    })

    // The background says *that* something changed; what this origin may see is still decided by the background.
    browser.runtime.onMessage.addListener((msg) => {
      if (msg.chain) rpc('eth_chainId').then((r) => post({ event: 'chainChanged', data: r.result }))
      if (msg.accounts) rpc('eth_accounts').then((r) => post({ event: 'accountsChanged', data: r.result }))
    })
  },
})

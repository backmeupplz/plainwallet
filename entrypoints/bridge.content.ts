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

    // State lives in storage.local, so its change feed doubles as the provider event source.
    browser.storage.onChanged.addListener(async (changes, area) => {
      if (area !== 'local') return
      if (changes.chainId) post({ event: 'chainChanged', data: (await rpc('eth_chainId')).result })
      if (changes.active || changes.sites || changes.addresses)
        post({ event: 'accountsChanged', data: (await rpc('eth_accounts')).result })
    })
  },
})

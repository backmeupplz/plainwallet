// A site as Safari shows it with the extension, run by Render.swift ahead of the extension's own provider
// (.output/android-mv3/android-inpage.js, unchanged); mac.sh puts `const SHOTS = { name, width, height, accounts, css }`
// before it. The provider's requests are answered here as the wallet would answer a site it's connected to:
// SHOTS.accounts on Ethereum. Once the site has loaded and settled, SHOTS.css goes on it and it's shot at
// width x height as <name>.png.
;(() => {
  const say = (msg) => webkit.messageHandlers.shots.postMessage(msg)
  const answers = { eth_chainId: '0x1', net_version: '1', eth_accounts: SHOTS.accounts, eth_requestAccounts: SHOTS.accounts }
  window.plainwalletNative = {
    postMessage: (s) => {
      const msg = JSON.parse(s)
      if ('id' in msg) setTimeout(() => plainwalletNative.onmessage({ data: JSON.stringify({ id: msg.id, result: answers[msg.method] ?? null }) }))
    },
  }
  addEventListener('load', async () => {
    try {
      await say({ type: 'size', width: SHOTS.width, height: SHOTS.height })
      await new Promise((r) => setTimeout(r, 8000)) // its fonts, images and first requests
      document.head.append(Object.assign(document.createElement('style'), { textContent: SHOTS.css }))
      scrollTo(0, 0)
      await new Promise((r) => setTimeout(r, 1500))
      await say({ type: 'shot', name: SHOTS.name })
      await say({ type: 'done' })
    } catch (e) {
      say({ type: 'done', error: String(e) })
    }
  })
})()

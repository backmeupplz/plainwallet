// The wallet page (.output/android-mv3/android.html) as the Mac's two windows show it, run by Render.swift in one
// language from fresh storage; mac.sh puts `const SHOTS = { lang }` before it. With ?view=tab it's the Mac app's window
// (440x720, as macos/PlainWallet sizes it): 5 the password that keeps the keys on the device, 1 the wallet, 4 sending.
// Then without a view, as Safari's extension shows popup.html: 3 the toolbar popup (360 wide, as tall as what's in
// it), 2 a site's permit approval in the window the extension opens for approvals (380x640, entrypoints/background.ts).
// Safari's popup.html is the same popup (entrypoints/popup) on the browser's extension API, which only Safari has;
// android.html runs it on the app's, which this script stands in for, handing it a site's requests as the app does.
;(() => {
  const sent = [] // what the page sent the app
  window.plainwalletNative = { platform: 'macos', postMessage: (s) => sent.push(JSON.parse(s)) }
  const say = (msg) => webkit.messageHandlers.shots.postMessage(msg)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (what, fn, seconds = 30) => {
    for (let i = 0; i < seconds * 4; i++) {
      const v = await fn()
      if (v) return v
      await sleep(250)
    }
    throw new Error(`no ${what} after ${seconds} s`)
  }
  const visible = () => [...document.querySelectorAll('button')].filter((b) => b.offsetParent)
  const fill = (i, v) => { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })) }
  // an approval's buttons take clicks a moment after they show (armed() in entrypoints/popup/main.ts)
  const ready = (b) => b.classList.contains('primary') && !b.disabled && b.ariaDisabled !== 'true'
  const primary = (what) => until(what, () => visible().find(ready))
  const shot = async (name) => {
    document.activeElement?.blur()
    await document.fonts.ready
    await sleep(1500)
    await say({ type: 'shot', name })
  }
  const PASSWORD = 'correct horse battery staple'
  const SITE = 'https://metamask.github.io', SPENDER = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'
  let n = 0
  // a site's request, as Safari's extension hands it to the background: the origin from Safari, not the site
  const request = async (method, params) => {
    const id = ++n
    plainwalletNative.onmessage({ data: JSON.stringify({ type: 'request', n: id, origin: SITE, title: 'E2E Test Dapp', data: JSON.stringify({ id, jsonrpc: '2.0', method, params }) }) })
    return id
  }

  async function app() {
    await say({ type: 'size', width: 440, height: 720 })
    const start = await until('start', () => visible().find((b) => !b.classList.contains('quiet')))
    if (document.documentElement.lang !== SHOTS.lang) throw new Error(`the wallet shows ${document.documentElement.lang}, not ${SHOTS.lang}`)
    start.click() // a new wallet
    const pw = await until('password fields', () => { const f = document.querySelectorAll('input[type=password]'); return f.length === 2 && f })
    pw.forEach((i) => fill(i, PASSWORD))
    await shot('5')
    ;(await primary('seed phrase button')).click()
    await until('seed phrase', () => document.querySelectorAll('ol li').length === 12)
    ;(await primary('create button')).click()
    await until('balances', () => document.querySelector('dl.balances[aria-busy=false]'))
    await shot('1')
    visible().at(-1).click() // Send
    const f = await until('send form', () => { const f = [...document.querySelectorAll('dialog input')].filter((i) => i.offsetParent); return f.length >= 2 && f })
    fill(f.at(-2), '0x8ba1f109551bD432803012645Ac136ddd64DBA72')
    fill(f.at(-1), '0.25')
    await shot('4')
    location.href = '/android.html' // the extension's own page, as its popup and approval window load it
  }

  async function safari() {
    document.body.classList.remove('app') // what only the apps' page has (style.css)
    await say({ type: 'size', width: 360, height: 600 })
    const pw = await until('unlock', () => document.querySelector('input[type=password]'))
    fill(pw, PASSWORD)
    ;(await primary('unlock button')).click()
    await until('balances', () => document.querySelector('dl.balances[aria-busy=false]'))
    await sleep(500)
    // Safari sizes the popup to its page
    await say({ type: 'size', width: 360, height: Math.ceil(document.getElementById('app').getBoundingClientRect().bottom + 16) })
    await shot('3')
    await say({ type: 'size', width: 380, height: 640 })
    const connect = await request('eth_requestAccounts', [])
    await until('connect approval', () => document.querySelector('.slip'))
    ;(await primary('Approve')).click()
    const reply = await until('accounts', () => sent.find((m) => m.type === 'reply' && m.n === connect))
    const [account] = JSON.parse(reply.data).result
    await say({ type: 'log', text: 'account ' + account }) // mac.sh connects the site behind the approval to it
    await request('eth_signTypedData_v4', [account, JSON.stringify({
      types: {
        EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
        Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
      },
      primaryType: 'Permit',
      domain: { name: 'MyToken', version: '1', chainId: 1, verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC' },
      message: { owner: account, spender: SPENDER, value: 3000, nonce: 0, deadline: 50000000000 },
    })])
    await until('permit', () => document.body.innerText.includes('message.spender') && visible().some(ready))
    await shot('2')
  }

  addEventListener('load', () => (new URLSearchParams(location.search).get('view') === 'tab' ? app() : safari()).then(
    () => location.search.includes('view=tab') || say({ type: 'done' }),
    // what was on screen, for render.log's error (mac.sh drops a failed language's PNGs)
    async (e) => { await say({ type: 'shot', name: 'failed' }).catch(() => {}); say({ type: 'done', error: `${e?.stack}\n${e}` }) }))
})()

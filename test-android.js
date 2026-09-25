// Self-check for the Android app's wallet page: the real background on entrypoints/android-shim.ts, driven the way
// MainActivity.java drives it. Run: npm test
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

class FakeStorage { // like localStorage: Object.keys() lists the items
  getItem(k) { return Object.hasOwn(this, k) ? this[k] : null }
  setItem(k, v) { this[k] = String(v) }
  removeItem(k) { delete this[k] }
}
Object.defineProperty(globalThis, 'localStorage', { value: new FakeStorage(), configurable: true })
globalThis.location = new URL('https://appassets.androidplatform.net/android.html?view=tab')
const sent = [] // what the page tells the app
const native = { postMessage: (s) => sent.push(JSON.parse(s)) }
globalThis.plainwalletNative = native
const rendered = []
globalThis.dispatchEvent = (e) => rendered.push(e.type)
globalThis.defineUnlistedScript = (definition) => definition
globalThis.defineBackground = (fn) => fn
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'wxt/browser') return { url: 'data:text/javascript,export const browser = globalThis.browser', shortCircuit: true }
    if (specifier === '@/package.json') return { url: 'data:text/javascript,export const version = "test"', shortCircuit: true }
    if (specifier.startsWith('@/')) specifier = new URL(specifier.slice(2) + '.ts', import.meta.url).href
    if (specifier === './wallet' || specifier === './store' || specifier === './describe') specifier += '.ts'
    return next(specifier, context)
  },
})

;(await import('./entrypoints/android-shim.ts')).default.main()
assert.deepEqual(sent, [{ type: 'ready', setup: false }])
const { addWallet, isUnlocked, load, save } = await import('./lib/store.ts')
;(await import('./entrypoints/background.ts')).default()
const until = async (check) => { for (let i = 0; i < 400 && !(await check()); i++) await new Promise((r) => setTimeout(r, 5)) }
const fromApp = (msg) => native.onmessage({ data: JSON.stringify(msg) })
let n = 0
/** A site's request as the app relays it: the origin from the WebView, the rest from the page. */
const request = async (origin, data) => {
  const number = ++n
  await fromApp({ type: 'request', n: number, origin, title: 'Some dapp', data: JSON.stringify(data) })
  const reply = sent.find((m) => m.type === 'reply' && m.n === number)
  assert.equal(reply.origin, origin)
  return JSON.parse(reply.data)
}
const approve = async (ok) => {
  await until(async () => (await browser.runtime.sendMessage({ type: 'pending' })).length > 0)
  const [p] = await browser.runtime.sendMessage({ type: 'pending' })
  await browser.runtime.sendMessage({ type: 'settle', id: p.id, ok })
}

await addWallet('test test test test test test test test test test test junk', 'android-password-1')
const [address] = (await load()).addresses
assert.ok(sent.some((m) => m.type === 'setup' && m.done)) // the app's address bar appears
assert.deepEqual(await request('https://dapp.test', { id: 7, method: 'eth_chainId' }), { id: 7, result: '0x1' })
// A page supplies only method and params: it can't pose as the wallet's own page, or pick its origin.
assert.equal((await request('https://dapp.test', { id: 8, type: 'pending' })).error.code, -32600)
assert.equal((await request('https://dapp.test', { id: 9, type: 'reset', method: 'eth_chainId', origin: 'https://other.test' })).result, '0x1')
assert.equal((await request('http://dapp.test', { id: 10, method: 'eth_chainId' })).error.code, 4100)
assert.equal((await request('https://dapp.test', { id: 11, method: 'eth_accounts' })).result.length, 0)

// Asking brings the wallet up; backing out of it (the app's "back") rejects, like closing the approval window.
const asked = request('https://dapp.test', { id: 12, method: 'eth_requestAccounts' })
await until(() => sent.some((m) => m.type === 'show'))
assert.ok(rendered.includes('plainwallet-render'))
await fromApp({ type: 'back' })
assert.equal((await asked).error.code, 4001)
assert.deepEqual((await load()).connections, {})

const connecting = request('https://other.test', { id: 1, method: 'eth_requestAccounts' })
await approve(true)
assert.deepEqual(await connecting, { id: 1, result: [address] })
assert.ok(sent.some((m) => m.type === 'hide'))
// Changes are pushed to the page the browser shows, if that site is connected; the app checks the origin again.
await fromApp({ type: 'page', url: 'https://other.test/swap', title: 'Other' })
await save({ chainId: 8453 })
const chainEvent = { type: 'event', origin: 'https://other.test', data: '{"chain":true,"accounts":false}' }
await until(() => sent.some((m) => JSON.stringify(m) === JSON.stringify(chainEvent)))
assert.ok(sent.some((m) => JSON.stringify(m) === JSON.stringify(chainEvent)))

// The star button: favorites are the browser's pages, toggled.
assert.deepEqual(sent.findLast((m) => m.type === 'starred'), { type: 'starred', on: false })
await fromApp({ type: 'star' })
assert.deepEqual((await browser.storage.local.get('favorites')).favorites, [{ url: 'https://other.test/swap', title: 'Other' }])
assert.deepEqual(sent.at(-1), { type: 'starred', on: true })
await fromApp({ type: 'star' })
assert.deepEqual((await browser.storage.local.get('favorites')).favorites, [])
// Favicons: a favorite takes the page's icon when the app sends one, and only a PNG data URL.
await fromApp({ type: 'star' })
await fromApp({ type: 'page', url: 'https://other.test/swap', title: 'Other', icon: 'javascript:alert(1)' })
assert.equal((await browser.storage.local.get('favorites')).favorites[0].icon, undefined)
await fromApp({ type: 'page', url: 'https://other.test/swap', title: 'Other', icon: 'data:image/png;base64,iVBORw0KGgo=' })
assert.equal((await browser.storage.local.get('favorites')).favorites[0].icon, 'data:image/png;base64,iVBORw0KGgo=')
// Anything else from the app goes to the wallet page's own Android code.
let heard
plainwalletApp.listen((msg) => (heard = msg))
await fromApp({ type: 'fingerprint', available: true, enabled: false })
assert.deepEqual(heard, { type: 'fingerprint', available: true, enabled: false })

// Auto-lock: an overdue alarm fires before anything reads the session key, even if no timer ran meanwhile.
assert.ok(await isUnlocked())
await browser.alarms.create('lock', { delayInMinutes: 0 })
assert.equal(await isUnlocked(), false)
console.log('android ok')
process.exit(0) // the shim's alarm check keeps an interval running

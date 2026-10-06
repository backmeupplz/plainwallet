// Self-check for the Mac app's shared wallet: the real store on entrypoints/android-shim.ts, whose storage.local goes to
// the app (macos/Shared/Storage.swift, faked here with the same requests and answers), and the Safari extension's
// storage.local (lib/shared-storage.ts) on the same file. Run: npm test
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// Storage.swift: key → JSON text; {get: keys | null}, {set: {key: text | null}}, {clear: true} → {values} or {error}
const file = new Map()
let failing = false
const storage = async (req) => {
  if (failing) return { error: 'Wallet storage: no app group' }
  if (req.compareAndSet) {
    const { expected, set } = req.compareAndSet
    if (Object.entries(expected).some(([k, v]) => (file.get(k) ?? null) !== v)) return { committed: false }
    for (const [k, v] of Object.entries(set)) file.set(k, v)
    return { committed: true }
  }
  if (req.set) { for (const [k, v] of Object.entries(req.set)) v === null ? file.delete(k) : file.set(k, v); return {} }
  if (req.clear) { file.clear(); return {} }
  return { values: Object.fromEntries([...file].filter(([k]) => req.get === null || req.get.includes(k))) }
}
globalThis.localStorage = { getItem: () => null } // the shim's start-up check only; the vault isn't here
globalThis.location = new URL('plainwallet://app/android.html?view=tab')
globalThis.plainwalletNative = { platform: 'macos', postMessage() {}, storage }
globalThis.dispatchEvent = () => {}
globalThis.defineUnlistedScript = (definition) => definition
globalThis.defineBackground = (fn) => fn
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'wxt/browser') return { url: 'data:text/javascript,export const browser = globalThis.browser', shortCircuit: true }
    if (specifier === '@/package.json') return { url: 'data:text/javascript,export const version = "test"', shortCircuit: true }
    if (specifier.startsWith('@/')) specifier = new URL(specifier.slice(2) + '.ts', import.meta.url).href
    if (['./wallet', './store', './describe'].includes(specifier)) specifier += '.ts'
    return next(specifier, context)
  },
})

;(await import('./entrypoints/android-shim.ts')).default.main()
const { addWallet, load, lock, unlock } = await import('./lib/store.ts')
const { nativeLocal } = await import('./lib/shared-storage.ts')

// A wallet made in the app lands in the shared file, as JSON text.
await addWallet('test test test test test test test test test test test junk', 'macos-password-1')
const [address] = (await load()).addresses
assert.equal(address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
assert.deepEqual(JSON.parse(file.get('addresses')), [address])

// The Safari extension reads that same wallet, and its writes are the app's next read: nothing is cached.
const safari = nativeLocal(storage)
assert.equal((await safari.get('vault')).vault, (await browser.storage.local.get('vault')).vault)
await safari.set({ jevKey: 'k' })
assert.equal((await browser.storage.local.get('jevKey')).jevKey, 'k')
await safari.remove('jevKey')
assert.deepEqual(await browser.storage.local.get('jevKey'), {})

// Each side unlocks on its own: locking the app leaves the shared vault alone, and the password opens it again.
await lock()
await unlock('macos-password-1')
assert.equal((await load()).addresses[0], address)

// Storage that can't answer is an error, never an empty wallet (which setup would write over).
failing = true
await assert.rejects(load(), /no app group/)
await assert.rejects(browser.storage.local.set({ x: 1 }), /no app group/)
failing = false
assert.ok(file.has('vault'))

await safari.clear()
assert.equal(file.size, 0)
console.log('macos shared storage ok')
process.exit(0) // the shim's alarm check keeps an interval running

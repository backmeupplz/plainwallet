// A disposable extension API mock: never reads or writes a real browser profile.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const area = () => ({
  data: {},
  async get(key) { return key ? { [key]: this.data[key] } : structuredClone(this.data) },
  async set(values) { Object.assign(this.data, values) },
  async clear() { this.data = {} },
  async remove(keys) { for (const k of [keys].flat()) delete this.data[k] },
})
let onMessage
const alarms = new Set()
const extension = 'moz-extension://reset-test/'
globalThis.browser = {
  storage: { local: area(), session: area(), onChanged: { addListener() {} } },
  alarms: {
    async create(name) { alarms.add(name) },
    async clear(name) { return alarms.delete(name) },
    onAlarm: { addListener() {} },
  },
  runtime: {
    getURL: (path) => extension + path.replace(/^\//, ''),
    onMessage: { addListener(fn) { onMessage = fn } },
  },
  windows: { async create() { return { id: 1 } }, async update() {}, async remove() {}, onRemoved: { addListener() {} } },
}
globalThis.defineBackground = (fn) => fn
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'wxt/browser') return { url: 'data:text/javascript,export const browser = globalThis.browser', shortCircuit: true }
    if (specifier.startsWith('@/')) specifier = new URL(specifier.slice(2) + '.ts', import.meta.url).href
    if (specifier === './wallet' || specifier === './store' || specifier === './describe') specifier += '.ts'
    return next(specifier, context)
  },
})
const { addWallet, addDerivedAccount, exportAccount, removeAccount, seedSources, load, lock, repair, save, secrets, isUnlocked, unlock } = await import('./lib/store.ts')
const { deriveKey, encryptVault, newMeta, toAccount } = await import('./lib/wallet.ts')
const { default: start } = await import('./entrypoints/background.ts')
start()
const trusted = { url: extension + 'popup.html' }
const site = { url: 'https://example.test/', origin: 'https://example.test' }
const message = (msg, sender = trusted) => new Promise((resolve) => onMessage(msg, sender, resolve))
const call = (method, params, from = site) => message({ method, params }, from)
const until = async (check) => { for (let i = 0; i < 400 && !(await check()); i++) await new Promise((r) => setTimeout(r, 5)) }
/** Plays the user: waits for the next approval and answers it. */
const answer = async (ok) => {
  await until(async () => (await message({ type: 'pending' })).length > 0)
  const [request] = await message({ type: 'pending' })
  await message({ type: 'settle', id: request.id, ok })
}

await addWallet('test test test test test test test test test test test junk', 'old-password-123')
const mnemonic = (await secrets())[0]
const baseAddress = (await load()).addresses[0]
// Legacy seed entries remain readable; independently imported children are skipped.
const child = toAccount({ mnemonic, addressIndex: 1 })
await addWallet('0x' + Buffer.from(child.getHdKey().privateKey).toString('hex'))
await addDerivedAccount(0)
assert.equal((await load()).addresses[2], toAccount({ mnemonic, addressIndex: 2 }).address)
assert.deepEqual(await seedSources(), [{ index: 0, address: baseAddress }])
await assert.rejects(addDerivedAccount(1), /stored seed/)
await assert.rejects(addDerivedAccount(999), /stored seed/)
await assert.rejects(addWallet(mnemonic), /already added/)
// Two open wallet views cannot overwrite each other's derived accounts.
await Promise.all([addDerivedAccount(0), addDerivedAccount(0)])
assert.equal(new Set((await load()).addresses).size, 5)
assert.deepEqual((await secrets()).slice(-2).map((s) => s.addressIndex), [3, 4])
const secondSeed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
await addWallet(secondSeed)
assert.equal((await seedSources()).length, 2)
await addDerivedAccount(5)
assert.equal((await load()).addresses[6], toAccount({ mnemonic: secondSeed, addressIndex: 1 }).address)
await lock()
await assert.rejects(addDerivedAccount(0), /locked/)
await unlock('old-password-123')
assert.equal((await secrets())[0], mnemonic)
assert.equal(toAccount((await secrets())[6]).address, (await load()).addresses[6])
await addWallet('0x' + '12'.repeat(32))
// Export requires fresh password authentication even with a valid cached unlock key.
const beforeExport = structuredClone(browser.storage.local.data)
const sessionBeforeExport = structuredClone(browser.storage.session.data)
await assert.rejects(exportAccount(0, ''), /Enter your password/)
await assert.rejects(exportAccount(0, 'incorrect-password'), /Wrong password/)
await assert.rejects(exportAccount(999, 'old-password-123'), /stored account/)
await assert.rejects(exportAccount(-1, 'old-password-123'), /stored account/)
for (const index of [0, 1, 2, 6, 7]) {
  const exported = await exportAccount(index, 'old-password-123')
  assert.equal(toAccount(exported.privateKey).address, (await load()).addresses[index])
  assert.equal(exported.mnemonic, index === 1 || index === 7 ? undefined : index === 6 ? secondSeed : mnemonic)
  assert.equal(exported.path, index === 1 || index === 7 ? undefined : `m/44'/60'/0'/0/${index === 6 ? 1 : index}`)
  if (index === 7) assert.equal(exported.privateKey, '0x' + '12'.repeat(32))
}
assert.deepEqual(browser.storage.local.data, beforeExport)
assert.deepEqual(browser.storage.session.data, sessionBeforeExport)
const duringLock = assert.rejects(exportAccount(0, 'old-password-123'), /locked/)
await new Promise((resolve) => setTimeout(resolve, 20))
await lock()
await duringLock
await assert.rejects(exportAccount(0, 'old-password-123'), /locked/)
await unlock('old-password-123')
console.log('password-authenticated export ok')

// Removing an account deletes its key, nickname and connections; the others keep their order, the selection follows.
const kept = await load()
const [a0, gone] = [kept.addresses[0], kept.addresses[1]]
await save({ active: 3, nicknames: { [gone]: 'Spare', [a0]: 'Main' }, connections: { 'https://a.test': [gone], 'https://b.test': [a0, gone] } })
await assert.rejects(removeAccount(1, a0), /does not match/)
await assert.rejects(removeAccount(99, gone), /does not match/)
await removeAccount(1, gone)
const removed = await load()
assert.deepEqual(removed.addresses, kept.addresses.filter((a) => a !== gone))
assert.deepEqual((await secrets()).map((s) => toAccount(s).address), removed.addresses)
assert.equal(removed.active, 2) // still the same account
assert.deepEqual(removed.nicknames, { [a0]: 'Main' })
assert.deepEqual(removed.connections, { 'https://b.test': [a0] })
await save({ connections: {}, nicknames: {} })
console.log('remove account ok')

// State written behind the wallet's back (Firefox content scripts can reach storage.local) is refused once unlocked,
// by the popup and by sites alike, and can be rebuilt from the vault.
await browser.storage.local.set({ chainId: 5 })
await assert.rejects(load(), /changed outside/)
assert.match((await call('eth_chainId')).error.message, /changed outside/)
await repair()
const repaired = await load()
assert.equal(repaired.chainId, 1)
assert.deepEqual(repaired.addresses, (await secrets()).map((s) => toAccount(s).address))
const [first] = repaired.addresses

// Connections are per account; locking keeps them (signing then asks for the password first).
const connecting = call('eth_requestAccounts')
await answer(true)
assert.deepEqual((await connecting).result, [first])
assert.deepEqual((await call('eth_accounts')).result, [first])
await save({ active: 1 })
assert.deepEqual((await call('eth_accounts')).result, [])
assert.equal((await call('personal_sign', ['hi', repaired.addresses[1]])).error.code, 4100)
await save({ active: 0 })
await lock()
assert.deepEqual((await call('eth_accounts')).result, [first])
assert.deepEqual((await call('eth_requestAccounts')).result, [first]) // no prompt: already connected
assert.deepEqual(await message({ type: 'pending' }), [])
await unlock('old-password-123')

// Saying no holds for a moment: the site can't re-ask straight away.
const other = { url: 'https://other.example/', origin: 'https://other.example' }
const refused = call('eth_requestAccounts', [], other)
await answer(false)
assert.equal((await refused).error.code, 4001)
assert.match((await call('eth_requestAccounts', [], other)).error.message, /moments ago/)

// Refused before any approval shows: sign-ins for another site, plain http, huge payloads, dapp RPCs into your network.
const signIn = `bank.example wants you to sign in with your Ethereum account:\n${first}\n\nURI: https://bank.example\nVersion: 1`
assert.match((await call('personal_sign', [signIn, first])).error.message, /for bank\.example/)
assert.equal((await call('eth_chainId', [], { url: 'http://example.test/', origin: 'http://example.test' })).error.code, 4100)
assert.equal((await call('eth_call', ['x'.repeat(600_000)])).error.code, -32602)
assert.equal((await call('wallet_addEthereumChain', [{ chainId: '0x3e7', chainName: 'Local', rpcUrls: ['http://localhost:8545'] }])).error.code, -32602)
assert.deepEqual(await message({ type: 'pending' }), [])
console.log('integrity and connections ok')

await save({ connections: { 'https://connected.test': [first] }, chainId: 777, networks: [{ id: 777, name: 'Custom', rpc: 'https://rpc.custom.example', symbol: 'C' }] })
const original = await load()
// A website cannot invoke reset, even with the same message type.
assert.equal((await message({ type: 'reset' }, site)).error.code, -32600)
assert.deepEqual(await load(), original)

await lock()
const pending = message({ method: 'eth_requestAccounts' }, site)
await new Promise((resolve) => setImmediate(resolve))
assert.equal((await message({ type: 'pending' })).length, 1)
assert.deepEqual(await message({ type: 'reset' }), {})
assert.equal((await pending).error.code, 4001)
assert.deepEqual(await message({ type: 'pending' }), [])
assert.deepEqual(browser.storage.local.data, {})
assert.deepEqual(browser.storage.session.data, {})
assert.equal(alarms.has('lock'), false)
assert.equal(await isUnlocked(), false)
await assert.rejects(secrets(), /locked/)
assert.equal((await load()).vault, '')
assert.deepEqual((await load()).addresses, [])
assert.deepEqual((await load()).connections, {})
assert.equal((await load()).chainId, 1)
assert.equal((await message({ method: 'eth_requestAccounts' }, site)).error.code, 4100)

// Setup works again with a new password, and a reset also clears an unlocked key.
await addWallet('0x' + '34'.repeat(32), 'new-password-123')
assert.equal((await secrets()).length, 1)
await assert.rejects(removeAccount(0, (await load()).addresses[0]), /only account/)
await lock()
await assert.rejects(unlock('old-password-123'), /Wrong password/)
await unlock('new-password-123')
assert.equal(await isUnlocked(), true)
await message({ type: 'reset' })
assert.equal(await isUnlocked(), false)
assert.deepEqual(browser.storage.session.data, {})

// Deletion errors reach the UI; the reset-in-progress flag is released for retry.
const clear = browser.storage.local.clear
browser.storage.local.clear = async () => { throw new Error('Storage unavailable') }
assert.deepEqual(await message({ type: 'reset' }), { error: 'Storage unavailable' })
browser.storage.local.clear = clear
assert.deepEqual(await message({ type: 'reset' }), {})
console.log('reset ok')

// A 0.1.x profile: PBKDF2 vault, unsigned plaintext state (tampered with here) and a per-origin sites list. Unlocking
// moves it to scrypt, rebuilds the accounts from the vault and signs the rest.
const { salt } = newMeta()
await browser.storage.local.set({
  vault: await encryptVault(await deriveKey('legacy-password-1', { salt }), { salt }, [mnemonic]),
  addresses: ['0x000000000000000000000000000000000000dEaD'],
  sites: ['https://old.example'],
  chainId: 10,
})
await unlock('legacy-password-1')
const upgraded = await load()
assert.equal(JSON.parse(upgraded.vault).kdf, 'scrypt')
assert.deepEqual(upgraded.addresses, [baseAddress])
assert.deepEqual(upgraded.connections, {})
assert.equal(upgraded.chainId, 10)
assert.equal(browser.storage.local.data.sites, undefined)
await lock()
await unlock('legacy-password-1')
assert.deepEqual(await secrets(), [mnemonic])
// Dropping the kdf field can't pass a new vault off as an old one: without the password's PBKDF2 key it won't open.
await lock()
const { kdf, ...stripped } = JSON.parse(browser.storage.local.data.vault)
browser.storage.local.data.vault = JSON.stringify(stripped)
await assert.rejects(unlock('legacy-password-1'), /Wrong password/)
console.log('migration ok')

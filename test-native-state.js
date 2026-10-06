// Two independent origin lock managers, one native file. Synthetic wallets only.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import * as wallet from './lib/wallet.ts'
import * as chains from 'viem/chains'
import { toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { nativeLocal } from './lib/shared-storage.ts'

const file = new Map()
const storage = async (req) => {
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
const code = stripTypeScriptTypes(readFileSync(new URL('./lib/store.ts', import.meta.url), 'utf8')).replace(/^import .*$/gm, '').replace(/export /g, '')
const deps = { ...wallet, ...chains, toHex, mnemonicToAccount }
const context = () => {
  const session = {}
  const local = nativeLocal(storage)
  const browser = { storage: { local, session: {
    async get() { return { ...session } }, async set(v) { Object.assign(session, v) }, async clear() { delete session.key },
  } }, alarms: { async create() {}, async clear() {} } }
  const queues = new Map()
  const navigator = { locks: { request(name, fn) {
    const p = (queues.get(name) ?? Promise.resolve()).then(fn)
    queues.set(name, p.catch(() => {}))
    return p
  } } }
  const store = new Function(...Object.keys(deps), 'browser', 'navigator', code + ';return {addWallet,addDerivedAccount,unlock,load,secrets,accountGroups,removeSeedGroup,removeAccount,save,repair,reset}')(...Object.values(deps), browser, navigator)
  return { local, ...store }
}
const a = context(), b = context()
const seed = 'test test test test test test test test test test test junk'
const spare = '0x' + '12'.repeat(32), added = '0x' + '34'.repeat(32)
await a.addWallet(seed, 'synthetic-password')
await a.addWallet(spare)
await b.unlock('synthetic-password')
const consistent = async () => assert.deepEqual((await a.load()).addresses, (await a.secrets()).map(s => wallet.toAccount(s).address))

// Pause one origin at a named boundary, commit the other, then require an explicit failure (never silent loss).
const interleave = async (method, matches, first, second) => {
  const original = a.local[method]
  let signal, resume, held = false
  const reached = new Promise(r => signal = r), gate = new Promise(r => resume = r)
  a.local[method] = async (...args) => {
    if (!held && matches(...args)) {
      held = true
      // A get has already taken its snapshot; a CAS has not yet acquired the native file lock.
      const snapshot = method === 'get' ? await original(...args) : undefined
      signal(); await gate
      return method === 'get' ? snapshot : original(...args)
    }
    return original(...args)
  }
  const pending = first()
  const rejected = assert.rejects(pending, /changed|selected accounts|stored seed/i)
  await reached
  try { await second() } finally { resume() }
  await rejected
  a.local[method] = original
  await consistent()
}
let group = (await a.accountGroups())[0].accounts
// Original failure: import lands between removal's vault snapshot and its state read.
await interleave('get', k => k === 'vault', () => a.removeSeedGroup(group), () => b.addWallet(added))
assert.ok((await a.secrets()).includes(added))
assert.ok((await a.secrets()).includes(spare))
// The remaining race: import lands after the state read, immediately before native commit.
const another = '0x' + '56'.repeat(32)
await interleave('compareAndSet', () => true, () => a.removeSeedGroup(group), () => b.addWallet(another))
assert.ok((await a.secrets()).includes(another))
// Metadata-only writes must also conflict, instead of restoring removed vault contents.
await interleave('compareAndSet', () => true, () => a.save({ chainId: 8453 }), () => b.removeSeedGroup(group))
assert.ok(!(await a.secrets()).includes(seed))
// A stale derive cannot resurrect a removed source. Re-add it, then remove from the other origin.
await a.addWallet(seed)
group = (await a.accountGroups()).find(g => g.type === 'seed').accounts
await interleave('get', k => k === 'vault', () => a.addDerivedAccount(group[0].index, group[0].address), () => b.removeSeedGroup(group))
assert.ok(!(await a.secrets()).some(s => wallet.mnemonicOf(s) === seed))
// Repair works even when the stored MAC is explicitly empty rather than absent.
await a.local.set({ mac: '' })
await a.repair()
await consistent()
// Repair and import are subject to the same native commit check; reset cannot be overwritten either.
await interleave('compareAndSet', () => true, () => a.repair(), () => b.addWallet('0x' + '78'.repeat(32)))
await interleave('compareAndSet', () => true, () => a.addWallet(seed), () => b.save({ chainId: 137 }))
const pendingReset = a.local.compareAndSet
let signal, resume
const reached = new Promise(r => signal = r), gate = new Promise(r => resume = r)
a.local.compareAndSet = async (...args) => { signal(); await gate; return pendingReset(...args) }
const pending = assert.rejects(a.save({ chainId: 1 }), /changed/)
await reached
await b.reset()
resume()
await pending
assert.equal(file.size, 0)

// Missing/old native implementations never acknowledge a transaction, and do not fire mirror events.
let mirrored = 0
for (const reply of [undefined, {}, { committed: false }, { error: 'bad request' }]) {
  await assert.rejects(nativeLocal(async () => reply, async () => { mirrored++ }).compareAndSet({}, {}))
}
assert.equal(mirrored, 0)
console.log('native cross-context state conflicts ok')

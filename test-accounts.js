// Execute the real dialog function against a tiny DOM, using only synthetic sources.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

class Element {
  children = []
  disabled = false
  checked = false
  value = ''
  events = {}
  constructor(tag, props, children) { this.tag = tag; Object.assign(this, props); this.children = children }
  replaceChildren(...nodes) { this.children = nodes }
  addEventListener(name, fn) { this.events[name] = fn }
}
const h = (tag, props = {}, ...children) => new Element(tag, props, children)
const nodes = (e) => [e, ...e.children.filter((c) => c instanceof Element).flatMap(nodes)]
const text = (e) => e.children.map((c) => typeof c === 'string' ? c : text(c)).join(' ')
let ui, unlocked = true, generation = 0, calls = []
const modal = () => {
  const content = h('div'), dialog = h('dialog', { open: true })
  dialog.close = () => { dialog.open = false; dialog.events.close?.() }
  const run = (fn) => async () => { await fn(); dialog.close() }
  ui = { content, dialog }
  return { ...ui, run }
}
const groups = [
  { type: 'seed', accounts: [{ index: 0, address: '0xseed0', addressIndex: 0 }, { index: 2, address: '0xseed1', addressIndex: 1 }] },
  { type: 'key', accounts: [{ index: 1, address: '0xkey' }] },
  { type: 'watch', accounts: [{ index: 3, address: '0xwatch' }] },
]
const source = await readFile(new URL('./entrypoints/popup/main.ts', import.meta.url), 'utf8')
const code = stripTypeScriptTypes(source.slice(source.indexOf('async function accountDialog('), source.indexOf('function nicknameDialog(')))
const accountDialog = new Function('h', 'modal', 'accountGroups', 'isUnlocked', 'newMnemonic', 'addWallet', 'addDerivedAccount', 'removeAccount', 'removeSeedGroup', 'secretBox', 'parseSecret', 'parseAddress', 'watchNote', code + '; return accountDialog')(
  h, modal, async () => groups, async () => unlocked,
  () => { generation++; return Array(12).fill('synthetic').join(' ') },
  async (s) => calls.push(['add', s]), async (...args) => calls.push(['derive', ...args]),
  async (...args) => calls.push(['remove', ...args]), async (...args) => calls.push(['group', ...args]),
  () => ({ input: h('textarea'), note: h('p') }), (s) => s,
  (s) => { if (!s.startsWith('0x')) throw new Error('Enter a valid 0x address'); return s }, 'Its key stays on another device.',
)
const button = (label) => nodes(ui.content).find((n) => n.tag === 'button' && text(n) === label)
const click = async (label) => { const b = button(label); assert.ok(b, label); if (!b.disabled) await b.onclick() }
const check = () => { const c = nodes(ui.content).find((n) => n.type === 'checkbox'); c.checked = true; c.onchange() }
const open = () => accountDialog({ nicknames: {} })
await open()
assert.match(text(ui.content), /Seed phrase 1/)
assert.match(text(ui.content), /Imported private key 1/)
assert.ok(!text(ui.content).includes('synthetic'))
assert.match(text(ui.content), /Watch-only address 1 .*0xwatch/)
await click('Generate account from this seed')
assert.deepEqual(calls.pop(), ['derive', 0, '0xseed0'])
await open()
await click('Generate new seed phrase')
assert.equal(generation, 1)
assert.equal(button('Create wallet').disabled, true)
await click('Create wallet')
assert.equal(calls.length, 0)
await click('Back')
assert.ok(!text(ui.content).includes('synthetic'))
assert.equal(calls.length, 0)
await click('Generate new seed phrase')
check()
await click('Create wallet')
assert.equal(calls.pop()[0], 'add')
assert.equal(ui.dialog.open, false)
assert.equal(text(ui.content), '')
await open()
await click('Remove seed phrase group')
assert.match(text(ui.content), /does not delete or move on-chain funds/)
assert.match(text(ui.content), /0xseed0.*0xseed1/)
assert.ok(!text(ui.content).includes('0xkey'))
assert.equal(button('Remove seed phrase and all listed accounts').disabled, true)
check()
await click('Remove seed phrase and all listed accounts')
assert.deepEqual(calls.pop(), ['group', groups[0].accounts])
await open()
await click('Remove account')
check()
await click('Remove this account')
assert.deepEqual(calls.pop(), ['remove', 0, '0xseed0'])
for (const [kind, value, wrong] of [['private key', '0xsynthetic', 'synthetic phrase'], ['seed phrase', 'synthetic phrase', '0xsynthetic']]) {
  await open()
  await click('Import ' + kind)
  const input = nodes(ui.content).find((n) => n.tag === 'textarea')
  input.value = wrong
  await assert.rejects(click('Import ' + kind), /Enter a/)
  input.value = value
  await click('Import ' + kind)
  assert.deepEqual(calls.pop(), ['add', value])
}
// Watch-only: added by address alone, removed without a backup checkbox (there is no key here to back up).
await open()
await click('Watch an address')
const address = nodes(ui.content).find((n) => n.tag === 'input')
address.value = 'not an address'
await assert.rejects(click('Watch address'), /valid 0x address/)
address.value = '0xwatch2'
await click('Watch address')
assert.deepEqual(calls.pop(), ['add', { watch: '0xwatch2' }])
await open()
nodes(ui.content).filter((n) => n.tag === 'button' && text(n) === 'Remove account').at(-1).onclick()
assert.match(text(ui.content), /Remove watch-only address\? .*0xwatch .*key, on the other device, is not affected/)
assert.ok(!nodes(ui.content).some((n) => n.type === 'checkbox'))
await click('Remove this address')
assert.deepEqual(calls.pop(), ['remove', 3, '0xwatch'])
// Closing/locking discards the unsaved seed, never commits it.
await open()
await click('Generate new seed phrase')
ui.dialog.close()
assert.equal(text(ui.content), '')
assert.equal(calls.length, 0)
unlocked = false
await open()
assert.equal(ui.dialog.open, false)
assert.equal(text(ui.content), '')
assert.ok(!source.includes('Add account'))
console.log('manage accounts UI ok')

// Real UI helper with a minimal DOM and controllable browser frames; no wallet/profile/storage access.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

class Element {
  isConnected = false
  children = []
  value = ''
  textContent = ''
  append(...nodes) { this.children.push(...nodes) }
  focus() { this.focused = true }
}
const events = new EventTarget()
globalThis.addEventListener = events.addEventListener.bind(events)
globalThis.document = { createElement: () => new Element() }
let frames = []
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length }
const frame = async () => {
  const callbacks = frames
  frames = []
  callbacks.forEach((fn) => fn())
  await Promise.resolve()
}
const paint = async () => { await frame(); await frame() }
const { invalidateUnlockView, unlockForm } = await import('./entrypoints/popup/unlock.ts')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let calls = 0, renders = 0
let operation = deferred()
const unlock = async (password) => {
  calls++
  assert.equal(password, 'synthetic password')
  return operation.promise
}
const mount = () => {
  const { section, form } = unlockForm(unlock, async () => { renders++ })
  form.isConnected = true
  const [label, button] = form.children
  const status = section.children[1]
  const input = label.children[0]
  input.value = 'synthetic password'
  return { form, button, input, status }
}
// Click and Enter use the browser's same native submit path, including programmatic submission.
const submit = (ui) => {
  const event = new Event('submit', { cancelable: true })
  const result = ui.form.onsubmit(event)
  assert.equal(event.defaultPrevented, true)
  return result
}
const busy = (ui, yes) => {
  assert.equal(ui.form.ariaBusy, String(yes))
  assert.equal(ui.button.disabled, yes)
  assert.equal(ui.input.disabled, yes)
  assert.equal(ui.button.textContent, yes ? 'Unlocking...' : 'Unlock')
}
let ui = mount()
assert.equal(ui.button.type, 'submit')
assert.equal(ui.status.role, 'status')
assert.equal(ui.status.ariaLive, 'polite')
busy(ui, false)
let attempt = submit(ui)
busy(ui, true)
assert.match(ui.status.textContent, /Unlocking/)
await submit(ui) // double click
await submit(ui) // Enter
await Promise.resolve()
assert.equal(calls, 0, 'microtasks must not start costly work')
await frame()
assert.equal(calls, 0, 'first animation frame must leave an opportunity to paint')
await frame()
assert.equal(calls, 1)
await submit(ui)
assert.equal(calls, 1, 'delayed operation remains single-flight')
operation.reject(new Error('Wrong password'))
await attempt
busy(ui, false)
assert.match(ui.status.textContent, /Wrong password.*try again/)
assert.equal(ui.input.value, '')
assert.equal(ui.input.focused, true)
assert.equal(renders, 0)

// Multiple failures and successes always release the guard and clear stale feedback on retry.
for (const result of ['failure', 'success', 'failure', 'success']) {
  operation = deferred()
  ui.input.value = 'synthetic password'
  attempt = submit(ui)
  assert.match(ui.status.textContent, /^Unlocking/)
  await paint()
  if (result === 'failure') operation.reject(new Error('internal details should not leak'))
  else operation.resolve()
  await attempt
  busy(ui, false)
  assert.equal(ui.input.value, '')
  if (result === 'failure') assert.equal(ui.status.textContent, 'Could not unlock your wallet. Please try again.')
  else assert.equal(ui.status.textContent, '')
}
assert.equal(calls, 5)
assert.equal(renders, 2)

// A redraw before paint cancels the old submission; its replacement is guarded until settlement.
ui.input.value = 'synthetic password'
attempt = submit(ui)
ui.form.isConnected = false
let replacement = mount()
busy(replacement, true)
await submit(replacement)
await paint()
await attempt
assert.equal(calls, 5)
busy(replacement, false)
assert.equal(renders, 2)
await submit(ui) // retained detached event handler cannot start another unlock
assert.equal(frames.length, 0)

// A harmless locked-view redraw preserves failure feedback and retry without a duplicate operation.
for (const outcome of ['resolve', 'reject']) {
  ui = replacement
  ui.input.value = 'synthetic password'
  operation = deferred()
  attempt = submit(ui)
  await paint()
  const count = calls
  ui.form.isConnected = false
  replacement = mount()
  busy(replacement, true)
  await submit(replacement)
  assert.equal(calls, count)
  operation[outcome](outcome === 'reject' ? new Error('Wrong password') : undefined)
  await attempt
  assert.equal(renders, 2)
  busy(replacement, false)
  assert.equal(replacement.status.textContent, outcome === 'reject' ? 'Wrong password. Please try again.' : '')
  replacement.form.isConnected = false
  replacement = mount()
  assert.equal(replacement.status.textContent, outcome === 'reject' ? 'Wrong password. Please try again.' : '')
}
ui = replacement
operation = deferred()
attempt = submit(ui)
assert.match(ui.status.textContent, /^Unlocking/)
await paint()
operation.resolve()
await attempt
assert.equal(renders, 3)
assert.equal(ui.status.textContent, '')

// Navigation or a newer authentication lifecycle must not inherit a late failure or completion.
for (const outcome of ['resolve', 'reject']) {
  operation = deferred()
  ui.input.value = 'synthetic password'
  attempt = submit(ui)
  await paint()
  invalidateUnlockView()
  ui.form.isConnected = false
  replacement = mount()
  busy(replacement, true)
  await submit(replacement)
  operation[outcome](outcome === 'reject' ? new Error('Wrong password') : undefined)
  await attempt
  assert.equal(renders, 3)
  busy(replacement, false)
  assert.equal(replacement.status.textContent, '')
  ui = replacement
}

// pagehide cancels delayed work even when nodes remain connected (and after a bfcache restore).
for (const restore of [false, true]) {
  ui = replacement
  ui.input.value = 'synthetic password'
  attempt = submit(ui)
  const count = calls
  events.dispatchEvent(new Event('pagehide'))
  if (restore) events.dispatchEvent(new Event('pageshow'))
  await paint()
  await attempt
  assert.equal(calls, count)
  assert.equal(renders, 3)
  events.dispatchEvent(new Event('pageshow'))
  busy(ui, false)
  replacement = mount()
  busy(replacement, false)
}

// Closing after unlock starts suppresses both outcomes, including a restore before rejection.
for (const outcome of ['resolve', 'reject']) {
  ui = replacement
  ui.input.value = 'synthetic password'
  operation = deferred()
  attempt = submit(ui)
  await paint()
  events.dispatchEvent(new Event('pagehide'))
  if (outcome === 'reject') events.dispatchEvent(new Event('pageshow'))
  operation[outcome](outcome === 'reject' ? new Error('Wrong password') : undefined)
  await attempt
  assert.equal(renders, 3)
  events.dispatchEvent(new Event('pageshow'))
  busy(ui, false)
  assert.equal(ui.status.textContent, '')
  replacement = mount()
}
ui = mount()
busy(ui, false)
ui.form.isConnected = false
const count = calls
await submit(ui)
await paint()
assert.equal(calls, count)

// The production entry point uses this tested helper; Android shares that same popup.
const popup = await readFile(new URL('./entrypoints/popup/main.ts', import.meta.url), 'utf8')
assert.ok(popup.includes('const { section, form } = unlockForm(unlock,'))
assert.ok(!popup.includes('act(() => unlock(pw.input.value))'))
assert.ok((await readFile(new URL('./entrypoints/android/main.ts', import.meta.url), 'utf8')).includes('../popup/main'))
// Exercise the real render function without importing wallet/network entrypoints. Other tests use this
// source-extraction pattern too; the unlock form above is imported directly, not reimplemented here.
const renderSource = popup.slice(popup.indexOf('export async function render('), popup.indexOf('\nrender()\n')).replace('export ', '').replace(': Pending[]', '').replace(': (Node | string)[]', '').replace('(e: Error)', '(e)').replace('pending[0]!', 'pending[0]').replace(' as string | undefined', '')
const makeRender = new Function('env',
  'let { browser, load, isUnlocked, touch, mainScreen, approvalScreen, unlockScreen, app, invalidateUnlockView, watchedAddresses, exported } = env; ' +
  "let renderId = 0, viewClosed = false, currentWindowId, seed = '', error = '', jevKey, watching, waiting; " +
  "const TAMPERED = 'tampered'; " + renderSource +
  '; return { render, close() { viewClosed = true; renderId++ } }')
const loads = [], settings = [], drawn = []
let unlocked = false, invalidations = 0
const env = {
  browser: {
    windows: { getCurrent: async () => ({ id: 1 }) },
    runtime: { sendMessage: async () => [] },
    storage: { local: { get: () => { const gate = deferred(); settings.push(gate); return gate.promise } } },
  },
  load: () => { const gate = deferred(); loads.push(gate); return gate.promise },
  isUnlocked: async () => unlocked,
  touch() {},
  watchedAddresses: async () => [], exported: async () => [],
  invalidateUnlockView() { invalidations++ },
  mainScreen: () => ['home'], approvalScreen: () => ['approval'], unlockScreen: () => ['locked'],
  app: { replaceChildren: (...nodes) => drawn.push(nodes) },
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
let renderer = makeRender(env)
let old = renderer.render()
await tick()
let latest = renderer.render()
await tick()
loads[1].resolve({ vault: true })
await latest
loads[0].resolve({ vault: true })
await old
assert.deepEqual(drawn, [['locked']], 'older render cannot overwrite the current screen')

unlocked = true
old = renderer.render()
await tick()
loads[2].resolve({ vault: true })
await tick()
assert.equal(settings.length, 1)
unlocked = false
latest = renderer.render() // a lock during the unlocked screen read
await tick()
loads[3].resolve({ vault: true })
await latest
settings[0].resolve({})
await old
assert.deepEqual(drawn, [['locked'], ['locked']], 'late unlock rendering cannot revive a locked view')

let connected = true
old = renderer.render(() => connected)
await tick()
connected = false
loads[4].resolve({ vault: true })
await old
assert.equal(drawn.length, 2, 'detached completion cannot redraw')
old = renderer.render()
await tick()
renderer.close()
loads[5].resolve({ vault: true })
await old
assert.equal(drawn.length, 2, 'closed view cannot redraw')
assert.equal(invalidations, 0, 'locked redraws and stale renders preserve the unlock lifecycle')
renderer = makeRender(env)
unlocked = true
old = renderer.render()
await tick()
loads[6].resolve({ vault: true })
await tick()
settings[1].resolve({})
await old
assert.equal(invalidations, 1, 'navigation out of the locked screen invalidates feedback')

// Exercise the production storage-event routing: mined preserves feedback; key changes invalidate it.
const listenerSource = popup.slice(popup.indexOf('browser.storage.onChanged.addListener'), popup.indexOf('// ponytail: MV3'))
let listener, storageRenders = 0
new Function('browser', 'invalidateUnlockView', 'clearSetup', 'document', 'render',
  'let cached; ' + listenerSource)(
  { storage: { onChanged: { addListener(fn) { listener = fn } } } },
  () => invalidations++, () => {}, { querySelectorAll: () => [] }, () => storageRenders++)
listener({ mined: { newValue: 1 } }, 'session')
assert.equal(invalidations, 1)
listener({ key: { newValue: 'synthetic' } }, 'session')
listener({ key: {} }, 'session')
assert.equal(invalidations, 3)
assert.equal(storageRenders, 3)
console.log('unlock feedback, paint boundary, single-flight retries/redraws and detached lifecycle ok')

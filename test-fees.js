import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, multicall3Abi, parseAbiParameters } from 'viem'
import { formatFeeUsd, freshQuote, nativeUsd, validateQuote } from './lib/fee-usd.ts'

for (const [fee, expected] of [[0n, '$0'], [1n, '<$0.001'], [999999n, '<$0.001'], [1000000n, '$0.001'], [1000500n, '$0.001001'], [12345000n, '$0.01235'], [123450000n, '$0.1235'], [999999999n, '$1'], [1000000000n, '$1.00'], [1234567890000n, '$1,234.57']])
  assert.equal(formatFeeUsd(fee, 9, 1n, 0), expected)
assert.equal(formatFeeUsd(1000n, 6, 10n ** 18n, 18), '$0.001')
assert.equal(formatFeeUsd(10n ** 36n, 18, 2000n * 10n ** 8n, 8), '$2,000,000,000,000,000,000,000.00')
assert.equal(formatFeeUsd(1n, 18, 1n, 18), '<$0.001')
for (const args of [[-1n,18,1n,8], [1n,18,0n,8], [1n,18,-1n,8], [1n,-1,1n,8], [1n,18,1n,1.5]]) assert.throws(() => formatFeeUsd(...args))

const now = 1_800_000_000_000, seconds = BigInt(now / 1000)
const round = [3n, 2000_00000000n, seconds - 10n, seconds - 10n, 3n]
const up = [2n, 0n, seconds - 7200n, seconds - 7200n, 2n]
const validate = (r = round, d = 8, s = up) => validateQuote(d, r, 8, 1200, now, s)
assert.ok(validate())
assert.ok(validateQuote(6, round, 6, 1200, now))
assert.equal(validate(undefined, 18), undefined)
for (const [index, value] of [[0,0n],[1,0n],[1,-1n],[2,0n],[2,seconds+1n],[3,0n],[3,seconds+1n],[4,2n]]) {
  const r = [...round]; r[index] = value; assert.equal(validate(r), undefined)
}
assert.equal(validate([3n,1n,seconds-1200n,seconds-1200n,3n]), undefined)
assert.ok(validate([3n,1n,seconds-1199n,seconds-1199n,3n]))
for (const s of [[2n,1n,seconds-7200n,seconds-7200n,2n], [2n,0n,0n,0n,2n], [2n,0n,seconds-3600n,seconds-3600n,2n], [2n,0n,seconds+1n,seconds+1n,2n], [2n,0n,seconds-7200n,seconds-7200n,1n]]) assert.equal(validate(round,8,s), undefined)
const q = validate()
assert.equal(freshQuote(q, now + 29999), true)
assert.equal(freshQuote(q, now + 30000), false)
assert.equal(freshQuote(q, now - 1), false)
assert.equal(validate([3n,1n,seconds-1199n,seconds-1199n,3n]).expiresAt, now + 1000)

const originalNow = Date.now
Date.now = () => now
// Retry pauses (1 s, 2 s) run instantly here; the 5 s timeout and DOM expiry timers keep their own handling below.
const realSetTimeout = globalThis.setTimeout
const fastRetries = (fn,ms,...args) => realSetTimeout(fn, ms === 1000 || ms === 2000 ? 1 : ms, ...args)
globalThis.setTimeout = fastRetries
let requests = [], targets = [], scenario = {}
const roundAbi = parseAbiParameters('uint80, int256, uint256, uint256, uint80')
const response = (id, result) => new Response(JSON.stringify({ jsonrpc:'2.0', id, result }))
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  requests.push({url, body, init})
  if (scenario.offline) throw new Error('offline')
  if (scenario.limited && scenario.limited--) return new Response(JSON.stringify({ jsonrpc:'2.0', id: body.id, error: { code: -32016, message: 'over rate limit' } }))
  if (body.method === 'eth_chainId') return response(body.id, '0x' + (scenario.chain ?? 1).toString(16))
  assert.equal(body.method, 'eth_call')
  assert.equal(body.params[0].from, undefined)
  assert.equal(init.redirect, 'error')
  assert.equal(init.credentials, 'omit')
  if (scenario.malformed) return response(body.id, '0x12')
  // All oracle reads arrive as one Multicall3 aggregate3 eth_call.
  assert.equal(body.params[0].to.toLowerCase(), '0xca11bde05977b3631167028862be2a173976ca11')
  const { args: [calls] } = decodeFunctionData({ abi: multicall3Abi, data: body.params[0].data })
  return response(body.id, encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: calls.map(({ target, callData }) => {
    targets.push(target.toLowerCase())
    if (callData === '0x313ce567') return { success: true, returnData: encodeAbiParameters(parseAbiParameters('uint8'), [scenario.decimals ?? 8]) }
    assert.equal(callData, '0xfeaf968c')
    const seq = ['0xbcf85224fc0756b9fa45aa7892530b47e10b6433','0xfdb631f5ee196f0ed6faa767959853a9f217697d','0x371ead81c9102c9bf4874a9075ffff170f2ee389'].includes(target.toLowerCase())
    return { success: true, returnData: encodeAbiParameters(roundAbi, seq ? scenario.up ?? up : scenario.round ?? round) }
  }) }))
}
let n = 0
const network = (id = 1, symbol = 'ETH') => ({ id, symbol, name:'test', rpc:'https://rpc.test/' + ++n })
const eth = network()
assert.ok(await nativeUsd(eth))
const count = requests.length
await nativeUsd(eth)
assert.equal(requests.length, count)
for (const [id,symbol,address] of [[8453,'ETH','0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70'],[42161,'ETH','0x639fe6ab55c921f74e7fac1ee960c0b6293ba612'],[10,'ETH','0x13e3ee699d1909e989722e753853ae30b17e08c5'],[137,'POL','0xab594600376ec9fd91f8e885dadf0ce036862de0'],[56,'BNB','0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee'],[43114,'AVAX','0x0a77230d17318075983913bc2145db16c7366156']]) {
  scenario = {chain:id}; targets = []
  assert.ok(await nativeUsd(network(id,symbol)))
  assert.ok(targets.includes(address))
}
requests = []
for (const net of [network(100,'xDAI'),network(999,'ETH'),network(56,'ETH'),network(1,'FOO'),network(137,'MATIC')]) assert.equal(await nativeUsd(net), undefined)
assert.equal(requests.length, 0)
for (const failure of [{chain:56},{decimals:18},{malformed:true},{offline:true},{round:[3n,0n,seconds-1n,seconds-1n,3n]}, {round:[3n,1n,seconds-3600n,seconds-3600n,3n]}]) {
  scenario = failure; assert.equal(await nativeUsd(network()), undefined)
}
// A review screen's burst trips public RPC rate limits (mainnet.base.org: -32016): retried, not "USD unavailable".
scenario = {chain:8453, limited:4}
assert.ok(await nativeUsd(network(8453)))
scenario = {chain:8453, up:[2n,1n,seconds-7200n,seconds-7200n,2n]}
assert.equal(await nativeUsd(network(8453)), undefined)
scenario = {}
Date.now = () => now + 30001
requests = []
assert.ok(await nativeUsd(eth))
assert.equal(requests.length,2) // eth_chainId and one eth_call
Date.now = () => now

// A hung provider is bounded, including in-flight cache sharing. Late results cannot revive an expired entry.
const workingFetch = globalThis.fetch
let resolveHung
const hung = new Promise((r) => { resolveHung = r })
globalThis.fetch = async (...args) => { await hung; return workingFetch(...args) }
globalThis.setTimeout = (fn,ms,...args) => fastRetries(fn, ms === 5000 ? 5 : ms, ...args)
const timedNetwork = network()
assert.deepEqual(await Promise.all([nativeUsd(timedNetwork),nativeUsd(timedNetwork)]), [undefined,undefined])
resolveHung()
await new Promise((r) => realSetTimeout(r,10))
assert.equal(await nativeUsd(timedNetwork),undefined)
globalThis.fetch = workingFetch
globalThis.setTimeout = fastRetries

// An early RPC error must abort siblings already waiting for response bodies, not just return unavailable.
const stalledBodies = []
let releaseRpcError
const rpcErrorGate = new Promise((resolve) => { releaseRpcError = resolve })
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (body.method === 'eth_chainId') {
    await rpcErrorGate // Let the oracle multicall's response body begin reading first.
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'RPC failed' } }))
  }
  const stalled = { signal: init.signal, reading: false, cancelled: false }
  stalledBodies.push(stalled)
  return new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener('abort', () => {
        stalled.cancelled = true
        controller.error(init.signal.reason)
      }, { once: true })
    },
    pull() {
      stalled.reading = true
      if (stalledBodies.length === 1 && stalledBodies[0].reading) releaseRpcError()
      return new Promise(() => {}) // Headers arrived, but the provider never sends the body.
    },
  }, { highWaterMark: 0 }))
}
try {
  assert.equal(await nativeUsd(network(8453)), undefined)
  assert.equal(stalledBodies.length, 3, 'three attempts: the first and two retries')
  assert.ok(stalledBodies[0].reading, 'the sibling body read started before the RPC error')
  assert.ok(stalledBodies.every((s) => s.signal.aborted && s.cancelled), 'each failed attempt cancels its stalled sibling body')
} finally {
  globalThis.fetch = workingFetch
}

// Exercise the actual fee DOM helper with delayed network/account/transaction review replacements.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/fee-usd') specifier = new URL('./lib/fee-usd.ts', import.meta.url).href
  return next(specifier, context)
} })
class Element {
  isConnected = true
  children = []
  append(...nodes) { this.children.push(...nodes) }
  set textContent(value) { this.children = [value] }
  get textContent() { return this.children.map((n) => typeof n === 'string' ? n : n.textContent).join('') }
}
// Capture expiry timers instead of leaving the test process open for 30 seconds.
const expiries = []
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms > 5000) { expiries.push(fn); return 0 }
  return realSetTimeout(fn,ms,...args)
}
const events = new Map()
globalThis.document = {createElement: () => new Element(), addEventListener: (name,fn) => events.set(name,fn), removeEventListener: (name) => events.delete(name)}
globalThis.addEventListener = document.addEventListener
globalThis.removeEventListener = document.removeEventListener
const { feeValue } = await import('./entrypoints/popup/fee.ts')
const until = async (check) => { for(let i=0;i<100 && !check();i++) await new Promise((r) => setTimeout(r,1)); assert.ok(check()) }
const originalFetch = globalThis.fetch
let unblock
const gate = new Promise((r) => {unblock=r})
globalThis.fetch = async (...args) => { await gate; return originalFetch(...args) }
const mutable = network()
const snapshotted = nativeUsd(mutable)
mutable.id = 56
mutable.symbol = 'BNB'
const stale = feeValue(network(), 123n)
assert.match(stale.textContent,/USD loading/)
stale.isConnected = false
const current = feeValue(network(100,'xDAI'), '0.123')
await until(() => current.textContent.includes('unavailable'))
unblock()
assert.ok(await snapshotted)
await new Promise((r) => setTimeout(r,10))
assert.match(stale.textContent,/USD loading/)
assert.equal(current.textContent,'0.123 xDAI (USD unavailable)')
globalThis.fetch = originalFetch
const fee = 500000000000n // includes all native components; UI does not recompute gas
const shown = feeValue(network(),fee)
await until(() => shown.textContent.includes('≈'))
assert.equal(shown.textContent,'0.0000005 ETH (≈ $0.001)')
assert.equal(fee,500000000000n)
// An expired quote never stays on screen as current: it is re-read while the review stays open.
Date.now = () => now + 30000
const requestsBefore = requests.length
events.get('focus')()
assert.match(shown.textContent,/USD loading/)
await until(() => shown.textContent.includes('≈'))
assert.ok(requests.length > requestsBefore)
// Same network, different account/transaction reviews: only their own exact fee is converted.
Date.now = () => now
const next = feeValue(network(), '0.000001')
await until(() => next.textContent.includes('≈'))
assert.equal(next.textContent,'0.000001 ETH (≈ $0.002)')
assert.match(shown.textContent,/≈/)
Date.now = () => now + 60000
next.isConnected = false
expiries.forEach((expire) => expire())
assert.match(next.textContent,/≈/) // detached: no re-read, listeners gone
assert.ok(!events.has('focus') && !events.has('visibilitychange'))
Date.now = originalNow
globalThis.setTimeout = realSetTimeout

// All review surfaces use the same conversion; transaction preparation/signing remains untouched.
const popup = await readFile(new URL('./entrypoints/popup/main.ts',import.meta.url),'utf8')
assert.equal(popup.split("['Estimated max fee', feeValue(").length - 1,3)
assert.ok(!popup.includes("['Max fee'"))
assert.ok((await readFile(new URL('./entrypoints/android/main.ts',import.meta.url),'utf8')).includes('popup/main'))
console.log('fee formatter, oracle validation, RPC privacy, network cache and UI races ok')

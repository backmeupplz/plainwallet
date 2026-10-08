import { encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, isAddress, parseEther, parseTransaction, serializeTransaction, zeroAddress } from 'viem'
import { balances, broadcast, mined, prepare, send, simulate, tokenInfo, unsigned, type Simulation } from '@/lib/chain'
import { describeCall, foreignSignIn, parseAddress, parseAmount, signedView, spenderOf } from '@/lib/describe'
import { analyze, type Subject, type Verdict } from '@/lib/jev'
import { lookup, type Level, type Lookup, type Party } from '@/lib/lookup'
import { megapotSettings } from '@/lib/megapot'
import { checkResponse, parseRequest, requestText } from '@/lib/offline'
import { accountGroups, addDerivedAccount, addWallet, autolock, exportAccount, exported, isUnlocked, keepExported, load, lock, removeAccount, removeSeedGroup, repair, save, setAutolock, signer, TAMPERED, touch, unlock, watchedAddresses, type Network, type State, type Token } from '@/lib/store'
import { checkSecret, newMnemonic, parseSecret } from '@/lib/wallet'
import type { Pending } from '../background'
import { feeValue } from './fee'
import { invalidateUnlockView, unlockForm } from './unlock'

const app = document.getElementById('app')!
let renderId = 0
let viewClosed = false
addEventListener('pagehide', () => { viewClosed = true; renderId++ })
addEventListener('pageshow', () => { viewClosed = false })
let error = ''
let seed = '' // freshly generated phrase, shown once and only saved after the user confirms
let pendingPassword: string | undefined // vault password entered alongside it (first wallet only)
let walletMode: 'generate' | 'import' | 'watch' | undefined
const clearSetup = () => { seed = ''; pendingPassword = undefined; walletMode = undefined }
const view = new URLSearchParams(location.search).get('view')
document.body.classList.toggle('sidebar', view === 'sidebar')
let currentWindowId: number | undefined
// WXT's default browser types cover Chrome; Firefox exposes its native sidebar under this name.
const sidebar = (browser as typeof browser & { sidebarAction?: { open(): Promise<void> } }).sidebarAction
// The toolbar popup (no view param) has done its job once the wallet opens elsewhere; a sidebar or tab stays.
const closePopup = () => { if (!view) window.close() }
const openTab = async (url: string) => {
  await browser.tabs.create({ url })
  closePopup()
}
// Transaction history lives on DeBank: the wallet keeps none of its own.
const openDebank = (address: string) => openTab(`https://debank.com/profile/${address}/history`)
// Fetched once per network + account + token list, and again after one of our transactions is mined (see
// lib/chain.ts): redraws for anything else reuse them.
let cached: { key: string; values: Promise<(bigint | undefined)[]> } | undefined
// Unsigned, so outside the MAC: at worst a tampered key costs a Jev opinion, never a signature. Empty = no Jev at all.
let jevKey = ''
// Watch-only addresses (the vault's say, read on each unlocked redraw) and the transactions exported from them.
let watching = new Set<string>()
let waiting: string[] = []
// What the wallet finds out before asking Jev: a simulation (always) and, with a key, public lookups.
type Checks = { simulation?: Promise<Simulation>; lookup?: Promise<Lookup> }
const analyses = new Map<string, Checks & { verdict?: Promise<Verdict> }>() // per approval id: redraws don't ask (and bill) again

// Children are appended as text nodes, so dapp-supplied strings can never become markup.
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]) {
  const el = Object.assign(document.createElement(tag), props)
  el.append(...children)
  return el
}
const field = (label: string, props: Record<string, unknown> = {}) => {
  const input = h('input', props)
  return { input, el: h('label', {}, label, input) }
}
/** Runs a UI action, surfaces its error, redraws. */
const act = (fn: () => unknown) => async () => {
  error = ''
  try {
    await fn()
  } catch (e) {
    error = (e as Error).message
  }
  await render()
}
/** Filled in by the apps (entrypoints/android): the phones' favorite sites above the balances, fingerprint unlock, and
 * no auto-lock switch (they lock themselves when you leave them); the Mac app's own note under that switch; no Megapot
 * on iOS, where the App Store doesn't allow lotteries.
 * `files`: watch-only requests and signatures go by file too, not only by copy and paste; the apps only copy. */
export const extras = { home: (): Node[] => [], unlock: (): Node[] => [], settings: (): Node[] => [], autolockSetting: true, megapot: true,
  autolockOff: 'When off, the wallet stays unlocked until you lock it or restart the browser.', files: !import.meta.env?.SAFARI }
const icons = {
  lock: 'M7 11V7a5 5 0 0 1 10 0v4 M5 11h14v10H5Z M12 15v2',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M9 3l-1 3-3 1-2 3 2 2-1 3 2 3 3-1 2 3h3l1-3 3-1 2-3-2-2 1-3-2-3-3 1-2-3Z',
  edit: 'M15 5l4 4 M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z',
  copy: 'M9 9h12v12H9Z M15 9V3H3v12h6',
  check: 'M5 12l4 4L19 6',
  history: 'M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
}
function iconButton(label: string, path: string, open: () => unknown) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value)
  const shape = document.createElementNS(svg.namespaceURI, 'path')
  shape.setAttribute('d', path)
  svg.append(shape)
  return h('button', { className: 'icon', title: label, ariaLabel: label, onclick: async () => {
    try { await open() } catch (e) { error = (e as Error).message; await render() }
  } }, svg)
}
const header = (...actions: Node[]) => h('header', {},
  h('img', { src: '/icon/32.png', width: 22, height: 22, alt: '' }), h('h1', {}, 'Plain Wallet'),
  ...(view !== 'sidebar' && (sidebar || browser.sidePanel?.open) ? [iconButton('Open in sidebar', 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z M9 3v18', async () => {
    // Call directly from the click handler: opening a sidebar requires a user gesture.
    await (sidebar ? sidebar.open() : browser.sidePanel.open({ windowId: currentWindowId! }))
    closePopup()
  })] : []),
  ...(view !== 'tab' ? [iconButton('Open in tab', 'M14 3h7v7 M21 3l-10 10 M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6',
    () => openTab(browser.runtime.getURL('/popup.html') + '?view=tab'))] : []),
  ...actions)
/** Copies and says so on the button itself. */
const copy = (text: string) => (e: Event) => {
  const button = e.currentTarget as HTMLElement
  const label = button.textContent
  navigator.clipboard.writeText(text)
  button.textContent = 'Copied'
  setTimeout(() => (button.textContent = label), 1200)
}
const saveFile = (text: string, name: string) => {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
}
/** Fills `box` from a file you pick. */
function loadButton(box: HTMLTextAreaElement) {
  const input = h('input', { type: 'file', accept: '.json,.txt,text/plain,application/json', hidden: true })
  input.onchange = async () => {
    const file = input.files?.[0]
    input.value = ''
    if (file) box.value = file.size > 1_000_000 ? '' : (await file.text()).trim()
  }
  return h('button', { onclick: () => input.click() }, 'Load from file', input)
}
// Consent buttons (Approve, Send) only come on once taps have stopped for 800 ms: a window that pops up under the
// cursor, the second half of a double-click, or a site getting you to tap again and again where the button is about to
// appear must not count as a click on them. aria-disabled rather than disabled, so taps on the button itself count as
// taps too. The Android app also re-arms them whenever it brings the wallet up.
let quiet: ReturnType<typeof setTimeout> | undefined
export function rearm() {
  const buttons = document.querySelectorAll<HTMLButtonElement>('button[data-armed]')
  buttons.forEach((button) => (button.ariaDisabled = 'true'))
  clearTimeout(quiet)
  quiet = setTimeout(() => buttons.forEach((button) => (button.ariaDisabled = 'false')), 800)
}
addEventListener('pointerdown', () => { if (document.querySelector('button[data-armed][aria-disabled="true"]')) rearm() }, true)
const armed = (button: HTMLButtonElement) => {
  const click = button.onclick
  button.onclick = (e) => { if (button.ariaDisabled !== 'true') click?.call(button, e) }
  button.dataset.armed = ''
  button.ariaDisabled = 'true'
  queueMicrotask(rearm)
  return button
}

/** A seed phrase / private key box that lowercases what you type and says, as you go, what's missing or wrong. */
function secretBox(changed: () => void = () => {}) {
  // spellcheck off: browsers' cloud ("enhanced") spellcheck would otherwise upload whatever is typed here
  const input = h('textarea', { rows: 3, placeholder: 'Seed phrase or private key', spellcheck: false, autocomplete: 'off', autocapitalize: 'off' })
  input.setAttribute('autocorrect', 'off') // not a property: phone keyboards read the attribute
  const note = h('p', { ariaLive: 'polite' })
  let ok = false
  input.oninput = () => {
    const { selectionStart, selectionEnd } = input
    if (input.value !== input.value.toLowerCase()) {
      input.value = input.value.toLowerCase()
      input.setSelectionRange(selectionStart, selectionEnd)
    }
    const check = checkSecret(input.value)
    ok = check.ok
    note.textContent = check.message
    note.className = check.ok ? 'ok' : check.bad ? 'bad' : ''
    changed()
  }
  return { input, note, ok: () => ok }
}

function walletForm(first: boolean) {
  if (!walletMode) return [
    h('p', {}, first ? 'How would you like to get started?' : 'How would you like to add a wallet?'),
    h('button', { className: 'primary', onclick: act(() => (walletMode = 'generate')) }, 'Generate new wallet'),
    h('button', { onclick: act(() => (walletMode = 'import')) }, 'Enter seed phrase or private key'),
    h('button', { onclick: act(() => (walletMode = 'watch')) }, 'Watch an address, sign on another device'),
  ]
  const importing = walletMode === 'import', watchOnly = walletMode === 'watch'
  const secret = secretBox(() => update())
  const address = field('Address', { placeholder: '0x…', spellcheck: false, autocomplete: 'off' })
  const pw = field('Password (min 12 characters)', { type: 'password' })
  const pw2 = field('Repeat password', { type: 'password' })
  // Checked as you type; the button waits until everything is right.
  const pwNote = h('p', { ariaLive: 'polite' })
  const pwOk = () => pw.input.value.length >= 12 && pw.input.value === pw2.input.value
  const update = () => {
    const [a, b] = [pw.input.value, pw2.input.value]
    const [text, className] = a.length < 12 ? [a ? `${12 - a.length} more character${a.length === 11 ? '' : 's'}` : '', '']
      : !b ? ['', ''] : a === b ? ['Passwords match', 'ok'] : a.startsWith(b) ? ['', ''] : ['Passwords don’t match', 'bad']
    Object.assign(pwNote, { textContent: text, className })
    submit.disabled = (importing && !secret.ok()) || (first && !pwOk())
  }
  pw.input.oninput = pw2.input.oninput = update
  const password = () => {
    if (!first) return undefined
    if (pw.input.value.length < 12) throw new Error('Password must be at least 12 characters')
    if (pw.input.value !== pw2.input.value) throw new Error('Passwords do not match')
    return pw.input.value
  }
  const generate = act(() => {
    pendingPassword = password()
    seed = newMnemonic()
  })
  const submit = h('button', { className: 'primary', onclick: importing || watchOnly ? act(async () => {
    await addWallet(watchOnly ? { watch: parseAddress(address.input.value) } : parseSecret(secret.input.value), password())
    clearSetup()
  }) : generate }, importing ? 'Import wallet' : watchOnly ? 'Watch address' : 'Generate seed phrase')
  update()
  return [
    h('button', { className: 'quiet', onclick: act(clearSetup) }, 'Back'),
    h('h2', {}, importing ? 'Import your wallet' : watchOnly ? 'Watch an address' : 'Create a new wallet'),
    ...(importing ? [h('label', {}, 'Seed phrase or private key', secret.input), secret.note]
      : watchOnly ? [h('p', {}, watchNote), address.el]
      : [h('p', {}, 'We’ll generate a new seed phrase for you to back up.')]),
    ...(first ? [h('p', {}, 'Choose a password to protect your wallets on this device.'), pw.el, pw2.el, pwNote] : []),
    submit,
  ]
}
const watchNote = 'Its key stays on another device, say an offline computer with Plain Wallet. Here you see its balances, use sites and prepare transactions; you take each one to that device to sign, and bring the signature back.'
const seedScreen = () => [
  h('h1', {}, 'Your seed phrase'),
  // No copy button: the system clipboard (and clipboard history/sync) is no place for a seed.
  h('p', {}, 'Write these 12 words down on paper, in order, and keep them somewhere private. You can reveal them again in Settings with your password.'),
  h('ol', {}, ...seed.split(' ').map((word) => h('li', {}, word))),
  h('button', { className: 'primary', onclick: act(async () => (await addWallet(seed, pendingPassword), clearSetup())) }, 'I saved it, create wallet'),
  h('button', { onclick: act(clearSetup) }, 'Cancel'),
]

/** `waiting`: the site whose request opened this window, so it's clear why the password is needed. */
function unlockScreen(waiting?: Pending) {
  const { section, form } = unlockForm(unlock, async () => { error = ''; await render(() => form.isConnected) })
  return [header(), ...(waiting ? [h('p', {}, `${waiting.origin} is waiting for your approval. Unlock to review it.`)] : []),
    section, ...extras.unlock(),
    h('button', { className: 'quiet', onclick: resetDialog }, 'Forgot password?')]
}

function resetDialog() {
  const { content, run, dialog } = modal('Reset wallet?')
  const acknowledgment = h('input', { type: 'checkbox' })
  const confirmation = field('Type RESET to confirm', { autocomplete: 'off', spellcheck: false })
  const warning = h('p', { id: 'reset-warning' }, "Your password can never be recovered. Your best option is to remember it. If you can't, you can reset the wallet.")
  const remove = h('button', { className: 'danger', disabled: true, onclick: run(async () => {
    const result = await browser.runtime.sendMessage({ type: 'reset' })
    if (result.error) throw new Error(result.error)
    clearSetup()
    error = ''
  }) }, 'Permanently reset wallet')
  acknowledgment.onchange = confirmation.input.oninput = () => (remove.disabled = !acknowledgment.checked || confirmation.input.value !== 'RESET')
  dialog.setAttribute('aria-describedby', warning.id)
  content.append(warning,
    h('p', { className: 'stamp' }, 'Resetting permanently deletes all wallets, seed phrases and private keys stored in Plain Wallet on this device, as well as connected sites and network settings. This cannot be undone.'),
    h('p', {}, 'You can only restore your wallets with seed phrases or private keys you backed up elsewhere.'),
    h('label', { className: 'acknowledgment' }, acknowledgment, 'I understand that all stored wallets will be permanently deleted and may be lost forever without a backup.'),
    confirmation.el, remove)
}

type Row = [label: string, value: string | Node]
const rowList = (rows: Row[]) => h('dl', {}, ...rows.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]))
// Nested data as dotted rows. The prefix keeps dapp-chosen field names from posing as the wallet's own rows.
const flatten = (value: unknown, path: string): Row[] =>
  value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => flatten(v, `${path}.${k}`)) : [[path, String(value)]]
const percent = (n: number) => `${Math.round(n * 100)}%`
// How likely the bad thing is, as the color of its number. Jev puts ordinary requests from sites it doesn't know at
// 15-30%, so only above that is it worth a second look; red once it's more likely than not.
const WARN = 0.3
const risk = (label: string, p: number) => h('span', { className: p >= 0.5 ? 'bad' : p >= WARN ? 'warn' : 'ok' }, `${label} ${percent(p)}`)

type Fold = { summary: (Node | string)[]; rows: [string, Node | string][]; note?: string }
/** One line that folds out into rows: filled in when `content` arrives, dropped if there turns out to be nothing to say. */
function foldLine(label: string, content: Promise<Fold | undefined>) {
  const result = h('span', { className: 'skeleton' })
  const more = h('div', { className: 'dialog-content' })
  const line = h('details', { className: 'fold', ariaBusy: 'true' }, h('summary', {}, `${label}: `, result), more)
  void content.then((c) => {
    if (!c) return line.remove()
    result.replaceWith(h('span', {}, ...c.summary))
    if (c.rows.length) more.append(h('dl', {}, ...c.rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])))
    if (c.note) more.append(h('p', {}, c.note))
    line.ariaBusy = 'false'
  }, () => line.remove())
  return line
}
const simulationFold = ({ summary, details, failed }: Simulation): Fold => ({
  summary: [h('span', { className: failed ? 'bad' : '' }, summary)], rows: details,
  note: 'Run on this network’s RPC as of the latest block, fee not included. The chain can change before yours is included.',
})
const partyRow = (label: string, p: Party): [string, Node] => [label, h('span', {}, h('span', { className: p.level }, `${p.name}: ${p.about}`), h('br'), p.address)]
function lookupFold({ contract, spender, call }: Lookup): Fold | undefined {
  const main = contract ?? spender
  if (!main && !call) return
  const worst = [contract, spender].find((p) => p?.level === 'bad') ?? [contract, spender].find((p) => p?.level === 'warn')
  return {
    summary: [main?.name ?? 'not found on Blockscout', ...(worst ? [' · ', h('span', { className: worst.level }, worst === spender ? `spender: ${spender!.name}` : 'check details')] : [])],
    rows: [...(contract ? [partyRow('Contract', contract)] : []), ...(call ? [['Function', call] as [string, string]] : []), ...(spender ? [partyRow('Spender', spender)] : [])],
    note: 'From Blockscout, which knows contracts verified on it or on Sourcify; ones verified only on Etherscan show as unverified.',
  }
}
function jevFold(v: Verdict, site: boolean): Fold {
  const others = v.ranked.slice(1, 4).filter(([, p]) => p >= 0.01).map(([k, p]) => `${k} ${percent(p)}`).join(', ')
  // The summary names only the risks worth a second look; the green numbers stay in the details.
  const risks: [string, number][] = [['scam', v.scam], ...(site ? [['fake site', v.lookalike!] as [string, number]] : [])]
  const flagged = risks.filter(([, p]) => p >= WARN).flatMap(([label, p]) => [' · ', risk(label, p)])
  return {
    summary: [v.action, ...(flagged.length ? flagged : [' · ', h('span', { className: 'ok' }, 'probably ok')])],
    rows: [['Action', `${v.action} (${percent(v.ranked[0]?.[1] ?? 0)})`], ...(others ? [['Or maybe', others] as [string, string]] : []),
      ['Scam risk', risk('', v.scam)], ...(site ? [['Fake site', risk('', v.lookalike!)] as [string, Node]] : [])],
    note: 'Jev (typesafe.ai) only sees the simulation, lookups and request details, and a site can word things to sway it.',
  }
}

/** The simulation (on the network's own RPC, so always) and, with a Jev key, public lookups. */
function txChecks(network: Network, from: `0x${string}`, tx: { to?: `0x${string}` | null; data?: `0x${string}`; value?: bigint }): Checks {
  if (!tx.to) return {}
  const call = tx.data && tx.data !== '0x' ? tx.data : undefined
  return {
    simulation: simulate(network, from, { to: tx.to, data: call, value: tx.value }),
    lookup: call && jevKey ? lookup(network.id, { contract: tx.to, spender: spenderOf(call), data: call }) : undefined,
  }
}
// A slow RPC (viem retries rate limits) or lookup gets 15 seconds, then Jev goes ahead without it.
const timed = <T>(p?: Promise<T>) => p && Promise.race([p.catch(() => undefined), new Promise<undefined>((done) => setTimeout(done, 15_000))])
/** Simulation, lookups and Jev, one foldable line each, filled in as they arrive. Nothing here is awaited, and anything
 * that goes wrong only costs these lines: the approval never waits for or depends on them. */
function secondOpinion(subject: Subject, fields: Record<string, string>, checks: () => Checks, id?: string) {
  let run = id ? analyses.get(id) : undefined
  if (!run) {
    let started: Checks
    try { started = checks() } catch { started = {} }
    const key = jevKey
    const verdict = key ? Promise.all([timed(started.simulation), timed(started.lookup)]).then(([simulated, found]) => analyze(key, subject, {
      ...fields,
      ...(simulated?.text && { simulation: simulated.text }),
      ...(found?.contract && { contract: `${found.contract.name}: ${found.contract.about}` }),
      ...(found?.call && { function: found.call }),
      ...(found?.spender && { spender: `${found.spender.name}: ${found.spender.about}` }),
    })) : undefined
    run = { ...started, verdict }
    if (id) analyses.set(id, run)
  }
  const { simulation, lookup: found, verdict } = run
  return [
    ...(simulation ? [foldLine('Simulation', simulation.then(simulationFold, () => simulationFold({ summary: 'unavailable', details: [] })))] : []),
    ...(found ? [foldLine('Contract', found.then(lookupFold))] : []),
    ...(verdict ? [foldLine('Jev', verdict.then((v) => jevFold(v, !!fields.site),
      (e: Error): Fold => ({ summary: [h('span', { className: 'warn' }, 'couldn’t check')], rows: [['Error', e.message]] })))] : []),
  ]
}
/** The second opinion for whatever a site asks to sign. */
function sitePanel(p: Pending) {
  const d = p.detail
  if (p.method === 'plainwallet_megapot') return secondOpinion('transaction', {
    network: p.network.name, to: d.to, value: `0 ${p.network.symbol}`, call: p.summary!,
  }, () => txChecks(p.network, p.account as `0x${string}`, { to: d.to, data: d.data }), p.id)
  const fields = { site: new URL(p.origin).hostname, ...(p.title && { page_title: p.title }), network: p.network.name }
  switch (p.method) {
    case 'eth_sendTransaction':
      return secondOpinion('transaction', {
        ...fields, to: d.to ?? '(new contract)', value: `${d.value} ${p.network.symbol}`,
        call: d.data === '0x' ? 'none' : d.to ? p.summary ?? 'contract call, not decoded' : 'deploys a new contract',
      }, () => txChecks(p.network, p.account as `0x${string}`, { to: d.to, data: d.data, value: parseEther(d.value) }), p.id)
    case 'personal_sign':
      return secondOpinion('signature', { ...fields, message: describe(p).text!.slice(0, 4000) }, () => ({}), p.id)
    case 'eth_signTypedData_v4': {
      const contract = d.domain?.verifyingContract, spender = d.message?.spender ?? d.message?.operator
      const address = (v: unknown) => typeof v === 'string' && isAddress(v) ? v : undefined
      return secondOpinion('signature', {
        ...fields, type: d.primaryType, domain: JSON.stringify(d.domain).slice(0, 1000), message: JSON.stringify(d.message).slice(0, 4000),
        ...(p.summary && { wallet_warning: p.summary }),
      }, () => ({ lookup: jevKey && (address(contract) || address(spender))
        ? lookup(Number(d.domain.chainId ?? p.network.id), { contract: address(contract), spender: address(spender) }) : undefined }), p.id)
    }
  }
  return []
}

/** What the slip says: labelled rows for structured requests, free text for messages. */
function describe(p: Pending): { title: string; rows?: Row[]; text?: string } {
  const d = p.detail
  try {
    switch (p.method) {
      case 'eth_requestAccounts':
        return { title: 'Connect this site?', text: 'It will see this account’s address and can ask you to sign. Your other accounts stay hidden from it.' }
      case 'wallet_switchEthereumChain':
        return { title: 'Switch network?', rows: [['Switch to', networkLabel(d)]] }
      case 'wallet_addEthereumChain':
        return {
          title: 'Add and switch to this network?',
          rows: [['Name', d.name], ['Chain ID', String(d.id)], ['Currency', d.symbol], ['RPC', d.rpc]],
          text: 'The site chose this RPC: it will see your address and activity on this network, and could hide or delay your transactions.',
        }
      case 'personal_sign':
        if (typeof d === 'string') return { title: 'Sign message', text: d }
        try {
          const bytes = Uint8Array.from(d.raw.slice(2).match(/../g) ?? [], (b: string) => parseInt(b, 16))
          return { title: 'Sign message', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
        } catch {
          return { title: 'Sign message (raw bytes)', text: d.raw }
        }
      case 'eth_signTypedData_v4': // already reduced to what is hashed
        return { title: `Sign typed data: ${d.primaryType}`, rows: [...flatten(d.domain, 'domain'), ...flatten(d.message, 'message')] }
      case 'plainwallet_megapot': // the wallet's own, see Settings
        return {
          title: d.step === 'approve' ? 'Approve USDC for Megapot tickets?' : 'Buy a Megapot ticket?',
          rows: [['To', d.to], ['Estimated max fee', feeValue(p.network, d.fee)], ['Data', d.data]],
        }
      case 'eth_sendTransaction':
        return {
          title: d.to ? 'Send transaction' : 'Deploy contract',
          rows: [['To', d.to ?? '(new contract)'], ['Value', `${d.value} ${p.network.symbol}`], ['Estimated max fee', feeValue(p.network, d.fee)], ['Data', d.data]],
        }
    }
  } catch {}
  return { title: p.method, text: JSON.stringify(d, null, 2) }
}

function approvalScreen(p: Pending, more: number) {
  const { title, rows = [], text } = describe(p)
  const offline = watching.has(p.account) ? p.offline : undefined
  const tx = p.method === 'eth_sendTransaction'
  const settle = (ok: boolean) => act(async () => {
    if (!ok && offline && tx) await keepExported(offline, false) // rejected: not waiting for it on the home screen either
    await browser.runtime.sendMessage({ type: 'settle', id: p.id, ok })
  })
  const own = p.method === 'plainwallet_megapot'
  const all: Row[] = [own ? ['Asked by', 'Plain Wallet: a Megapot ticket every few transactions (Settings)'] : ['From site', p.origin],
    ['Network', networkLabel(p.network)], ['Account', p.account], ...rows]
  let ok: HTMLButtonElement, elsewhere: Node[] = []
  if (!offline) ok = armed(h('button', { className: 'primary', onclick: settle(true) }, 'Approve'))
  else {
    // Checked here so a wrong paste can be fixed in place; the background checks it again.
    const back = responseIn(), failure = h('p', { className: 'bad', role: 'alert' })
    ok = armed(h('button', { className: 'primary', onclick: async () => {
      try {
        const result = await checkResponse(parseRequest(offline), back.box.value)
        await browser.runtime.sendMessage({ type: 'settle', id: p.id, ok: true, result })
        await render()
      } catch (e) { failure.textContent = (e as Error).message }
    } }, tx ? 'Broadcast' : 'Submit signature'))
    elsewhere = [h('p', {}, offlineNote), ...requestOut(offline, tx ? () => keepExported(offline, true) : undefined), ...back.nodes, failure,
      h('p', {}, tx ? 'Once you’ve copied it, you can also close this window: the transaction waits under “Waiting for a signature” on the wallet’s home screen, though the site won’t hear back.'
        : 'Keep this window open: the site is waiting for the signature.')]
  }
  return [
    h('h1', {}, title),
    h('div', { className: 'slip' },
      // red is reserved for requests that hand over open-ended control
      ...(p.summary ? [h('strong', { className: p.danger ? 'stamp' : '' }, p.summary)] : []),
      rowList(all),
      ...(text ? [h('pre', {}, text)] : [])),
    ...sitePanel(p),
    ...elsewhere,
    h('div', { className: 'row' }, h('button', { onclick: settle(false) }, 'Reject'), ok),
    ...(more ? [h('p', {}, `${more} more ${more === 1 ? 'request' : 'requests'} waiting`)] : []),
  ]
}

// Watch-only accounts: what goes out to the device with the key, and what comes back from it.
const offlineNote = 'This account is watch-only. Sign this request in Plain Wallet on the device that holds its key (Settings → Sign a request), then bring back what it gives you.'
/** The request, to copy (or save, outside the apps). `kept`: once it's out, before a toolbar popup closing on a save can lose it. */
function requestOut(text: string, kept: () => unknown = () => {}) {
  const box = h('textarea', { value: text, readOnly: true, rows: 4, spellcheck: false })
  return [h('label', {}, 'Request to sign', box),
    h('div', { className: 'row' },
      h('button', { onclick: (e: Event) => { copy(text)(e); void kept() } }, 'Copy request'),
      ...(extras.files ? [h('button', { onclick: async () => { await kept(); saveFile(text, 'plainwallet-request.json') } }, 'Save to file')] : []))]
}
function responseIn() {
  const box = h('textarea', { rows: 3, placeholder: '0x…', spellcheck: false, autocomplete: 'off', autocapitalize: 'off' })
  box.setAttribute('autocorrect', 'off')
  return { box, nodes: [h('label', {}, 'Signed by the other device', box), ...(extras.files ? [loadButton(box)] : [])] }
}
/** A transaction as signed, read from its own bytes: nothing fetched, so the offline device shows it the same way. */
function txRows(s: State, tx: ReturnType<typeof parseTransaction>) {
  const known = s.networks.find((n) => n.id === tx.chainId)
  const network = known ?? { id: tx.chainId!, name: 'Not in this wallet', rpc: '', symbol: 'native units' }
  const token = s.tokens[network.id]?.find((t) => t.address.toLowerCase() === tx.to?.toLowerCase())
  const fee = (tx.gas ?? 0n) * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n)
  return { summary: describeCall(tx.data, token), rows: [
    ['Network', networkLabel(network)], ['To', tx.to ? getAddress(tx.to) : '(new contract)'], ['Value', `${formatEther(tx.value ?? 0n)} ${network.symbol}`],
    // OP-stack chains add a fee for posting to Ethereum on top, which isn't in the transaction
    ['Max gas fee', known ? feeValue(known, fee) : `${formatEther(fee)} ${network.symbol}`], ['Nonce', String(tx.nonce ?? 0)], ['Data', tx.data ?? '0x'],
  ] as Row[] }
}
/** After a broadcast: the hash, then whether it made it. Waited for outside run(): the dialog stays closable. */
function submitted(content: HTMLElement, network: Network, from: string, hash: `0x${string}`) {
  const status = h('strong', { className: 'pending' }, 'Submitted, waiting for it to be included…')
  content.replaceChildren(status, h('p', { className: 'mono' }, hash), h('button', { onclick: copy(hash) }, 'Copy hash'),
    h('button', { className: 'primary', onclick: () => openDebank(from) }, 'View on DeBank'))
  void mined(network, hash).then(
    (receipt) => receipt.status === 'success'
      ? Object.assign(status, { className: '', textContent: 'Confirmed. The transaction succeeded.' })
      : Object.assign(status, { className: 'stamp', textContent: 'Failed. The transaction was included but reverted; only the fee was spent.' }),
    () => Object.assign(status, { className: '', textContent: 'Not included after 10 minutes. Check it on DeBank.' }))
}
/** A transaction exported from a watch-only account: out to the device with the key, back in, broadcast. */
function exportedTx(s: State, content: HTMLElement, run: ReturnType<typeof modal>['run'], text: string) {
  const request = parseRequest(text) as { from: `0x${string}`; transaction: `0x${string}` }
  const tx = parseTransaction(request.transaction)
  const { rows, summary } = txRows(s, tx)
  const back = responseIn()
  content.replaceChildren(
    h('div', { className: 'slip' }, ...(summary ? [h('strong', {}, summary)] : []), rowList([['From', request.from], ...rows])),
    h('p', {}, offlineNote), ...requestOut(text), ...back.nodes,
    h('p', {}, 'The wallet keeps it under “Waiting for a signature” on its home screen until you broadcast or discard it.'),
    h('div', { className: 'row' }, h('button', { onclick: run(() => keepExported(text, false)) }, 'Discard'),
      armed(h('button', { className: 'primary', onclick: run(async () => {
        const network = s.networks.find((n) => n.id === tx.chainId)
        if (!network) throw new Error(`Add chain ${tx.chainId} under networks to broadcast this`)
        const hash = await broadcast(network, await checkResponse(request, back.box.value))
        await keepExported(text, false)
        submitted(content, network, request.from, hash)
      }, false) }, 'Broadcast'))))
}
function waitingDialog(s: State) {
  const { content, run } = modal('Waiting for a signature')
  content.append(h('p', {}, 'Transactions exported from watch-only accounts. Bring one back signed to broadcast it.'),
    ...waiting.flatMap((text) => {
      try {
        const { from, transaction } = parseRequest(text) as { from: string; transaction: `0x${string}` }
        const { rows, summary } = txRows(s, parseTransaction(transaction))
        return [h('div', { className: 'slip' }, ...(summary ? [h('strong', {}, summary)] : []), rowList([['From', from], ...rows]),
          h('button', { className: 'primary', onclick: () => exportedTx(s, content, run, text) }, 'Continue'))]
      } catch { return [] } // only something else writing to storage gets one here: nothing to show
    }))
}
/** The other end: this device holds the key, and signs what a watch-only one exported. Nothing is fetched. */
function signDialog(s: State) {
  const { content, run } = modal('Sign a request')
  const box = h('textarea', { rows: 5, placeholder: '{"plainwallet":"sign",…}', spellcheck: false, autocomplete: 'off', autocapitalize: 'off' })
  box.setAttribute('autocorrect', 'off')
  const review = run(async () => {
    const r = parseRequest(box.value)
    const index = s.addresses.indexOf(r.from)
    if (index < 0 || watching.has(r.from)) throw new Error(`This wallet doesn’t hold the key for ${r.from}`)
    const site: Row[] = r.origin ? [['Site', `${r.origin} (as the other device saw it)`]] : []
    let shown: Node[], sign: (a: Awaited<ReturnType<typeof signer>>) => Promise<`0x${string}`>
    if ('transaction' in r) {
      const tx = parseTransaction(r.transaction)
      const { rows, summary } = txRows(s, tx)
      shown = [h('h3', {}, tx.to ? 'Sign transaction' : 'Sign contract deployment'), ...(summary ? [h('strong', {}, summary)] : []), rowList([...site, ['Account', r.from], ...rows])]
      sign = (a) => a.signTransaction(tx)
    } else if ('message' in r) {
      const { title, text } = describe({ method: 'personal_sign', detail: r.message } as Pending)
      // The same EIP-4361 check the other device made, should it have skipped it.
      const foreign = r.origin && foreignSignIn(text!, r.origin)
      if (foreign) throw new Error(`Refused: this sign-in message is for ${foreign}, not ${r.origin}`)
      shown = [h('h3', {}, title), rowList([...site, ['Account', r.from]]), h('pre', {}, text!)]
      sign = (a) => a.signMessage({ message: r.message })
    } else {
      const { view, summary } = signedView(r.typedData)
      const { title, rows = [] } = describe({ method: 'eth_signTypedData_v4', detail: view } as Pending)
      shown = [h('h3', {}, title), ...(summary ? [h('strong', { className: 'stamp' }, summary)] : []), rowList([...site, ['Account', r.from], ...rows])]
      sign = (a) => a.signTypedData(r.typedData)
    }
    content.replaceChildren(h('div', { className: 'slip' }, ...shown),
      h('div', { className: 'row' }, h('button', { onclick: () => content.replaceChildren(...form) }, 'Back'),
        armed(h('button', { className: 'primary', onclick: run(async () => {
          // The check the other device will make, before you carry it back.
          const signed = await checkResponse(r, await sign(await signer(index, r.from)))
          content.replaceChildren(h('p', {}, 'Signed. Take this back to the watch-only device and paste it there.'),
            h('label', {}, 'Signed', h('textarea', { value: signed, readOnly: true, rows: 4, spellcheck: false })),
            h('div', { className: 'row' }, h('button', { onclick: copy(signed) }, 'Copy'),
              ...(extras.files ? [h('button', { onclick: () => saveFile(signed, 'plainwallet-signed.txt') }, 'Save to file')] : [])))
        }, false) }, 'Sign'))))
  }, false)
  const form = [h('p', {}, 'For a watch-only account on another device: paste the request it gave you, check it here, and sign it with the key this wallet holds. Nothing is sent anywhere.'),
    h('label', {}, 'Request', box), ...(extras.files ? [loadButton(box)] : []), h('button', { className: 'primary', onclick: review }, 'Review')]
  content.append(...form)
}

/** Native dialogs keep unfinished input intact when an action fails. Actions check the vault key themselves
 * (lib/store.ts), and every dialog closes when the wallet locks. */
function modal(title: string) {
  const content = h('div', { className: 'dialog-content' })
  const failure = h('p', { className: 'error', role: 'alert', hidden: true })
  const heading = h('h2', { id: `dialog-${crypto.randomUUID()}` }, title)
  const dialog = h('dialog', { onclose: () => dialog.remove() }, heading, content, failure,
    h('button', { onclick: () => dialog.close() }, 'Close'))
  dialog.setAttribute('aria-labelledby', heading.id)
  let busy = false
  dialog.oncancel = (e) => { if (busy) e.preventDefault() }
  const run = (fn: () => unknown, close = true) => async () => {
    if (busy) return
    busy = true
    failure.hidden = true
    const buttons = [...dialog.querySelectorAll('button')].map((button) => [button, button.disabled] as const)
    buttons.forEach(([button]) => (button.disabled = true))
    try {
      await fn()
      if (close) dialog.close()
      await render()
    } catch (e) {
      failure.textContent = (e as Error).message
      failure.hidden = false
    } finally {
      busy = false
      buttons.forEach(([button, disabled]) => (button.disabled = disabled))
    }
  }
  document.body.append(dialog)
  dialog.showModal()
  return { content, run, dialog }
}

const shortAddress = (address: string) => `${address.slice(0, 8)}…${address.slice(-6)}`
const nameOf = (s: State, address: string) => s.nicknames[address] || shortAddress(address)
const networkLabel = (n: Network) => `${n.name} (${n.id})`
const option = (value: string | number, text: string, selected = false) => h('option', { value, selected }, text)
const accountOptions = (s: State) => s.addresses.map((a, i) => option(i, `${s.nicknames[a] || `Account ${i + 1}`} — ${shortAddress(a)}${watching.has(a) ? ' (watch-only)' : ''}`, i === s.active))

async function accountDialog(s: State) {
  const { content, run, dialog } = modal('Manage accounts')
  const groups = await accountGroups()
  // Loading/decrypting may finish after another view locked the wallet.
  if (!dialog.open || !(await isUnlocked())) { dialog.close(); return }
  const label = (a: { index: number; address: string }) => s.nicknames[a.address] || `Account ${a.index + 1}`
  let generated = ''
  const choose = () => {
    generated = ''
    let seedNumber = 0, keyNumber = 0, watchNumber = 0
    content.replaceChildren(
      h('p', {}, 'Accounts are grouped by their saved seed phrase or imported private key. Secrets are not shown here.'),
      ...groups.map((group) => {
        const source = group.accounts[0]!
        const title = group.type === 'seed' ? `Seed phrase ${++seedNumber}` : group.type === 'watch' ? `Watch-only address ${++watchNumber}` : `Imported private key ${++keyNumber}`
        return h('section', { className: 'slip' }, h('h3', {}, title),
          ...group.accounts.map((a) => h('div', { className: 'dialog-content' },
            h('strong', {}, label(a)), h('p', { className: 'mono' }, a.address),
            ...(a.addressIndex !== undefined ? [h('p', { className: 'mono' }, `m/44'/60'/0'/0/${a.addressIndex}`)] : []),
            h('button', { className: 'quiet', onclick: () => remove([a], false, group.type === 'seed', group.type === 'watch') }, 'Remove account'))),
          ...(group.type === 'seed' ? [
            h('button', { onclick: run(() => addDerivedAccount(source.index, source.address)) }, 'Generate account from this seed'),
            h('button', { className: 'danger', onclick: () => remove(group.accounts, true, true) }, 'Remove seed phrase group'),
          ] : []))
      }),
      h('button', { className: 'primary', onclick: generate }, 'Generate new seed phrase'),
      h('button', { onclick: () => importSecret(false) }, 'Import private key'),
      h('button', { onclick: () => importSecret(true) }, 'Import seed phrase'),
      h('button', { onclick: watchAddress }, 'Watch an address'))
  }
  const back = () => h('button', { className: 'quiet', onclick: choose }, 'Back')
  const generate = () => {
    generated = newMnemonic()
    const backedUp = h('input', { type: 'checkbox' })
    const create = h('button', { className: 'primary', disabled: true, onclick: run(async () => {
      if (!backedUp.checked || !generated) throw new Error('Back up the new seed phrase first')
      await addWallet(generated)
      generated = ''
    }) }, 'Create wallet')
    backedUp.onchange = () => (create.disabled = !backedUp.checked)
    content.replaceChildren(back(), h('h3', {}, 'Your new seed phrase'),
      h('p', {}, 'This creates an independent wallet, not another account from an existing seed. Write these 12 words down on paper, in order, and keep them private. Nothing is saved until you confirm.'),
      h('ol', {}, ...generated.split(' ').map((word) => h('li', {}, word))),
      h('label', { className: 'acknowledgment' }, backedUp, 'I saved this new seed phrase somewhere safe.'), create)
  }
  const remove = (accounts: { index: number; address: string }[], wholeSeed: boolean, fromSeed: boolean, watch = false) => {
    if (watch) return content.replaceChildren(back(), h('h3', {}, 'Remove watch-only address?'),
      h('strong', {}, label(accounts[0]!)), h('p', { className: 'mono' }, accounts[0]!.address),
      h('p', {}, 'This removes the address, its nickname and site connections from this wallet. Its key, on the other device, is not affected.'),
      h('button', { className: 'danger', onclick: run(() => removeAccount(accounts[0]!.index, accounts[0]!.address)) }, 'Remove this address'))
    const backedUp = h('input', { type: 'checkbox' })
    const confirm = h('button', { className: 'danger', disabled: true, onclick: run(() => {
      if (!backedUp.checked) throw new Error('Confirm your backup first')
      return wholeSeed ? removeSeedGroup(accounts) : removeAccount(accounts[0]!.index, accounts[0]!.address)
    }) }, wholeSeed ? 'Remove seed phrase and all listed accounts' : 'Remove this account')
    backedUp.onchange = () => (confirm.disabled = !backedUp.checked)
    content.replaceChildren(back(), h('h3', {}, wholeSeed ? 'Remove seed phrase group?' : 'Remove account?'),
      ...accounts.flatMap((a) => [h('strong', {}, label(a)), h('p', { className: 'mono' }, a.address)]),
      h('p', { className: 'stamp' }, 'This removes local wallet access, nicknames and site connections from this device. It does not delete or move on-chain funds. Without a backup, you may permanently lose access.'),
      ...(fromSeed ? [h('p', {}, wholeSeed ? 'The seed phrase and every listed account will be removed. Independently imported private keys are not part of this group.' : 'Other accounts from this seed stay available. The seed is removed only when its last account is removed; you can restore this account with your backup and the derivation path shown in Manage accounts.')] : []),
      h('p', {}, 'To remove every account, lock the wallet and use Forgot password? → Reset wallet.'),
      h('label', { className: 'acknowledgment' }, backedUp, 'I have the seed phrase or private key for these accounts backed up elsewhere.'), confirm)
  }
  const importSecret = (mnemonic: boolean) => {
    const { input, note } = secretBox()
    input.placeholder = mnemonic ? 'Seed phrase' : 'Private key'
    content.replaceChildren(back(), h('label', {}, mnemonic ? 'Seed phrase' : 'Private key', input), note,
      h('button', { className: 'primary', onclick: run(() => {
        const secret = parseSecret(input.value)
        if (secret.startsWith('0x') === mnemonic) throw new Error(mnemonic ? 'Enter a seed phrase, not a private key' : 'Enter a private key, not a seed phrase')
        return addWallet(secret)
      }) }, mnemonic ? 'Import seed phrase' : 'Import private key'))
  }
  const watchAddress = () => {
    const address = h('input', { placeholder: '0x…', spellcheck: false, autocomplete: 'off' })
    content.replaceChildren(back(), h('p', {}, watchNote), h('label', {}, 'Address', address),
      h('button', { className: 'primary', onclick: run(() => addWallet({ watch: parseAddress(address.value) })) }, 'Watch address'))
  }
  dialog.addEventListener('close', () => { generated = ''; content.replaceChildren() })
  choose()
}
function nicknameDialog(s: State) {
  const address = s.addresses[s.active]!
  const { content, run } = modal('Account nickname')
  const name = field('Nickname', { value: s.nicknames[address] || '', maxLength: 40, placeholder: 'e.g. Savings' })
  content.append(h('p', { className: 'mono' }, address), name.el,
    h('button', { className: 'primary', onclick: run(async () => {
      const nickname = name.input.value.trim()
      await save((now) => {
        const nicknames = { ...now.nicknames }
        if (nickname) nicknames[address] = nickname
        else delete nicknames[address]
        return { nicknames }
      })
    }) }, 'Save nickname'))
}

function networkDialog(s: State, adding = false) {
  const { content, run } = modal('Manage networks')
  const selected = h('select', {}, ...s.networks.map((n) => option(n.id, n.name, !adding && n.id === s.chainId)), option('add', 'Add network…', adding))
  const name = field('Name'), id = field('Chain ID', { type: 'number', min: 1 })
  const url = field('RPC URL', { spellcheck: false }), symbol = field('Currency symbol')
  const picker = h('label', {}, 'Network', selected)
  let custom = false
  // Adding starts with a choice: chainlist.org adds through the site's wallet_addEthereumChain (and its approval slip).
  const choice = [
    h('button', { className: 'primary', onclick: () => openTab('https://chainlist.org/') }, 'Add from chainlist.org'),
    h('button', { onclick: () => { custom = true; populate() } }, 'Add custom network'),
  ]
  const populate = () => {
    const current = s.networks.find((n) => String(n.id) === selected.value)
    const choosing = !current && !custom
    content.replaceChildren(picker, ...(choosing ? choice : [name.el, id.el, url.el, symbol.el, commit, remove]))
    name.input.value = current?.name || ''
    id.input.value = current ? String(current.id) : ''
    id.input.disabled = !!current
    url.input.value = current?.rpc || ''
    symbol.input.value = current?.symbol || 'ETH'
    remove.disabled = !current || s.networks.length < 2
    commit.textContent = current ? 'Save network' : 'Add network'
  }
  const commit = h('button', { className: 'primary', onclick: run(async () => {
    const n: Network = { id: Number(id.input.value), name: name.input.value.trim(), rpc: url.input.value.trim(), symbol: symbol.input.value.trim() }
    if (!/^https?:\/\/\S+$/.test(n.rpc)) throw new Error('RPC must be an http(s) URL')
    if (!Number.isSafeInteger(n.id) || n.id <= 0 || !n.name || !n.symbol) throw new Error('Fill in every network field')
    const isNew = selected.value === 'add'
    await save((current) => {
      if (isNew && current.networks.some((x) => x.id === n.id)) throw new Error('That chain ID already exists; select it to edit')
      if (!isNew && !current.networks.some((x) => x.id === n.id)) throw new Error('This network was removed; reopen the network editor')
      return { networks: isNew ? [...current.networks, n] : current.networks.map((x) => x.id === n.id ? n : x), chainId: isNew ? n.id : current.chainId }
    })
  }) }, '')
  const remove = h('button', { className: 'danger', onclick: run(async () => {
    const removed = Number(selected.value)
    await save((current) => {
      const networks = current.networks.filter((n) => n.id !== removed)
      if (!networks.length) throw new Error('Keep at least one network')
      return { networks, chainId: current.chainId === removed ? networks[0]!.id : current.chainId }
    })
  }) }, 'Delete network')
  selected.onchange = () => { custom = false; populate() }
  populate()
}

function exportDialog(s: State) {
  const { content, run, dialog } = modal('Export seeds / private keys')
  const selected = h('select', {}, ...accountOptions(s).filter((o) => !watching.has(s.addresses[Number(o.value)]!)))
  const pw = field('Enter your password again', { type: 'password', autocomplete: 'off' })
  const reveal = run(async () => {
    const index = Number(selected.value)
    selected.disabled = true
    try {
      const exported = await exportAccount(index, pw.input.value)
      if (!dialog.open || !(await isUnlocked())) return
      // No copy buttons: the wallet never puts a secret on the system clipboard itself.
      const secretField = (label: string, value: string) =>
        [h('label', {}, label, h('textarea', { value, readOnly: true, rows: 3, spellcheck: false, autocomplete: 'off', autocapitalize: 'off' }))]
      content.replaceChildren(
        h('p', { className: 'mono' }, s.addresses[index]!),
        h('p', {}, 'Keep these secrets private. Anyone with them can control your funds.'),
        ...(exported.mnemonic ? [h('p', {}, 'This seed phrase restores all accounts generated from it.'), ...secretField('Seed phrase', exported.mnemonic)]
          : [h('p', {}, 'This account was imported by private key; no seed phrase is stored for it.')]),
        ...secretField('Private key', exported.privateKey),
        ...(exported.path ? [h('p', { className: 'mono' }, `Derivation path: ${exported.path}`)] : []))
    } finally {
      pw.input.value = ''
      selected.disabled = false
    }
  }, false)
  pw.input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void reveal() } }
  dialog.addEventListener('close', () => {
    pw.input.value = ''
    content.querySelectorAll('textarea').forEach((input) => { input.value = '' })
    content.replaceChildren()
  })
  content.append(h('p', {}, 'Select an account and enter your password to reveal its stored seed phrase and private key.'),
    h('label', {}, 'Account', selected), pw.el,
    h('button', { className: 'primary', onclick: reveal }, 'Reveal secrets'))
}

function sendDialog(s: State, network: Network, tokens: Token[]) {
  const index = s.active, from = s.addresses[index]!
  const { content, run } = modal(`Send on ${network.name}`)
  const asset = h('select', {}, option('', network.symbol), ...tokens.map((t, i) => option(i, t.symbol)))
  const to = field('To address', { placeholder: '0x…', spellcheck: false, autocomplete: 'off' })
  const amount = field('Amount', { placeholder: '0.0', inputMode: 'decimal', autocomplete: 'off' })
  const review = run(async () => {
    const token = asset.value === '' ? undefined : tokens[Number(asset.value)]!
    const recipient = parseAddress(to.input.value)
    if (recipient === zeroAddress) throw new Error('That is the zero address: anything sent there is burned')
    if (recipient === token?.address) throw new Error('That is the token’s own contract: tokens sent there are almost always lost')
    const decimals = token?.decimals ?? 18, value = parseAmount(amount.input.value, decimals)
    const { request, fee } = await prepare(network, from, token
      ? { to: token.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, value] }) }
      : { to: recipient, value })
    const watch = watching.has(from)
    const confirm = armed(h('button', { className: 'primary', onclick: run(async () => {
      if (watch) {
        // Kept right away: a toolbar popup closes as soon as you switch to anything else.
        const text = requestText({ from, transaction: serializeTransaction(await unsigned(network, from, request)) })
        await keepExported(text, true)
        return exportedTx(s, content, run, text)
      }
      const hash = await send(network, await signer(index, from), request)
      void browser.runtime.sendMessage({ type: 'sent', account: from }) // counts toward a Megapot ticket, if that's on
      submitted(content, network, from, hash)
    }, false) }, watch ? 'Export to sign' : 'Send'))
    content.replaceChildren(
      h('div', { className: 'slip' }, rowList([
        ['Network', networkLabel(network)], ['From', from], ['To', recipient],
        ['Amount', `${formatUnits(value, decimals)} ${token?.symbol ?? network.symbol}`],
        ...(token ? [['Token contract', token.address] as Row] : []),
        ['Estimated max fee', feeValue(network, fee)],
      ])),
      ...secondOpinion('transaction', {
        network: network.name, to: request.to!, value: `${formatEther(request.value ?? 0n)} ${network.symbol}`,
        call: describeCall(request.data, token) ?? 'none',
      }, () => txChecks(network, from, request)),
      h('div', { className: 'row' }, h('button', { onclick: () => content.replaceChildren(...form) }, 'Back'), confirm))
  }, false)
  const form = [h('label', {}, 'Asset', asset), to.el, amount.el, h('button', { className: 'primary', onclick: review }, 'Review')]
  content.append(...form)
}

function tokenDialog(network: Network, tokens: Token[]) {
  const { content, run } = modal(`Tokens on ${network.name}`)
  const list = h('div', { className: 'dialog-content' })
  const empty = () => { if (!list.childElementCount) list.append(h('p', {}, 'No tokens on this network.')) }
  for (const t of tokens) {
    const row = h('div', { className: 'row' }, h('span', {}, h('span', {}, t.symbol), h('p', { className: 'mono' }, t.address)))
    row.append(h('button', { className: 'quiet', onclick: run(async () => {
      await save((now) => ({ tokens: { ...now.tokens, [network.id]: (now.tokens[network.id] ?? []).filter((x) => x.address !== t.address) } }))
      row.remove()
      empty()
    }, false) }, 'Remove'))
    list.append(row)
  }
  empty()
  const address = field('Token contract address', { placeholder: '0x…', spellcheck: false, autocomplete: 'off' })
  content.append(list, address.el, h('button', { className: 'primary', onclick: run(async () => {
      const token = await tokenInfo(network, address.input.value)
      await save((now) => {
        const list = now.tokens[network.id] ?? []
        if (list.some((t) => t.address === token.address)) throw new Error(`${token.symbol} is already listed`)
        return { tokens: { ...now.tokens, [network.id]: [...list, token] } }
      })
    }) }, 'Add token'))
}

async function settingsDialog(s: State) {
  const m = megapotSettings((await browser.storage.local.get('megapot')).megapot)
  const { content, run, dialog } = modal('Settings')
  const locks = h('input', { type: 'checkbox', checked: await autolock() })
  locks.onchange = run(() => setAutolock(locks.checked), false)
  const sites = h('div', { className: 'dialog-content' })
  const empty = () => { if (!sites.childElementCount) sites.append(h('p', {}, 'No connected sites.')) }
  for (const [site, accounts] of Object.entries(s.connections)) {
    const names = accounts.map((a) => nameOf(s, a)).join(', ')
    const row = h('div', { className: 'row' }, h('span', {}, h('span', { className: 'mono' }, site), h('p', {}, names)))
    row.append(h('button', { className: 'quiet', onclick: run(async () => {
      await save((now) => ({ connections: Object.fromEntries(Object.entries(now.connections).filter(([o]) => o !== site)) }))
      row.remove()
      empty()
    }, false) }, 'Disconnect'))
    sites.append(row)
  }
  empty()
  const jev = field('API key', { type: 'password', value: jevKey, autocomplete: 'off', spellcheck: false })
  content.append(h('button', { onclick: () => { dialog.close(); exportDialog(s) } }, 'Export seeds / private keys'),
    h('button', { onclick: () => { dialog.close(); signDialog(s) } }, 'Sign a request from a watch-only device'),
    h('button', { onclick: run(async () => { dialog.close(); await accountDialog(s) }) }, 'Manage accounts'),
    ...(extras.autolockSetting ? [h('label', { className: 'acknowledgment' }, locks, 'Lock after 15 minutes without use'),
      h('p', {}, extras.autolockOff)] : []),
    h('h2', {}, 'Connected sites'), sites,
    h('details', { className: 'fold' },
      h('summary', {}, 'Jev transaction check: ', h('span', {}, jevKey ? 'on' : 'off')),
      h('div', { className: 'dialog-content' },
        h('p', {}, 'Transactions are always simulated on your network’s RPC. With a typesafe.ai API key, each transaction and signature you review is also looked up on Blockscout and described to Jev, which says what it does and how likely it is a scam. Leave empty to turn that off.'),
        jev.el, h('button', { onclick: run(() => {
          const key = jev.input.value.trim()
          return key ? browser.storage.local.set({ jevKey: key }) : browser.storage.local.remove('jevKey')
        }) }, 'Save API key'))),
    ...(extras.megapot ? [megapotSection(m, run)] : []),
    ...extras.settings(),
    h('p', {}, `Plain Wallet ${browser.runtime.getManifest().version} · `,
      h('a', { href: 'https://github.com/backmeupplz/plainwallet', target: '_blank', rel: 'noreferrer' }, 'Source code on GitHub')))
}

/** Collapsed until opened: a Megapot ticket every N transactions, off by default. */
function megapotSection(m: ReturnType<typeof megapotSettings>, run: ReturnType<typeof modal>['run']) {
  const on = h('input', { type: 'checkbox', checked: m.on })
  const every = field('Every how many transactions', { type: 'number', min: 1, step: 1, value: m.every, inputMode: 'numeric' })
  const left = m.every - m.count
  return h('details', { className: 'fold' },
    h('summary', {}, 'Megapot: ', h('span', {}, m.on ? (m.every === 1 ? 'ticket/tx' : `ticket/${m.every} txs`) : 'off')),
    h('div', { className: 'dialog-content' },
      h('p', {}, 'Every N transactions you send, the wallet asks you to buy one ',
        h('a', { href: 'https://megapot.io', target: '_blank', rel: 'noreferrer' }, 'Megapot'),
        ' lottery ticket: 1 USDC on Base, random numbers, for the account that sent it. You approve each purchase like any transaction; when the allowance runs out, an approval for the next 10 tickets comes first. If that account has less than 1 USDC on Base, the ticket is skipped without asking. Needs a little ETH on Base for fees.'),
      h('label', { className: 'acknowledgment' }, on, 'Buy Megapot tickets'), every.el,
      ...(m.on ? [h('p', {}, `Next ticket after ${left} more transaction${left === 1 ? '' : 's'}.`)] : []),
      ...(m.error ? [h('p', { className: 'warn' }, `The last ticket wasn’t bought: ${m.error}`)] : []),
      h('button', { onclick: run(async () => {
        const n = Number(every.input.value)
        if (!Number.isSafeInteger(n) || n < 1) throw new Error('Enter a whole number of transactions, 1 or more')
        const now = megapotSettings((await browser.storage.local.get('megapot')).megapot)
        await browser.storage.local.set({ megapot: { on: on.checked, every: n, count: Math.min(now.count, n - 1) } })
      }) }, 'Save Megapot settings')))
}

function mainScreen(s: State) {
  const address = s.addresses[s.active]!
  const accounts = h('select', { id: 'account', title: address }, ...accountOptions(s), option('add', 'Manage accounts…'))
  accounts.onchange = () => {
    if (accounts.value === 'add') { accounts.value = String(s.active); void act(() => accountDialog(s))() }
    else void act(() => save({ active: Number(accounts.value) }))()
  }
  const networks = h('select', { id: 'network' },
    ...s.networks.map((n) => option(n.id, networkLabel(n), n.id === s.chainId)), option('add', 'Add network…'))
  networks.onchange = () => {
    if (networks.value === 'add') { networks.value = String(s.chainId); networkDialog(s, true) }
    else void act(() => save({ chainId: Number(networks.value) }))()
  }
  const copyAddress = iconButton('Copy address', icons.copy, async () => {
    await navigator.clipboard.writeText(address)
    copyAddress.querySelector('path')!.setAttribute('d', icons.check)
    copyAddress.title = copyAddress.ariaLabel = 'Copied'
    copyAddress.disabled = true
    setTimeout(() => {
      copyAddress.querySelector('path')!.setAttribute('d', icons.copy)
      copyAddress.title = copyAddress.ariaLabel = 'Copy address'
      copyAddress.disabled = false
    }, 1200)
  })
  const network = s.networks.find((n) => n.id === s.chainId)!
  const tokens = s.tokens[network.id] ?? []
  const decimals = [18, ...tokens.map((t) => t.decimals)]
  const amounts = decimals.map(() => h('dd', { className: 'skeleton' }))
  const list = h('dl', { className: 'balances', ariaBusy: 'true' }, ...[network.symbol, ...tokens.map((t) => t.symbol)].flatMap((symbol, i) => [h('dt', {}, symbol), amounts[i]!]))
  const key = [network.id, network.rpc, address, ...tokens.map((t) => t.address)].join()
  // Offline, nothing to wait for: the RPC's retries would only keep the placeholders up.
  if (cached?.key !== key) cached = { key, values: navigator.onLine ? balances(network, address, tokens) : Promise.resolve(decimals.map(() => undefined)) }
  const { values } = cached
  // An offline device (the one holding a watch-only account's key, say) still signs.
  const unreachable = h('div', { className: 'dialog-content', hidden: true })
  const showUnreachable = () => {
    unreachable.hidden = false
    unreachable.replaceChildren(h('p', { className: 'warn' }, `${navigator.onLine ? `Can’t reach ${network.name}’s RPC.` : 'This device is offline.'} Balances and sending need it; signing a request from a watch-only device doesn’t.`),
      h('button', { onclick: () => signDialog(s) }, 'Sign a request'))
  }
  if (!navigator.onLine) showUnreachable()
  // Stale fills after a re-render land in detached nodes, which is harmless.
  void values.then((v) => {
    if (v[0] == null) showUnreachable()
    if (v[0] == null && cached?.values === values) cached = undefined // RPC unreachable: try again on the next redraw
    list.ariaBusy = 'false'
    v.forEach((value, i) => {
      const exact = value == null ? '' : formatUnits(value, decimals[i]!)
      amounts[i]!.className = ''
      amounts[i]!.textContent = exact ? Number(exact).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'
      amounts[i]!.title = exact
    })
  })
  return [
    header(iconButton('Settings', icons.settings, () => settingsDialog(s)), iconButton('Lock', icons.lock, act(lock))),
    ...extras.home(),
    h('div', { className: 'selector-field' }, h('label', { htmlFor: 'network' }, 'Network'),
      h('div', { className: 'row' }, networks, iconButton('Manage networks', icons.edit, () => networkDialog(s)))),
    h('div', { className: 'selector-field' }, h('label', { htmlFor: 'account' }, 'Account'),
      h('div', { className: 'row' }, accounts, iconButton('Edit account nickname', icons.edit, () => nicknameDialog(s)),
        iconButton('Transaction history on DeBank', icons.history, () => openDebank(address)), copyAddress)),
    ...(watching.has(address) ? [h('p', {}, 'Watch-only: you sign for this account on the device that holds its key.')] : []),
    list, unreachable,
    ...(waiting.length ? [h('button', { onclick: () => waitingDialog(s) }, `Waiting for a signature (${waiting.length})`)] : []),
    h('div', { className: 'row' }, h('button', { onclick: () => tokenDialog(network, tokens) }, 'Tokens'),
      h('button', { className: 'primary', onclick: () => sendDialog(s, network, tokens) }, 'Send')),
  ]
}

// Only reachable unlocked: that's when load() has the key to check the state with.
const tamperedScreen = () => [
  header(iconButton('Lock', icons.lock, act(lock))),
  h('p', { className: 'stamp' }, `${TAMPERED}. Your keys are safe in the encrypted vault, but the wallet won’t use an account list, networks, tokens or connected sites it can’t trust.`),
  h('button', { className: 'primary', onclick: act(repair) }, 'Rebuild from the vault'),
  h('p', {}, 'This restores your accounts from the vault and resets networks, tokens, nicknames and connected sites.'),
]

export async function render(stillCurrent = () => true) {
  const mine = ++renderId
  if (viewClosed || !stillCurrent()) return
  currentWindowId ??= (await browser.windows.getCurrent()).id
  const s = await load().catch((e: Error) => e)
  const pending: Pending[] = await browser.runtime.sendMessage({ type: 'pending' })
  const unlocked = await isUnlocked()
  if (mine !== renderId || viewClosed || !stillCurrent()) return
  let screen: (Node | string)[]
  if (s instanceof Error) {
    // Anything but tampering is storage failing to answer (in the Mac app: the file it shares with Safari).
    screen = s.message === TAMPERED ? tamperedScreen() : [header(), h('div', { className: 'error', role: 'alert' }, `Can't read the wallet: ${s.message}`)]
  } else if (seed) screen = seedScreen()
  else if (!s.vault) screen = [header(), ...walletForm(true)]
  else if (!unlocked) screen = unlockScreen(pending[0])
  else {
    touch() // using the wallet pushes the auto-lock back
    jevKey = ((await browser.storage.local.get('jevKey')).jevKey as string | undefined) ?? ''
    ;[watching, waiting] = [new Set(await watchedAddresses()), await exported()]
    screen = pending.length ? approvalScreen(pending[0]!, pending.length - 1) : mainScreen(s)
  }
  if (mine !== renderId || viewClosed || !stillCurrent()) return
  if (s instanceof Error || seed || !s.vault || unlocked) invalidateUnlockView()
  app.replaceChildren(...(error ? [h('div', { className: 'error', role: 'alert' }, error)] : []), ...screen)
}

render()
addEventListener('online', () => void render())
addEventListener('offline', () => void render())
// Persistent views must return to the unlock screen when another view or the alarm locks the vault.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !('key' in changes || 'mined' in changes)) return
  if ('mined' in changes) cached = undefined
  if ('key' in changes) invalidateUnlockView()
  if (changes.key && !changes.key.newValue) {
    clearSetup()
    document.querySelectorAll('dialog').forEach((dialog) => dialog.close())
  }
  void render()
})
// ponytail: MV3 kills an idle service worker after ~30s, which would drop in-memory approvals; an open popup keeps it awake
setInterval(() => browser.runtime.sendMessage({ type: 'ping' }), 20_000)

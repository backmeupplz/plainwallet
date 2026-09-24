import { encodeFunctionData, erc20Abi, formatEther, formatUnits, zeroAddress } from 'viem'
import { balances, mined, prepare, send, tokenInfo } from '@/lib/chain'
import { parseAddress, parseAmount } from '@/lib/describe'
import { addDerivedAccount, addWallet, exportAccount, isUnlocked, load, lock, removeAccount, repair, save, seedSources, signer, TAMPERED, touch, unlock, type Network, type State, type Token } from '@/lib/store'
import { newMnemonic, parseSecret } from '@/lib/wallet'
import type { Pending } from '../background'

const app = document.getElementById('app')!
let error = ''
let seed = '' // freshly generated phrase, shown once and only saved after the user confirms
let pendingPassword: string | undefined // vault password entered alongside it (first wallet only)
let walletMode: 'generate' | 'import' | undefined
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

// Children are appended as text nodes, so dapp-supplied strings can never become markup.
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]) {
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
// Consent buttons start disabled: a window that pops up under the cursor, or the second half of a double-click on
// whatever was there before, must not count as a click on them.
const armed = (button: HTMLButtonElement) => {
  button.disabled = true
  setTimeout(() => (button.disabled = false), 800)
  return button
}

function walletForm(first: boolean) {
  if (!walletMode) return [
    h('p', {}, first ? 'How would you like to get started?' : 'How would you like to add a wallet?'),
    h('button', { className: 'primary', onclick: act(() => (walletMode = 'generate')) }, 'Generate new wallet'),
    h('button', { onclick: act(() => (walletMode = 'import')) }, 'Enter seed phrase or private key'),
  ]
  const importing = walletMode === 'import'
  // spellcheck off: browsers' cloud ("enhanced") spellcheck would otherwise upload whatever is typed here
  const secret = h('textarea', { rows: 3, placeholder: 'Seed phrase or private key', spellcheck: false, autocomplete: 'off', autocapitalize: 'off' })
  const pw = field('Password (min 12 characters)', { type: 'password' })
  const pw2 = field('Repeat password', { type: 'password' })
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
  return [
    h('button', { className: 'quiet', onclick: act(clearSetup) }, 'Back'),
    h('h2', {}, importing ? 'Import your wallet' : 'Create a new wallet'),
    ...(importing ? [h('label', {}, 'Seed phrase or private key', secret)] : [h('p', {}, 'We’ll generate a new seed phrase for you to back up.')]),
    ...(first ? [h('p', {}, 'Choose a password to protect your wallets on this device.'), pw.el, pw2.el] : []),
    h('button', { className: 'primary', onclick: importing ? act(async () => {
      await addWallet(parseSecret(secret.value), password())
      clearSetup()
    }) : generate }, importing ? 'Import wallet' : 'Generate seed phrase'),
  ]
}
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
  const pw = field('Password', { type: 'password', autofocus: true })
  const go = act(() => unlock(pw.input.value))
  pw.input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void go()
    }
  }
  return [header(), ...(waiting ? [h('p', {}, `${waiting.origin} is waiting for your approval. Unlock to review it.`)] : []),
    pw.el, h('button', { className: 'primary', onclick: go }, 'Unlock'),
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

type Row = [label: string, value: string]
const rowList = (rows: Row[]) => h('dl', {}, ...rows.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]))
// Nested data as dotted rows. The prefix keeps dapp-chosen field names from posing as the wallet's own rows.
const flatten = (value: unknown, path: string): Row[] =>
  value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([k, v]) => flatten(v, `${path}.${k}`)) : [[path, String(value)]]
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
      case 'eth_sendTransaction':
        return {
          title: d.to ? 'Send transaction' : 'Deploy contract',
          rows: [['To', d.to ?? '(new contract)'], ['Value', `${d.value} ${p.network.symbol}`], ['Max fee', `${d.fee} ${p.network.symbol}`], ['Data', d.data]],
        }
    }
  } catch {}
  return { title: p.method, text: JSON.stringify(d, null, 2) }
}

function approvalScreen(p: Pending, more: number) {
  const { title, rows = [], text } = describe(p)
  const settle = (ok: boolean) => act(() => browser.runtime.sendMessage({ type: 'settle', id: p.id, ok }))
  const ok = armed(h('button', { className: 'primary', onclick: settle(true) }, 'Approve'))
  const all: Row[] = [['From site', p.origin], ['Network', networkLabel(p.network)], ['Account', p.account], ...rows]
  return [
    h('h1', {}, title),
    h('div', { className: 'slip' },
      // red is reserved for requests that hand over open-ended control
      ...(p.summary ? [h('strong', { className: p.danger ? 'stamp' : '' }, p.summary)] : []),
      rowList(all),
      ...(text ? [h('pre', {}, text)] : [])),
    h('div', { className: 'row' }, h('button', { onclick: settle(false) }, 'Reject'), ok),
    ...(more ? [h('p', {}, `${more} more ${more === 1 ? 'request' : 'requests'} waiting`)] : []),
  ]
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
const accountOptions = (s: State) => s.addresses.map((a, i) => option(i, `${s.nicknames[a] || `Account ${i + 1}`} — ${shortAddress(a)}`, i === s.active))

async function accountDialog(s: State) {
  const sources = await seedSources()
  const { content, run } = modal('Add account')
  const choose = () => content.replaceChildren(
    h('button', { disabled: !sources.length, onclick: derive }, 'Generate account from seed'),
    ...(!sources.length ? [h('p', {}, 'Add a seed phrase first to generate more accounts from it.')] : []),
    h('button', { onclick: () => importSecret(false) }, 'Add private key'),
    h('button', { onclick: () => importSecret(true) }, 'Add seed phrase'))
  const back = () => h('button', { className: 'quiet', onclick: choose }, 'Back')
  const derive = () => {
    const source = h('select', {}, ...sources.map((entry, i) => option(entry.index,
      `Seed ${i + 1} — ${nameOf(s, entry.address)}`)))
    content.replaceChildren(back(),
      h('p', {}, 'Create the next unused account from your saved seed phrase.'),
      ...(sources.length > 1 ? [h('label', {}, 'Seed phrase', source)] : []),
      h('button', { className: 'primary', onclick: run(() => addDerivedAccount(Number(source.value))) }, 'Generate account'))
  }
  const importSecret = (mnemonic: boolean) => {
    const input = h('textarea', { rows: 3, spellcheck: false, autocomplete: 'off', autocapitalize: 'off' })
    content.replaceChildren(back(), h('label', {}, mnemonic ? 'Seed phrase' : 'Private key', input),
      h('button', { className: 'primary', onclick: run(() => {
        const secret = parseSecret(input.value)
        if (secret.startsWith('0x') === mnemonic) throw new Error(mnemonic ? 'Enter a seed phrase, not a private key' : 'Enter a private key, not a seed phrase')
        return addWallet(secret)
      }) }, mnemonic ? 'Add seed phrase' : 'Add private key'))
  }
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
  const selected = h('select', {}, ...accountOptions(s))
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
    const confirm = armed(h('button', { className: 'primary', onclick: run(async () => {
      const hash = await send(network, await signer(index, from), request)
      // Waited for outside run(): the dialog stays closable while the transaction is pending.
      const status = h('strong', { className: 'pending' }, 'Submitted, waiting for it to be included…')
      content.replaceChildren(status, h('p', { className: 'mono' }, hash), h('button', { onclick: copy(hash) }, 'Copy hash'),
        h('button', { className: 'primary', onclick: () => openDebank(from) }, 'View on DeBank'))
      void mined(network, hash).then(
        (receipt) => receipt.status === 'success'
          ? Object.assign(status, { className: '', textContent: 'Confirmed. The transaction succeeded.' })
          : Object.assign(status, { className: 'stamp', textContent: 'Failed. The transaction was included but reverted; only the fee was spent.' }),
        () => Object.assign(status, { className: '', textContent: 'Not included after 10 minutes. Check it on DeBank.' }))
    }, false) }, 'Send'))
    content.replaceChildren(
      h('div', { className: 'slip' }, rowList([
        ['Network', networkLabel(network)], ['From', from], ['To', recipient],
        ['Amount', `${formatUnits(value, decimals)} ${token?.symbol ?? network.symbol}`],
        ...(token ? [['Token contract', token.address] as Row] : []),
        ['Max fee', `${formatEther(fee)} ${network.symbol}`],
      ])),
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

function removeDialog(s: State) {
  const { content, run } = modal('Remove account')
  const selected = h('select', {}, ...accountOptions(s))
  const backedUp = h('input', { type: 'checkbox' })
  const remove = h('button', { className: 'danger', disabled: true, onclick: run(() =>
    removeAccount(Number(selected.value), s.addresses[Number(selected.value)]!)) }, 'Remove account')
  backedUp.onchange = () => (remove.disabled = !backedUp.checked)
  selected.onchange = () => { backedUp.checked = false; remove.disabled = true }
  content.append(h('label', {}, 'Account', selected),
    h('p', { className: 'stamp' }, 'This deletes the account’s key from Plain Wallet on this device, with its nickname and site connections. Its funds stay on-chain, reachable only with its seed phrase or private key.'),
    h('label', { className: 'acknowledgment' }, backedUp, 'I have this account’s seed phrase or private key backed up elsewhere.'),
    remove)
}

function settingsDialog(s: State) {
  const { content, run, dialog } = modal('Settings')
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
  content.append(h('button', { onclick: () => { dialog.close(); exportDialog(s) } }, 'Export seeds / private keys'),
    h('button', { onclick: () => { dialog.close(); removeDialog(s) } }, 'Remove account'),
    h('h2', {}, 'Connected sites'), sites,
    h('a', { href: 'https://github.com/backmeupplz/plainwallet', target: '_blank', rel: 'noreferrer' }, 'Source code on GitHub'))
}

function mainScreen(s: State) {
  const address = s.addresses[s.active]!
  const accounts = h('select', { id: 'account', title: address }, ...accountOptions(s), option('add', 'Add account…'))
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
  if (cached?.key !== key) cached = { key, values: balances(network, address, tokens) }
  const { values } = cached
  // Stale fills after a re-render land in detached nodes, which is harmless.
  void values.then((v) => {
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
    h('div', { className: 'selector-field' }, h('label', { htmlFor: 'network' }, 'Network'),
      h('div', { className: 'row' }, networks, iconButton('Manage networks', icons.edit, () => networkDialog(s)))),
    h('div', { className: 'selector-field' }, h('label', { htmlFor: 'account' }, 'Account'),
      h('div', { className: 'row' }, accounts, iconButton('Edit account nickname', icons.edit, () => nicknameDialog(s)),
        iconButton('Transaction history on DeBank', icons.history, () => openDebank(address)), copyAddress)),
    list,
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

async function render() {
  currentWindowId ??= (await browser.windows.getCurrent()).id
  const s = await load().catch((e: Error) => e)
  const pending: Pending[] = await browser.runtime.sendMessage({ type: 'pending' })
  let screen: (Node | string)[]
  if (s instanceof Error) {
    if (s.message !== TAMPERED) throw s
    screen = tamperedScreen()
  } else if (seed) screen = seedScreen()
  else if (!s.vault) screen = [header(), ...walletForm(true)]
  else if (!(await isUnlocked())) screen = unlockScreen(pending[0])
  else {
    touch() // using the wallet pushes the auto-lock back
    screen = pending.length ? approvalScreen(pending[0]!, pending.length - 1) : mainScreen(s)
  }
  app.replaceChildren(...(error ? [h('div', { className: 'error', role: 'alert' }, error)] : []), ...screen)
}

render()
// Persistent views must return to the unlock screen when another view or the alarm locks the vault.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !('key' in changes || 'mined' in changes)) return
  if ('mined' in changes) cached = undefined
  if (changes.key && !changes.key.newValue) {
    clearSetup()
    document.querySelectorAll('dialog').forEach((dialog) => dialog.close())
  }
  void render()
})
// ponytail: MV3 kills an idle service worker after ~30s, which would drop in-memory approvals; an open popup keeps it awake
setInterval(() => browser.runtime.sendMessage({ type: 'ping' }), 20_000)

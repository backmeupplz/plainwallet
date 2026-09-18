import { addWallet, isUnlocked, load, lock, save, unlock, type Network, type State } from '@/lib/store'
import { newMnemonic, parseSecret } from '@/lib/wallet'
import type { Pending } from '../background'

const app = document.getElementById('app')!
let error = ''
let seed = '' // freshly generated phrase, shown once and only saved after the user confirms
let pendingPassword: string | undefined // vault password entered alongside it (first wallet only)

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
const httpUrl = (s: string) => {
  if (!/^https?:\/\/\S+$/.test(s)) throw new Error('RPC must be an http(s) URL')
  return s
}

function walletForm(first: boolean) {
  // spellcheck off: browsers' cloud ("enhanced") spellcheck would otherwise upload whatever is typed here
  const secret = h('textarea', { rows: 3, placeholder: 'Seed phrase or private key', spellcheck: false, autocomplete: 'off', autocapitalize: 'off' })
  const pw = field('Password (min 8 characters)', { type: 'password' })
  const pw2 = field('Repeat password', { type: 'password' })
  const password = () => {
    if (!first) return undefined
    if (pw.input.value.length < 8) throw new Error('Password must be at least 8 characters')
    if (pw.input.value !== pw2.input.value) throw new Error('Passwords do not match')
    return pw.input.value
  }
  const generate = act(() => {
    pendingPassword = password()
    seed = newMnemonic()
  })
  return [
    ...(first ? [pw.el, pw2.el] : []),
    h('button', { onclick: generate }, 'Generate new wallet'),
    secret,
    h('button', { onclick: act(() => addWallet(parseSecret(secret.value), password())) }, 'Import'),
  ]
}
const seedScreen = () => [
  h('h1', {}, 'Your seed phrase'),
  h('p', {}, 'Write it down. It is the only backup and will not be shown again.'),
  h('pre', {}, seed),
  h('button', { onclick: () => navigator.clipboard.writeText(seed) }, 'Copy'),
  h('button', { onclick: act(async () => (await addWallet(seed, pendingPassword), (seed = ''), (pendingPassword = undefined))) }, 'I saved it, create wallet'),
  h('button', { onclick: act(() => (seed = '')) }, 'Cancel'),
]

function unlockScreen() {
  const pw = field('Password', { type: 'password', autofocus: true })
  const go = act(() => unlock(pw.input.value))
  pw.input.onkeydown = (e) => e.key === 'Enter' && go()
  return [h('h1', {}, 'Plain Wallet'), pw.el, h('button', { onclick: go }, 'Unlock')]
}

function describe(p: Pending): [title: string, body: string] {
  const d = p.detail
  try {
    switch (p.method) {
      case 'eth_requestAccounts':
        return ['Connect this site?', 'It will see your address and can ask you to sign.']
      case 'wallet_switchEthereumChain':
        return ['Switch network?', `${d.name} (chain ${d.id})`]
      case 'wallet_addEthereumChain':
        return ['Add and switch to this network?', `${d.name} (chain ${d.id}, ${d.symbol})\nRPC: ${d.rpc}\n\nAll your requests on it go through this RPC.`]
      case 'personal_sign':
        if (typeof d === 'string') return ['Sign message', d]
        try {
          const bytes = Uint8Array.from(d.raw.slice(2).match(/../g) ?? [], (b: string) => parseInt(b, 16))
          return ['Sign message', new TextDecoder('utf-8', { fatal: true }).decode(bytes)]
        } catch {
          return ['Sign message (raw bytes)', d.raw]
        }
      case 'eth_signTypedData_v4':
        return [`Sign typed data: ${d.primaryType}`, JSON.stringify({ domain: d.domain, message: d.message }, null, 2)]
      case 'eth_sendTransaction':
        return [
          d.to ? 'Send transaction' : 'Deploy contract',
          `To: ${d.to ?? '(new contract)'}\nValue: ${d.value} ${p.network.symbol}\nMax fee: ${d.fee} ${p.network.symbol}\nData: ${d.data}`,
        ]
    }
  } catch {}
  return [p.method, JSON.stringify(d, null, 2)]
}

function approvalScreen(p: Pending, more: number) {
  const [title, body] = describe(p)
  const settle = (ok: boolean) => act(() => browser.runtime.sendMessage({ type: 'settle', id: p.id, ok }))
  // Starts disabled: a window that pops up under the cursor, or the second half of a double-click on the previous
  // request, must not count as consent.
  const ok = h('button', { onclick: settle(true), disabled: true }, 'Approve')
  setTimeout(() => (ok.disabled = false), 800)
  return [
    h('h1', {}, title),
    h('div', { className: 'mono' }, p.origin),
    h('div', {}, `Network: ${p.network.name} (${p.network.id})`),
    h('div', { className: 'mono' }, `Account: ${p.account}`),
    h('pre', {}, body),
    h('div', { className: 'row' }, h('button', { onclick: settle(false) }, 'Reject'), ok),
    ...(more ? [h('div', {}, `${more} more request(s) waiting`)] : []),
  ]
}

function mainScreen(s: State) {
  const address = s.addresses[s.active]!
  const network = s.networks.find((n) => n.id === s.chainId)!
  const option = (value: number, text: string, selected: boolean) => h('option', { value, selected }, text)

  const wallets: HTMLSelectElement = h('select', { onchange: act(() => save({ active: Number(wallets.value) })) },
    ...s.addresses.map((a, i) => option(i, `${i + 1}: ${a.slice(0, 8)}…${a.slice(-6)}`, i === s.active)))
  const networks: HTMLSelectElement = h('select', { onchange: act(() => save({ chainId: Number(networks.value) })) },
    ...s.networks.map((n) => option(n.id, `${n.name} (${n.id})`, n.id === s.chainId)))

  const setNetworks = (list: Network[], chainId = s.chainId) => save({ networks: list, chainId })
  const rpc = field(`RPC endpoint for ${network.name}`, { value: network.rpc, spellcheck: false }) // may hold an API key
  rpc.input.onchange = act(() => setNetworks(s.networks.map((n) => (n === network ? { ...n, rpc: httpUrl(rpc.input.value.trim()) } : n))))

  const name = field('Name'), id = field('Chain ID', { type: 'number', min: 1 }), url = field('RPC URL'), symbol = field('Currency symbol', { value: 'ETH' })
  const add = act(() => {
    const n = { id: Number(id.input.value), name: name.input.value.trim(), rpc: httpUrl(url.input.value.trim()), symbol: symbol.input.value.trim() }
    if (!Number.isSafeInteger(n.id) || n.id <= 0 || !n.name || !n.symbol) throw new Error('Fill in every network field')
    if (s.networks.some((x) => x.id === n.id)) throw new Error('That chain ID already exists; edit its RPC instead')
    return setNetworks([...s.networks, n], n.id)
  })
  const remove = act(() => {
    const rest = s.networks.filter((n) => n !== network)
    return setNetworks(rest, rest[0]!.id)
  })

  return [
    h('div', { className: 'row' }, h('h1', {}, 'Plain Wallet'), h('span'), h('button', { onclick: act(lock) }, 'Lock')),
    wallets,
    h('button', { className: 'mono', title: 'Copy address', onclick: () => navigator.clipboard.writeText(address) }, address),
    networks,
    rpc.el,
    h('details', {}, h('summary', {}, 'Networks'), name.el, id.el, url.el, symbol.el,
      h('button', { onclick: add }, 'Add network'),
      h('button', { onclick: remove, disabled: s.networks.length < 2 }, `Remove ${network.name}`)),
    h('details', {}, h('summary', {}, 'Add wallet'), ...walletForm(false)),
    h('details', {}, h('summary', {}, `Connected sites (${s.sites.length})`),
      ...s.sites.map((site) => h('div', { className: 'row' }, h('span', { className: 'mono' }, site),
        h('button', { onclick: act(() => save({ sites: s.sites.filter((x) => x !== site) })) }, 'Disconnect')))),
  ]
}

async function render() {
  const s = await load()
  let screen: (Node | string)[]
  if (seed) screen = seedScreen()
  else if (!s.vault) screen = [h('h1', {}, 'Plain Wallet'), ...walletForm(true)]
  else if (!(await isUnlocked())) screen = unlockScreen()
  else {
    const pending: Pending[] = await browser.runtime.sendMessage({ type: 'pending' })
    screen = pending.length ? approvalScreen(pending[0]!, pending.length - 1) : mainScreen(s)
  }
  app.replaceChildren(h('div', { className: 'error' }, error), ...screen)
}

render()
// ponytail: MV3 kills an idle service worker after ~30s, which would drop in-memory approvals; an open popup keeps it awake
setInterval(() => browser.runtime.sendMessage({ type: 'ping' }), 20_000)

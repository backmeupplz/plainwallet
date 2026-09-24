import { erc20Abi, formatEther, formatUnits, hexToString, toHex } from 'viem'
import { readContract } from 'viem/actions'
import { client, mined, noRedirect, prepare, send, tokenInfo } from '@/lib/chain'
import { clean, describeCall, foreignSignIn, publicRpc, signedView } from '@/lib/describe'
import { allowanceOf, approveTickets, BASE, buyTicket, JACKPOT, megapotAbi, megapotSettings, tick, TICKETS_PER_APPROVAL, USDC } from '@/lib/megapot'
import { load, lock, reset, save, signer, type Network } from '@/lib/store'

// EIP-1193 / EIP-1474 error shape
const err = (code: number, message: string) => ({ code, message })
const big = (v?: string) => (v == null ? undefined : BigInt(v))
const size = (v: unknown) => { try { return JSON.stringify(v ?? null).length } catch { return Infinity } }

// `title`: the page's own title, only ever context for Jev.
export type Pending = { id: string; origin: string; title?: string; method: string; network: Network; account: string; summary?: string; danger?: boolean; detail: any }
const pending = new Map<string, Pending & { resolve: () => void; reject: (e: unknown) => void }>()
let win: Promise<{ id?: number } | undefined> | undefined
let generation = 0 // a reset also invalidates requests still preparing their approval
let resetting = false
// ponytail: a "site" is the last two host labels, standing in for the registrable domain (no public suffix list here),
// so a.github.io and b.github.io share one limit
const site = (origin: string) => new URL(origin).hostname.split('.').slice(-2).join('.')
const cooldown = new Map<string, number>() // site -> until when its requests are refused, after you rejected one
const reads = new Map<string, { since: number; count: number }>() // origin -> RPC calls forwarded in the current window

/** Queues a request for the user and resolves once they approve it in the popup (rejects with 4001 otherwise). */
function approve(p: Omit<Pending, 'id'>) {
  return new Promise<void>((resolve, reject) => {
    // A site can't flood the queue, spam approval windows (from subdomains either), or re-ask the moment you said no.
    if ((cooldown.get(site(p.origin)) ?? 0) > Date.now()) return reject(err(4001, 'You rejected this site moments ago; try again shortly'))
    if ([...pending.values()].filter((x) => site(x.origin) === site(p.origin)).length >= 5) return reject(err(-32005, 'Too many pending requests'))
    // Random, not a counter: a counter restarts with the service worker, so a stale approval window still showing
    // an old request could approve a newer one that happened to reuse its id.
    const id = crypto.randomUUID()
    pending.set(id, { ...p, id, resolve, reject })
    if (win) win.then((w) => void (w?.id && browser.windows.update(w.id, { focused: true })))
    else win = browser.windows.create({ url: browser.runtime.getURL('/popup.html'), type: 'popup', width: 380, height: 640 })
  })
}

function settle(id: string, ok: boolean) {
  const p = pending.get(id)
  pending.delete(id)
  if (ok) p?.resolve()
  else if (p) {
    cooldown.set(site(p.origin), Date.now() + 10_000)
    p.reject(err(4001, 'User rejected the request'))
  }
  // Forget the window as it closes: a request arriving meanwhile (a Megapot ticket right after a transaction) opens a new
  // one instead of landing in, and being rejected with, the closing one.
  if (!pending.size && win) {
    const closing = win
    win = undefined
    closing.then((w) => void (w?.id && browser.windows.remove(w.id)))
  }
}

// Plain Wallet's own requests (Megapot tickets) come from its own origin, never a site's.
const WALLET = new URL(browser.runtime.getURL('/')).origin
let counted = Promise.resolve()
/** Counts a transaction the wallet sent (not its own Megapot ones); every Nth, asks to buy a ticket for `account`. */
const sent = (account: string) => void (counted = counted.then(async () => {
  const { next, buy } = tick(megapotSettings((await browser.storage.local.get('megapot')).megapot))
  await browser.storage.local.set({ megapot: next })
  if (buy) void megapot(account).then(
    () => setMegapotError(undefined),
    (e) => { if (e?.code !== 4001) void setMegapotError(e?.shortMessage ?? e?.message ?? String(e)) }) // 4001: you rejected it
}).catch(console.error))
// Shown in Settings: nothing else is watching when a purchase fails (no USDC or gas on Base, a drawing being settled).
const setMegapotError = async (error?: string) => {
  const { megapot: m } = await browser.storage.local.get('megapot')
  await browser.storage.local.set({ megapot: { ...megapotSettings(m), error: error && clean(error, 160) } })
}

/** One ticket on Base: if the allowance ran out, an approval for the next ten first, each in its own approval window. */
async function megapot(account: string) {
  const s = await load()
  const index = s.addresses.indexOf(account as `0x${string}`)
  const network = s.networks.find((n) => n.id === BASE)
  if (index < 0) return
  if (!network) throw new Error('Add Base (8453) under networks to buy tickets')
  const from = account as `0x${string}`
  const c = client(network)
  const [price, allowance, balance] = await Promise.all([
    readContract(c, { address: JACKPOT, abi: megapotAbi, functionName: 'ticketPrice' }),
    readContract(c, allowanceOf(from)),
    readContract(c, { address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [from] }),
  ])
  const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`
  // Not worth a window you could only reject.
  if (balance < price) throw new Error(`the account had less than ${usdc(price)} on Base`)
  const walletTx = async (tx: { to: `0x${string}`; data: `0x${string}` }, step: 'approve' | 'buy', summary: string) => {
    const { request, fee } = await prepare(network, from, tx)
    await approve({ origin: WALLET, method: 'plainwallet_megapot', network, account, summary,
      detail: { step, to: tx.to, value: '0', fee: formatEther(fee), data: tx.data } })
    const receipt = await mined(network, await send(network, await signer(index, from), request))
    if (receipt.status !== 'success') throw new Error('The Megapot transaction reverted')
  }
  if (allowance < price) await walletTx(approveTickets(price), 'approve', `Lets Megapot's ticket buyer spend ${usdc(price * TICKETS_PER_APPROVAL)} of yours: the next ${TICKETS_PER_APPROVAL} tickets`)
  await walletTx(buyTicket(from), 'buy', `Buys 1 Megapot ticket for ${usdc(price)}, random numbers, sent to this account`)
}

async function handle(origin: string, method: unknown, rawParams: unknown, title?: string): Promise<unknown> {
  if (resetting) throw err(4001, 'Wallet is being reset')
  const started = generation
  if (typeof method !== 'string') throw err(-32600, 'Invalid request')
  const params: any[] = Array.isArray(rawParams) ? rawParams : []
  const s = await load()
  const network = s.networks.find((n) => n.id === s.chainId)!
  const address = s.addresses[s.active]
  // Per account: a site sees only the accounts you connected it to. Locking doesn't disconnect anything (a dapp would
  // drop its session): whatever needs a signature opens the wallet, which asks for the password before the approval.
  const connected = !!address && !!s.connections[origin]?.includes(address)
  const ask = async (detail: unknown, summary?: string, danger?: boolean) => {
    if (resetting || started !== generation) throw err(4001, 'Wallet was reset')
    await approve({ origin, title, method, network, account: address!, summary, danger, detail })
    // A request that arrived while locked showed unverified state; approving unlocked the wallet, so load() now
    // checks it (and throws if it was tampered with). It must still say what the approval showed.
    const now = await load()
    const same = now.addresses[s.active] === address && now.networks.some((n) => n.id === network.id && n.rpc === network.rpc)
    if (!same || (method !== 'eth_requestAccounts' && !now.connections[origin]?.includes(address!)))
      throw err(4001, 'Wallet changed while this was waiting; try again')
  }

  switch (method) {
    case 'eth_chainId':
      return toHex(s.chainId)
    case 'net_version':
      return String(s.chainId)
    case 'eth_accounts':
      return connected ? [address] : []
    case 'eth_requestAccounts':
      if (!address) throw err(4100, 'Open Plain Wallet and create a wallet first')
      if (!connected) {
        await ask(null)
        await save((now) => ({ connections: { ...now.connections, [origin]: [...new Set([...(now.connections[origin] ?? []), address])] } }))
      }
      return [address]
  }
  if (!connected) throw err(4100, 'Site is not connected; call eth_requestAccounts first')

  switch (method) {
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain': {
      const c = params[0] ?? {}
      const id = Number(c.chainId)
      if (id === s.chainId) return null
      const known = s.networks.find((n) => n.id === id)
      if (!known) {
        if (method === 'wallet_switchEthereumChain') throw err(4902, 'Unrecognized chain; add it first')
        // Sites like chainlist.org send every RPC they know of: take the first one we'd accept.
        const rpc = Array.isArray(c.rpcUrls) ? c.rpcUrls.find(publicRpc) : undefined
        if (!Number.isSafeInteger(id) || id <= 0 || typeof c.chainName !== 'string' || !publicRpc(rpc))
          throw err(-32602, 'Invalid chain parameters (the RPC must be a public https URL)')
        // clean() collapses whitespace: newlines in a name could push the real chain id and RPC out of view
        const added = { id, name: clean(c.chainName, 40), rpc, symbol: clean(c.nativeCurrency?.symbol ?? 'ETH', 10) }
        // A site can call its network anything: point out a name borrowed from one you already have.
        const lookalike = s.networks.find((n) => added.name.toLowerCase().includes(n.name.toLowerCase()))
        await ask(added, lookalike && `This is not your ${lookalike.name}, which is chain ${lookalike.id}`, !!lookalike)
        await save((now) => ({ networks: [...now.networks.filter((n) => n.id !== id), added], chainId: id }))
        return null
      }
      await ask(known)
      await save({ chainId: id })
      return null
    }

    case 'personal_sign':
    case 'eth_signTypedData_v4':
    case 'eth_sendTransaction': {
      const from = method === 'personal_sign' ? params[1] : method === 'eth_sendTransaction' ? params[0]?.from : params[0]
      if (typeof from !== 'string' || from.toLowerCase() !== address?.toLowerCase()) throw err(4100, 'Unknown account')
      const sign = () => signer(s.active, address!)

      if (method === 'personal_sign') {
        const data = String(params[0])
        const message = /^0x([0-9a-f]{2})*$/i.test(data) ? { raw: data as `0x${string}` } : data
        // EIP-4361: a sign-in message has to be for the site asking, or a phishing site could log in as you elsewhere.
        const foreign = foreignSignIn(typeof message === 'string' ? message : hexToString(message.raw), origin)
        if (foreign) throw err(-32602, `Refused: this sign-in message is for ${foreign}, not ${origin}`)
        await ask(message)
        return (await sign()).signMessage({ message })
      }
      if (method === 'eth_signTypedData_v4') {
        const td = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
        if (td?.domain?.chainId != null && Number(td.domain.chainId) !== s.chainId)
          throw err(-32602, 'Typed data chainId does not match the active network')
        const { view, summary } = signedView(td)
        await ask(view, summary, !!summary)
        return (await sign()).signTypedData(td)
      }
      const tx = params[0] ?? {}
      // Prepared BEFORE asking: the approval shows the real gas cost (a dapp or a lying RPC could otherwise burn the
      // balance as fees).
      // ponytail: nonce + fees always come from the RPC, dapp-suggested ones are ignored; pass them through if a dapp needs it
      const { request, fee } = await prepare(network, address!, { to: tx.to || undefined, data: tx.data ?? tx.input, value: big(tx.value), gas: big(tx.gas) })
      // Symbol/decimals only make the summary readable (who gets what comes from the calldata itself): from the
      // wallet's own token list where it has the token, otherwise from the RPC.
      const listed = s.tokens[network.id]?.find((t) => t.address.toLowerCase() === request.to?.toLowerCase())
      const summary = describeCall(request.data, listed ?? (request.to ? await tokenInfo(network, request.to).catch(() => undefined) : undefined))
      await ask({ to: request.to ?? null, value: formatEther(request.value ?? 0n), fee: formatEther(fee), data: request.data ?? '0x' }, summary, !!summary && /UNLIMITED|ALL your/.test(summary))
      const hash = await send(network, await sign(), request)
      mined(network, hash).catch(() => {})
      sent(address!)
      return hash
    }
  }

  // Forward only the standard read/broadcast namespaces: the user's RPC may be their own node with admin_,
  // personal_, debug_ or a dev node's cheat methods enabled. Node-side signing and subscriptions are never forwarded.
  if (!/^(eth|net|web3)_/.test(method) || /^eth_(sign|sendTransaction|subscribe|unsubscribe)/.test(method)) throw err(4200, `${method} is not supported`)
  // A connected site can't use the wallet to hammer (or run up the bill on) your RPC.
  const used = reads.get(origin)
  if (used && Date.now() - used.since < 10_000) {
    if (++used.count > 200) throw err(-32005, 'Too many requests; slow down')
  } else reads.set(origin, { since: Date.now(), count: 1 })
  const res = await fetch(network.rpc, {
    ...noRedirect,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: rawParams ?? [] }),
  })
  const json = await res.json()
  if (json.error) throw json.error
  return json.result
}

export default defineBackground(() => {
  browser.alarms.onAlarm.addListener((alarm) => alarm.name === 'lock' && lock()) // armed in lib/store.ts

  // Content scripts run inside the website's process. Keep the vault ciphertext and the permission/network/address
  // state out of their reach, so a renderer exploit can neither copy the vault nor rewrite them. Chrome only: Firefox
  // has no such switch, which is why lib/store.ts signs the state.
  browser.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error)

  // ...which means provider events have to be pushed to the bridges from here. Only to sites connected before or
  // after the change: for any other site the timing alone could link your visits.
  browser.storage.onChanged.addListener(async (changes, area) => {
    const changed = (k: string) => k in changes && JSON.stringify(changes[k]!.oldValue) !== JSON.stringify(changes[k]!.newValue)
    if (area !== 'local') return
    const chain = changed('chainId')
    const accounts = ['active', 'connections', 'addresses'].some(changed)
    if (!chain && !accounts) return
    const now = (await load().catch(() => undefined))?.connections ?? {}
    const before = (changes.connections?.oldValue ?? {}) as Record<string, string[]>
    for (const tab of await browser.tabs.query({})) {
      const origin = tab.url && URL.canParse(tab.url) ? new URL(tab.url).origin : ''
      if (tab.id && (now[origin] || before[origin])) browser.tabs.sendMessage(tab.id, { chain, accounts }).catch(() => {})
    }
  })

  browser.windows.onRemoved.addListener(async (id) => {
    if ((await win)?.id !== id) return
    win = undefined
    for (const p of [...pending.keys()]) settle(p, false)
  })

  browser.runtime.onMessage.addListener((msg, sender, respond) => {
    // Our own pages (popup / approval window). Web pages can't reach this: no externally_connectable.
    if (sender.url?.startsWith(browser.runtime.getURL('/'))) {
      if (msg.type === 'pending') respond([...pending.values()].map(({ resolve, reject, ...p }) => p))
      else if (msg.type === 'settle') respond(settle(msg.id, msg.ok))
      else if (msg.type === 'sent') respond(sent(msg.account)) // from the popup's own Send
      else if (msg.type === 'reset') {
        if (resetting) { respond({ error: 'Wallet is already being reset' }); return }
        resetting = true
        generation++
        for (const p of pending.values()) p.reject(err(4001, 'Wallet was reset'))
        pending.clear()
        // Keep the initiating popup open so it can show setup (or a storage error).
        reset().then(
          () => { resetting = false; respond({}) },
          (e) => { resetting = false; respond({ error: e.message }) },
        )
        return true
      }
      else respond(null) // ping
      return
    }
    // Content script. The origin comes from the browser, never from the page.
    const origin = sender.origin ?? new URL(sender.url!).origin
    // https only (plus local dev servers): on plain http anyone on the network path could inject a page that talks to
    // the wallet as that site. Sandboxed pages all report the origin "null"; approving one would connect every such page.
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return respond({ error: err(4100, 'Plain Wallet only works on https sites') })
    // A site can't freeze the approval window, or the wallet, with a huge payload.
    if (size(msg.params) > 512_000) return respond({ error: err(-32602, 'Request too large') })
    handle(origin, msg.method, msg.params, sender.tab?.title && clean(sender.tab.title, 80)).then(
      (result) => respond({ result }),
      (e) => respond({ error: { code: e?.code ?? -32603, message: e?.shortMessage ?? e?.message ?? String(e) } }),
    )
    return true
  })
})

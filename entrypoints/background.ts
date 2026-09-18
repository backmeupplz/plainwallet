import { createWalletClient, defineChain, formatEther, http, toHex, type TransactionSerializable } from 'viem'
import { getTransactionCount, readContract } from 'viem/actions'
import { clean, describeCall, signedView, TOKEN_ABI } from '@/lib/describe'
import { load, lock, save, secrets, type Network } from '@/lib/store'

// An RPC may not redirect: a dapp-supplied https URL could otherwise bounce the extension's requests (sent with its
// own host permissions) to a device on the user's network.
const noRedirect = { redirect: 'error' } as const
import { toAccount } from '@/lib/wallet'

// EIP-1193 / EIP-1474 error shape
const err = (code: number, message: string) => ({ code, message })
const big = (v?: string) => (v == null ? undefined : BigInt(v))

export type Pending = { id: string; origin: string; method: string; network: Network; account: string; summary?: string; detail: any }
const pending = new Map<string, Pending & { resolve: () => void; reject: (e: unknown) => void }>()
let win: Promise<{ id?: number } | undefined> | undefined

/** Queues a request for the user and resolves once they approve it in the popup (rejects with 4001 otherwise). */
function approve(p: Omit<Pending, 'id'>) {
  return new Promise<void>((resolve, reject) => {
    // a site can't flood the queue or spam approval windows
    if ([...pending.values()].filter((x) => x.origin === p.origin).length >= 5) return reject(err(-32005, 'Too many pending requests'))
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
  else p?.reject(err(4001, 'User rejected the request'))
  if (!pending.size) win?.then((w) => void (w?.id && browser.windows.remove(w.id)))
}

async function handle(origin: string, method: unknown, rawParams: unknown): Promise<unknown> {
  if (typeof method !== 'string') throw err(-32600, 'Invalid request')
  const params: any[] = Array.isArray(rawParams) ? rawParams : []
  const s = await load()
  const network = s.networks.find((n) => n.id === s.chainId)!
  const address = s.addresses[s.active]
  const connected = s.sites.includes(origin)
  const ask = (detail: unknown, summary?: string) => approve({ origin, method, network, account: address!, summary, detail })

  switch (method) {
    case 'eth_chainId':
      return toHex(s.chainId)
    case 'net_version':
      return String(s.chainId)
    case 'eth_accounts':
      return connected && address ? [address] : []
    case 'eth_requestAccounts':
      if (!address) throw err(4100, 'Open Plain Wallet and create a wallet first')
      if (!connected) {
        await ask(null)
        await save({ sites: [...new Set([...(await load()).sites, origin])] })
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
      if (!s.networks.some((n) => n.id === id)) {
        if (method === 'wallet_switchEthereumChain') throw err(4902, 'Unrecognized chain; add it first')
        const rpc = c.rpcUrls?.[0]
        // https only (plain http just for local dev nodes): the extension fetches this URL with its own host
        // permissions, so a dapp must not be able to point it at devices on the user's network.
        const okRpc = typeof rpc === 'string' && /^https:\/\/\S+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/.test(rpc)
        if (!Number.isSafeInteger(id) || id <= 0 || typeof c.chainName !== 'string' || !okRpc) throw err(-32602, 'Invalid chain parameters')
        // clean() collapses whitespace: newlines in a name could push the real chain id and RPC out of view
        const added = { id, name: clean(c.chainName, 40), rpc, symbol: clean(c.nativeCurrency?.symbol ?? 'ETH', 10) }
        await ask(added)
        await save({ networks: [...(await load()).networks, added], chainId: id })
        return null
      }
      await ask(s.networks.find((n) => n.id === id))
      await save({ chainId: id })
      return null
    }

    case 'personal_sign':
    case 'eth_signTypedData_v4':
    case 'eth_sendTransaction': {
      const from = method === 'personal_sign' ? params[1] : method === 'eth_sendTransaction' ? params[0]?.from : params[0]
      if (typeof from !== 'string' || from.toLowerCase() !== address?.toLowerCase()) throw err(4100, 'Unknown account')
      // `addresses` in storage is plaintext and unauthenticated, the vault is not: make sure they agree.
      const sign = async () => {
        const account = toAccount((await secrets())[s.active]!)
        if (account.address !== address) throw err(-32603, 'Vault does not match the selected account')
        return account
      }

      if (method === 'personal_sign') {
        const data = String(params[0])
        const message = /^0x([0-9a-f]{2})*$/i.test(data) ? { raw: data as `0x${string}` } : data
        await ask(message)
        return (await sign()).signMessage({ message })
      }
      if (method === 'eth_signTypedData_v4') {
        const td = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]
        if (td?.domain?.chainId != null && Number(td.domain.chainId) !== s.chainId)
          throw err(-32602, 'Typed data chainId does not match the active network')
        const { view, summary } = signedView(td)
        await ask(view, summary)
        return (await sign()).signTypedData(td)
      }
      const tx = params[0] ?? {}
      const chain = defineChain({
        id: network.id,
        name: network.name,
        nativeCurrency: { name: network.symbol, symbol: network.symbol, decimals: 18 },
        rpcUrls: { default: { http: [network.rpc] } },
      })
      const client = createWalletClient({ account: address!, chain, transport: http(network.rpc, { fetchOptions: noRedirect }) })
      // Prepared BEFORE asking, and that exact request is what gets signed: the approval shows the real gas cost
      // (a dapp or a lying RPC could otherwise burn the balance as fees) and nothing can change after the click.
      // ponytail: nonce + fees always come from the RPC, dapp-suggested ones are ignored; pass them through if a dapp needs it
      const request = await client.prepareTransactionRequest({
        to: tx.to || undefined,
        data: tx.data ?? tx.input,
        value: big(tx.value),
        gas: big(tx.gas),
      })
      // Not client.sendTransaction: it signs for whatever chain the RPC *claims* to be, so a mislabeled network
      // could yield a signature valid on a chain the user never saw in the approval. Check, then sign offline.
      if (request.chainId !== network.id) throw err(-32603, `RPC serves chain ${request.chainId}, not ${network.name} (${network.id})`)
      const fee = request.gas * (request.maxFeePerGas ?? request.gasPrice ?? 0n)
      // symbol/decimals only make the summary readable; who gets what comes from the calldata itself
      const token = (functionName: 'symbol' | 'decimals') =>
        request.to ? readContract(client, { address: request.to, abi: TOKEN_ABI, functionName }).catch(() => undefined) : undefined
      const summary = describeCall(request.data, { symbol: (await token('symbol')) as string, decimals: (await token('decimals')) as number })
      await ask({ to: request.to ?? null, value: formatEther(request.value ?? 0n), fee: formatEther(fee), data: request.data ?? '0x' }, summary)
      // Only the nonce is refreshed after the click (it isn't shown and can't redirect funds): requests queued
      // together were all prepared at the same nonce.
      const nonce = await getTransactionCount(client, { address: address!, blockTag: 'pending' })
      const { account: _, ...unsigned } = { ...request, nonce }
      return client.sendRawTransaction({ serializedTransaction: await (await sign()).signTransaction(unsigned as TransactionSerializable) })
    }
  }

  // Forward only the standard read/broadcast namespaces: the user's RPC may be their own node with admin_,
  // personal_, debug_ or a dev node's cheat methods enabled. Node-side signing and subscriptions are never forwarded.
  if (!/^(eth|net|web3)_/.test(method) || /^eth_(sign|sendTransaction|subscribe|unsubscribe)/.test(method)) throw err(4200, `${method} is not supported`)
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
  // state out of their reach, so a renderer exploit can neither copy the vault nor rewrite them.
  browser.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(console.error)

  // ...which means provider events have to be pushed to the bridges from here.
  browser.storage.onChanged.addListener(async (changes, area) => {
    const msg = { chain: 'chainId' in changes, accounts: ['active', 'sites', 'addresses'].some((k) => k in changes) }
    if (area !== 'local' || !(msg.chain || msg.accounts)) return
    for (const tab of await browser.tabs.query({})) if (tab.id) browser.tabs.sendMessage(tab.id, msg).catch(() => {})
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
      else respond(null) // ping
      return
    }
    // Content script. The origin comes from the browser, never from the page.
    const origin = sender.origin ?? new URL(sender.url!).origin
    // sandboxed pages all report the origin "null"; approving one would connect every such page on any site
    if (!/^https?:\/\//.test(origin)) return respond({ error: err(4100, 'Unsupported origin') })
    handle(origin, msg.method, msg.params).then(
      (result) => respond({ result }),
      (e) => respond({ error: { code: e?.code ?? -32603, message: e?.shortMessage ?? e?.message ?? String(e) } }),
    )
    return true
  })
})

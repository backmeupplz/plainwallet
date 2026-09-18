import { createWalletClient, defineChain, http, toHex, type TransactionSerializable } from 'viem'
import { load, save, secrets, type Network } from '@/lib/store'
import { toAccount } from '@/lib/wallet'

// EIP-1193 / EIP-1474 error shape
const err = (code: number, message: string) => ({ code, message })
const big = (v?: string) => (v == null ? undefined : BigInt(v))

export type Pending = { id: number; origin: string; method: string; network: Network; detail: any }
const pending = new Map<number, Pending & { resolve: () => void; reject: (e: unknown) => void }>()
let nextId = 1
let win: Promise<{ id?: number } | undefined> | undefined

/** Queues a request for the user and resolves once they approve it in the popup (rejects with 4001 otherwise). */
function approve(p: Omit<Pending, 'id'>) {
  return new Promise<void>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { ...p, id, resolve, reject })
    if (win) win.then((w) => void (w?.id && browser.windows.update(w.id, { focused: true })))
    else win = browser.windows.create({ url: browser.runtime.getURL('/popup.html'), type: 'popup', width: 380, height: 640 })
  })
}

function settle(id: number, ok: boolean) {
  const p = pending.get(id)
  pending.delete(id)
  if (ok) p?.resolve()
  else p?.reject(err(4001, 'User rejected the request'))
  if (!pending.size) win?.then((w) => void (w?.id && browser.windows.remove(w.id)))
}

async function handle(origin: string, method: string, params: any[] = []): Promise<unknown> {
  const s = await load()
  const network = s.networks.find((n) => n.id === s.chainId)!
  const address = s.addresses[s.active]
  const connected = s.sites.includes(origin)
  const ask = (detail: unknown) => approve({ origin, method, network, detail })

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
        await ask(address)
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
        if (!Number.isSafeInteger(id) || id <= 0 || typeof c.chainName !== 'string' || !/^https?:\/\//.test(rpc))
          throw err(-32602, 'Invalid chain parameters')
        const added = { id, name: c.chainName.slice(0, 40), rpc, symbol: String(c.nativeCurrency?.symbol ?? 'ETH').slice(0, 10) }
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
      const sign = async () => toAccount((await secrets())[s.active]!)

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
        await ask(td)
        return (await sign()).signTypedData(td)
      }
      const tx = params[0]
      await ask(tx)
      const chain = defineChain({
        id: network.id,
        name: network.name,
        nativeCurrency: { name: network.symbol, symbol: network.symbol, decimals: 18 },
        rpcUrls: { default: { http: [network.rpc] } },
      })
      const account = await sign()
      const client = createWalletClient({ account, chain, transport: http(network.rpc) })
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
      return client.sendRawTransaction({ serializedTransaction: await account.signTransaction(request as TransactionSerializable) })
    }
  }

  if (method.startsWith('wallet_') || /^eth_sign|^eth_subscribe|^eth_unsubscribe/.test(method)) throw err(4200, `${method} is not supported`)
  const res = await fetch(network.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  if (json.error) throw json.error
  return json.result
}

export default defineBackground(() => {
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
    handle(origin, msg.method, msg.params).then(
      (result) => respond({ result }),
      (e) => respond({ error: { code: e?.code ?? -32603, message: e?.shortMessage ?? e?.message ?? String(e) } }),
    )
    return true
  })
})

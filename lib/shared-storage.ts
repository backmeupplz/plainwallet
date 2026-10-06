// The Mac app and its Safari extension share one wallet: storage.local for both is a file in the app's app group
// (macos/Shared/Storage.swift), read and written through the app (the wallet page's bridge) or the extension's native
// handler. Signed state uses compare-and-set under the native file lock; Web Locks cannot span these two origins.
type Reply = { values?: Record<string, string>; committed?: boolean; error?: string } | undefined

/** A storage.local on `send`, which reaches Storage.swift. Values travel as JSON text; `null` deletes. */
export function nativeLocal(send: (msg: object) => Promise<Reply>, wrote = async (_items: Record<string, unknown> | null) => {}) {
  const call = async (msg: object) => {
    const reply = await send(msg)
    if (!reply || reply.error) throw new Error(reply?.error ?? 'The Plain Wallet app did not answer')
    return reply.values ?? {}
  }
  const write = async (items: Record<string, unknown>) => {
    await call({ set: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v === undefined ? null : JSON.stringify(v)])) })
    await wrote(items)
  }
  return {
    // A distinct request and explicit acknowledgement fail closed against an older native handler.
    compareAndSet: async (expected: Record<string, unknown>, items: Record<string, unknown>) => {
      const encode = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === undefined ? null : JSON.stringify(v)]))
      const reply = await send({ compareAndSet: { expected: encode(expected), set: encode(items) } })
      if (!reply || reply.error) throw new Error(reply?.error ?? 'The Plain Wallet app did not answer')
      if (reply.committed !== true) throw new Error('Wallet changed in another window; reopen it and try again')
      await wrote(items)
    },
    get: async (keys?: string | string[] | null) =>
      Object.fromEntries(Object.entries(await call({ get: keys == null ? null : [keys].flat() })).map(([k, v]) => [k, JSON.parse(v)])),
    set: write,
    remove: (keys: string | string[]) => write(Object.fromEntries([keys].flat().map((k) => [k, undefined]))),
    clear: async () => {
      await call({ clear: true })
      await wrote(null)
    },
  }
}

// In Safari, storage.local becomes the app's. Writes are mirrored into Safari's own storage.local only so that
// storage.onChanged still tells the background which sites to send chainChanged / accountsChanged; nothing reads it.
// Changes made in the app send no such events. Safari's own `browser`, not wxt/browser's: the apps' shim imports this
// file before it sets up theirs.
if (import.meta.env?.SAFARI) {
  const browser = (globalThis as any).browser
  const mirror = browser.storage.local
  Object.defineProperty(browser.storage, 'local', {
    configurable: true,
    value: nativeLocal((msg) => browser.runtime.sendNativeMessage('com.borodutch.plainwallet', msg), async (items) => {
      if (!items) return mirror.clear()
      const removed = Object.keys(items).filter((k) => items[k] === undefined)
      await mirror.set(Object.fromEntries(Object.entries(items).filter(([, v]) => v !== undefined)))
      if (removed.length) await mirror.remove(removed)
    }),
  })
}

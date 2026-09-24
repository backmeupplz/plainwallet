import { version } from '@/package.json'

// Android app only (android/). The slice of the extension API that background.ts and the popup use, for the app's
// wallet page (entrypoints/android/), which runs both. Loaded as a classic script before them, so `wxt/browser` finds
// it. Everything outside this page goes through the app (MainActivity.java): showing this page over the browser,
// opening sites, and relaying site requests, whose origin the app takes from the WebView, never from the site.
export default defineUnlistedScript({
  include: ['android'],
  main() {
    const native = (globalThis as any).plainwalletNative // the app injects it into this page's origin only
    const toNative = (msg: object) => native.postMessage(JSON.stringify(msg))
    // Messages and storage hand out copies, as the browser does.
    const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
    const event = <F extends (...args: any[]) => unknown>() => {
      const fns = new Set<F>()
      return { fns, addListener: (fn: F) => void fns.add(fn), fire: (...args: Parameters<F>) => fns.forEach((fn) => fn(...args)) }
    }

    // Alarms (only the auto-lock) are deadlines, checked every second and before anything reads the session: timers
    // don't run while Android has the app frozen in the background.
    const alarm = event<(a: { name: string }) => void>()
    const alarms = new Map<string, number>()
    const due = () => alarms.forEach((at, name) => { if (at <= Date.now()) { alarms.delete(name); alarm.fire({ name }) } })
    setInterval(due, 1000)

    const changed = event<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void>()
    type Backing = { get(k: string): string | null | undefined; set(k: string, v: string): void; delete(k: string): void; keys(): string[] }
    const area = (name: string, store: Backing) => {
      const read = (k: string) => { const v = store.get(k); return v == null ? undefined : JSON.parse(v) }
      const write = async (entries: [string, unknown][]) => {
        const changes = Object.fromEntries(entries.map(([k, v]) => [k, { oldValue: read(k), newValue: clone(v) }]))
        for (const [k, v] of entries) v === undefined ? store.delete(k) : store.set(k, JSON.stringify(v))
        setTimeout(() => changed.fire(changes, name))
      }
      return {
        get: async (keys?: string | string[]) => {
          if (name === 'session') due()
          return Object.fromEntries((keys == null ? store.keys() : [keys].flat()).map((k) => [k, read(k)]).filter(([, v]) => v !== undefined))
        },
        set: (items: Record<string, unknown>) => write(Object.entries(items)),
        remove: (keys: string | string[]) => write([keys].flat().map((k) => [k, undefined])),
        clear: () => write(store.keys().map((k) => [k, undefined])),
      }
    }
    // local: this page's localStorage, which no site can reach (a different origin). session: memory, so the unlock
    // key goes when the app's process does, like with a browser restart.
    const session = new Map<string, string>()
    const storage = {
      local: area('local', { get: (k) => localStorage.getItem(k), set: (k, v) => localStorage.setItem(k, v), delete: (k) => localStorage.removeItem(k), keys: () => Object.keys(localStorage) }),
      session: area('session', { get: (k) => session.get(k), set: (k, v) => session.set(k, v), delete: (k) => session.delete(k), keys: () => [...session.keys()] }),
      onChanged: changed,
    }

    const message = event<(msg: any, sender: object, respond: (response?: unknown) => void) => unknown>()
    /** Like runtime.sendMessage: resolves with the first response, or undefined if no listener will answer. */
    const deliver = (msg: unknown, sender: object) => new Promise<any>((resolve) => {
      let later = false
      for (const fn of message.fns) if (fn(clone(msg), sender, (response) => resolve(clone(response))) === true) later = true
      if (!later) resolve(undefined)
    })

    // The "approval window" is this page, brought up over the browser.
    let open = false
    const removed = event<(id: number) => void>()
    const show = async () => {
      open = true
      toNative({ type: 'show' })
      dispatchEvent(new Event('plainwallet-render'))
      return { id: 1 }
    }
    // The one tab: whatever the browser shows.
    let page = { url: '', title: '' }
    const origin = (url: string) => (URL.canParse(url) ? new URL(url).origin : 'null')

    type Favorite = { url: string; title: string }
    const favorites = async (): Promise<Favorite[]> => (await storage.local.get('favorites')).favorites ?? []
    const starred = async () => toNative({ type: 'starred', on: (await favorites()).some((f) => f.url === page.url) })

    const api = {
      runtime: {
        id: 'plainwallet',
        getURL: (path: string) => new URL(path, location.origin).href,
        getManifest: () => ({ name: 'Plain Wallet', version }),
        // From this page: the background's trusted branch, which checks sender.url.
        sendMessage: (msg: unknown) => deliver(msg, { url: location.href }),
        onMessage: message,
      },
      storage,
      alarms: {
        create: async (name: string, { delayInMinutes }: { delayInMinutes: number }) => void alarms.set(name, Date.now() + delayInMinutes * 60_000),
        clear: async (name: string) => alarms.delete(name),
        onAlarm: alarm,
      },
      windows: {
        create: show,
        update: show,
        remove: async () => { open = false; toNative({ type: 'hide' }) },
        getCurrent: async () => ({ id: 1 }),
        onRemoved: removed,
      },
      tabs: {
        create: async ({ url }: { url: string }) => toNative({ type: 'open', url }),
        query: async () => (page.url ? [{ id: 1, ...page }] : []),
        // The app delivers it only if the browser still shows that origin.
        sendMessage: async (_id: number, msg: unknown) => toNative({ type: 'event', origin: origin(page.url), data: JSON.stringify(msg) }),
      },
    }
    ;(globalThis as any).browser = (globalThis as any).chrome = api

    native.onmessage = async ({ data }: { data: string }) => {
      const msg = JSON.parse(data)
      switch (msg.type) {
        case 'request': { // a site's request, with the origin the app got from the WebView
          let request
          try { request = JSON.parse(msg.data) } catch { return }
          // Only the method and params come from the site: no sender.url, so never the trusted branch.
          const response = await deliver({ method: request?.method, params: request?.params }, { origin: origin(msg.origin), tab: { id: 1, title: msg.title } })
          return toNative({ type: 'reply', n: msg.n, origin: msg.origin, data: JSON.stringify({ id: request?.id, ...response }) })
        }
        case 'page': // the browser moved on
          page = { url: msg.url, title: msg.title ?? '' }
          return starred()
        case 'star': {
          if (!page.url) return
          const list = await favorites()
          const on = list.some((f) => f.url === page.url)
          await storage.local.set({ favorites: on ? list.filter((f) => f.url !== page.url) : [...list, page] })
          return starred()
        }
        case 'shown': // you brought this page up
          return dispatchEvent(new Event('plainwallet-render'))
        case 'back': // you backed out of an approval: like closing its window, which rejects what's waiting
          if (open) { open = false; removed.fire(1) }
      }
    }
    toNative({ type: 'ready' })
  },
})

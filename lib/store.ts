// Extension state. Public data + encrypted vault in storage.local; the vault key only in storage.session
// (trusted contexts only, wiped on browser restart / extension reload).
import { arbitrum, avalanche, base, bsc, gnosis, mainnet, optimism, polygon } from 'viem/chains'
import { browser } from 'wxt/browser'
import { decryptVault, deriveKey, encryptVault, newSalt, toAccount } from './wallet'

export type Network = { id: number; name: string; rpc: string; symbol: string }

const defaults = {
  vault: '',
  addresses: [] as `0x${string}`[], // index-aligned with the secrets inside the vault
  active: 0,
  chainId: 1,
  networks: [mainnet, base, arbitrum, optimism, polygon, bsc, avalanche, gnosis].map(
    (c): Network => ({ id: c.id, name: c.name, rpc: c.rpcUrls.default.http[0], symbol: c.nativeCurrency.symbol }),
  ),
  sites: [] as string[], // connected origins
}
export type State = typeof defaults

export const load = async (): Promise<State> => ({ ...defaults, ...(await browser.storage.local.get()) })
export const save = (patch: Partial<State>) => browser.storage.local.set(patch)

const sessionKey = async () => (await browser.storage.session.get('key')).key as string | undefined
export const isUnlocked = async () => !!(await sessionKey())
export const lock = () => browser.storage.session.clear()

/** Auto-lock: (re)armed on unlock and on every use of the popup. An alarm, because it outlives the service worker. */
export const AUTO_LOCK_MINUTES = 15
export const touch = () => browser.alarms.create('lock', { delayInMinutes: AUTO_LOCK_MINUTES })
const setKey = async (key: string) => (await browser.storage.session.set({ key }), touch())

export async function unlock(password: string) {
  const { vault } = await load()
  const key = await deriveKey(password, JSON.parse(vault).salt)
  await decryptVault(key, vault).catch(() => Promise.reject(new Error('Wrong password')))
  await setKey(key)
}

export async function secrets(): Promise<string[]> {
  const key = await sessionKey()
  if (!key) throw new Error('Wallet is locked')
  return decryptVault(key, (await load()).vault)
}

/** Adds a wallet and makes it active. `password` is only needed (and used) to create the vault. */
export async function addWallet(secret: string, password?: string) {
  const { vault, addresses } = await load()
  const address = toAccount(secret).address
  if (addresses.includes(address)) throw new Error('Wallet already added')
  if (!vault && !password) throw new Error('Password required') // never derive a vault key from an empty password
  const salt = vault ? JSON.parse(vault).salt : newSalt()
  const key = vault ? await sessionKey() : await deriveKey(password!, salt)
  if (!key) throw new Error('Wallet is locked')
  const all = [...(vault ? await decryptVault(key, vault) : []), secret]
  await save({ vault: await encryptVault(key, salt, all), addresses: [...addresses, address], active: addresses.length })
  await setKey(key)
}

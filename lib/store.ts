// Extension state. Public data + encrypted vault in storage.local; the vault key only in storage.session
// (trusted contexts only, wiped on browser restart / extension reload). Firefox also lets content scripts, i.e. code in
// a website's process, read and write storage.local: so everything besides the self-authenticating vault carries a MAC
// under the vault key, and once unlocked the wallet refuses state it didn't write.
import { arbitrum, avalanche, base, bsc, gnosis, mainnet, optimism, polygon } from 'viem/chains'
import { browser } from 'wxt/browser'
import { toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { addressOf, decryptVault, deriveKey, encryptVault, mac, mnemonicOf, newMeta, toAccount, watched, type Secret, type VaultMeta } from './wallet'
import '@/lib/shared-storage' // Safari: storage.local is the Mac app's

export type Network = { id: number; name: string; rpc: string; symbol: string }
export type Token = { address: `0x${string}`; symbol: string; decimals: number }

const token = (address: `0x${string}`, symbol: string, decimals: number): Token => ({ address, symbol, decimals })

const defaults = {
  vault: '',
  mac: '', // over the SIGNED fields
  addresses: [] as `0x${string}`[], // index-aligned with the secrets inside the vault
  nicknames: {} as Record<string, string>,
  active: 0,
  chainId: 1,
  networks: [mainnet, base, arbitrum, optimism, polygon, bsc, avalanche, gnosis].map(
    (c): Network => ({ id: c.id, name: c.name, rpc: c.rpcUrls.default.http[0], symbol: c.nativeCurrency.symbol }),
  ),
  connections: {} as Record<string, string[]>, // origin -> the accounts it may see
  // per chain id; the built-in ones were checked against each chain's symbol() and decimals()
  tokens: {
    1: [
      token('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6),
      token('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'USDT', 6),
      token('0x6B175474E89094C44Da98b954EedeAC495271d0F', 'DAI', 18),
      token('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'WETH', 18),
      token('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 'WBTC', 8),
    ],
    8453: [
      token('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 6),
      token('0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 'USDT', 6),
      token('0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 'DAI', 18),
      token('0x4200000000000000000000000000000000000006', 'WETH', 18),
    ],
    42161: [
      token('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'USDC', 6),
      token('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 'USD₮0', 6),
      token('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI', 18),
      token('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 'WETH', 18),
      token('0x912CE59144191C1204E64559FE8253a0e49E6548', 'ARB', 18),
    ],
    10: [
      token('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 'USDC', 6),
      token('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 'USDT', 6),
      token('0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 'DAI', 18),
      token('0x4200000000000000000000000000000000000006', 'WETH', 18),
      token('0x4200000000000000000000000000000000000042', 'OP', 18),
    ],
    137: [
      token('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 'USDC', 6),
      token('0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 'USDT0', 6),
      token('0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 'DAI', 18),
      token('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 'WETH', 18),
    ],
    56: [
      token('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', 'USDC', 18),
      token('0x55d398326f99059fF775485246999027B3197955', 'USDT', 18),
      token('0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 'ETH', 18),
    ],
    43114: [
      token('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 'USDC', 6),
      token('0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 'USDt', 6),
      token('0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', 'WETH.e', 18),
    ],
    100: [
      token('0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', 'USDC.e', 6),
      token('0x4ECaBa5870353805a9F068101A40E0f32ed605C6', 'USDT', 6),
      token('0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', 'WETH', 18),
      token('0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb', 'GNO', 18),
    ],
  } as Record<number, Token[]>,
}
export type State = typeof defaults

const SIGNED = ['addresses', 'nicknames', 'active', 'chainId', 'networks', 'connections', 'tokens'] as const
const signed = (s: State) => Object.fromEntries(SIGNED.map((name) => [name, s[name]]))
export const TAMPERED = 'Wallet settings were changed outside Plain Wallet'

/** While locked nothing here is verified: whatever relies on it has to run after an unlock, i.e. after this check. */
export const load = async (): Promise<State> => checked(await browser.storage.local.get())

async function checked(raw: Partial<State>): Promise<State> {
  const s: State = { ...defaults, ...raw }
  const key = await sessionKey()
  if (key && s.mac !== (await mac(key, signed(s)))) throw new Error(TAMPERED)
  return s
}

/** Re-signs the whole state, so it needs the vault key; serialized, so concurrent writers don't drop each other's changes. */
export const save = (patch: Partial<State> | ((s: State) => Partial<State>), key?: string, expectedVault?: string) =>
  navigator.locks.request('state', async () => {
    const k = key ?? (await unlockedKey())
    const before = await browser.storage.local.get()
    const s = await checked(before)
    if (expectedVault !== undefined && s.vault !== expectedVault) throw new Error('Wallet changed in another window; reopen it and try again')
    await write(k, { ...s, ...(typeof patch === 'function' ? patch(s) : patch) }, before)
  })

// Every signed field is written out, defaults included: a later version changing a default must not break the MAC.
const write = async (key: string, s: State, before: Partial<Pick<State, 'vault' | 'mac'>>) => {
  const items = { ...signed(s), vault: s.vault, mac: await mac(key, signed(s)) }
  const local = browser.storage.local as typeof browser.storage.local & {
    compareAndSet?: (expected: Record<string, unknown>, items: Record<string, unknown>) => Promise<void>
  }
  // Native reads and writes cross processes. Check the vault AND signed state in the same file-lock transaction.
  if (local.compareAndSet) await local.compareAndSet({ vault: before.vault, mac: before.mac }, items)
  else await local.set(items) // browser origins share the state/vault Web Locks
}

/** After a failed integrity check: accounts come back from the vault, everything else starts over. */
export const repair = () =>
  navigator.locks.request('state', async () => {
    const key = await unlockedKey()
    const before = await browser.storage.local.get()
    const vault = (before.vault as string | undefined) ?? ''
    await write(key, { ...defaults, vault, addresses: (await decryptVault(key, vault)).map(addressOf) }, before)
  })

// The vault authenticates itself (AES-GCM), so reading it needs no MAC check.
const storedVault = async () => ((await browser.storage.local.get('vault')).vault as string | undefined) ?? ''

const sessionKey = async () => (await browser.storage.session.get('key')).key as string | undefined
const unlockedKey = async () => {
  const key = await sessionKey()
  if (!key) throw new Error('Wallet is locked')
  return key
}
export const isUnlocked = async () => !!(await sessionKey())
export const lock = () => browser.storage.session.clear()

/** Permanently deletes this extension's wallets, permissions and settings. No password needed. */
export const reset = () => navigator.locks.request('vault', async () => {
  await lock()
  await browser.storage.local.clear()
  await browser.alarms.clear('lock')
})

// Auto-lock off is stored as a MAC under the vault key: a website's process (Firefox) can delete it, which only turns
// auto-lock back on, but can't write it. Off still locks on browser restart (storage.session) and with the Lock button.
const NO_AUTOLOCK = 'auto-lock off'
export const autolock = async () => {
  const key = await sessionKey()
  return !key || (await browser.storage.local.get('noAutolock')).noAutolock !== (await mac(key, NO_AUTOLOCK))
}
export const setAutolock = async (on: boolean) => {
  if (on) await browser.storage.local.remove('noAutolock')
  else await browser.storage.local.set({ noAutolock: await mac(await unlockedKey(), NO_AUTOLOCK) })
  await touch()
}

/** Auto-lock: (re)armed on unlock and on every use of the popup. An alarm, because it outlives the service worker. */
export const touch = async () => (await autolock()) ? browser.alarms.create('lock', { delayInMinutes: 15 }) : browser.alarms.clear('lock')
const setKey = async (key: string) => (await browser.storage.session.set({ key }), touch())

export const unlock = (password: string) =>
  navigator.locks.request('vault', async () => {
    const vault = await storedVault()
    const meta: VaultMeta = JSON.parse(vault)
    let key = await deriveKey(password, meta)
    const all = await decryptVault(key, vault).catch(() => Promise.reject(new Error('Wrong password')))
    if (!meta.kdf) {
      // A 0.1.x vault: move it to scrypt and sign the state it kept in plaintext. Addresses are rebuilt from the vault
      // and connections start over (they are per account now), so nothing tampered with before the upgrade is kept.
      // Only a password-derived key opens the vault, so no one else can pass a vault off as old to get here.
      const next = newMeta()
      key = await deriveKey(password, next)
      const upgraded = await encryptVault(key, next, all)
      // Nothing is overwritten unless the new vault opens with the password again, from what was actually stored.
      const check = await decryptVault(await deriveKey(password, JSON.parse(upgraded)), upgraded)
      if (JSON.stringify(check) !== JSON.stringify(all)) throw new Error('Vault upgrade check failed; nothing was changed')
      await save({ vault: upgraded, addresses: all.map(addressOf), connections: {} }, key, vault)
      await browser.storage.local.remove('sites')
    }
    await setKey(key)
  })

/** Android fingerprint unlock: the vault key itself, which Android keeps behind your fingerprint. It has to open the
 * vault (AES-GCM authenticates), just as a password-derived key does. */
export const unlockWithKey = (key: string) =>
  navigator.locks.request('vault', async () => {
    await decryptVault(key, await storedVault()).catch(() => Promise.reject(new Error('Fingerprint unlock no longer fits this wallet; unlock with your password')))
    await setKey(key)
  })

export const secrets = async (): Promise<Secret[]> => decryptVault(await unlockedKey(), await storedVault())

/** The vault account at `index`. `addresses` in storage is plaintext and unauthenticated, the vault is not: make sure they agree. */
export async function signer(index: number, address: string) {
  const account = toAccount((await secrets())[index]!)
  if (account.address !== address) throw new Error('Vault does not match the selected account')
  return account
}

/** Watch-only accounts: their keys are on another device. Only addresses leave the vault here. */
export const watchedAddresses = async () => (await secrets()).flatMap((s) => watched(s) ?? [])

// Transactions exported from a watch-only account, as the request text the other device signs: kept until their
// signed copy is broadcast or you drop them, so closing the wallet in between loses nothing. Outside the MAC: a
// tampered entry can't get anything broadcast, which takes the other device's signature over exactly that entry, and
// that device shows what it signs on its own.
export const exported = async () => ((await browser.storage.local.get('offline')).offline as string[] | undefined) ?? []
export const keepExported = (request: string, keep: boolean) => navigator.locks.request('offline', async () => {
  const rest = (await exported()).filter((r) => r !== request)
  await browser.storage.local.set({ offline: keep ? [...rest, request] : rest })
})

/** Export always authenticates the supplied password, never the cached unlock key. */
export async function exportAccount(index: number, password: string) {
  const session = await unlockedKey()
  if (!password) throw new Error('Enter your password')
  const vault = await storedVault()
  const key = await deriveKey(password, JSON.parse(vault))
  const all = await decryptVault(key, vault).catch(() => { throw new Error('Wrong password') })
  if (await sessionKey() !== session || (await storedVault()) !== vault) throw new Error('Wallet changed or locked; try again')
  const secret = Number.isSafeInteger(index) && index >= 0 ? all[index] : undefined
  if (!secret) throw new Error('Select a stored account')
  if (watched(secret)) throw new Error('This account is watch-only: no seed phrase or key is stored for it here')
  const mnemonic = mnemonicOf(secret)
  const addressIndex = typeof secret === 'object' && 'addressIndex' in secret ? secret.addressIndex : 0
  return {
    mnemonic,
    privateKey: mnemonic ? toHex(mnemonicToAccount(mnemonic, { addressIndex }).getHdKey().privateKey!) : secret as string,
    path: mnemonic ? `m/44'/60'/0'/0/${addressIndex}` : undefined,
  }
}

/** Adds a wallet and makes it active. `password` is only needed (and used) to create the vault. */
export const addWallet = (secret: Secret, password?: string) => navigator.locks.request('vault', () => appendWallet(secret, password))

async function appendWallet(secret: Secret, password?: string, expectedVault?: string) {
  const { vault, addresses } = await load()
  if (expectedVault !== undefined && vault !== expectedVault) throw new Error('Seed source changed; reopen Manage accounts')
  const address = addressOf(secret)
  if (addresses.includes(address)) throw new Error(watched(secret) ? 'This address is already in the wallet' : 'Wallet already added')
  if (!vault && !password) throw new Error('Password required') // never derive a vault key from an empty password
  const meta: VaultMeta = vault ? JSON.parse(vault) : newMeta()
  const key = vault ? await unlockedKey() : await deriveKey(password!, meta)
  const all = [...(vault ? await decryptVault(key, vault) : []), secret]
  await save({ vault: await encryptVault(key, meta, all), addresses: [...addresses, address], active: addresses.length }, key, vault)
  await setKey(key)
}

/** Public source groups only: no seed words, keys or secret fingerprints leave the vault. */
export async function accountGroups() {
  const all = await secrets()
  const groups: { type: 'seed' | 'key' | 'watch'; accounts: { index: number; address: `0x${string}`; addressIndex?: number }[] }[] = []
  const seeds = new Map<string, number>()
  all.forEach((secret, index) => {
    const mnemonic = mnemonicOf(secret)
    const account = { index, address: addressOf(secret),
      ...(mnemonic ? { addressIndex: typeof secret === 'object' && 'addressIndex' in secret ? secret.addressIndex : 0 } : {}) }
    const group = mnemonic ? seeds.get(mnemonic) : undefined
    if (group !== undefined) groups[group]!.accounts.push(account)
    else {
      if (mnemonic) seeds.set(mnemonic, groups.length)
      groups.push({ type: mnemonic ? 'seed' : watched(secret) ? 'watch' : 'key', accounts: [account] })
    }
  })
  return groups
}

/** Only public labels leave this function; seed words stay in the vault. */
export async function seedSources() {
  return (await accountGroups()).filter((g) => g.type === 'seed').map((g) => {
    const { index, address } = g.accounts[0]!
    return { index, address }
  })
}

/** Deletes exactly the accounts the user confirmed, never a changed group or shifted index. */
export const removeAccount = (index: number, address: string) => removeAccounts([{ index, address }], false)
export const removeSeedGroup = (accounts: { index: number; address: string }[]) => removeAccounts(accounts, true)

const removeAccounts = (accounts: { index: number; address: string }[], group: boolean) => navigator.locks.request('vault', async () => {
  const key = await unlockedKey()
  const vault = await storedVault()
  const all = await decryptVault(key, vault)
  const mismatch = () => { throw new Error('Vault does not match the selected accounts; reopen Manage accounts') }
  const indexes = new Set(accounts.map((a) => a.index))
  if (!accounts.length || indexes.size !== accounts.length) mismatch()
  for (const { index, address } of accounts) {
    const secret = Number.isSafeInteger(index) && index >= 0 ? all[index] : undefined
    if (!secret || addressOf(secret) !== address) mismatch()
  }
  if (group) {
    const mnemonic = mnemonicOf(all[accounts[0]!.index]!)
    if (!mnemonic || all.some((s, i) => (mnemonicOf(s) === mnemonic) !== indexes.has(i))) mismatch()
  }
  if (all.length === indexes.size) throw new Error('This would remove your only account or all accounts. To delete them, lock the wallet and reset it.')
  const next = await encryptVault(key, JSON.parse(vault), all.filter((_, i) => !indexes.has(i)))
  await save((s) => {
    if (accounts.some(({ index, address }) => s.addresses[index] !== address)) mismatch()
    const removed = new Set(accounts.map((a) => a.address))
    const addresses = s.addresses.filter((a) => !removed.has(a))
    const nicknames = Object.fromEntries(Object.entries(s.nicknames).filter(([a]) => !removed.has(a)))
    const connections = Object.fromEntries(Object.entries(s.connections)
      .map(([origin, list]) => [origin, list.filter((a) => !removed.has(a))] as const).filter(([, list]) => list.length))
    return { vault: next, nicknames, connections, addresses, active: Math.max(0, addresses.indexOf(s.addresses[s.active]!)) }
  }, key, vault)
})

export const addDerivedAccount = (source: number, address?: string) => navigator.locks.request('vault', async () => {
  const vault = await storedVault()
  const all = await decryptVault(await unlockedKey(), vault)
  const selected = all[source]
  const mnemonic = selected && mnemonicOf(selected)
  if (!mnemonic) throw new Error('Select a stored seed phrase')
  if (address !== undefined && addressOf(selected!) !== address) throw new Error('Seed source changed; reopen Manage accounts')
  let addressIndex = Math.max(...all.filter((s) => mnemonicOf(s) === mnemonic).map((s) => typeof s === 'object' && 'addressIndex' in s ? s.addressIndex : 0)) + 1
  const { addresses } = await load()
  // An address may already have been imported separately as a private key.
  while (addresses.includes(toAccount({ mnemonic, addressIndex }).address)) addressIndex++
  await appendWallet({ mnemonic, addressIndex }, undefined, vault)
})

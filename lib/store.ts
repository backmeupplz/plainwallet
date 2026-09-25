// Extension state. Public data + encrypted vault in storage.local; the vault key only in storage.session
// (trusted contexts only, wiped on browser restart / extension reload). Firefox also lets content scripts, i.e. code in
// a website's process, read and write storage.local: so everything besides the self-authenticating vault carries a MAC
// under the vault key, and once unlocked the wallet refuses state it didn't write.
import { arbitrum, avalanche, base, bsc, gnosis, mainnet, optimism, polygon } from 'viem/chains'
import { browser } from 'wxt/browser'
import { toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { decryptVault, deriveKey, encryptVault, mac, mnemonicOf, newMeta, toAccount, type Secret, type VaultMeta } from './wallet'

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
export async function load(): Promise<State> {
  const s: State = { ...defaults, ...(await browser.storage.local.get()) }
  const key = await sessionKey()
  if (key && s.mac !== (await mac(key, signed(s)))) throw new Error(TAMPERED)
  return s
}

/** Re-signs the whole state, so it needs the vault key; serialized, so concurrent writers don't drop each other's changes. */
export const save = (patch: Partial<State> | ((s: State) => Partial<State>), key?: string) =>
  navigator.locks.request('state', async () => {
    const k = key ?? (await unlockedKey())
    const s = await load()
    await write(k, { ...s, ...(typeof patch === 'function' ? patch(s) : patch) })
  })

// Every signed field is written out, defaults included: a later version changing a default must not break the MAC.
const write = async (key: string, s: State) => browser.storage.local.set({ ...signed(s), vault: s.vault, mac: await mac(key, signed(s)) })

/** After a failed integrity check: accounts come back from the vault, everything else starts over. */
export const repair = () =>
  navigator.locks.request('state', async () => {
    const key = await unlockedKey()
    const vault = await storedVault()
    await write(key, { ...defaults, vault, addresses: (await decryptVault(key, vault)).map((s) => toAccount(s).address) })
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

/** Auto-lock: (re)armed on unlock and on every use of the popup. An alarm, because it outlives the service worker. */
export const touch = () => browser.alarms.create('lock', { delayInMinutes: 15 })
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
      await save({ vault: upgraded, addresses: all.map((s) => toAccount(s).address), connections: {} }, key)
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
  const mnemonic = mnemonicOf(secret)
  const addressIndex = typeof secret === 'string' ? 0 : secret.addressIndex
  return {
    mnemonic,
    privateKey: mnemonic ? toHex(mnemonicToAccount(mnemonic, { addressIndex }).getHdKey().privateKey!) : secret as string,
    path: mnemonic ? `m/44'/60'/0'/0/${addressIndex}` : undefined,
  }
}

/** Adds a wallet and makes it active. `password` is only needed (and used) to create the vault. */
export const addWallet = (secret: string, password?: string) => navigator.locks.request('vault', () => appendWallet(secret, password))

async function appendWallet(secret: Secret, password?: string) {
  const { vault, addresses } = await load()
  const address = toAccount(secret).address
  if (addresses.includes(address)) throw new Error('Wallet already added')
  if (!vault && !password) throw new Error('Password required') // never derive a vault key from an empty password
  const meta: VaultMeta = vault ? JSON.parse(vault) : newMeta()
  const key = vault ? await unlockedKey() : await deriveKey(password!, meta)
  const all = [...(vault ? await decryptVault(key, vault) : []), secret]
  await save({ vault: await encryptVault(key, meta, all), addresses: [...addresses, address], active: addresses.length }, key)
  await setKey(key)
}

/** Deletes one account's secret from the vault, along with its nickname and site connections. `address` must match
 * what the user picked, so a list that changed underneath the dialog can't delete a different account. */
export const removeAccount = (index: number, address: string) => navigator.locks.request('vault', async () => {
  const key = await unlockedKey()
  const vault = await storedVault()
  const all = await decryptVault(key, vault)
  const secret = Number.isSafeInteger(index) && index >= 0 ? all[index] : undefined
  if (!secret || toAccount(secret).address !== address) throw new Error('Vault does not match the selected account')
  if (all.length < 2) throw new Error('This is your only account. To delete it, lock the wallet and reset it.')
  const next = await encryptVault(key, JSON.parse(vault), all.filter((_, i) => i !== index))
  await save((s) => {
    if (s.addresses[index] !== address) throw new Error('Vault does not match the selected account')
    const { [address]: _, ...nicknames } = s.nicknames
    const connections = Object.fromEntries(Object.entries(s.connections)
      .map(([origin, accounts]) => [origin, accounts.filter((a) => a !== address)] as const).filter(([, accounts]) => accounts.length))
    return {
      vault: next, nicknames, connections,
      addresses: s.addresses.filter((_, i) => i !== index),
      active: s.active === index ? 0 : s.active > index ? s.active - 1 : s.active,
    }
  }, key)
})

/** Only public labels leave this function; seed words stay in the vault. */
export async function seedSources() {
  const all = await secrets()
  const seen = new Set<string>()
  return all.flatMap((secret, index) => {
    const mnemonic = mnemonicOf(secret)
    if (!mnemonic || seen.has(mnemonic)) return []
    seen.add(mnemonic)
    return [{ index, address: toAccount(secret).address }]
  })
}

export const addDerivedAccount = (source: number) => navigator.locks.request('vault', async () => {
  const all = await secrets()
  const selected = all[source]
  const mnemonic = selected && mnemonicOf(selected)
  if (!mnemonic) throw new Error('Select a stored seed phrase')
  let addressIndex = Math.max(...all.filter((s) => mnemonicOf(s) === mnemonic).map((s) => typeof s === 'string' ? 0 : s.addressIndex)) + 1
  const { addresses } = await load()
  // An address may already have been imported separately as a private key.
  while (addresses.includes(toAccount({ mnemonic, addressIndex }).address)) addressIndex++
  await appendWallet({ mnemonic, addressIndex })
})

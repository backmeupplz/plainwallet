// Pure key + vault logic: no extension APIs, so `npm test` can run it in Node.
import { scryptAsync } from '@noble/hashes/scrypt' // viem's own hashing library
import { validateMnemonic } from '@scure/bip39' // viem doesn't re-export it; same copy viem uses
import { english, generateMnemonic, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'

export const newMnemonic = () => generateMnemonic(english)

/** Normalizes user input into a secret (mnemonic or 0x private key); throws if it is neither. */
export function parseSecret(input: string): string {
  const s = input.trim()
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return s.startsWith('0x') ? s : `0x${s}`
  const mnemonic = s.toLowerCase().split(/\s+/).join(' ')
  if (validateMnemonic(mnemonic, english)) return mnemonic
  throw new Error('Not a valid seed phrase or private key')
}

// Keep legacy strings readable; derived accounts carry their index inside the encrypted vault.
export type Secret = string | { mnemonic: string; addressIndex: number }
export const mnemonicOf = (secret: Secret) => typeof secret === 'string' ? (secret.startsWith('0x') ? undefined : secret) : secret.mnemonic
export const toAccount = (secret: Secret) =>
  typeof secret !== 'string' ? mnemonicToAccount(secret.mnemonic, { addressIndex: secret.addressIndex })
    : secret.startsWith('0x') ? privateKeyToAccount(secret as `0x${string}`) : mnemonicToAccount(secret)

// Vault: scrypt (memory-hard, so a copied vault is expensive to brute-force on GPUs) -> AES-256-GCM, random salt per
// vault, fresh IV per encryption. 0.1.x vaults used PBKDF2-SHA256 (no `kdf` field); unlocking one upgrades it.
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export type VaultMeta = { salt: string; kdf?: 'scrypt' }
export const newMeta = (): VaultMeta => ({ salt: b64(crypto.getRandomValues(new Uint8Array(32))), kdf: 'scrypt' })

/** Returns the raw AES key (base64). This is what stays in session storage while unlocked. */
export async function deriveKey(password: string, { salt, kdf }: VaultMeta): Promise<string> {
  const pw = new TextEncoder().encode(password)
  if (kdf === 'scrypt') return b64(await scryptAsync(pw, unb64(salt), { N: 2 ** 17, r: 8, p: 1, dkLen: 32 })) // 128 MiB
  const base = await crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits'])
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: 900_000 }, base, 256))
}

const aesKey = (key: string) => crypto.subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function encryptVault(key: string, { salt, kdf }: VaultMeta, secrets: Secret[]): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(key), new TextEncoder().encode(JSON.stringify(secrets)))
  return JSON.stringify({ kdf, salt, iv: b64(iv), data: b64(data) })
}

/** Throws if the key (i.e. the password) is wrong: AES-GCM authenticates. */
export async function decryptVault(key: string, vault: string): Promise<Secret[]> {
  const { iv, data } = JSON.parse(vault)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(key), unb64(data))
  return JSON.parse(new TextDecoder().decode(plain))
}

// Stable JSON: storage may hand objects back with their keys in a different order.
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as any)[k])])) : v

/** HMAC-SHA256 of `value` under a subkey of the vault key: lets the wallet notice state it didn't write itself. */
export async function mac(key: string, value: unknown): Promise<string> {
  const base = await crypto.subtle.importKey('raw', unb64(key), 'HKDF', false, ['deriveKey'])
  const info = new TextEncoder().encode('plainwallet state')
  const hmac = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info }, base, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return b64(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(JSON.stringify(canon(value)))))
}

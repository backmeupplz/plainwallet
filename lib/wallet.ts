// Pure key + vault logic: no extension APIs, so `npm test` can run it in Node.
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

export const toAccount = (secret: string) =>
  secret.startsWith('0x') ? privateKeyToAccount(secret as `0x${string}`) : mnemonicToAccount(secret)

// Vault: PBKDF2-SHA256 -> AES-256-GCM, random salt per vault, fresh IV per encryption.
const ITERATIONS = 900_000
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export const newSalt = () => b64(crypto.getRandomValues(new Uint8Array(32)))

/** Returns the raw AES key (base64). This is what stays in session storage while unlocked. */
export async function deriveKey(password: string, salt: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const params = { name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: ITERATIONS }
  return b64(await crypto.subtle.deriveBits(params, base, 256))
}

const aesKey = (key: string) => crypto.subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function encryptVault(key: string, salt: string, secrets: string[]): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(key), new TextEncoder().encode(JSON.stringify(secrets)))
  return JSON.stringify({ salt, iv: b64(iv), data: b64(data) })
}

/** Throws if the key (i.e. the password) is wrong: AES-GCM authenticates. */
export async function decryptVault(key: string, vault: string): Promise<string[]> {
  const { iv, data } = JSON.parse(vault)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(key), unb64(data))
  return JSON.parse(new TextDecoder().decode(plain))
}

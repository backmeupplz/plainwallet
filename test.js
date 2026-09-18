// Self-check for the key + vault path. Run: npm test
import assert from 'node:assert/strict'
import { decryptVault, deriveKey, encryptVault, newMnemonic, newSalt, parseSecret, toAccount } from './lib/wallet.ts'

const MNEMONIC = 'test test test test test test test test test test test junk'
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

assert.equal(toAccount(parseSecret(`  ${MNEMONIC.toUpperCase().replaceAll(' ', '\n')} `)).address, ADDRESS)
assert.equal(toAccount(parseSecret(KEY)).address, ADDRESS)
assert.equal(toAccount(parseSecret(`0x${KEY}`)).address, ADDRESS)
assert.throws(() => parseSecret(MNEMONIC.replace('junk', 'test'))) // bad checksum
assert.throws(() => parseSecret('0x1234'))
assert.equal(parseSecret(newMnemonic()).split(' ').length, 12)

const salt = newSalt()
const key = await deriveKey('hunter2', salt)
const vault = await encryptVault(key, salt, [MNEMONIC])
assert.deepEqual(await decryptVault(key, vault), [MNEMONIC])
assert.deepEqual(await decryptVault(await deriveKey('hunter2', JSON.parse(vault).salt), vault), [MNEMONIC])
await assert.rejects(async () => decryptVault(await deriveKey('wrong', salt), vault))
assert.notEqual(JSON.parse(await encryptVault(key, salt, [MNEMONIC])).iv, JSON.parse(vault).iv) // IV never reused
assert.ok(!vault.includes('junk'))

console.log('ok')

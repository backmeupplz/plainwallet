// Self-check for the key + vault path. Run: npm test
import assert from 'node:assert/strict'
import { describeCall, signedView } from './lib/describe.ts'
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

// what the approval screen says about calldata and typed data
const SPENDER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0')
const approve = (amount) => `0x095ea7b3${word(SPENDER)}${word(amount.toString(16))}`
assert.equal(describeCall(approve(2n ** 256n - 1n), { symbol: 'USDC', decimals: 6 }), `Lets ${SPENDER} spend UNLIMITED USDC of yours`)
assert.equal(describeCall(approve(2n ** 160n - 1n)), `Lets ${SPENDER} spend UNLIMITED tokens of yours`) // Permit2-style max
assert.equal(describeCall(approve(1500000n), { symbol: 'USDC', decimals: 6 }), `Lets ${SPENDER} spend 1.5 USDC of yours`)
assert.equal(describeCall(approve(7n), { symbol: 'US\n\n\nDC' }), `Lets ${SPENDER} spend 7 (raw units, or NFT #7) US DC of yours`)
assert.equal(describeCall(`0xa9059cbb${word(SPENDER)}${word('de0b6b3a7640000')}`, { decimals: 18 }), `Sends 1 tokens to ${SPENDER}`)
assert.equal(describeCall(`0xa22cb465${word(SPENDER)}${word('1')}`), `Lets ${SPENDER} move ALL your NFTs in this collection`)
assert.equal(describeCall('0xdeadbeef00'), 'Contract call 0xdeadbeef (not decoded)')
assert.equal(describeCall('0x'), undefined)

const types = { Permit: [{ name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }], Order: [{ name: 'items', type: 'Item[]' }], Item: [{ name: 'id', type: 'uint256' }] }
const permit = signedView({ types, primaryType: 'Permit', domain: { name: 'T', chainId: 1, evil: 'x' }, message: { spender: SPENDER, value: '1', note: 'free login, nothing is approved' } })
assert.deepEqual(permit.view.message, { spender: SPENDER, value: '1' }) // the unsigned decoy key is gone
assert.deepEqual(permit.view.domain, { name: 'T', chainId: 1 })
assert.match(permit.summary, /Token approval/)
const order = signedView({ types, primaryType: 'Order', domain: {}, message: { items: [{ id: '1', decoy: 'x' }], decoy: 'y' } })
assert.deepEqual(order.view.message, { items: [{ id: '1' }] })
assert.equal(order.summary, undefined)

console.log('ok')

// Self-check for the key + vault path. Run: npm test
import assert from 'node:assert/strict'
import { describeCall, foreignSignIn, parseAddress, parseAmount, publicRpc, signedView } from './lib/describe.ts'
import { decryptVault, deriveKey, encryptVault, mac, newMeta, newMnemonic, parseSecret, toAccount } from './lib/wallet.ts'
import { hashTypedData, recoverMessageAddress } from 'viem'

const MNEMONIC = 'test test test test test test test test test test test junk'
const KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

assert.equal(toAccount(parseSecret(`  ${MNEMONIC.toUpperCase().replaceAll(' ', '\n')} `)).address, ADDRESS)
assert.equal(toAccount(parseSecret(KEY)).address, ADDRESS)
assert.equal(toAccount(parseSecret(`0x${KEY}`)).address, ADDRESS)
assert.throws(() => parseSecret(MNEMONIC.replace('junk', 'test'))) // bad checksum
assert.throws(() => parseSecret('0x1234'))
assert.equal(parseSecret(newMnemonic()).split(' ').length, 12)

const meta = newMeta()
const key = await deriveKey('hunter2', meta)
const vault = await encryptVault(key, meta, [MNEMONIC])
assert.equal(JSON.parse(vault).kdf, 'scrypt')
assert.deepEqual(await decryptVault(key, vault), [MNEMONIC])
assert.deepEqual(await decryptVault(await deriveKey('hunter2', JSON.parse(vault)), vault), [MNEMONIC])
await assert.rejects(async () => decryptVault(await deriveKey('wrong', meta), vault))
assert.notEqual(JSON.parse(await encryptVault(key, meta, [MNEMONIC])).iv, JSON.parse(vault).iv) // IV never reused
assert.ok(!vault.includes('junk'))
// 0.1.x vaults (no kdf field) still derive with PBKDF2, and a different key than scrypt from the same salt
const legacy = { salt: meta.salt }
assert.notEqual(await deriveKey('hunter2', legacy), key)
assert.deepEqual(await decryptVault(await deriveKey('hunter2', legacy), await encryptVault(await deriveKey('hunter2', legacy), legacy, [MNEMONIC])), [MNEMONIC])
// state MAC: independent of key order (storage may reorder), bound to the values and to the key
assert.equal(await mac(key, { a: 1, b: { c: [1, 2], d: 'x' } }), await mac(key, { b: { d: 'x', c: [1, 2] }, a: 1 }))
assert.notEqual(await mac(key, { a: 1 }), await mac(key, { a: 2 }))
assert.notEqual(await mac(key, { a: 1 }), await mac(await deriveKey('hunter3', meta), { a: 1 }))

const derived = { mnemonic: MNEMONIC, addressIndex: 1 }
assert.equal(toAccount(derived).address, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
const mixed = await encryptVault(key, meta, [MNEMONIC, `0x${KEY}`, derived])
assert.deepEqual(await decryptVault(key, mixed), [MNEMONIC, `0x${KEY}`, derived])
const signer = toAccount((await decryptVault(key, mixed))[2])
assert.equal(await recoverMessageAddress({ message: 'Derived account test', signature: await signer.signMessage({ message: 'Derived account test' }) }), signer.address)

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
assert.match(permit.summary, /move or approve your assets/)
const bundle = signedView({ types: { Bundle: [{ name: 'items', type: 'Item[]' }], Item: types.Item }, primaryType: 'Bundle', domain: {}, message: { items: [{ id: '1', decoy: 'x' }], decoy: 'y' } })
assert.deepEqual(bundle.view.message, { items: [{ id: '1' }] })
assert.equal(bundle.summary, undefined)
// the other ways a signature hands over assets are flagged too
for (const primaryType of ['OrderComponents', 'TransferWithAuthorization', 'SafeTx', 'PermitBatch']) assert.ok(signedView({ types: { [primaryType]: [] }, primaryType, domain: {}, message: {} }).summary, primaryType)
assert.ok(signedView({ types: { Listing: [{ name: 'offer', type: 'uint256' }] }, primaryType: 'Listing', domain: {}, message: { offer: '1' } }).summary)
// without an EIP712Domain type, a domain field viem won't hash (chainId as a string) must not be shown either
const loose = { types: { Mail: [{ name: 'body', type: 'string' }] }, primaryType: 'Mail', domain: { name: 'App', chainId: '1' }, message: { body: 'hi' } }
assert.deepEqual(signedView(loose).view.domain, { name: 'App' })
assert.equal(hashTypedData(loose), hashTypedData({ ...loose, domain: signedView(loose).view.domain }))
assert.deepEqual(signedView({ ...loose, domain: { name: 'App', chainId: 1 } }).view.domain, { name: 'App', chainId: 1 })

// addresses: EIP-55 catches typos in mixed case; all-lowercase has no checksum to check
assert.equal(parseAddress(` ${ADDRESS.toLowerCase()} `), ADDRESS)
assert.throws(() => parseAddress(ADDRESS.slice(0, -1) + '7'), /checksum/)
assert.throws(() => parseAddress('0x1234'), /valid/)

// sign-in messages (EIP-4361) only for the site asking
const signIn = (domain) => `${domain} wants you to sign in with your Ethereum account:\n${ADDRESS}\n\nURI: https://x\nVersion: 1`
assert.equal(foreignSignIn(signIn('example.com'), 'https://example.com'), undefined)
assert.equal(foreignSignIn(signIn('Example.COM'), 'https://example.com'), undefined)
assert.equal(foreignSignIn(signIn('localhost:3000'), 'http://localhost:3000'), undefined)
assert.equal(foreignSignIn(signIn('opensea.io'), 'https://opensea.io.evil.com'), 'opensea.io')
assert.equal(foreignSignIn(signIn('https://example.com'), 'http://example.com'), 'https://example.com')
assert.equal(foreignSignIn(`hi\n  ${signIn('bank.example')}`, 'https://evil.com'), 'bank.example') // not just the first line
assert.equal(foreignSignIn('Sign this to prove you own the address', 'https://evil.com'), undefined)

// RPCs a dapp may add: public https only
for (const ok of ['https://mainnet.base.org', 'https://eth.llamarpc.com/v1/key']) assert.ok(publicRpc(ok), ok)
for (const bad of ['http://rpc.example.com', 'https://localhost:8545', 'https://localhost./', 'https://127.1/', 'https://2130706433/', 'https://192.168.1.1/',
  'https://[::1]/', 'https://router.local', 'https://intranet', 'https://a.b.localhost', 'https://user:pw@rpc.com', 'not a url', 42]) assert.ok(!publicRpc(bad), String(bad))

// what the send form accepts
assert.equal(parseAmount(' 1.5 ', 6), 1500000n)
assert.equal(parseAmount('.5', 18), 5n * 10n ** 17n)
assert.equal(parseAmount('3', 0), 3n)
for (const bad of ['', '.', 'abc', '-1', '1e3', '1.2.3', '0', '0.0']) assert.throws(() => parseAmount(bad, 6), bad)
assert.throws(() => parseAmount('1.0000001', 6), /At most 6 decimals/) // never silently rounded
assert.throws(() => parseAmount('1.5', 0))

console.log('ok')

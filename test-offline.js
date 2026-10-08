// Self-check for watch-only accounts: a request goes out, and only exactly that, signed by that account, comes back in.
import assert from 'node:assert/strict'
import { parseTransaction, serializeTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { checkResponse, parseRequest, requestText } from './lib/offline.ts'
import { addressOf, mnemonicOf, toAccount } from './lib/wallet.ts'

// Disposable, publicly known test keys (Hardhat's accounts 0 and 1).
const signer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const from = signer.address
const to = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const fails = (promise, pattern) => assert.rejects(promise, pattern)

// The vault entry for a watched address: an address, never a key.
const watch = { watch: from }
assert.equal(addressOf(watch), from)
assert.equal(mnemonicOf(watch), undefined)
assert.throws(() => toAccount(watch), /watch-only/i)

const txs = [
  { chainId: 8453, nonce: 7, to, value: 10n ** 15n, gas: 21000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 6n, type: 'eip1559' },
  { chainId: 1, nonce: 0, to, value: 0n, data: '0xa9059cbb', gas: 50000n, gasPrice: 10n ** 9n, type: 'legacy' },
  { chainId: 56, nonce: 1, value: 0n, data: '0x6080', gas: 50000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 1n, type: 'eip1559' },
]
for (const tx of txs) {
  const request = parseRequest(requestText({ from, origin: 'https://app.example', transaction: serializeTransaction(tx) }))
  assert.equal(request.origin, 'https://app.example')
  const signed = await signer.signTransaction(parseTransaction(request.transaction))
  assert.equal(await checkResponse(request, `  ${signed}\n`), signed)
  // Another account's signature, a changed transaction, the unsigned one, or junk: all refused.
  await fails(checkResponse(request, await other.signTransaction(parseTransaction(request.transaction))), /wasn’t signed by/)
  await fails(checkResponse(request, await signer.signTransaction({ ...parseTransaction(request.transaction), nonce: tx.nonce + 1 })), /different transaction/)
  await fails(checkResponse(request, await signer.signTransaction({ ...parseTransaction(request.transaction), chainId: 10 })), /different transaction/)
  await fails(checkResponse(request, request.transaction), /isn’t signed/)
  await fails(checkResponse(request, 'hello'), /0x followed by hex/)
}
// Requests that would sign something other than what is shown, or something replayable, are refused.
const tx = serializeTransaction(txs[0])
assert.throws(() => parseRequest(requestText({ from, transaction: tx.slice(0, -2) })), /can’t be read|canonical/)
assert.throws(() => parseRequest(JSON.stringify({ plainwallet: 'sign', from, transaction: serializeTransaction({ ...txs[1], chainId: undefined }) })), /names no chain/)
const signedTx = await signer.signTransaction(txs[0])
assert.throws(() => parseRequest(requestText({ from, transaction: signedTx })), /already signed/)
assert.throws(() => parseRequest(JSON.stringify({ plainwallet: 'sign', from, transaction: tx, message: 'hi' })), /isn’t a Plain Wallet/)
assert.throws(() => parseRequest(JSON.stringify({ plainwallet: 'sign', from: '0x1234', transaction: tx })), /isn’t a Plain Wallet/)
assert.throws(() => parseRequest(tx), /isn’t a Plain Wallet/)
const delegation = { address: to, chainId: 1, nonce: 0, r: '0x01', s: '0x01', yParity: 0 }
assert.throws(() => parseRequest(requestText({ from, transaction: serializeTransaction({ ...txs[0], type: 'eip7702', authorizationList: [delegation] }) })), /doesn’t sign eip7702/)
assert.throws(() => parseRequest(requestText({ from, message: { raw: '0x123' } })), /can’t be read/)

// Messages, as text and as raw bytes.
for (const message of ['Sign in to app.example', { raw: '0xdeadbeef' }]) {
  const request = parseRequest(requestText({ from, message }))
  const signature = await signer.signMessage({ message })
  assert.equal(await checkResponse(request, signature), signature)
  await fails(checkResponse(request, await other.signMessage({ message })), /isn’t .* signature of this message/)
  await fails(checkResponse(request, await signer.signMessage({ message: 'something else' })), /signature of this message/)
  await fails(checkResponse(request, '0x1234'), /isn’t a signature/)
}

// Typed data.
const typedData = {
  domain: { name: 'Example', version: '1', chainId: 1, verifyingContract: to },
  types: { Mail: [{ name: 'to', type: 'address' }, { name: 'contents', type: 'string' }] },
  primaryType: 'Mail',
  message: { to, contents: 'hello' },
}
const typed = parseRequest(requestText({ from, typedData }))
const signature = await signer.signTypedData(typedData)
assert.equal(await checkResponse(typed, signature), signature)
await fails(checkResponse(typed, await signer.signTypedData({ ...typedData, message: { to, contents: 'bye' } })), /signature of this typed data/)
assert.throws(() => parseRequest(requestText({ from, typedData: { message: {} } })), /typed data/)

console.log('watch-only requests and responses ok')

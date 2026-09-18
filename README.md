# Plain Wallet

A very minimal EVM wallet Chrome extension. ~550 lines of TypeScript, two runtime dependencies ([viem](https://github.com/wevm/viem) and its bip39 library), built with [WXT](https://github.com/wxt-dev/wxt). MIT.

> Not audited. Don't keep funds in it that you can't afford to lose.

## What it does

- Generate a wallet (shows the seed phrase once, to copy) or import one by seed phrase / private key. Multiple wallets, one address per seed (`m/44'/60'/0'/0/0`).
- Password-encrypted vault (PBKDF2-SHA256 900k → AES-256-GCM via WebCrypto) in `chrome.storage.local`. The derived key lives only in `chrome.storage.session` while unlocked.
- Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Gnosis built in. Edit any network's RPC endpoint, add or remove networks.
- Connects to dapps via EIP-1193 and EIP-6963, per-site approval, disconnect any time.
- Approval window for: connect, `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`. Everything else a connected site asks is forwarded to your RPC endpoint.

## What it doesn't

Balances, sending from the popup, tokens, NFTs, history, swaps, hardware wallets, ENS, gas editing (nonce and fees come from the RPC), revealing the seed phrase later, removing a wallet, auto-lock.

## Install

```sh
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select `.output/chrome-mv3`.

## Develop

```sh
npm run dev   # Chrome with the extension loaded and hot reload
npm test      # self-check for key derivation + vault encryption
```

```
dapp → entrypoints/inpage.content.ts   EIP-1193 provider in the page's world, holds nothing
     → entrypoints/bridge.content.ts   relays to the background, emits chainChanged / accountsChanged
     → entrypoints/background.ts       permissions, approvals, signing, RPC
entrypoints/popup/                     the only UI: setup, unlock, approvals, settings
lib/wallet.ts                          secrets → accounts, vault crypto (pure)
lib/store.ts                           chrome.storage state
```

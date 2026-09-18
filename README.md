# Plain Wallet

A very minimal EVM wallet Chrome extension. ~550 lines of TypeScript, two runtime dependencies ([viem](https://github.com/wevm/viem) and its bip39 library), built with [WXT](https://github.com/wxt-dev/wxt). MIT.

> Not audited. Don't keep funds in it that you can't afford to lose.

## What it does

- Generate a wallet (shows the seed phrase once, to copy) or import one by seed phrase / private key. Multiple wallets, one address per seed (`m/44'/60'/0'/0/0`).
- Password-encrypted vault (PBKDF2-SHA256 900k → AES-256-GCM via WebCrypto) in `chrome.storage.local`. The derived key lives only in `chrome.storage.session` while unlocked.
- Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Gnosis built in. Edit any network's RPC endpoint, add or remove networks.
- Connects to dapps via EIP-1193 and EIP-6963, per-site approval, disconnect any time.
- Approval window for: connect, `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`. Everything else a connected site asks is forwarded to your RPC endpoint.

## Security model

- Seeds come from `crypto.getRandomValues` (128 bits, via `@scure/bip39`), generated inside the extension's own page. There is no weaker fallback.
- Secrets exist only in the popup and the background. The page gets a provider object that holds nothing; the content script only relays. Both `chrome.storage` areas are closed to content scripts, so even the encrypted vault stays out of the website's process.
- A site can do nothing but read the chain ID until you approve a connection for its exact origin. Requests from iframes and other windows are ignored.
- Every signature needs a click in the extension's own window, which shows the origin, network, account, and for transactions the recipient, value, max fee and calldata. The transaction is fully prepared before you see it and exactly that is signed, only if the RPC really serves the chain you approved.
- Only `eth_`/`net_`/`web3_` reads and `eth_sendRawTransaction` are forwarded to your RPC. Networks added by a dapp must use https.
- Known gaps: no auto-lock (unlocked until the browser restarts), typed data and calldata are shown raw rather than decoded, copying a seed puts it on the system clipboard, and your RPC provider sees your address and IP.

## What it doesn't

Balances, sending from the popup, tokens, NFTs, history, swaps, hardware wallets, ENS, gas editing (nonce and fees come from the RPC), revealing the seed phrase later, removing a wallet, auto-lock.

## Install

```sh
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select `.output/chrome-mv3`.

### Firefox / LibreWolf

```sh
npx wxt zip -b firefox --mv3   # → .output/plainwallet-<version>-firefox.zip
```

The build is unsigned, so either load it temporarily from `about:debugging` (removed, with its storage, on restart), or in a browser that allows it (LibreWolf, Firefox Developer Edition/Nightly) set `xpinstall.signatures.required` to `false`, rename the zip to `.xpi` and open it in the browser. That pref turns off signature checks for every extension.

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

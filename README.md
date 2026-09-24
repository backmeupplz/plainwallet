# <img src="assets/icon.svg" width="28" align="top" alt=""> Plain Wallet

A very minimal EVM wallet extension for Chrome and Firefox. ~1350 lines of TypeScript, three runtime dependencies ([viem](https://github.com/wevm/viem) and the bip39/hashing libraries it is built on), built with [WXT](https://github.com/wxt-dev/wxt). MIT.

> Not audited. Don't keep funds in it that you can't afford to lose.

## What it does

- Popup, sidebar or full tab.
- Generate or import wallets (seed phrase / private key), derive more accounts from a seed, nicknames, remove accounts, export secrets behind your password (shown, never copied to the clipboard).
- Password-encrypted vault (scrypt, 128 MiB → AES-256-GCM; PBKDF2 vaults from 0.1.x are upgraded on unlock); auto-locks after 15 minutes. Forgot the password? Reset wipes everything.
- Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Gnosis built in; add or edit any network.
- Balances of the gas token and common tokens on each built-in network; add any ERC-20 by address or remove one (symbol and decimals come from the chain). Refreshed on open, on network/account switch and when your transaction is mined.
- Send the gas token or a token: review, sign, then see it confirm or fail. History opens on DeBank.
- Dapps on https sites via EIP-1193 / EIP-6963, connected per account, with an approval window for every signature, transaction and network change.

## Security model

- Seeds come from `crypto.getRandomValues` (128 bits, via `@scure/bip39`), generated inside the extension's own page. There is no weaker fallback.
- Secrets exist only in the popup and the background. The page gets a provider object that holds nothing; the content script only relays. The unlocked vault key lives in `storage.session`, which content scripts can't reach in either browser. Chrome also closes `storage.local` to them; Firefox can't, so there a compromised website process could read the encrypted vault. Everything stored besides the vault is signed with a key derived from the vault key: once unlocked, the wallet refuses state it didn't write and offers to rebuild it from the vault.
- A site can do nothing but read the chain ID until you connect it (its exact origin), and then it sees only the accounts you connected it to. Locking disconnects nothing: a request that needs a signature brings up the unlock screen, then its approval. Plain-http sites get no provider (localhost aside), iframes and other windows are ignored, and after you reject a request the site has to wait a few seconds before asking again.
- Every signature needs a click in the extension's own window, which shows the origin, network, account, and for transactions the recipient, value, max fee and calldata. Token approvals and transfers (`approve`, `increaseAllowance`, `transfer`, `transferFrom`, `setApprovalForAll`) are spelled out in a sentence, with unlimited amounts flagged. Typed data is reduced to the fields that are actually hashed, and signatures that can hand over assets (permits, transfer authorizations, marketplace orders, Safe transactions) are flagged. Sign-in messages (EIP-4361) for a different site are refused. The transaction is fully prepared before you see it (the max fee includes the L1 data fee on OP-stack chains) and exactly that is signed, only after the RPC confirms it serves the chain you approved.
- Only `eth_`/`net_`/`web3_` reads and `eth_sendRawTransaction` are forwarded to your RPC, rate-limited per site. Networks added by a dapp need a public https RPC (no localhost, private or raw IP addresses), and a name borrowed from one of your networks is flagged.
- Balances, token lookups and sends go to the network's RPC. DeBank sees your address only when you open it.
- Known gaps: calldata other than the token calls above is shown as raw hex; symbol/decimals of tokens not in your list come from the RPC (the addresses and UNLIMITED flag do not); a public hostname that resolves to a private address (DNS rebinding) still passes the dapp-RPC check; on Firefox a compromised website process can read your addresses and connected sites; your RPC provider sees your address and IP.

## What it doesn't

Prices, NFTs, built-in history, swaps, hardware wallets, ENS, gas editing (nonce and fees come from the RPC).

## Install

### Chrome (and Brave, Edge, other Chromium browsers)

Install [Plain Wallet from the Chrome Web Store](https://chromewebstore.google.com/detail/pmnbalegifiefmohkolfpclnmkooifcp), then pin it from the puzzle-piece menu so it stays in the toolbar. It updates automatically.

Or build it from source:

```sh
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select `.output/chrome-mv3`. An unpacked build doesn't update itself: pull, rebuild and click the reload icon on its card.

### Firefox / LibreWolf

```sh
npx wxt zip -b firefox --mv3   # → .output/plainwallet-<version>-firefox.zip
```

The build is unsigned, so either load it temporarily from `about:debugging` (removed, with its storage, on restart), or in a browser that allows it (LibreWolf, Firefox Developer Edition/Nightly) set `xpinstall.signatures.required` to `false`, rename the zip to `.xpi` and open it in the browser. That pref turns off signature checks for every extension.

## Develop

```sh
npm run dev   # Chrome with the extension loaded and hot reload
npm test      # self-check: vault crypto and upgrade, signed state, approval wording, amounts, connections
```

```
dapp → entrypoints/inpage.content.ts   EIP-1193 provider in the page's world, holds nothing
     → entrypoints/bridge.content.ts   relays to the background, emits chainChanged / accountsChanged
     → entrypoints/background.ts       permissions, approvals, signing, RPC
entrypoints/popup/                     the only UI: setup, unlock, balances, send, approvals, settings
lib/wallet.ts                          secrets → accounts, vault crypto (pure)
lib/describe.ts                        calldata / typed data → what the approval says, typed amounts (pure)
lib/chain.ts                           RPC: balances, token lookup, prepare + sign + send
lib/store.ts                           chrome.storage state, signed with the vault key
assets/icon.svg                        the one icon source; `public/icon/*.png` are rendered from it with rsvg-convert
```

# <img src="assets/icon.svg" width="28" align="top" alt=""> Plain Wallet

A very minimal EVM wallet extension for Chrome and Firefox. ~1900 lines of TypeScript, three runtime dependencies ([viem](https://github.com/wevm/viem) and the bip39/hashing libraries it is built on), built with [WXT](https://github.com/wxt-dev/wxt). MIT.

> Not audited. Don't keep funds in it that you can't afford to lose.

## What it does

- Popup, sidebar or full tab.
- Generate or import wallets (seed phrase / private key), derive more accounts from a seed, nicknames, remove accounts, export secrets behind your password (shown, never copied to the clipboard).
- Password-encrypted vault (scrypt, 128 MiB → AES-256-GCM; PBKDF2 vaults from 0.1.x are upgraded on unlock); auto-locks after 15 minutes. Forgot the password? Reset wipes everything.
- Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Gnosis built in; add networks from chainlist.org or by hand, and edit any network.
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
- Every transaction you review is simulated on the network's RPC (`eth_simulateV1`) and shows your balance changes or the revert reason, filled in as it arrives; the Approve button never waits for it. Optional: with a Jev (typesafe.ai) API key in Settings, every transaction and signature also gets two more lines: the contract and any spender looked up on Blockscout (verified or not, age, token, scam flag; the function named from the verified ABI, or else from Sourcify's signature list, where a match must decode the calldata exactly), and Jev's read on what it does and how likely it is a scam or a lookalike site, colored by risk. Each line folds out into details; none of it replaces the wallet's own rows.
- Optional, off by default: a [Megapot](https://megapot.io) lottery ticket every N transactions you send (Settings → Megapot). Every Nth transaction brings up a purchase to approve: one 1 USDC ticket on Base with random numbers, for the account that sent it; when the allowance runs out, an approval for the next 10 tickets comes first. It's skipped without asking when that account has less than 1 USDC on Base.
- Known gaps: calldata other than the token calls above is shown as raw hex; symbol/decimals of tokens not in your list come from the RPC (the addresses and UNLIMITED flag do not); a public hostname that resolves to a private address (DNS rebinding) still passes the dapp-RPC check; on Firefox a compromised website process can read your addresses, connected sites and Jev API key; your RPC provider sees your address and IP.

## What it doesn't

Prices, NFTs, built-in history, swaps, hardware wallets, ENS, gas editing (nonce and fees come from the RPC).

## Install

### Chrome (and Brave, Edge, other Chromium browsers)

Build it from source:

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

Contributing? Read [CONTRIBUTING.md](CONTRIBUTING.md); AI coding agents should also read [AGENTS.md](AGENTS.md).

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
lib/chain.ts                           RPC: balances, token lookup, prepare + sign + send, simulate
lib/lookup.ts                          Blockscout + Sourcify lookups (only with a Jev key)
lib/jev.ts                             Jev (typesafe.ai) second opinion (only with a Jev key)
lib/megapot.ts                         Megapot ticket every N transactions: addresses, calldata, counting (pure)
lib/store.ts                           chrome.storage state, signed with the vault key
assets/icon.svg                        the one icon source; `public/icon/*.png` are rendered from it with rsvg-convert
```

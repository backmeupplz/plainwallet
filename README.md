# <img src="assets/icon.svg" width="28" align="top" alt=""> Plain Wallet

A very minimal EVM wallet extension for Chrome, Firefox and Safari, and Android, iOS and Mac apps. ~1900 lines of TypeScript, three runtime dependencies ([viem](https://github.com/wevm/viem) and the bip39/hashing libraries it is built on), built with [WXT](https://github.com/wxt-dev/wxt). MIT.

> Not audited. Don't keep funds in it that you can't afford to lose.

## What it does

- Popup, sidebar or full tab.
- Manage accounts, grouped by seed phrase or imported private key without revealing secrets. Generate an independent seed with a backup confirmation, derive more accounts from saved seeds, or import a seed / private key. Remove individual accounts or whole seed groups after confirming a backup (local access only, not on-chain funds); removing every account uses the existing lock → reset flow. Nicknames and password-gated secret export (shown, never copied to the clipboard).
- Password-encrypted vault (scrypt, 128 MiB → AES-256-GCM; PBKDF2 vaults from 0.1.x are upgraded on unlock); auto-locks after 15 minutes. Forgot the password? Reset wipes everything.
- Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Gnosis built in; add networks from chainlist.org or by hand, and edit any network.
- Balances of the gas token and common tokens on each built-in network; add any ERC-20 by address or remove one (symbol and decimals come from the chain). Refreshed on open, on network/account switch and when your transaction is mined.
- Send the gas token or a token: review, sign, then see it confirm or fail. History opens on DeBank.
- Dapps on https sites via EIP-1193 / EIP-6963, connected per account, with an approval window for every signature, transaction and network change.
- Watch-only accounts for a cold wallet: add just an address, use it with balances, Send and dapps, and sign each transaction or message in Plain Wallet on another device, say an offline computer, which holds the key (Settings → Sign a request). The request goes there and the signature comes back by copy and paste, or by file in the browser extensions. Exported transactions wait on the home screen until you bring the signature back, so the wallet can be closed in between. Offline, the wallet says so instead of failing on every RPC call, and still signs.

## Security model

- Seeds come from `crypto.getRandomValues` (128 bits, via `@scure/bip39`), generated inside the extension's own page. There is no weaker fallback.
- Secrets exist only in the popup and the background. The page gets a provider object that holds nothing; the content script only relays. The unlocked vault key lives in `storage.session`, which content scripts can't reach in either browser. Chrome also closes `storage.local` to them; Firefox can't, so there a compromised website process could read the encrypted vault. Everything stored besides the vault is signed with a key derived from the vault key: once unlocked, the wallet refuses state it didn't write and offers to rebuild it from the vault.
- A site can do nothing but read the chain ID until you connect it (its exact origin), and then it sees only the accounts you connected it to. Locking disconnects nothing: a request that needs a signature brings up the unlock screen, then its approval. Plain-http sites get no provider (localhost aside), iframes and other windows are ignored, and after you reject a request the site has to wait a few seconds before asking again.
- Every signature needs a click in the extension's own window (Approve comes on only after a moment without clicks, so a window popping up under the cursor can't catch one), which shows the origin, network, account, and for transactions the recipient, value, max fee and calldata. Token approvals and transfers (`approve`, `increaseAllowance`, `transfer`, `transferFrom`, `setApprovalForAll`) are spelled out in a sentence, with unlimited amounts flagged. Typed data is reduced to the fields that are actually hashed, and signatures that can hand over assets (permits, transfer authorizations, marketplace orders, Safe transactions) are flagged. Sign-in messages (EIP-4361) for a different site are refused. The transaction is fully prepared before you see it (the max fee includes the L1 data fee on OP-stack chains) and exactly that is signed, only after the RPC confirms it serves the chain you approved.
- Only `eth_`/`net_`/`web3_` reads and `eth_sendRawTransaction` are forwarded to your RPC, rate-limited per site. The wallet never follows EIP-3668 offchain lookups, which would let a contract have it fetch any URL. Networks added by a dapp need a public https RPC (no localhost, private or raw IP addresses), and a name borrowed from one of your networks is flagged.
- Balances, token lookups and sends go to the network's RPC. DeBank sees your address only when you open it.
- A watch-only account holds no key: what it exports is the exact transaction (the standard unsigned encoding, with the nonce and fees fixed), message or typed data, and the device with the key shows it decoded from those bytes alone, with nothing fetched, before you sign. Only legacy, EIP-2930 and EIP-1559 transactions with a chain id are signed. What comes back is accepted only if it is exactly that transaction, or a signature of exactly that message, by that account: the popup checks it, and for dapps the background checks it again before broadcasting it or handing it to the site.
- Every transaction you review is simulated on the network's RPC (`eth_simulateV1`) and shows your balance changes or the revert reason, filled in as it arrives; the Approve button never waits for it. Optional: with a Jev (typesafe.ai) API key in Settings, every transaction and signature also gets two more lines: the contract and any spender looked up on Blockscout (verified or not, age, token, scam flag; the function named from the verified ABI, or else from Sourcify's signature list, where a match must decode the calldata exactly), and Jev's read on what it does and how likely it is a scam or a lookalike site, colored by risk. Each line folds out into details; none of it replaces the wallet's own rows.
- Optional, off by default: a [Megapot](https://megapot.io) lottery ticket every N transactions you send (Settings → Megapot). Every Nth transaction brings up a purchase to approve: one 1 USDC ticket on Base with random numbers, for the account that sent it; when the allowance runs out, an approval for the next 10 tickets comes first. It's skipped without asking when that account has less than 1 USDC on Base.
- Known gaps: calldata other than the token calls above is shown as raw hex; a watch-only account's queued transactions share a nonce if you export another before broadcasting the first, so the second then fails to broadcast; exported transactions waiting for a signature are kept outside the signed state, so on Firefox a website process could add or change entries there (anything broadcast still needs the other device's signature over exactly that entry); symbol/decimals of tokens not in your list come from the RPC (the addresses and UNLIMITED flag do not); a public hostname that resolves to a private address (DNS rebinding) still passes the dapp-RPC check; on Firefox a compromised website process can read your addresses, connected sites and Jev API key; your RPC provider sees your address and IP.

## What it doesn't

Portfolio/token prices, NFTs, built-in history, swaps, hardware wallets, ENS, gas editing (nonce and fees come from the RPC).

Network-fee reviews show the native estimated max fee and approximate USD from validated Chainlink feeds on the same network’s RPC. Positive USD fees below $0.001 show <$0.001. Unsupported networks (including Gnosis/xDAI), invalid/stale feeds and outages show USD unavailable without blocking signing. No price-tracking service or extra wallet-address disclosure; see [feed mappings, freshness and limitations](docs/fee-prices.md).

## Install

### Chrome (and Brave, Edge, other Chromium browsers)

Install [Plain Wallet from the Chrome Web Store](https://chromewebstore.google.com/detail/plain-wallet/pmnbalegifiefmohkolfpclnmkooifcp), then pin it from the puzzle-piece menu so it stays in the toolbar. It updates automatically.

Or build it from source:

```sh
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select `.output/chrome-mv3`. An unpacked build doesn't update itself: pull, rebuild and click the reload icon on its card.

### Firefox / LibreWolf

Plain Wallet is waiting for review on Firefox Add-ons. Until it's listed there, build it yourself:

```sh
npx wxt zip -b firefox --mv3   # → .output/plainwallet-<version>-firefox.zip
```

The build is unsigned, so either load it temporarily from `about:debugging` (removed, with its storage, on restart), or in a browser that allows it (LibreWolf, Firefox Developer Edition/Nightly) set `xpinstall.signatures.required` to `false`, rename the zip to `.xpi` and open it in the browser. That pref turns off signature checks for every extension.

### Safari and the Mac app

Get [Plain Wallet on the Mac App Store](https://apps.apple.com/app/id6817506091) (in review; the link works once Apple approves it). Then open Safari → Settings → Extensions, turn on **Plain Wallet** and allow it on websites. The app's own window is the same wallet.

One Mac app (macOS 14+) holds both: the extension for Safari, and the wallet in a window of its own: the Android app's wallet page without a browser, since dapps go through Safari. Both are the same wallet, kept in a file in the app's app group that the app and the extension's native handler read and write for them (`lib/shared-storage.ts`, `macos/Shared/Storage.swift`); each unlocks on its own. Building needs Xcode, and signing with the team in the app group's name (`ACWP4F58HZ`): without it macOS keeps both out of that file and the wallet shows an error.

```sh
npm ci && npm run build:macos      # the wallet page → macos/web, the Safari extension → macos/safari
open macos/PlainWallet.xcodeproj   # run the PlainWallet scheme
```

Then turn it on in Safari → Settings → Extensions and allow it on websites. A build not signed by the App Store or a Developer ID only shows up there after Develop → Developer Settings → Allow unsigned extensions, which Safari turns off again when it quits. In the Safari extension, Plain Wallet has no side panel; everything else is the extension's. In the app:

- The wallet page is served from the app's bundle under a `plainwallet://` scheme that only its web view knows. Links open in your default browser; the page never navigates away.
- As with the Android app, the RPC, Blockscout, Sourcify and Jev must allow cross-origin requests.
- The vault and settings live in that shared file, `~/Library/Group Containers/ACWP4F58HZ.com.borodutch.plainwallet/storage.json`; the unlock key only in the page's memory. A change made in the app reaches dapps in Safari (a new account or network) only when they next ask. It locks after 15 minutes without use (unless turned off in Settings), when the Mac sleeps or its screen locks, and when you close the window, which quits the app.

### Android

The same wallet as an app: an address bar with a ☆ to favorite the site, over a browser whose pages get Plain Wallet's provider, and the wallet itself (favorites on top of its home screen, then the usual screens and approvals), with optional fingerprint unlock. Needs Android 11+ and Android System WebView 140 or newer.

Get it on [Google Play](https://play.google.com/store/apps/details?id=com.borodutch.plainwallet), or download `plainwallet-<version>-android.apk` from the [latest release](https://github.com/backmeupplz/plainwallet/releases/latest) and open it on the phone (allow installing from your browser or file manager when asked). Releases are signed with the same key, so later ones install over it. Or build it, with the Android SDK installed (Android Studio, or `ANDROID_HOME` pointing at one):

```sh
npm ci
cd android && ./gradlew assembleDebug   # runs `npm run build:android` first; Gradle checks every download against gradle/verification-metadata.xml
adb install app/build/outputs/apk/debug/app-debug.apk
```

Debug builds let Chrome DevTools into both WebViews and allow screenshots of the wallet; don't keep funds in one. Release builds come out of Gradle unsigned and are signed separately, so no build tool ever sees the release key: `./gradlew assembleRelease`, then `apksigner sign --ks <keystore> --ks-key-alias plainwallet --out plainwallet-<version>-android.apk app/build/outputs/apk/release/app-release-unsigned.apk` (it asks for the password).

The wallet always sits under a blue band across the top of the screen; a website never does. If a page asks for your password or seed phrase, it isn't Plain Wallet. Differences from the extension, beyond one tab and no downloads, uploads, pop-up dialogs or links to other apps:

- Sites run in a WebView profile of their own, so they get their own renderer process and storage, apart from the unlocked wallet's; a site exploiting a WebView bug would still have to escape the renderer sandbox to reach it. The browser extension's pages are separate processes in the same way. The app refuses to run on an outdated WebView.
- The wallet page is a web page, so the RPC, Blockscout, Sourcify and Jev must allow cross-origin requests (public ones generally do); the extension's host permissions skip that check. Plain-http RPCs don't work.
- The vault and settings live in the wallet page's `localStorage`, which sites can't reach; the unlock key only in its memory. It locks after 15 minutes without use, after a minute away from the app (the screen off counts, and changing the phone's clock doesn't help), and whenever Android ends the app. Nothing is backed up to the cloud or copied to a new phone.
- The wallet's screens stay out of screenshots, screen recordings and the recent-apps view; other apps' overlays are hidden and taps passing through them ignored while it shows; keyboards are told not to learn what's typed into it and autofill doesn't see it. Approve and Send only come on after a moment without taps. A seed phrase or private key typed into the address bar is refused, not searched.
- A request's origin comes from the WebView (`addWebMessageListener`), never from the page, as in the extension.
- Optional fingerprint unlock (Settings, with your password): Android keeps the vault key encrypted under a Keystore key that needs a strong biometric each time and is invalidated when fingerprints are added or removed. Anyone whose fingerprint is enrolled on the phone can unlock the wallet; export still asks for the password.

### iOS

Get [Plain Wallet on the App Store](https://apps.apple.com/app/id6817506091) (in review; the link works once Apple approves it).

The Android app on iPhone (iOS 18+): the same wallet page and provider in a small Swift wrapper, `ios/PlainWallet/PlainWallet.swift`, with optional Face ID or Touch ID unlock. No Megapot: the App Store doesn't take apps that sell lottery tickets. Building needs a Mac with Xcode; the web half builds anywhere and goes in `ios/web`:

```sh
npm ci && npm run build:android && rm -rf ios/web && cp -R .output/android-mv3 ios/web
open ios/PlainWallet.xcodeproj   # or xcodebuild -project ios/PlainWallet.xcodeproj -scheme PlainWallet ...
```

It differs from the Android app where iOS does:

- Sites get a website data store of their own, so WebKit gives them their own web content process and storage, apart from the unlocked wallet's, which is served from the app's bundle under its own `plainwallet://` scheme that only the wallet's web view knows. A request's origin comes from WebKit (`WKScriptMessage.frameInfo.securityOrigin`), never from the page; each answer goes back to the page that asked, and only while the browser still shows that origin.
- iOS can't keep the wallet out of screenshots. It shows a cover instead of the wallet in the app switcher and while the screen is recorded or mirrored (release builds). Third-party keyboards are turned off in the app, so seed phrases and passwords only ever go through Apple's. Plain-http sites don't load.
- Optional Face ID or Touch ID unlock (Settings, with your password): the vault key sits in the Keychain on this device only, behind the Face ID enrolled when you turned it on (`biometryCurrentSet`), so changing Face ID or removing the passcode turns it off. Anyone whose face or finger is enrolled can unlock the wallet; export still asks for the password.

## Store releases

Published stable GitHub releases can submit updates to Play, Chrome Web Store and AMO after owner setup. See [store release setup, publication choices and recovery](docs/STORE_RELEASE.md). Credentials and store approval are not included; review submission is not public rollout.

## Develop

Contributing? Read [CONTRIBUTING.md](CONTRIBUTING.md); AI coding agents should also read [AGENTS.md](AGENTS.md).

```sh
npm run dev   # Chrome with the extension loaded and hot reload
npm test      # self-check: vault crypto and upgrade, signed state, approval wording, amounts, connections, the Android wallet page
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
entrypoints/android-inpage.ts          Android: the provider, relaying to the app instead of bridge.content.ts
entrypoints/android-shim.ts            Android: the extension API the background and popup use, over the app
entrypoints/android/                   Android and Mac: the wallet page, background and popup in one, favorites on Android's home screen
android/                               Android: MainActivity.java, the address bar and the two WebViews, relaying between them
ios/                                   iOS: PlainWallet.swift, the same as MainActivity.java on WebKit, for entrypoints/android*
macos/                                 Mac: PlainWallet.swift, the wallet page in a window (no browser), and the Safari extension's container
assets/icon.svg                        the one icon source; `public/icon/*.png` are rendered from it with rsvg-convert
```

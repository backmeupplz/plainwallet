# Contributing to Plain Wallet

Plain Wallet is a small, unaudited EVM browser-extension wallet. Keep changes narrow, dependencies few, and behavior understandable. Read the [security model and known gaps](README.md#security-model) before changing wallet code; the [AI-agent instructions](AGENTS.md) also apply to automated contributors.

## Set up and check a change

Use a current Node.js/npm installation. From the repository root:

```sh
npm ci
npm test
npm run build
```

`npm ci` installs the exact lockfile dependencies, and runs no install scripts (see `.npmrc`): dependencies are pinned by version and hash, so add new ones deliberately and review lockfile changes. `npm run build` and `npm run dev` generate WXT's `.wxt` types themselves. `npm test` runs the Node self-checks in `test.js` and `test-reset.js`; `npm run build` builds the default Chrome MV3 extension into `.output/chrome-mv3`. For interactive Chrome development use `npm run dev`; see the [README install instructions](README.md#install) for loading Chrome and building a Firefox zip. These checks do not replace a browser review of changed wallet flows.

The request path is `entrypoints/inpage.content.ts` (page provider) → `entrypoints/bridge.content.ts` (relay) → `entrypoints/background.ts` (permission, approval, signing and RPC). The UI is in `entrypoints/popup/`; `lib/wallet.ts` handles keys and vault crypto, `lib/store.ts` handles signed extension state, `lib/describe.ts` builds human-readable approval details, `lib/chain.ts` prepares, signs, sends and simulates transactions, and `lib/lookup.ts` and `lib/jev.ts` fetch the optional Blockscout lookups and Jev second opinion (only with a Jev API key). Add or adjust the smallest relevant self-check for changed behavior; report which commands and browser flows you actually verified, and what you could not verify.

## Security and review

- Never put real seed phrases, private keys, passwords or vault contents in tests, screenshots, logs, issues, commits, or AI prompts. Use disposable wallets without funds for browser checks.
- Preserve the browser-derived, exact-origin connection boundary: an unconnected site must not see accounts, and only explicitly connected accounts may be exposed. Do not move secrets into page/content-script messages.
- Keep signing and network changes behind explicit extension-window approvals that accurately show the requesting origin, account, network and operation. Do not bypass vault encryption, state authentication, lock/unlock checks or password verification for exports.
- Keep transaction preparation and the displayed details bound to what is signed; check that the RPC serves the approved chain. Treat RPC-supplied metadata as untrusted. Preserve restricted forwarding of dapp RPC requests.

Open a focused PR explaining the behavior and security impact, with test results and any manual checks. Changes to permissions, vault/storage, approval descriptions, signing, transactions or RPC policy need particularly careful human review; automated checks and AI output alone are not approval. Do not combine unrelated refactors or add dependencies without a clear need.

If you find a vulnerability, do **not** publish exploit details, working secrets or sensitive user data in a public issue/PR. Use GitHub's private vulnerability reporting for this repository if it is available; otherwise ask maintainers through the repository's existing public channels for a secure reporting route without sharing the details publicly. No private contact address is assumed here.

# Instructions for AI coding agents

Work only on the requested change. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the relevant source before editing; keep the wallet minimal, avoid speculative abstractions or new dependencies, and preserve unrelated work. Do not change runtime behavior to satisfy a docs-only request.

Use the architecture map in [CONTRIBUTING.md](CONTRIBUTING.md#set-up-and-check-a-change) to trace the complete request/approval/signing path when changing security-sensitive code. Protect these invariants:

- Never put real user secrets in development artifacts, logs, prompts or PRs. Use only disposable, unfunded test wallets and synthetic fixtures for checks.
- Derive the requesting origin from browser sender metadata, not page-supplied messages; keep connections exact-origin and account-scoped. The in-page provider and content bridge must not hold vault material.
- Require explicit approval in the extension UI for connections, signatures, transactions and network changes; show what is actually authorized. Preserve lock/unlock, authenticated vault/state and password-gated export behavior.
- Prepare transactions before approval; bind the shown recipient, value, calldata and fees to the eventual signed request, and verify the RPC chain ID. Do not broaden forwarded dapp RPC methods or accept unsafe dapp-supplied RPC endpoints.

Run `npm ci`, `npm test` and `npm run build` where feasible. For changed flows, add a focused regression check and inspect the real browser UI using a disposable wallet when feasible. State exactly what ran, what did not, and any remaining security assumptions. Submit a focused PR for human review; do not self-declare wallet changes secure or audited. Follow [CONTRIBUTING.md](CONTRIBUTING.md#security-and-review) for non-public vulnerability reporting.

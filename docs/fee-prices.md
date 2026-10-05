# USD network-fee estimates

The shared Chrome, Firefox and Android approval UI converts the **same prepared native fee** (gas limit × fee cap, plus the L1 estimate where preparation supplies one). Neither the signed request nor native amount is modified. “Estimated max fee” is not a promise of the final charge: gas usage, effective gas price and L1 data cost may differ; the existing preparation path can also fail to obtain an L1 estimate.

USD is approximate, not a spending limit. Positive amounts below $0.001 show **<$0.001**; exact $0.001 and genuine zero remain distinct. Integer arithmetic retains four significant figures below $1 and cents above it. Unknown prices never become zero.

## Allowlist and evidence

Checked against Chainlink's official reference-data directory on 2026-10-03. Directory URLs are published in [Chainlink documentation source](https://github.com/smartcontractkit/documentation/blob/main/src/features/data/chains.ts); they are research sources, **not runtime requests**. All selected feeds have 8 decimals. Each proxy is read on its own network using the user's configured RPC; there is no cross-chain fallback.

| Chain ID / gas asset | Proxy | Maximum age (seconds) | Official directory |
| --- | --- | --- | --- |
| 1 / ETH | 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419 | 3600 | [Ethereum](https://reference-data-directory.vercel.app/feeds-mainnet.json) |
| 8453 / ETH | 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70 | 1200 | [Base](https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json) |
| 42161 / ETH | 0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612 | 1755 | [Arbitrum](https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-arbitrum-1.json) |
| 10 / ETH | 0x13e3Ee699D1909E989722E753853AE30b17e08c5 | 1200 | [Optimism](https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-optimism-1.json) |
| 137 / POL | 0xAB594600376Ec9fD91F8e885dADF0CE036862dE0 | 27 | [Polygon](https://reference-data-directory.vercel.app/feeds-matic-mainnet.json) |
| 56 / BNB | 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE | 27 | [BNB Chain](https://reference-data-directory.vercel.app/feeds-bsc-mainnet.json) |
| 43114 / AVAX | 0x0A77230d17318075983913bC2145DB16C7366156 | 120 | [Avalanche](https://reference-data-directory.vercel.app/feeds-avalanche-mainnet.json) |

Bounds are the published feed-specific heartbeats, with no extra stale grace. Polygon's legacy feed name/path is MATIC / USD, but its current directory metadata explicitly identifies baseAsset POL and POL/USD-RefPrice. Base's selected address is the 8-decimal secondary proxy of the shared SVR feed, not the separate 18-decimal Compound feed.

Gnosis (100, xDAI) is deliberately unavailable: its [directory](https://reference-data-directory.vercel.app/feeds-xdai-mainnet.json) lists DAI / USD at 0x678df3415fc31947dA4324eC63212874be5a82f8 (8 decimals, 86400-second heartbeat), not a quote measuring native bridged xDAI and its redemption/bridge risk. We do not substitute DAI or a constant $1. Other/custom chain IDs, testnets, and symbol mismatches are unavailable too. An edited RPC for an allowlisted chain is still supported, subject to the same chain-ID and data checks; a dishonest RPC can lie about all of them.

## Validation, privacy and lifetime

- Fixed chain/asset/proxy mapping and address checksum; RPC chain ID; exact expected feed decimals; positive answer; nonzero round and timestamps; start ≤ update ≤ local time; completed round; age strictly below the feed bound. Uses [AggregatorV3 semantics](https://docs.chain.link/data-feeds/api-reference) and [consumer responsibilities](https://docs.chain.link/data-feeds/developer-responsibilities).
- Base, Arbitrum and Optimism additionally read the [official sequencer uptime proxies](https://docs.chain.link/data-feeds/l2-sequencer-feeds). Reject down/uninitialized/future/incomplete status and the first 3600 seconds after recovery. Uptime timestamps indicate status changes, not periodic price updates, so price heartbeat limits do not apply to them.
- Only eth_chainId and eth_call, without a wallet address, signing, payment, redirects, cookies or CCIP offchain lookups. RPC sees the user's IP and oracle calls; there is no silent third-party price tracker. RPC responses and the local clock remain trust assumptions, not cryptographic proof.
- Five-second total request bound, no retries, up to 16 cache entries keyed by chain/RPC/symbol. In-flight reads and failures are cached to limit bursts. Quotes expire at the earlier of 30 seconds after validation or their feed-age deadline. The UI removes expired dollars, including on focus/visibility resume; reopening a review can fetch again. No price polling.
- Each fee node captures its own network/fee; detached old reviews ignore late replies. Replacing network, account or transaction reviews cannot fill a new row with a previous row's quote. Unavailable/loading USD never delays Approve/Send and never changes preparation or signing.

Run npm test for formatter, validation, mocked RPC privacy/cache/malformed/outage, and detached-review race checks. Builds cover Chrome, Firefox and the Android shared WebView UI; they do not establish a security audit or prove public RPC availability.

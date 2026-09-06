# Changelog

## Unreleased

Initial package, seeded from launchpad and made a superset of the exchange and
marketplace copies. Core session (`WalletSession`), typed provider wrapper,
compose pipeline, spent-UTXO journal and address lock, relay client with a
throttle budget, typed Counterparty reads with pagination, pending registry,
pool quote in bigint, BIP-322 and BIP-137 proof verification, sign-in helpers,
React bindings (`WalletProvider`, `useWallet`, `useCompose`, `usePending`,
`useSpendableBalance`, `leaderPolling`). Horizon Wallet adapter (`/horizon` entry) with the
compose pipeline's PSBT path and node broadcast.

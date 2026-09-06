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

Wallet discovery: `discoverWallets()` lists XCP Wallet and Horizon Wallet
with installed flags, the session binds to one at restore or connect,
`connectAction` tells the connect button whether to install, choose or
connect, the choice is remembered, `forgetWallet()` clears it.
`useWalletChooser` and `WalletChooser` in `/react`. New error code
`wallet_choice`. Fee rate defaults to mempool.space's precise next-block
rate floored by the network's own minimum (`fetchFeeRate`, `fetchPreciseFees`,
`feeRateFrom`). Paired grants: a switch between a Legacy account and its
granted SegWit sibling keeps the identity and proof
(`accountChangeKeepsIdentity`); a real switch is re-proved with a quiet
connect (`connect({ quiet: true })`, no paired prompt). `lockOnEmptyReconcile`
session option.

# Changelog

## Unreleased

Classic P2PKH message signatures: for a P2PKH (`1…`) address, `verifyBip322`
accepts both the two-item BIP-322 legacy stack and a 65-byte classic BIP-137
signature (headers 27–34; 35–42 refused), chosen by decoded length, with the
recovered key required to hash to the address. XCP Wallet 0.14 moves legacy
signatures and connection proofs to the classic form and labels those proofs
`{ method: "BIP-137", format: "legacy_recoverable" }`; older wallets keep
sending the stack. `verifyDeclaredConnectionSignature` (and so the session and
`verifySignIn`) accepts either form on a P2PKH address whatever the label
says. `pubkeyFromBip322` takes an optional `message` and recovers the key from
a classic signature in the header's encoding, so compose still finds a
`multisig_pubkey`. SegWit and Taproot verification is unchanged.

Taproot compose safety: Core 11.5 answers `encoding=taproot` and `inscription=true`
with an unsigned reveal the compose pipeline cannot sign, and broadcasting the commit
alone would strand its BTC. Compose now refuses those parameters before any request,
and refuses any compose response carrying reveal fields (`reveal_rawtransaction`,
`signed_reveal_rawtransaction`, `envelope_script`, `reveal_*`) before signing, with
the new error code `reveal_unsupported`.

Reload required: an XCP Wallet `4900` with `data.reloadRequired` (the extension
was updated or reloaded, and this page's bridge is dead) maps to the new error
code `reload_required` and is never retried; a plain `4900` keeps its single
retry. The same payload on the provider's `disconnect` event no longer clears
the session: the address and remembered connection stay, and the session moves
to the new sticky `readyState: "reload_required"` with `reloadRequired: true`
and `connectAction: "reload"`. Signing and connect fail fast in that state.
`isReloadRequired()` and `RELOAD_REQUIRED_MESSAGE` are exported;
`XcpWalletOptions.onReloadRequired` reports it from any request;
`useWalletChooser().connect` reloads the page. `WalletReadyState` and
`ConnectAction` gain a member, so exhaustive switches over them need a case.

Keep connected workspaces available while the wallet is locked. Session signing
methods unlock on demand through the existing provider connection route, then
recheck identity and paired access. Cancelled unlocks retain the connection;
changed accounts stop pending actions. PSBT requests are snapshotted before
waiting. Passive reconciliation never asks to unlock.

Add the standalone `/amounts` entry and versioned `/amounts/vectors` JSON.
Draft validation preserves invalid/incomplete text without yielding an amount;
explicit decimal precision and exact raw conversion avoid changing user intent.
Legacy truncating numeric helpers remain available for intentional arithmetic.

Compose and pool-quote parameters now validate against Core field types before
network requests. Raw quantities reject malformed strings and unsafe numbers;
booleans, text and legitimate fractional fee/commission/broadcast fields retain
their own semantics. Unreadable balance values fail instead of becoming zero.
Compose verifies that Core's raw transaction and PSBT agree, binds a provider's
signed result to the same Bitcoin inputs/outputs, and derives PSBT prevout
amounts from parent bytes whose transaction IDs are verified.

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
session option. The SWR-backed hooks moved to their own entries
(`react/leader-polling`, `react/use-spendable-balance`) so a site without SWR can use `/react`.
Horizon adapter passes `sighashTypes` as the allowed set, which is what Horizon expects.
Broadcast for a wallet that cannot (`broadcastSignedTransaction`): a POST to the node, which
refuses GET, then mempool.space and Blockstream. Playwright end-to-end suite against the real XCP Wallet build, with Horizon discovery checks.
`useWalletMenu()` for the connected menu; `proofOnConnect` asks a wallet that grants
without proving to sign the connection proof (`createProofMessage`).
`state.accounts` and `switchAccount()`: Horizon grants every address at once, both
encodings of a key included; the pair is presented as a paired grant and a site can
offer a picker.

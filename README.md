# @xcp/wallet-sdk

The wallet and Counterparty transaction logic the XCP properties share: the
launchpad, the exchange, the marketplace, xcpfolio, the browser extension and,
when it exists, the mobile app. One copy, versioned, instead of one per repo
drifting apart.

## What is in it

**`@xcp/wallet-sdk`** — framework-free. Runs anywhere `fetch` does.

- `provider/` — the wallet provider SDK: detection, `XcpWallet`, connection
  proofs, friendly errors.
- `bip322` — BIP-322 signature verification and pubkey recovery.
- `numeric` — raw-integer helpers: exact bigint parsing, lossless JSON,
  slippage math, quantity serialization for compose parameters.
- `pool-quote` — Core's swap quote algorithm in bigint, so a client can quote
  against state the node does not have yet (the mempool's).
- `raw-tx` — just enough raw-transaction parsing to know what a compose spends
  and what it returns as change.
- `spent-utxos` + `transaction-lock` — the cross-tab journal of our own
  broadcasts, and the per-address lock that serialises compose → sign →
  broadcast across tabs.
- `relay` + `client` — Counterparty reads with a same-origin fallback, a
  cross-tab throttle flag, and a budget so a throttled page cannot turn a
  per-visitor limit into a per-site one.
- `errors` — one `WalletSdkError` with a closed list of codes; every failure
  the SDK raises is one, the wallet's own numeric code kept alongside.
- `address-access` — which of a paired grant's addresses is the identity,
  under a site's own rule for what it can verify.
- `provider/psbt-capabilities` — the wallet's reported signing contract, and
  a check that refuses a known-incompatible PSBT before the approval screen.

**`@xcp/wallet-sdk/web`** — the one browser-only piece: `detectProvider`,
which finds the extension's injected provider. Kept apart so an extension
or a mobile app never ships a `window` reference.

**`@xcp/wallet-sdk/react`** — what a React site adds on top.

- `WalletProvider` / `useWallet` — the wallet context.
- `useCompose` — compose → sign → broadcast, with the lock, the journal, the
  UTXO-race retry and the friendly error mapping.
- `leaderPolling` — an SWR middleware: one tab polls each key, the others take
  its broadcast.

## Configuring

Two things differ between hosts, and only two: which node to talk to, and
where cross-load state lives. Both have web defaults.

```ts
import { configureWalletSdk } from "@xcp/wallet-sdk";

configureWalletSdk({
  counterpartyApiBase: "https://api.counterparty.io:4000/v2", // the default
  storage: localStorage,                                       // the default where it exists
});
```

An extension passes a synchronous shim over `chrome.storage`; a mobile app
passes a synchronous store such as MMKV. Storage is synchronous on purpose —
the journal and the throttle flag are read on the hot path of composing a
transaction.

## What a site can plug in

`WalletProvider` takes a few optional props so no site has to fork it:

| Prop | Who uses it | What it does |
|---|---|---|
| `provider` | marketplace (regtest runner), mobile | A provider instead of the injected extension |
| `pairedAddresses` | marketplace | Ask for the Legacy/SegWit sibling at connect |
| `canSign` | marketplace | Which addresses the site verifies; decides the identity under a pair |
| `describeIntent` | marketplace | How a PSBT intent is named in a capability error |
| `events` | exchange | `onMissing` / `onConnected` / `onRejected`, for analytics |

`useCompose` takes `{ onBroadcast, feeRate }`: an analytics hook per broadcast,
and where the default fee rate comes from. It exposes `compose(type, params)`
for any Counterparty message, with named builders as conveniences; a site's
own policy (the launchpad's XCP-69 fairminter) is a thin call to `compose` in
the site, not in here.

Every failure is a `WalletSdkError` with a `code`: `user_rejected`,
`unauthorized`, `timeout`, `rate_limited`, `capability` and so on. Branch on
`isWalletSdkError(e, code)`; show `friendlyError(e)`.

Proofs declare their signature dialect. BIP-322 is the default; a proof
declared BIP-137 `legacy_recoverable` (a Trezor) is verified that way and
only that way.

## Installing

Consumed as a git dependency pinned to a tag, so each app moves when it
chooses to:

```json
"@xcp/wallet-sdk": "github:XCP/wallet-sdk#<tag>"
```

The package ships TypeScript source, not a build. Next.js needs
`transpilePackages: ["@xcp/wallet-sdk"]`; Vite, WXT and Metro handle it as is.

## Developing

```
npm install
npm run check   # tsc + biome
npm test        # vitest
npm run format  # biome, in place
```

CI runs check and test on every push and pull request.

Releases are tags: bump `version` in package.json, commit, tag `vX.Y.Z`.

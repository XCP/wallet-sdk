# @xcp/wallet-sdk

Wallet and Counterparty transaction logic shared by the XCP sites, the browser
extension and the mobile app.

## Entries

| Entry | Contents |
|---|---|
| `@xcp/wallet-sdk` | Core. Session, provider wrapper, proofs, numerics, pool quote, transaction journal and lock, relay client. No `window`. |
| `@xcp/wallet-sdk/amounts` | Strict editable-draft validation and exact input/raw conversion. No dependencies, browser or React. |
| `@xcp/wallet-sdk/amounts/vectors` | Versioned, language-neutral JSON regression vectors. |
| `@xcp/wallet-sdk/web` | Wallet discovery (`discoverWallets`, `XCP_WALLET`, `HORIZON_WALLET`) and page-level signals (`webSessionOptions`). Browser only. |
| `@xcp/wallet-sdk/horizon` | Horizon Wallet as an `XcpProvider`: `detectHorizonProvider`, `createHorizonProvider`. |
| `@xcp/wallet-sdk/react` | `WalletProvider`, `useWallet`, `useWalletChooser`, `WalletChooser`, `useCompose`, `usePending`. |
| `@xcp/wallet-sdk/react/leader-polling` | The SWR middleware; `swr` is needed only here and below. |
| `@xcp/wallet-sdk/react/use-spendable-balance` | SWR-backed balance with pending debits. |

## Use

For transaction inputs, use the [strict amount contract](docs/amounts.md).
Keep invalid drafts visible and block quote/compose calls until validation succeeds.

```ts
import { createWalletSdk } from "@xcp/wallet-sdk";

const sdk = createWalletSdk({ storage: localStorage });
const balances = await sdk.counterparty.get(`/addresses/${address}/balances`);
```

```tsx
import { WalletProvider, useWallet, useCompose } from "@xcp/wallet-sdk/react";

<WalletProvider events={{ onConnected: track }}>{children}</WalletProvider>

const { status, address, connect, signPsbt } = useWallet();
const { compose, composeOrder } = useCompose({ onBroadcast });
```

Without React, `new WalletSession({ ...webSessionOptions() })` and `subscribe`.

### Locking is not disconnecting

`readyState: "locked"` retains the address and granted pair. Keep the user's
workspace visible. `WalletSession.signMessage`, `signTransaction`, `signPsbt`
and `signPsbts` check readiness and, only on that explicit action, ask the wallet
to unlock through its existing connection route. No new paired permission is
requested. Cancellation retains the connection; account or grant changes stop
the pending action. Signing failures are not automatically replayed by the session.
Passive reconciliation never opens unlock. A site's login expiry remains separate.
Public address metadata is remembered for locked reloads, scoped to the selected
wallet and active account. It is display data only: signing rechecks the live grant.

### Reload required

When XCP Wallet is updated or reloaded, pages that were already open lose their
link to it; only reloading the page reconnects. The extension says so with a
`4900` carrying `data.reloadRequired: true`, as a request failure and once as a
`disconnect` event. The session then moves to `readyState: "reload_required"`
(`reloadRequired: true`, `connectAction: "reload"`, `lastError.code ===
"reload_required"`). The address, the remembered connection and the address
metadata are kept: the site was not revoked, and the reloaded page restores
them. The state is sticky for the page; signing and connect fail at once with
`reload_required` without calling the wallet. Show a "Reload page" prompt
(`RELOAD_REQUIRED_MESSAGE` is the extension's wording) and disable signing.
`useWalletChooser().connect` reloads the page under `reload`.

A plain `4900` (no `data`) is a background restart and is still retried once;
a `disconnect` with `{}` is a revocation and still clears the session.

### Taproot commit and reveal

Compose refuses Taproot encoding (see below); a site sends a Core 11.5
`encoding=taproot` compose or an inscription as a `commit-and-reveal` bundle with
`signCommitAndReveal`, which XCP Wallet 0.14.1+ signs in one approval when it
lists the kind. See [commit and reveal](docs/commit-and-reveal.md).

### Bundles

`signPsbts` sends linked PSBTs; XCP Wallet uses one approval and Horizon uses one per PSBT. XCP Wallet reports what it can
take in `getAddresses().signing.psbtBatch`: `maxRequests`,
`maxPolicyOfferAlternatives` and `marketplaceBundles`, the kinds it proves as a
whole (`attach-and-list`, `authorize-offers`, `fund-and-authorize-offers`,
`fund-policy-offer`, `commit-and-reveal`, and whatever a newer wallet adds).
Send a kind only when `supportsMarketplaceBundle(signing, kind)` says so. The
reported size is the limit; `SIGN_PSBTS_BUNDLE_LIMIT` (8) applies only to a
wallet that reports nothing.

## Configuration

`configureWalletSdk({ counterpartyApiBase, storage })`, or the same fields on
`createWalletSdk`. Storage is a synchronous key-value store; `localStorage`
by default where present. An extension passes a `chrome.storage` shim, a
mobile app an MMKV instance.

`WalletProvider` / `WalletSessionOptions`: `wallets` (which wallets to
offer; default every supported one), `provider` (skip discovery),
`pairedAddresses`, `canSign` (identity policy under a paired grant),
`describeIntent`, `events`, `origin`, `lockOnEmptyReconcile` (an empty
passive answer reads as a lock; off by default because a cold worker
answers empty too).

`useCompose({ onBroadcast, feeRate })`; `compose(type, params)` composes any
message, `composeFromUtxo` targets one UTXO. Site policy stays in the site.
Compose broadcasts one transaction, so it refuses `encoding: "taproot"` and
`inscription: true`, and any Core answer carrying a reveal, with
`reveal_unsupported`: a commit broadcast without its reveal strands its BTC.

## Which wallet

XCP Wallet is the default and the recommended wallet: first in every list,
the wallet a stored address is assumed to belong to, and the only one with
the full surface (raw signing, bundles, events). Horizon Wallet is the one
supported alternative, offered when it is installed. The session finds both
and binds to one only when a stored address names it or connect picks it.
`connectAction` says what the connect button should do:

| Installed | `connectAction` | Connect button |
|---|---|---|
| none | `install` | opens a panel of store links |
| one | `connect` | connects through it, no chooser |
| both, none remembered | `choose` | opens a two-row chooser, once |
| both, one remembered | `connect` | connects through the remembered one |
| (wallet updated or restarted) | `reload` | reloads the page |

`state.accounts` is every account the wallet granted, active first: one
for XCP Wallet, all of them for Horizon, which has no active account of its
own. `switchAccount(address)` acts as another one; a site shows a picker
when there is more than one. `connect(id)` answers the chooser and remembers the choice under
`xcp:wallet-choice`; `forgetWallet()` clears it. `state.wallet` names the
bound wallet; `state.wallets` is the list, XCP Wallet first, with
`installed` flags and icons. Wallets registered in `window.btc_providers`
but without an adapter here are never offered.

```tsx
import { useWalletChooser, WalletChooser } from "@xcp/wallet-sdk/react";

const chooser = useWalletChooser();
<button onClick={chooser.connect}>Connect</button>
<Dialog open={chooser.open} onClose={chooser.close}>
  <WalletChooser chooser={chooser} />
</Dialog>
```

`useWalletMenu()` is the connected menu's state: the bound wallet, the
granted accounts and `switchAccount`, `canSwitchWallet` and `switchWallet`,
`disconnect`. `WalletChooser` renders the rows and nothing else; the dialog and its
styling are the site's (`xcp-wallet-chooser__*` class names). To offer XCP
Wallet only: `<WalletProvider wallets={discoverWallets([XCP_WALLET])}>`.

## Message signatures

`verifyBip322(address, message, signature)` checks BIP-322 simple for SegWit
and Taproot. A P2PKH (`1…`) address accepts either form, chosen by decoded
length: a 65-byte classic BIP-137 signature (what XCP Wallet 0.14 signs for
legacy addresses, headers 27–34) or the older two-item BIP-322 stack. The
recovered key must hash to the address; a proof's `verification` label never
decides validity there. `pubkeyFromBip322(address, signature, message)`
returns the signer's key, in the classic header's encoding when classic.

`signIn(session, origin, nonce)` asks the wallet to sign an `xcp-sign-in`
challenge; `verifySignIn` checks it, or a connection proof, on the server.
Messages starting `xcp-wallet\n` are XCP Wallet's own connection proofs, which
it refuses to sign for a site.

## Horizon Wallet

The supported alternative. Discovery offers it when installed; to bind to
it outright instead:

```tsx
import { createHorizonProvider, detectHorizonProvider, horizonMessageVerification } from "@xcp/wallet-sdk/horizon";

const horizon = await detectHorizonProvider();
<WalletProvider provider={createHorizonProvider(horizon)} messageVerificationForAddress={horizonMessageVerification}>
```

Horizon proves nothing at connect. With `proofOnConnect` the session asks it
to sign the connection proof, one more prompt, so connect is login on sites
that exchange proofs for sessions; declining leaves the session unverified.
Horizon has no raw-transaction signing, so composes go through the PSBT path;
no broadcast, so the SDK broadcasts through the node; no events, so account
switches show up on the next prompt; no bundles, so `signPsbts` is one prompt
per PSBT. Legacy/SegWit messages declare BIP-137; Taproot messages explicitly
declare ECDSA-BIP86. Servers must support that exact-address verifier to accept
Taproot login. See [Horizon compatibility](docs/horizon.md) for tested actions
and the distinction between generic signing and wallet-side intent validation.

## End to end

`npm run test:e2e` drives the real extensions in a headed Chromium: XCP Wallet
from `../extension/.output/chrome-mv3` (or `XCP_WALLET_EXTENSION`), onboarded
fresh, then connect with the proof verified in the page, a message signature
verified against the address, restore on reload, and disconnect. With
`HORIZON_EXTENSION` pointing at an unpacked Horizon build it also checks
Horizon's injected surface, its registry entry, and that discovery offers the
chooser. Horizon's own prompts render on a canvas and are not driven. Not part
of CI.

## Errors

Every failure is a `WalletSdkError` with a `code`: `user_rejected`,
`unauthorized`, `unsupported_method`, `disconnected`, `reload_required`,
`wallet_missing`, `timeout`, `invalid_response`, `capability`, `rate_limited`,
`network`, `invalid_argument`, `wallet_choice`, `transaction_mismatch`,
`reveal_unsupported`. `isWalletSdkError(e, code)` to
branch; `friendlyError(e)` to display. `isReloadRequired(e)` also recognises a
raw provider error or `disconnect` payload.

## Install

```json
"@xcp/wallet-sdk": "github:XCP/wallet-sdk#v0.5.0"
```

Builds on install (`prepare`). Ships ESM and type declarations.

### Wallet versions

0.5.0 targets XCP Wallet 0.14 and Counterparty Core 11.5. Features are found
by what the wallet reports, never by its version:

- Classic P2PKH message signatures (XCP Wallet 0.14) verify alongside the
  older BIP-322 stack.
- `signing.psbtBatch` reports `maxRequests`, `maxPolicyOfferAlternatives` and
  `marketplaceBundles`; the SDK uses them for bundle limits.
- `commit-and-reveal` (XCP Wallet 0.14.1+) is listed only by a wallet that can
  sign it; `signCommitAndReveal` asks nothing of any other.
- `xcp_signPsbt` takes no `reveal` (removed in XCP Wallet 0.14.1). An
  `inscription` commit's leaf is closed by the source's own Taproot key and
  its reveal is a second `xcp_signPsbt`; a Core 11.5 compose uses
  `signCommitAndReveal`.

## Develop

```
npm install
npm run check   # tsc + biome
npm test
npm run build
npm run docs    # typedoc -> docs/api
```

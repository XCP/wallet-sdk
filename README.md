# @xcp/wallet-sdk

Wallet and Counterparty transaction logic shared by the XCP sites, the browser
extension and the mobile app.

## Entries

| Entry | Contents |
|---|---|
| `@xcp/wallet-sdk` | Core. Session, provider wrapper, proofs, numerics, pool quote, transaction journal and lock, relay client. No `window`. |
| `@xcp/wallet-sdk/web` | Wallet discovery (`discoverWallets`, `XCP_WALLET`, `HORIZON_WALLET`) and page-level signals (`webSessionOptions`). Browser only. |
| `@xcp/wallet-sdk/horizon` | Horizon Wallet as an `XcpProvider`: `detectHorizonProvider`, `createHorizonProvider`. |
| `@xcp/wallet-sdk/react` | `WalletProvider`, `useWallet`, `useWalletChooser`, `WalletChooser`, `useCompose`, `leaderPolling`. |

## Use

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

## Configuration

`configureWalletSdk({ counterpartyApiBase, storage })`, or the same fields on
`createWalletSdk`. Storage is a synchronous key-value store; `localStorage`
by default where present. An extension passes a `chrome.storage` shim, a
mobile app an MMKV instance.

`WalletProvider` / `WalletSessionOptions`: `wallets` (which wallets to
offer; default every supported one), `provider` (skip discovery),
`pairedAddresses`, `canSign` (identity policy under a paired grant),
`describeIntent`, `events`, `origin`.

`useCompose({ onBroadcast, feeRate })`; `compose(type, params)` composes any
message, `composeFromUtxo` targets one UTXO. Site policy stays in the site.

## Which wallet

Two wallets are supported: XCP Wallet and Horizon Wallet. The session finds
both and binds to one only when a stored address names it or connect picks
it. `connectAction` says what the connect button should do:

| Installed | `connectAction` | Connect button |
|---|---|---|
| none | `install` | opens a panel of store links |
| one | `connect` | connects through it, no chooser |
| both, none remembered | `choose` | opens a two-row chooser, once |
| both, one remembered | `connect` | connects through the remembered one |

`connect(id)` answers the chooser and remembers the choice under
`xcp:wallet-choice`; `forgetWallet()` clears it. `state.wallet` names the
bound wallet; `state.wallets` is the list, recommended first, with
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

`WalletChooser` renders the rows and nothing else; the dialog and its
styling are the site's (`xcp-wallet-chooser__*` class names). To offer one
wallet only: `<WalletProvider wallets={discoverWallets([XCP_WALLET])}>`.

## Horizon Wallet

Offered by default through discovery. To bind to it outright:

```tsx
import { createHorizonProvider, detectHorizonProvider, HORIZON_MESSAGE_VERIFICATION } from "@xcp/wallet-sdk/horizon";

const horizon = await detectHorizonProvider();
<WalletProvider provider={createHorizonProvider(horizon)} messageVerification={HORIZON_MESSAGE_VERIFICATION}>
```

Horizon has no raw-transaction signing, so composes go through the PSBT path;
no broadcast, so the SDK broadcasts through the node; no events, so account
switches show up on the next prompt; no bundles, so `signPsbts` is one prompt
per PSBT. Message signatures are BIP-137 and are declared as such on proofs.

## Errors

Every failure is a `WalletSdkError` with a `code`: `user_rejected`,
`unauthorized`, `unsupported_method`, `disconnected`, `wallet_missing`,
`timeout`, `invalid_response`, `capability`, `rate_limited`, `network`,
`invalid_argument`, `wallet_choice`. `isWalletSdkError(e, code)` to branch;
`friendlyError(e)` to display.

## Install

```json
"@xcp/wallet-sdk": "github:XCP/wallet-sdk#v0.1.0"
```

Builds on install (`prepare`). Ships ESM and type declarations.

## Develop

```
npm install
npm run check   # tsc + biome
npm test
npm run build
npm run docs    # typedoc -> docs/api
```

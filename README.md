# @xcp/wallet-sdk

Wallet and Counterparty transaction logic shared by the XCP sites, the browser
extension and the mobile app.

## Entries

| Entry | Contents |
|---|---|
| `@xcp/wallet-sdk` | Core. Session, provider wrapper, proofs, numerics, pool quote, transaction journal and lock, relay client. No `window`. |
| `@xcp/wallet-sdk/web` | Wallet discovery (`discoverWallets`, `XCP_WALLET`, `HORIZON_WALLET`) and page-level signals (`webSessionOptions`). Browser only. |
| `@xcp/wallet-sdk/horizon` | Horizon Wallet as an `XcpProvider`: `detectHorizonProvider`, `createHorizonProvider`. |
| `@xcp/wallet-sdk/react` | `WalletProvider`, `useWallet`, `useWalletChooser`, `WalletChooser`, `useCompose`, `usePending`. |
| `@xcp/wallet-sdk/react/leader-polling` | The SWR middleware; `swr` is needed only here and below. |
| `@xcp/wallet-sdk/react/use-spendable-balance` | SWR-backed balance with pending debits. |

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
`describeIntent`, `events`, `origin`, `lockOnEmptyReconcile` (an empty
passive answer reads as a lock; off by default because a cold worker
answers empty too).

`useCompose({ onBroadcast, feeRate })`; `compose(type, params)` composes any
message, `composeFromUtxo` targets one UTXO. Site policy stays in the site.

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

## Horizon Wallet

The supported alternative. Discovery offers it when installed; to bind to
it outright instead:

```tsx
import { createHorizonProvider, detectHorizonProvider, HORIZON_MESSAGE_VERIFICATION } from "@xcp/wallet-sdk/horizon";

const horizon = await detectHorizonProvider();
<WalletProvider provider={createHorizonProvider(horizon)} messageVerification={HORIZON_MESSAGE_VERIFICATION}>
```

Horizon proves nothing at connect. With `proofOnConnect` the session asks it
to sign the connection proof, one more prompt, so connect is login on sites
that exchange proofs for sessions; declining leaves the session unverified.
Horizon has no raw-transaction signing, so composes go through the PSBT path;
no broadcast, so the SDK broadcasts through the node; no events, so account
switches show up on the next prompt; no bundles, so `signPsbts` is one prompt
per PSBT. Message signatures are BIP-137 and are declared as such on proofs.

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

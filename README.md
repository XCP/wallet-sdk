# @xcp/wallet-sdk

Wallet and Counterparty transaction logic shared by the XCP sites, the browser
extension and the mobile app.

## Entries

| Entry | Contents |
|---|---|
| `@xcp/wallet-sdk` | Core. Session, provider wrapper, proofs, numerics, pool quote, transaction journal and lock, relay client. No `window`. |
| `@xcp/wallet-sdk/web` | `detectProvider` and page-level signals (`webSessionOptions`). Browser only. |
| `@xcp/wallet-sdk/react` | `WalletProvider`, `useWallet`, `useCompose`, `leaderPolling`. |

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

`WalletProvider` / `WalletSessionOptions`: `provider` (skip detection),
`pairedAddresses`, `canSign` (identity policy under a paired grant),
`describeIntent`, `events`, `origin`.

`useCompose({ onBroadcast, feeRate })`; `compose(type, params)` composes any
message, `composeFromUtxo` targets one UTXO. Site policy stays in the site.

## Errors

Every failure is a `WalletSdkError` with a `code`: `user_rejected`,
`unauthorized`, `unsupported_method`, `disconnected`, `wallet_missing`,
`timeout`, `invalid_response`, `capability`, `rate_limited`, `network`,
`invalid_argument`. `isWalletSdkError(e, code)` to branch; `friendlyError(e)`
to display.

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

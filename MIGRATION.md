# Migrating a site to @xcp/wallet-sdk

1. Add `"@xcp/wallet-sdk": "github:XCP/wallet-sdk#<tag>"`. It builds on install.
2. Delete `lib/wallet/`, `lib/counterparty-relay.ts`, `lib/swr-leader.ts`,
   `lib/pool-quote.ts`, `lib/bip322.ts`, `lib/pending.ts`, `hooks/use-spendable-balance.ts`.
3. Replace imports:
   - `@/lib/wallet/wallet-context` -> `@xcp/wallet-sdk/react` (`WalletProvider`, `useWallet`)
   - `@/lib/wallet/useCompose` -> `@xcp/wallet-sdk/react` (`useCompose`)
   - `@/lib/wallet/sdk` -> `@xcp/wallet-sdk`
   - `@/lib/counterparty-relay` -> `@xcp/wallet-sdk` (`relayingFetch`, `isRateLimited`, `RelayBudgetExhausted`)
   - `@/lib/swr-leader` -> `@xcp/wallet-sdk/react/leader-polling`
   - `hooks/use-spendable-balance` -> `@xcp/wallet-sdk/react/use-spendable-balance`
   - `@/lib/pool-quote` -> `@xcp/wallet-sdk`
   - `@/lib/pending` -> `@xcp/wallet-sdk` (`registerPending`, ...) and `usePending`
4. Configure once, before the provider mounts:
   `configureWalletSdk({ counterpartyApiBase, network })` or `createWalletSdk(...)`.
5. Per site:
   - `status === "not_detected"` becomes `"detecting"` or `"not_installed"`. `"locked"` is new:
     the extension emitted an empty account list on lock; identity and grant stay, and
     `connect()` opens the unlock screen. Gate actions on `"connected"`.
   - Launchpad: `composeFairminter` becomes `compose("fairminter", params)` in the site.
   - Exchange: `trackWallet` / `trackTx` become `events` on `WalletProvider` and
     `onBroadcast` on `useCompose`; the precise fee source becomes `feeRate`.
   - Marketplace: the runner becomes `provider`; `canSignHere` becomes `canSign`;
     PSBT requests pass through `signPsbt(request)` / `signPsbts(request)` unchanged;
     intent naming becomes `describeIntent`.
6. Storage keys are prefixed `xcp:`; in-flight throttle flags and journal rows
   (15-minute TTL) start empty once.

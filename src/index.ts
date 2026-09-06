/**
 * @xcp/wallet-sdk — the transaction logic the XCP properties share.
 *
 * Framework-free. Nothing here touches React, SWR, `window` or the DOM
 * beyond `fetch` and the storage the host injects (see config.ts). Finding
 * the extension's injected provider is the separate `@xcp/wallet-sdk/web`
 * entry; the React bindings the sites use are `@xcp/wallet-sdk/react`.
 */

export * from "./address-access";
export * from "./bip322";
export * from "./client";
export {
  configureWalletSdk,
  DEFAULT_COUNTERPARTY_API_BASE,
  getCounterpartyApiBase,
  getStorage,
  type KeyValueStorage,
  type WalletSdkConfig,
} from "./config";
export * from "./errors";
export * from "./numeric";
export * from "./pool-quote";
export * from "./provider";
export * from "./raw-tx";
export * from "./relay";
export * from "./spent-utxos";
export * from "./transaction-lock";

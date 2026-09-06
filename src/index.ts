/**
 * @xcp/wallet-sdk — the transaction logic the XCP properties share.
 *
 * Framework-free. Nothing here touches React, SWR or the DOM beyond `fetch`
 * and the storage the host injects (see config.ts). The React bindings the
 * sites use are the separate `@xcp/wallet-sdk/react` entry.
 */

export {
  configureWalletSdk,
  getCounterpartyApiBase,
  getStorage,
  DEFAULT_COUNTERPARTY_API_BASE,
  type KeyValueStorage,
  type WalletSdkConfig,
} from "./config";

export * from "./numeric";
export * from "./pool-quote";
export * from "./raw-tx";
export * from "./spent-utxos";
export * from "./transaction-lock";
export * from "./relay";
export * from "./client";
export * from "./bip322";

export * from "./provider";

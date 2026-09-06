/**
 * Host-injected configuration. Web defaults apply when unset. Storage is
 * synchronous because the journal and the throttle flag are read on the compose path.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WalletSdkConfig {
  /** The Counterparty node, including `/v2`. */
  counterpartyApiBase?: string;
  /** Where cross-load state lives. `null` means nowhere: everything still
   *  works, nothing survives a reload. */
  storage?: KeyValueStorage | null;
}

export const DEFAULT_COUNTERPARTY_API_BASE = "https://api.counterparty.io:4000/v2";

let apiBase = DEFAULT_COUNTERPARTY_API_BASE;
let configuredStorage: KeyValueStorage | null | undefined;

export function configureWalletSdk(config: WalletSdkConfig): void {
  if (config.counterpartyApiBase !== undefined) apiBase = config.counterpartyApiBase.replace(/\/+$/, "");
  if (config.storage !== undefined) configuredStorage = config.storage;
}

export function getCounterpartyApiBase(): string {
  return apiBase;
}

/** Read on each call: a host may configure after first import. */
export function getStorage(): KeyValueStorage | null {
  if (configuredStorage !== undefined) return configuredStorage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Some contexts throw on the accessor itself (sandboxed frames).
    return null;
  }
}

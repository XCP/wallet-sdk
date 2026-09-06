/**
 * The two things a host has to tell the SDK, and the only two.
 *
 * Everything else in this package is pure: given a node to talk to and a
 * place to remember things across page loads, the same code runs in a
 * Next.js site, a Chrome extension, and a React Native app. Those two are
 * exactly what differ between them, so they are injected here rather than
 * assumed anywhere.
 *
 * Both have web defaults, so a site changes nothing: the public node, and
 * `localStorage` where it exists. An extension passes a `chrome.storage`
 * shim; a mobile app passes a synchronous store such as MMKV. Storage is
 * synchronous on purpose — the journal and the throttle flag are read on
 * the hot path of composing a transaction, where an await per lookup would
 * reorder work that must stay ordered. A host with only an async store
 * preloads into memory and hands the SDK that.
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

/**
 * The configured store, else `localStorage` when the runtime has one, else
 * null. Read every time rather than cached: a host may configure after the
 * first module that needs storage has already been imported.
 */
export function getStorage(): KeyValueStorage | null {
  if (configuredStorage !== undefined) return configuredStorage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Some contexts throw on the accessor itself (sandboxed frames).
    return null;
  }
}

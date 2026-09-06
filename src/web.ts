/** Browser-only: locating the injected wallets and page-level signals a session needs. */

import { discoverWallets } from "@/wallets/discovery";

export {
  discoverWallets,
  KNOWN_WALLETS,
  type WalletDiscovery,
} from "@/wallets/discovery";
export { HORIZON_WALLET, HORIZON_WALLET_INSTALL_URL } from "@/wallets/horizon";
export { type RegisteredProvider, registeredProvider } from "@/wallets/registry";
export { XCP_WALLET, XCP_WALLET_INSTALL_URL } from "@/wallets/xcp";

/** The `storage` event fires only in other tabs: the cross-tab connect signal. */
export function subscribeStorageKey(key: string, onChange: (value: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: StorageEvent) => {
    if (event.key === key) onChange(event.newValue);
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

export const isPageVisible = (): boolean =>
  typeof document === "undefined" || document.visibilityState === "visible";

/** Browser defaults for `WalletSessionOptions`: every supported wallet, chosen at connect. */
export function webSessionOptions() {
  return {
    wallets: discoverWallets(),
    subscribeStorage: subscribeStorageKey,
    isVisible: isPageVisible,
    origin: typeof window === "undefined" ? undefined : window.location.origin,
  };
}

/** Browser-only: locating the injected wallets and page-level signals a session needs. */

import { WalletSdkError } from "@/errors";
import type { XcpProvider } from "@/provider/types";
import { discoverWallets } from "@/wallets/discovery";
import { XCP_DISCOVER_EVENT, XCP_INITIALIZED_EVENT } from "@/wallets/xcp";

export {
  discoverWallets,
  KNOWN_WALLETS,
  type WalletDiscovery,
} from "@/wallets/discovery";
export { HORIZON_WALLET, HORIZON_WALLET_INSTALL_URL } from "@/wallets/horizon";
export { type RegisteredProvider, registeredProvider } from "@/wallets/registry";
export { XCP_WALLET, XCP_WALLET_INSTALL_URL } from "@/wallets/xcp";

/** Resolves once the provider is injected, or rejects after `timeoutMs`. Dispatches `xcp-wallet#discover` so an already-injected provider re-announces. */
export function detectProvider(timeoutMs = 3000): Promise<XcpProvider> {
  if (typeof window === "undefined")
    return Promise.reject(new WalletSdkError("wallet_missing", "Not in a browser environment"));
  if (window.xcpwallet) return Promise.resolve(window.xcpwallet);

  return new Promise<XcpProvider>((resolve, reject) => {
    const handler = () => {
      if (window.xcpwallet) {
        cleanup();
        resolve(window.xcpwallet);
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      if (window.xcpwallet) {
        resolve(window.xcpwallet);
      } else {
        reject(new WalletSdkError("wallet_missing", "XCP wallet not detected"));
      }
    }, timeoutMs);

    function cleanup() {
      window.removeEventListener(XCP_INITIALIZED_EVENT, handler);
      clearTimeout(timer);
    }

    window.addEventListener(XCP_INITIALIZED_EVENT, handler);

    window.dispatchEvent(new Event(XCP_DISCOVER_EVENT));
  });
}

export function getProvider(): XcpProvider | null {
  if (typeof window === "undefined") return null;
  return window.xcpwallet ?? null;
}

/** The `storage` event fires only in other tabs: the cross-tab connect signal. */
export function subscribeStorageKey(key: string, onChange: (value: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: StorageEvent) => {
    if (event.key === key) onChange(event.newValue);
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

/** Content scripts can inject seconds after page load. */
export function onLateProvider(init: (provider: XcpProvider) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => {
    if (window.xcpwallet) {
      window.removeEventListener(XCP_INITIALIZED_EVENT, handler);
      init(window.xcpwallet);
    }
  };
  window.addEventListener(XCP_INITIALIZED_EVENT, handler);
  return () => window.removeEventListener(XCP_INITIALIZED_EVENT, handler);
}

/** Nudge a provider that injected after the session started looking. */
export function announceLateProvider(): void {
  if (typeof window !== "undefined" && window.xcpwallet) {
    window.dispatchEvent(new Event(XCP_INITIALIZED_EVENT));
  }
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

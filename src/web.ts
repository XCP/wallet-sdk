/** Browser-only: locating the injected provider and page-level signals a session needs. */

import { WalletSdkError } from "@/errors";
import type { XcpProvider } from "@/provider/types";

declare global {
  interface Window {
    xcpwallet?: XcpProvider;
  }
}

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
      window.removeEventListener("xcp-wallet#initialized", handler);
      clearTimeout(timer);
    }

    window.addEventListener("xcp-wallet#initialized", handler);

    window.dispatchEvent(new Event("xcp-wallet#discover"));
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
      window.removeEventListener("xcp-wallet#initialized", handler);
      init(window.xcpwallet);
    }
  };
  window.addEventListener("xcp-wallet#initialized", handler);
  return () => window.removeEventListener("xcp-wallet#initialized", handler);
}

/** Nudge a provider that injected after the session started looking. */
export function announceLateProvider(): void {
  if (typeof window !== "undefined" && window.xcpwallet) {
    window.dispatchEvent(new Event("xcp-wallet#initialized"));
  }
}

export const isPageVisible = (): boolean =>
  typeof document === "undefined" || document.visibilityState === "visible";

/** Browser defaults for `WalletSessionOptions`. */
export function webSessionOptions() {
  return {
    detect: () => detectProvider(),
    onLateProvider,
    subscribeStorage: subscribeStorageKey,
    isVisible: isPageVisible,
    origin: typeof window === "undefined" ? undefined : window.location.origin,
  };
}

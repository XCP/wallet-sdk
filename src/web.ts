/**
 * The browser-only entry: finding the extension's injected provider.
 *
 * Kept out of the core so an extension or a mobile app never ships a
 * `window` reference. A site imports `@xcp/wallet-sdk/web`; the React
 * context does so on its behalf.
 */

import { WalletSdkError } from "./errors";
import type { XcpProvider } from "./provider/types";

declare global {
  interface Window {
    xcpwallet?: XcpProvider;
  }
}

/**
 * Async detection that handles the race between script load and extension injection.
 * Resolves with the provider once available, or rejects after timeout.
 *
 * Uses a request/announce pattern: dispatches 'xcp-wallet#discover' to ask
 * the extension to re-announce itself, so detection works regardless of
 * whether the extension injected before or after this code runs.
 */
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

    // Ask the extension to re-announce — handles the case where the extension
    // injected before this listener was registered (race condition fix)
    window.dispatchEvent(new Event("xcp-wallet#discover"));
  });
}

/** Sync check — returns the provider if already injected, otherwise null. */
export function getProvider(): XcpProvider | null {
  if (typeof window === "undefined") return null;
  return window.xcpwallet ?? null;
}

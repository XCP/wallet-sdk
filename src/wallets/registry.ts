/**
 * `window.btc_providers` is the page-global list Bitcoin wallets push
 * themselves into (the sats-connect convention). Only the registry is used
 * here, never its request protocol: a wallet is recognised by id and wrapped
 * by its own adapter, so wallets without one are never offered.
 */

export interface RegisteredProvider {
  id: string;
  name?: string;
  icon?: string;
  methods?: string[];
}

declare global {
  interface Window {
    btc_providers?: RegisteredProvider[];
  }
}

export function registeredProvider(id: string): RegisteredProvider | null {
  if (typeof window === "undefined" || !Array.isArray(window.btc_providers)) return null;
  return window.btc_providers.find((entry) => entry?.id === id) ?? null;
}

/** Only a source an `<img>` will actually render; a broken data URI shows as a missing image. */
export function usableIcon(icon: unknown): string | null {
  if (typeof icon !== "string") return null;
  return /^(data:image\/(png|svg\+xml|webp|jpeg);|https:\/\/)/.test(icon) ? icon : null;
}

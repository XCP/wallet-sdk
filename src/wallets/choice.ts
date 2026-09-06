import { getStorage } from "@/config";
import type { WalletId } from "@/wallets/descriptor";

/** Which wallet this site last connected through. Read at restore and whenever more than one is installed. */
export const WALLET_CHOICE_STORAGE_KEY = "xcp:wallet-choice";

export function rememberedWallet(known: readonly WalletId[]): WalletId | null {
  try {
    const value = getStorage()?.getItem(WALLET_CHOICE_STORAGE_KEY);
    return known.includes(value as WalletId) ? (value as WalletId) : null;
  } catch {
    return null;
  }
}

export function rememberWallet(id: WalletId): void {
  try {
    getStorage()?.setItem(WALLET_CHOICE_STORAGE_KEY, id);
  } catch {}
}

export function forgetRememberedWallet(): void {
  try {
    getStorage()?.removeItem(WALLET_CHOICE_STORAGE_KEY);
  } catch {}
}

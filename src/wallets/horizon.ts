import { createHorizonProvider, getHorizonProvider, HORIZON_MESSAGE_VERIFICATION } from "@/horizon/provider";
import type { WalletDescriptor } from "@/wallets/descriptor";

export const HORIZON_WALLET_INSTALL_URL =
  "https://chromewebstore.google.com/detail/horizon-wallet/bnmgkjlaommgappfckljlelgahnbngme";

/** Horizon announces nothing on injection, so a late arrival is found by polling for a few seconds. */
const INJECT_POLL_MS = 250;
const INJECT_POLL_LIMIT_MS = 5_000;

export const HORIZON_WALLET: WalletDescriptor = {
  id: "horizon",
  name: "Horizon Wallet",
  icon: null,
  installUrl: HORIZON_WALLET_INSTALL_URL,
  registryId: "HorizonWalletProvider",
  messageVerification: HORIZON_MESSAGE_VERIFICATION,
  installed: () => getHorizonProvider() !== null,
  provider: () => createHorizonProvider(),
  onInjected: (listener) => {
    if (typeof window === "undefined" || getHorizonProvider()) return () => {};
    const started = Date.now();
    const timer = setInterval(() => {
      if (getHorizonProvider()) {
        clearInterval(timer);
        listener();
      } else if (Date.now() - started >= INJECT_POLL_LIMIT_MS) {
        clearInterval(timer);
      }
    }, INJECT_POLL_MS);
    return () => clearInterval(timer);
  },
};

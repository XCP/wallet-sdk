import {
  CASATOOKAN_MESSAGE_VERIFICATION,
  casaTookanMessageVerification,
  createCasaTookanProvider,
  getCasaTookanProvider,
} from "@/casatookan/provider";
import type { WalletDescriptor } from "@/wallets/descriptor";

export const CASATOOKAN_WALLET: WalletDescriptor = {
  id: "casatookan",
  name: "Casa Tookan",
  icon: null,
  installUrl: "https://casatookan.com",
  registryId: "CasaTookanBitcoinProvider",
  messageVerification: CASATOOKAN_MESSAGE_VERIFICATION,
  messageVerificationForAddress: casaTookanMessageVerification,
  installed: () => getCasaTookanProvider() !== null,
  provider: () => createCasaTookanProvider(),
  onInjected: (listener) => {
    if (typeof window === "undefined" || getCasaTookanProvider()) return () => {};
    const started = Date.now();
    const timer = setInterval(() => {
      if (getCasaTookanProvider()) {
        clearInterval(timer);
        listener();
      } else if (Date.now() - started >= 5_000) {
        clearInterval(timer);
      }
    }, 250);
    return () => clearInterval(timer);
  },
};

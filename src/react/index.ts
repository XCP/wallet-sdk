/**
 * @xcp/wallet-sdk/react — React bindings over the core session and compose
 * pipeline, plus the SWR leader-polling middleware.
 */

export { leaderPolling } from "@/react/leader-polling";
export {
  type ComposeState,
  type ComposeStatus,
  type UseComposeOptions,
  useCompose,
} from "@/react/use-compose";
export { useWallet } from "@/react/use-wallet";
export {
  WalletContext,
  type WalletContextValue,
  WalletProvider,
  type WalletProviderProps,
} from "@/react/wallet-provider";
export {
  type ProofStatus,
  WALLET_CONNECTED_STORAGE_KEY,
  type WalletReadyState,
  type WalletSessionEvents,
  type WalletSessionState,
} from "@/session";

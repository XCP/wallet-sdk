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
export { usePending } from "@/react/use-pending";
export { useSpendableBalance } from "@/react/use-spendable-balance";
export { useWallet } from "@/react/use-wallet";
export { useWalletChooser, type WalletChooserState } from "@/react/use-wallet-chooser";
export { WalletChooser, type WalletChooserProps } from "@/react/wallet-chooser";
export {
  WalletContext,
  type WalletContextValue,
  WalletProvider,
  type WalletProviderProps,
} from "@/react/wallet-provider";
export {
  type ConnectAction,
  type ProofStatus,
  WALLET_CONNECTED_STORAGE_KEY,
  type WalletReadyState,
  type WalletSessionEvents,
  type WalletSessionState,
} from "@/session";
export type { WalletCandidate, WalletId } from "@/wallets/descriptor";

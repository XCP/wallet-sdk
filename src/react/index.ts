/**
 * @xcp/wallet-sdk/react — what a React site puts on top of the core.
 *
 * The wallet context, the compose → sign → broadcast hook, and the SWR
 * middleware that makes several tabs poll like one. An extension or a mobile
 * app does not import this entry; it builds its own UI on the core.
 */

export { leaderPolling } from "./swr-leader";
export type { ComposeState, ComposeStatus, UseComposeOptions } from "./use-compose";
export { fetchMedianFeeRate, fetchPriorityFeeRate, useCompose } from "./use-compose";
export type {
  ProofStatus,
  WalletContextValue,
  WalletEvents,
  WalletProviderProps,
  XcpWalletStatus,
} from "./wallet-context";
export { useWallet, WALLET_CONNECTED_STORAGE_KEY, WalletProvider } from "./wallet-context";

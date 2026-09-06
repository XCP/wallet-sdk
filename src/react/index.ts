/**
 * @xcp/wallet-sdk/react — what a React site puts on top of the core.
 *
 * The wallet context, the compose → sign → broadcast hook, and the SWR
 * middleware that makes several tabs poll like one. An extension or a mobile
 * app does not import this entry; it builds its own UI on the core.
 */

export { WalletProvider, useWallet } from "./wallet-context";
export { useCompose, fetchMedianFeeRate, fetchPriorityFeeRate } from "./use-compose";
export type { ComposeState, ComposeStatus } from "./use-compose";
export { leaderPolling } from "./swr-leader";

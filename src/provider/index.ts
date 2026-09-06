/**
 * XCP Wallet SDK — framework-agnostic wallet integration.
 *
 * React apps: use `useWallet()` from the react entry instead.
 * Non-React: get a provider (the web entry's `detectProvider()`, or your
 * own bridge) and wrap it: `new XcpWallet(provider)`.
 */

export {
  BTC_ADDRESS_REGEX,
  DISCONNECTED,
  UNAUTHORIZED,
  UNSUPPORTED_METHOD,
  USER_REJECTED,
} from "./constants";
export { friendlyError } from "./errors";
export { SIGN_PSBTS_BUNDLE_LIMIT, XcpWallet, type XcpWalletOptions } from "./provider";
export {
  assertProviderCanSignPsbt,
  assertProviderCanSignPsbts,
  type IntentDescriber,
  type ProviderPsbtSigningCapabilities,
  type ProviderPsbtSigningMethodCapabilities,
  ProviderSigningCapabilityError,
  type ProviderSigningCapabilityErrorCode,
  parseProviderPsbtSigningCapabilities,
} from "./psbt-capabilities";
export type {
  ConnectionProof,
  ConnectResult,
  SignPsbtParams,
  SignPsbtRequest,
  SignPsbtsRequest,
  WalletAddress,
  WalletAddresses,
  XcpProvider,
  XcpWalletEvents,
} from "./types";
export { parseProofMessage, validateProof, verifyDeclaredConnectionSignature } from "./verify";

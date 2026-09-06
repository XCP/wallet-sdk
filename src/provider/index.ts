/**
 * XCP Wallet SDK — framework-agnostic wallet integration.
 *
 * React apps: use `useWallet()` from `../wallet-context` instead.
 * Non-React: use `detectProvider()` + `new XcpWallet(provider)` directly.
 */
export { detectProvider, getProvider } from './detect'
export { XcpWallet, SIGN_PSBTS_BUNDLE_LIMIT, type XcpWalletOptions } from './provider'
export { friendlyError } from './errors'
export { validateProof, parseProofMessage, verifyDeclaredConnectionSignature } from './verify'
export {
  parseProviderPsbtSigningCapabilities,
  assertProviderCanSignPsbt,
  assertProviderCanSignPsbts,
  ProviderSigningCapabilityError,
  type ProviderPsbtSigningCapabilities,
  type ProviderPsbtSigningMethodCapabilities,
  type ProviderSigningCapabilityErrorCode,
  type IntentDescriber,
} from './psbt-capabilities'
export { BTC_ADDRESS_REGEX, USER_REJECTED, UNAUTHORIZED, UNSUPPORTED_METHOD, DISCONNECTED } from './constants'
export type {
  XcpProvider,
  XcpWalletEvents,
  ConnectionProof,
  ConnectResult,
  WalletAddress,
  WalletAddresses,
  SignPsbtParams,
  SignPsbtRequest,
  SignPsbtsRequest,
} from './types'

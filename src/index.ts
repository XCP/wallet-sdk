/**
 * @xcp/wallet-sdk — core entry. Framework-free; no `window` reference.
 * Browser detection is `@xcp/wallet-sdk/web`; React bindings are
 * `@xcp/wallet-sdk/react`.
 */

export {
  configureWalletSdk,
  DEFAULT_COUNTERPARTY_API_BASE,
  getCounterpartyApiBase,
  getStorage,
  type KeyValueStorage,
  type WalletSdkConfig,
} from "@/config";
export { fetchJson } from "@/counterparty/client";
export { fetchMedianFeeRate, fetchPriorityFeeRate } from "@/counterparty/fees";
export {
  type BookOrder,
  cloneMarket,
  computePoolFill,
  computePoolInputForTargetPrice,
  computePoolOutput,
  type Fill,
  fillMarket,
  type MarketState,
  type MempoolQuote,
  OTHER_POOL_FEE_BPS,
  type PoolSide,
  quoteAfterMempool,
  XCP_POOL_FEE_BPS,
} from "@/counterparty/pool-quote";
export { counterpartyRelay, isRateLimited, RelayBudgetExhausted, relayingFetch } from "@/counterparty/relay";
export {
  canVerifyBip322,
  legacyMessageHash,
  type MessageSignatureVerdict,
  pubkeyFromBip322,
  verifyBip322,
  verifyLegacyRecoverableMessage,
} from "@/crypto/bip322";
export { fromWalletError, isWalletSdkError, WalletSdkError, type WalletSdkErrorCode } from "@/errors";
export * from "@/numeric";
export {
  ANY_ADDRESS,
  type CanSignPolicy,
  CHECKING_ADDRESS_ACCESS,
  connectionProofForIdentity,
  type WalletAddressAccess,
  walletAddressAccess,
} from "@/provider/address-access";
export {
  assertProviderCanSignPsbt,
  assertProviderCanSignPsbts,
  type IntentDescriber,
  type ProviderPsbtSigningCapabilities,
  type ProviderPsbtSigningMethodCapabilities,
  ProviderSigningCapabilityError,
  type ProviderSigningCapabilityErrorCode,
  parseProviderPsbtSigningCapabilities,
} from "@/provider/capabilities";
export {
  BTC_ADDRESS_REGEX,
  DISCONNECTED,
  UNAUTHORIZED,
  UNSUPPORTED_METHOD,
  USER_REJECTED,
} from "@/provider/constants";
export { friendlyError } from "@/provider/friendly-error";
export type { XcpMethod, XcpMethods, XcpParams, XcpRequest, XcpResult } from "@/provider/methods";
export { parseProofMessage, validateProof, verifyDeclaredConnectionSignature } from "@/provider/proof";
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
} from "@/provider/types";
export {
  SIGN_PSBTS_BUNDLE_LIMIT,
  type WalletFeatures,
  XcpWallet,
  type XcpWalletOptions,
} from "@/provider/wallet";
export { type CounterpartyApi, type CounterpartyReadOptions, createWalletSdk, type WalletSdk } from "@/sdk";
export {
  type ProofStatus,
  WALLET_CONNECTED_STORAGE_KEY,
  type WalletReadyState,
  WalletSession,
  type WalletSessionEvents,
  type WalletSessionOptions,
  type WalletSessionState,
} from "@/session";

export {
  msSinceLastSpend,
  type OwnTxOutput,
  pendingChangeInputs,
  recentlySpentUtxos,
  registerBroadcast,
} from "@/transaction/journal";
export { addressTransactionLockName, withAddressTransactionLock } from "@/transaction/lock";
export {
  addressScriptPubKey,
  ownTransactionOutputs,
  parseTxInputs,
  parseTxOutputs,
  type TxInput,
  type TxOutput,
} from "@/transaction/raw-tx";

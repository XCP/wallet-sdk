import type { ProviderPsbtSigningCapabilities } from './psbt-capabilities'

/** Raw provider shape injected by the XCP wallet extension on `window.xcpwallet` */
export interface XcpProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on: (event: string, handler: (...args: any[]) => void) => void
  removeListener: (event: string, handler: (...args: any[]) => void) => void
}

/** Typed event map for XcpWallet.on / .off */
export interface XcpWalletEvents {
  accountsChanged: [accounts: string[]]
  disconnect: []
}

/**
 * Proof of address ownership returned during connect.
 *
 * `verification` names the signature dialect. Older extension builds omit
 * it, and those proofs are BIP-322 by default. `BIP-137` with the
 * `legacy_recoverable` format is what hardware wallets such as Trezor
 * produce; it is verified only when declared, never as a fallback.
 */
export interface ConnectionProof {
  address: string
  message: string
  signature: string
  verification?:
    | { method: 'BIP-322'; format: string } // e.g. 'p2tr', 'p2wpkh', 'p2pkh'
    | { method: 'BIP-137'; format: 'legacy_recoverable' }
}

/** Response from xcp_requestAccounts */
export interface ConnectResult {
  accounts: string[]
  proof: ConnectionProof | null
  /** Proofs for every address covered by an explicitly granted pair.
   *  Older extension builds omit this field and retain the active proof. */
  proofs?: ConnectionProof[]
}

/**
 * What one PSBT signing call carries. `hex`, `signInputs` and `sighashTypes`
 * are what the wallet validates; `inscription` is the launchpad's commit
 * proof; `intent` is an open slot for a host's own claim — the marketplace
 * attaches a typed description of the trade for the wallet's approval
 * screen, and the SDK passes it through untouched.
 */
export interface SignPsbtParams<Intent = unknown> {
  hex: string
  signInputs?: Record<string, number[]>
  sighashTypes?: number[]
  /**
   * For an inscription commit: the reveal's tapleaf script and the taproot internal key, hex.
   * The XCP Wallet re-derives the commit address and message from these and refuses to sign on
   * any mismatch -- without them a commit is unprovable BTC movement and is blocked outright.
   */
  inscription?: { revealScript: string; tapInternalKey: string }
  intent?: Intent
}

/** A complete xcp_signPsbt request, as a host may build it up front. */
export interface SignPsbtRequest<Intent = unknown> {
  method: 'xcp_signPsbt'
  params: readonly [SignPsbtParams<Intent>]
}

/** A linked bundle: one approval, several PSBTs. */
export interface SignPsbtsRequest<Intent = unknown> {
  method: 'xcp_signPsbts'
  params: readonly [{ requests: readonly SignPsbtParams<Intent>[] }]
}

/** One address the wallet controls, with the key that proves it. */
export interface WalletAddress {
  address: string
  /** Compressed public key, hex. */
  publicKey: string
  /** e.g. 'p2pkh', 'p2wpkh', 'p2tr'. */
  type: string
}

/**
 * Response from xcp_getAddresses. `legacy` and `segwit` are present only when
 * the site has paired-address permission; `active` always is.
 */
export interface WalletAddresses {
  active: WalletAddress
  legacy?: WalletAddress
  segwit?: WalletAddress
  /** Optional method-level signing contract. Absent on older wallet versions. */
  signing?: ProviderPsbtSigningCapabilities
}

declare global {
  interface Window {
    xcpwallet?: XcpProvider
  }
}

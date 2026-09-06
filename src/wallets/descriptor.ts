import type { ConnectionProof, XcpProvider } from "@/provider/types";

/** The wallets this SDK has an adapter for. Anything else in the page is ignored. */
export type WalletId = "xcp" | "horizon";

/** How one supported wallet is found, described and wrapped. */
export interface WalletDescriptor {
  id: WalletId;
  name: string;
  /** An image source an `<img>` can show, or null when the wallet supplies none. */
  icon: string | null;
  installUrl: string;
  /** The wallet's id under `window.btc_providers`, when it registers there. */
  registryId?: string;
  /** The dialect this wallet's `signMessage` produces. Absent means BIP-322. */
  messageVerification?: ConnectionProof["verification"];
  /** Whether the wallet is injected right now. */
  installed(): boolean;
  /** The wallet as an `XcpProvider`. Throws `wallet_missing` when not installed. */
  provider(): XcpProvider;
  /** Calls `listener` once the wallet injects after page load. */
  onInjected(listener: () => void): () => void;
  /** Ask an already-injected wallet to announce itself again. */
  nudge?(): void;
}

/** What a chooser renders: one row per supported wallet. */
export interface WalletCandidate {
  id: WalletId;
  name: string;
  icon: string | null;
  installUrl: string;
  installed: boolean;
}

import { getStorage } from "@/config";
import { canVerifyBip322 } from "@/crypto/bip322";
import { isWalletSdkError, WalletSdkError } from "@/errors";
import {
  ANY_ADDRESS,
  type CanSignPolicy,
  CHECKING_ADDRESS_ACCESS,
  connectionProofForIdentity,
  type WalletAddressAccess,
  walletAddressAccess,
} from "@/provider/address-access";
import type { IntentDescriber } from "@/provider/capabilities";
import { friendlyError } from "@/provider/friendly-error";
import { validateProof, verifyDeclaredConnectionSignature } from "@/provider/proof";
import type {
  ConnectionProof,
  ConnectResult,
  SignPsbtParams,
  SignPsbtRequest,
  SignPsbtsRequest,
  XcpProvider,
} from "@/provider/types";
import { XcpWallet } from "@/provider/wallet";
import type { ComposeSigner } from "@/transaction/compose";

/**
 * Wallet session state machine: detect, restore, adopt, reconcile, reverify.
 * Framework-free; hosts subscribe to `getState()`.
 */

/** `detecting` and `not_installed` are distinct: a page shows a stored identity for one and a connect button for the other. */
export type WalletReadyState = "detecting" | "not_installed" | "disconnected" | "connected";

/** `unverified` is the resting state (no proof to check); `failed` means a proof was supplied and did not verify. */
export type ProofStatus = "unverified" | "verified" | "failed";

export interface WalletSessionState {
  readyState: WalletReadyState;
  /** The address this site signs and acts as — the identity. */
  address: string | null;
  /** The wallet's active account. Equals `address` unless a Legacy account
   *  was promoted to sign as its paired SegWit sibling. */
  activeAddress: string | null;
  connectionProof: ConnectionProof | null;
  proofStatus: ProofStatus;
  /** The identity's public key, when the wallet can supply one. */
  publicKey: string | null;
  connecting: boolean;
  /** A message fit for a person, from the last failed connect. */
  connectError: string | null;
  /** The last failure, with its code, for a host that branches. */
  lastError: WalletSdkError | null;
  /** What the wallet actually granted after the paired-capability request. */
  addressAccess: WalletAddressAccess;
  /** The paired LEGACY address when it is not the identity: it can hold
   *  assets and sign its own inputs, but never signs anything this site
   *  verifies — an asset source, never the signer. */
  legacySource: string | null;
  /** True when a provider was supplied instead of being detected. */
  customProvider: boolean;
}

export interface WalletSessionEvents {
  /** Connect was pressed and no wallet was there to answer. */
  onMissing?: () => void;
  onConnected?: (address: string) => void;
  /** The person declined in the wallet's own prompt. */
  onRejected?: () => void;
}

export interface WalletSessionOptions {
  /** A provider to use outright — a regtest runner, a native bridge. */
  provider?: XcpProvider;
  /** How to find the injected provider when none is supplied. The web entry's
   *  `detectProvider`; absent, the session reports `not_installed`. */
  detect?: () => Promise<XcpProvider>;
  /** Called after a failed detection with a callback to run if the provider
   *  appears later. The web entry listens for the extension's announce event. */
  onLateProvider?: (init: (provider: XcpProvider) => void) => () => void;
  /** The origin proofs are issued for. Required to verify any proof. */
  origin?: string;
  /** Learn that another tab wrote or cleared the stored session. */
  subscribeStorage?: (key: string, onChange: (value: string | null) => void) => () => void;
  /** Whether the page is being looked at; the reconcile loop waits otherwise. */
  isVisible?: () => boolean;
  /** Ask for the paired Legacy/SegWit sibling at connect. */
  pairedAddresses?: boolean;
  /** Which addresses this site can verify signatures from. Decides the identity
   *  under a paired grant (see address-access.ts). Default: every address. */
  canSign?: CanSignPolicy;
  /** How a PSBT request's intent is named in a capability error. */
  describeIntent?: IntentDescriber;
  events?: WalletSessionEvents;
  /** Passive reconcile cadence. Default 15s — 4 req/min against a 100/min origin limit. */
  reconcileMs?: number;
  /** The dialect this provider's `signMessage` produces. XCP Wallet: BIP-322 (omit). Horizon: BIP-137. */
  messageVerification?: ConnectionProof["verification"];
}

/**
 * Stored address for optimistic restore. A cold MV3 worker answers `xcp_accounts`
 * with [] even for an approved origin, so [] never means revoked.
 */
export const WALLET_CONNECTED_STORAGE_KEY = "xcp-wallet-connected";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function storageGet(key: string): string | null {
  try {
    return getStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    getStorage()?.setItem(key, value);
  } catch {}
}
function storageRemove(key: string) {
  try {
    getStorage()?.removeItem(key);
  } catch {}
}

const INITIAL: WalletSessionState = {
  readyState: "detecting",
  address: null,
  activeAddress: null,
  connectionProof: null,
  proofStatus: "unverified",
  publicKey: null,
  connecting: false,
  connectError: null,
  lastError: null,
  addressAccess: CHECKING_ADDRESS_ACCESS,
  legacySource: null,
  customProvider: false,
};

export class WalletSession {
  private state: WalletSessionState;
  private readonly listeners = new Set<() => void>();
  private readonly options: WalletSessionOptions;
  private wallet: XcpWallet | null = null;
  private started = false;
  private stopped = false;
  private connecting = false;
  private disconnecting = false;
  private keyedPublicKey: { address: string; publicKey: string } | null = null;
  /** Prevents a reconcile tick from re-asking for a proof already answered. */
  private verifiedAddress: string | null = null;
  private cleanups: (() => void)[] = [];

  constructor(options: WalletSessionOptions = {}) {
    this.options = options;
    this.state = { ...INITIAL, customProvider: options.provider !== undefined };
  }

  // ---- observable ----

  getState(): WalletSessionState {
    return this.state;
  }

  get address(): string | null {
    return this.state.address;
  }

  get publicKey(): string | null {
    return this.state.publicKey;
  }

  get connectionProof(): ConnectionProof | null {
    return this.state.connectionProof;
  }

  get messageVerification(): ConnectionProof["verification"] {
    return this.options.messageVerification;
  }

  /** The session as the compose pipeline sees it. */
  asSigner(): ComposeSigner {
    return this;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<WalletSessionState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ---- lifecycle ----

  /** Idempotent. Returns the stop function. */
  start(): () => void {
    if (this.started) return () => this.stop();
    this.started = true;
    this.stopped = false;

    const key = WALLET_CONNECTED_STORAGE_KEY;
    // The storage event is the only cross-tab connect signal; the provider emits nothing on connect.
    if (this.options.subscribeStorage) {
      this.cleanups.push(
        this.options.subscribeStorage(key, (value) => {
          if (this.stopped) return;
          if (value && value !== "1") this.adopt(value, null);
          else if (value === null) this.clearSession("disconnected");
        }),
      );
    }

    const ms = this.options.reconcileMs ?? 15_000;
    const timer = setInterval(() => void this.reconcile(), ms);
    this.cleanups.push(() => clearInterval(timer));

    if (this.options.provider) {
      this.initWallet(this.options.provider);
    } else if (this.options.detect) {
      this.options
        .detect()
        .then((provider) => {
          if (!this.stopped) this.initWallet(provider);
        })
        .catch(() => {
          if (this.stopped) return;
          this.set({ readyState: "not_installed" });
          if (this.options.onLateProvider) {
            this.cleanups.push(
              this.options.onLateProvider((provider) => {
                if (!this.stopped) this.initWallet(provider);
              }),
            );
          }
        });
    } else {
      this.set({ readyState: "not_installed" });
    }

    return () => this.stop();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.wallet?.off("accountsChanged", this.onAccountsChanged);
    this.wallet?.off("disconnect", this.onDisconnect);
  }

  private initWallet(provider: XcpProvider) {
    if (this.wallet) return;
    const wallet = new XcpWallet(provider, {
      pairedAddresses: this.options.pairedAddresses,
      describeIntent: this.options.describeIntent,
    });
    this.wallet = wallet;
    wallet.on("accountsChanged", this.onAccountsChanged);
    wallet.on("disconnect", this.onDisconnect);

    const stored = storageGet(WALLET_CONNECTED_STORAGE_KEY);
    if (stored && stored !== "1") {
      this.set({ readyState: "connected", activeAddress: stored, address: stored });
      void this.refreshAddressMetadata(stored);
      void this.reconcile();
    } else {
      this.set({ readyState: "disconnected" });
    }
  }

  private readonly onAccountsChanged = (accounts: string[]) => {
    if (this.stopped) return;
    // [] is a lock, not a revocation; revocation arrives as `disconnect`.
    if (accounts.length === 0) return;
    this.adopt(accounts[0]!, null);
    void this.reverify(accounts[0]!);
  };

  private readonly onDisconnect = () => {
    if (this.stopped) return;
    this.clearSession("disconnected");
  };

  // ---- state transitions ----

  private clearSession(readyState: WalletReadyState, connectError: string | null = null) {
    this.keyedPublicKey = null;
    this.verifiedAddress = null;
    storageRemove(WALLET_CONNECTED_STORAGE_KEY);
    this.set({
      readyState,
      address: null,
      activeAddress: null,
      connectionProof: null,
      proofStatus: "unverified",
      publicKey: null,
      addressAccess: CHECKING_ADDRESS_ACCESS,
      legacySource: null,
      connectError,
    });
  }

  /** Only an actual account change resets identity; passive `xcp_accounts` replies repeat the active account. */
  private adopt(addr: string, proof: ConnectionProof | null, status: ProofStatus = "unverified") {
    const activeChanged = this.state.activeAddress !== addr;
    const patch: Partial<WalletSessionState> = { readyState: "connected", connectError: null };
    if (proof) {
      patch.connectionProof = proof;
      patch.proofStatus = status;
    } else if (activeChanged) {
      patch.connectionProof = null;
      patch.proofStatus = "unverified";
    }
    if (activeChanged) {
      patch.activeAddress = addr;
      patch.address = addr;
      this.keyedPublicKey = null;
      patch.publicKey = null;
      patch.addressAccess = CHECKING_ADDRESS_ACCESS;
      patch.legacySource = null;
    }
    storageSet(WALLET_CONNECTED_STORAGE_KEY, addr);
    this.set(patch);
    if (activeChanged) void this.refreshAddressMetadata(addr);
  }

  /** Identity and key come from one `xcp_getAddresses` answer; the key composes past an OP_RETURN from a never-spent address. */
  private async refreshAddressMetadata(
    active: string,
    known?: Awaited<ReturnType<XcpWallet["getAddresses"]>>,
  ) {
    const addresses = known === undefined ? ((await this.wallet?.getAddresses()) ?? null) : known;
    if (this.stopped || this.state.activeAddress !== active) return;
    const access = walletAddressAccess(active, addresses, this.options.canSign ?? ANY_ADDRESS);
    const identity = access.identity ?? active;
    const match = [addresses?.active, addresses?.legacy, addresses?.segwit].find(
      (c) => c?.address === identity,
    );
    this.keyedPublicKey = match ? { address: identity, publicKey: match.publicKey } : null;
    this.set({
      address: identity,
      publicKey: this.keyedPublicKey?.publicKey ?? null,
      addressAccess: access,
      legacySource: access.legacySource,
    });
  }

  /** An unverifiable address type reports `unverified`, never `failed`. */
  private async checkProof(proof: ConnectionProof, addr: string): Promise<ProofStatus> {
    if (!this.options.origin) return "unverified";
    if (proof.verification?.method !== "BIP-137" && !canVerifyBip322(addr)) return "unverified";
    const check = await validateProof(proof, this.options.origin, addr, {
      verifySignature: async (message, signature, address) => {
        try {
          return verifyDeclaredConnectionSignature(proof, message, signature, address);
        } catch {
          return false;
        }
      },
    });
    if (!check.valid) console.warn("[wallet] connection proof did not verify:", check.reason);
    return check.valid ? "verified" : "failed";
  }

  /**
   * `xcp_accounts` first: a non-empty answer proves the grant and makes the following
   * `xcp_requestAccounts` silent. An empty answer stays unverified rather than risk a prompt.
   */
  private async reverify(addr: string) {
    const wallet = this.wallet;
    if (!wallet || this.verifiedAddress === addr) return;
    this.verifiedAddress = addr;
    try {
      const accounts = await wallet.getAccounts();
      if (!accounts.includes(addr)) {
        this.verifiedAddress = null;
        return;
      }
      const result = await wallet.connect();
      if (this.stopped || this.state.activeAddress !== addr) return;
      const identity = this.state.address ?? addr;
      const proof = connectionProofForIdentity(result, identity);
      if (!proof) return;
      const status = await this.checkProof(proof, identity);
      if (this.state.activeAddress !== addr) return;
      this.set({ connectionProof: proof, proofStatus: status });
    } catch {
      this.verifiedAddress = null;
    }
  }

  /** An empty answer never demotes the optimistic state. */
  private async reconcile() {
    const wallet = this.wallet;
    if (!wallet || this.stopped || this.disconnecting) return;
    if (!storageGet(WALLET_CONNECTED_STORAGE_KEY)) return;
    if (this.options.isVisible && !this.options.isVisible()) return;
    try {
      const accounts = await wallet.getAccounts();
      if (this.stopped || this.disconnecting) return;
      if (accounts.length > 0) {
        this.adopt(accounts[0]!, null);
        void this.reverify(accounts[0]!);
      }
    } catch {}
  }

  // ---- actions ----

  async connect(): Promise<void> {
    if (this.connecting) return;
    const wallet = this.wallet;
    if (!wallet) {
      const error = new WalletSdkError(
        "wallet_missing",
        "No XCP wallet extension detected — please install one",
      );
      this.set({ connectError: friendlyError(error), lastError: error });
      this.options.events?.onMissing?.();
      return;
    }
    this.connecting = true;
    this.disconnecting = false;
    this.set({ connecting: true, connectError: null, lastError: null });
    try {
      // One passive backstop for an approval that landed after both attempts died.
      let result: ConnectResult;
      try {
        result = await wallet.connect();
      } catch (e) {
        if (isWalletSdkError(e, "user_rejected")) throw e; // genuine denial — surface it
        await sleep(1500);
        const accounts = await wallet.getAccounts().catch(() => []);
        if (accounts.length === 0) throw e;
        result = { accounts, proof: null };
      }

      if (this.disconnecting) return;
      if (result.accounts.length === 0) {
        const error = new WalletSdkError(
          "invalid_response",
          "The wallet returned no account — open the extension and try again",
        );
        this.set({ connectError: error.message, lastError: error });
        return;
      }
      const addr = result.accounts[0]!;
      const addresses = await wallet.getAddresses();
      const access = walletAddressAccess(addr, addresses, this.options.canSign ?? ANY_ADDRESS);
      const identity = access.identity ?? addr;
      // Verification informs the badge; it does not gate connecting.
      const identityProof = connectionProofForIdentity(result, identity);
      const status = identityProof ? await this.checkProof(identityProof, identity) : "unverified";
      this.verifiedAddress = addr;
      this.adopt(addr, identityProof, status);
      // A re-approval can leave the active account unchanged, so adopt() did not refresh.
      await this.refreshAddressMetadata(addr, addresses);
      this.options.events?.onConnected?.(identity);
    } catch (e) {
      const error =
        e instanceof WalletSdkError ? e : new WalletSdkError("network", friendlyError(e), { cause: e });
      if (!this.disconnecting) {
        this.clearSession("disconnected", friendlyError(e));
        this.set({ lastError: error });
      }
      if (isWalletSdkError(e, "user_rejected")) this.options.events?.onRejected?.();
    } finally {
      this.connecting = false;
      this.set({ connecting: false });
    }
  }

  async disconnect(): Promise<void> {
    this.disconnecting = true;
    if (this.wallet) {
      try {
        await this.wallet.disconnect();
      } catch (e) {
        console.warn("[wallet] disconnect failed:", e);
      }
    }
    this.clearSession("disconnected");
  }

  /** A 4100 from a signing call is the revocation passive polling cannot see. */
  private async withAuthCheck<T>(run: (wallet: XcpWallet) => Promise<T>): Promise<T> {
    const wallet = this.wallet;
    if (!wallet) throw new WalletSdkError("wallet_missing", "Wallet not available");
    try {
      return await run(wallet);
    } catch (e) {
      if (isWalletSdkError(e, "unauthorized")) {
        this.clearSession(
          "disconnected",
          "Wallet is no longer connected to this site — reconnect to continue",
        );
        this.set({ lastError: e });
      }
      throw e;
    }
  }

  signMessage(message: string): Promise<string> {
    const { address: identity, activeAddress: active } = this.state;
    // A promoted identity signs as the granted sibling.
    const signer = identity && active && identity !== active ? identity : undefined;
    return this.withAuthCheck((wallet) => wallet.signMessage(message, signer));
  }

  signTransaction(hex: string): Promise<string> {
    return this.withAuthCheck((wallet) => wallet.signTransaction(hex));
  }

  signPsbt(request: SignPsbtRequest<unknown>): Promise<string>;
  signPsbt(
    hex: string,
    signInputs?: Record<string, number[]>,
    sighashTypes?: number[],
    inscription?: SignPsbtParams["inscription"],
  ): Promise<string>;
  signPsbt(
    requestOrHex: SignPsbtRequest<unknown> | string,
    signInputs?: Record<string, number[]>,
    sighashTypes?: number[],
    inscription?: SignPsbtParams["inscription"],
  ): Promise<string> {
    return this.withAuthCheck((wallet) =>
      typeof requestOrHex === "string"
        ? wallet.signPsbt(requestOrHex, signInputs, sighashTypes, inscription)
        : wallet.signPsbt(requestOrHex),
    );
  }

  signPsbts(request: SignPsbtsRequest<unknown>): Promise<string[]> {
    return this.withAuthCheck((wallet) => wallet.signPsbts(request));
  }

  broadcastTransaction(hex: string): Promise<string> {
    const wallet = this.wallet;
    if (!wallet) throw new WalletSdkError("wallet_missing", "Wallet not available");
    return wallet.broadcastTransaction(hex);
  }

  getWallet(): XcpWallet | null {
    return this.wallet;
  }
}

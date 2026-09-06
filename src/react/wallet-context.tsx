"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  ANY_ADDRESS,
  type CanSignPolicy,
  CHECKING_ADDRESS_ACCESS,
  connectionProofForIdentity,
  type WalletAddressAccess,
  walletAddressAccess,
} from "../address-access";
import { canVerifyBip322 } from "../bip322";
import { getStorage } from "../config";
import { isWalletSdkError } from "../errors";
import {
  type ConnectionProof,
  type ConnectResult,
  friendlyError,
  type IntentDescriber,
  type SignPsbtParams,
  type SignPsbtRequest,
  type SignPsbtsRequest,
  validateProof,
  verifyDeclaredConnectionSignature,
  type XcpProvider,
  XcpWallet,
} from "../provider";
import { detectProvider } from "../web";

/**
 * How much we actually know about the connected address's key:
 *  - 'verified' — this session saw a fresh proof and its signature checked out.
 *  - 'unverified' — nothing to check. A restored session, an accountsChanged
 *    switch, or an address type we can't verify; xcp_accounts carries no proof,
 *    so this is the normal resting state, not a warning.
 *  - 'failed' — a proof WAS supplied and did not verify. The only genuinely
 *    suspicious state, and the one that gates metadata editing.
 */
export type ProofStatus = "unverified" | "verified" | "failed";

/** Check a proof against the address that supplied it, in whichever dialect
 *  the proof declares. An address type we can't verify reports 'unverified',
 *  never 'failed' — a coverage gap and a bad signature are different claims
 *  and must not look the same. */
async function checkProof(proof: ConnectionProof, addr: string): Promise<ProofStatus> {
  if (proof.verification?.method !== "BIP-137" && !canVerifyBip322(addr)) return "unverified";
  const check = await validateProof(proof, window.location.origin, addr, {
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

export type XcpWalletStatus = "not_detected" | "disconnected" | "connected";

/** What a site may want to know about, without the SDK knowing how it counts. */
export interface WalletEvents {
  /** Connect was pressed and no wallet was there to answer. */
  onMissing?: () => void;
  onConnected?: (address: string) => void;
  /** The person declined in the wallet's own prompt (code 4001). */
  onRejected?: () => void;
}

export interface WalletProviderProps {
  children: ReactNode;
  /**
   * A provider to use instead of the injected `window.xcpwallet` — a regtest
   * runner in development, a native bridge on mobile. When given, detection
   * is skipped and `customProvider` reads true.
   */
  provider?: XcpProvider;
  /** Ask for the paired Legacy/SegWit sibling at connect. See XcpWalletOptions. */
  pairedAddresses?: boolean;
  /**
   * Which addresses this site can verify signatures from. Decides the
   * identity under a paired grant (see address-access.ts). The default
   * accepts every address, so the active account is always the identity.
   */
  canSign?: CanSignPolicy;
  /** How a PSBT request's intent is named in a capability error. */
  describeIntent?: IntentDescriber;
  events?: WalletEvents;
}

export interface WalletContextValue {
  status: XcpWalletStatus;
  /** The address this site signs and acts as — the identity. */
  address: string | null;
  connectionProof: ConnectionProof | null;
  /** The identity's public key, when the wallet can supply one. */
  publicKey: string | null;
  /** The wallet's active account. Equals `address` unless a Legacy account
   *  was promoted to sign as its paired SegWit sibling. */
  activeAddress: string | null;
  proofStatus: ProofStatus;
  connecting: boolean;
  connectError: string | null;
  /** True when a provider was supplied instead of the injected extension. */
  customProvider: boolean;
  /** The paired LEGACY address when it is not the identity: it can hold
   *  assets and sign its own inputs, but never signs anything this site
   *  verifies — an asset source, never the signer. */
  legacySource: string | null;
  /** What the wallet actually granted after the paired-capability request. */
  addressAccess: WalletAddressAccess;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Signs as the identity — which, under a promoted pair, is the sibling. */
  signMessage: (message: string) => Promise<string>;
  signTransaction: (hex: string) => Promise<string>;
  /** Positional (hex, inputs, sighash types) or a complete request with an intent attached. */
  signPsbt: {
    (request: SignPsbtRequest<any>): Promise<string>;
    (
      hex: string,
      signInputs?: Record<string, number[]>,
      sighashTypes?: number[],
      inscription?: SignPsbtParams["inscription"],
    ): Promise<string>;
  };
  signPsbts: (request: SignPsbtsRequest<any>) => Promise<string[]>;
  broadcastTransaction: (hex: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

/**
 * Stores the connected ADDRESS. The address lets a reload restore the
 * connection optimistically: the extension's MV3 service worker is
 * idle-killed and a cold worker answers xcp_accounts with [] even for an
 * approved origin with an unlocked wallet (its keychain only rehydrates when
 * the extension popup opens). An empty answer therefore means "unavailable
 * right now", never "revoked" — the two are indistinguishable from the page,
 * so we stay connected and let events, polling, or a failed signing attempt
 * resolve the ambiguity. Exported so chrome can render the restored identity
 * on first paint instead of flashing a connect prompt at a connected user.
 */
export const WALLET_CONNECTED_STORAGE_KEY = "xcp-wallet-connected";
const STORAGE_KEY = WALLET_CONNECTED_STORAGE_KEY;
/** Passive reconcile cadence — 4 req/min against a 100/min origin limit. */
const RECONCILE_MS = 15_000;
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

export function WalletProvider({
  children,
  provider: customProvider,
  pairedAddresses = false,
  canSign = ANY_ADDRESS,
  describeIntent,
  events,
}: WalletProviderProps) {
  const [status, setStatus] = useState<XcpWalletStatus>("not_detected");
  const [address, setAddress] = useState<string | null>(null);
  const [activeAddress, setActiveAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectionProof, setConnectionProof] = useState<ConnectionProof | null>(null);
  const [proofStatus, setProofStatus] = useState<ProofStatus>("unverified");
  const [keyedPublicKey, setKeyedPublicKey] = useState<{ address: string; publicKey: string } | null>(null);
  const [addressAccess, setAddressAccess] = useState<WalletAddressAccess>(CHECKING_ADDRESS_ACCESS);
  const connectingRef = useRef(false);
  const disconnectingRef = useRef(false);
  const walletRef = useRef<XcpWallet | null>(null);
  /** The identity, mirrored for event handlers (updaters stay pure). */
  const addressRef = useRef<string | null>(null);
  /** The wallet's active account, mirrored likewise. */
  const activeRef = useRef<string | null>(null);
  /** Addresses already put through reverify, so a 15s reconcile tick doesn't
   *  re-ask the wallet for a proof it has already answered. */
  const verifiedAddressRef = useRef<string | null>(null);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const canSignRef = useRef(canSign);
  canSignRef.current = canSign;

  const clearSession = useCallback(() => {
    addressRef.current = null;
    activeRef.current = null;
    verifiedAddressRef.current = null;
    setAddress(null);
    setActiveAddress(null);
    setConnectionProof(null);
    setProofStatus("unverified");
    setKeyedPublicKey(null);
    setAddressAccess(CHECKING_ADDRESS_ACCESS);
    setStatus("disconnected");
    storageRemove(STORAGE_KEY);
  }, []);

  /**
   * Resolve the identity and its key for the active account.
   *
   * Counterparty needs the public key to compose anything past an OP_RETURN
   * for a never-spent address; and under a paired grant the identity may be
   * the active account's sibling rather than the account itself. Both come
   * from the same passive xcp_getAddresses answer, so they are resolved
   * together. Null key on older builds; callers keep a fallback.
   */
  const refreshAddressMetadata = useCallback(
    async (active: string, knownAddresses?: Awaited<ReturnType<XcpWallet["getAddresses"]>>) => {
      const addresses =
        knownAddresses === undefined ? ((await walletRef.current?.getAddresses()) ?? null) : knownAddresses;
      if (activeRef.current !== active) return;
      const access = walletAddressAccess(active, addresses, canSignRef.current);
      const identity = access.identity ?? active;
      if (addressRef.current !== identity) {
        addressRef.current = identity;
        setAddress(identity);
      }
      const match = [addresses?.active, addresses?.legacy, addresses?.segwit].find(
        (candidate) => candidate?.address === identity,
      );
      setKeyedPublicKey(match ? { address: identity, publicKey: match.publicKey } : null);
      setAddressAccess(access);
    },
    [],
  );

  /** Adopt an account as the connected one. Proof follows the address: a
   *  fresh proof replaces, a switch without one invalidates. Only an actual
   *  account change starts a new identity resolution — passive xcp_accounts
   *  replies repeat the active account, not the granted identity, and
   *  re-adopting the same account must not discard the session. */
  const adopt = useCallback(
    (addr: string, proof: ConnectionProof | null, status: ProofStatus = "unverified") => {
      const activeChanged = activeRef.current !== addr;
      if (proof) {
        setConnectionProof(proof);
        setProofStatus(status);
      } else if (activeChanged) {
        setConnectionProof(null);
        setProofStatus("unverified");
      }
      if (activeChanged) {
        activeRef.current = addr;
        setActiveAddress(addr);
        addressRef.current = addr;
        setAddress(addr);
      }
      setStatus("connected");
      setConnectError(null);
      storageSet(STORAGE_KEY, addr);
    },
    [],
  );

  /**
   * Fetch and check a proof for an account we adopted without one — a
   * reload's optimistic restore, or an accountsChanged switch (neither event
   * carries a proof). Without this the badge would be honest but useless: it
   * could only ever be green in the seconds after an explicit Connect click.
   *
   * xcp_accounts is asked first because it is non-interactive, and a
   * non-empty answer proves the origin is still approved — which is what
   * makes the xcp_requestAccounts that follows silent, since the extension
   * returns the stored grant plus a fresh proof without prompting. An empty
   * answer is ambiguous (cold service worker, locked wallet, or genuinely
   * revoked), so we stay unverified rather than risk springing an approval
   * popup nobody asked for; the reconcile loop retries once the worker is
   * warm.
   */
  const reverify = useCallback(async (addr: string) => {
    const wallet = walletRef.current;
    if (!wallet || verifiedAddressRef.current === addr) return;
    verifiedAddressRef.current = addr;
    try {
      const accounts = await wallet.getAccounts();
      if (!accounts.includes(addr)) {
        verifiedAddressRef.current = null;
        return;
      }
      const result = await wallet.connect();
      // The active account can move while this is in flight; a proof for an
      // account we've since left says nothing about the one we're on.
      if (activeRef.current !== addr) return;
      const identity = addressRef.current ?? addr;
      const proof = connectionProofForIdentity(result, identity);
      if (!proof) return;
      const status = await checkProof(proof, identity);
      if (activeRef.current !== addr) return;
      setConnectionProof(proof);
      setProofStatus(status);
    } catch {
      // Locked, revoked, rate-limited, or the worker died — leave the address
      // adopted and unverified, and allow a later attempt.
      verifiedAddressRef.current = null;
    }
  }, []);

  // The identity and its key follow the active account.
  useEffect(() => {
    setKeyedPublicKey(null);
    setAddressAccess(CHECKING_ADDRESS_ACCESS);
    if (!activeAddress) return;
    void refreshAddressMetadata(activeAddress);
  }, [activeAddress, refreshAddressMetadata]);

  // Stored WITH its address and compared on read, rather than cleared when
  // the address changes: a key belonging to an account we have since left is
  // worse than no key at all, and deriving it means there is no window in
  // which the pair can disagree.
  const publicKey = keyedPublicKey?.address === address ? keyedPublicKey.publicKey : null;

  // Detect wallet, subscribe to events, optimistically restore, reconcile
  useEffect(() => {
    let cancelled = false;

    const onAccountsChanged = (accounts: string[]) => {
      if (cancelled) return;
      if (accounts.length === 0) {
        // Lock, not revocation: the extension emits [] on lock and re-emits
        // the address on unlock; the connection is retained (PROVIDER.md).
        // Revocation arrives as 'disconnect'. Stay connected — a signing
        // attempt on a locked wallet opens its unlock prompt anyway.
        return;
      }
      adopt(accounts[0], null);
      void reverify(accounts[0]);
    };

    const onDisconnect = () => {
      if (cancelled) return;
      clearSession();
    };

    // Cross-tab: connecting in one tab has no provider event (the
    // extension emits nothing on connect) — the storage write is the
    // only signal the other tabs get.
    const onStorage = (e: StorageEvent) => {
      if (cancelled || e.key !== STORAGE_KEY) return;
      if (e.newValue && e.newValue !== "1") adopt(e.newValue, null);
      else if (e.newValue === null) onDisconnect();
    };
    window.addEventListener("storage", onStorage);

    // Ask the warm(ed) worker who we are; adopt any answer. An empty
    // answer proves nothing (cold worker / locked wallet) and never
    // demotes the optimistic state.
    const reconcile = async () => {
      const wallet = walletRef.current;
      if (!wallet || cancelled || disconnectingRef.current) return;
      if (!storageGet(STORAGE_KEY)) return;
      if (document.visibilityState === "hidden") return;
      try {
        const accounts = await wallet.getAccounts();
        if (cancelled || disconnectingRef.current) return;
        if (accounts.length > 0) {
          adopt(accounts[0], null);
          void reverify(accounts[0]);
        }
      } catch {
        // transient — next tick retries
      }
    };
    const reconcileTimer = setInterval(reconcile, RECONCILE_MS);

    const initWallet = (provider: XcpProvider) => {
      if (cancelled || walletRef.current) return;
      const wallet = new XcpWallet(provider, { pairedAddresses, describeIntent });
      walletRef.current = wallet;

      wallet.on("accountsChanged", onAccountsChanged);
      wallet.on("disconnect", onDisconnect);

      // Optimistic restore: show the stored address immediately, then
      // reconcile. Waiting for xcp_accounts here is what caused
      // "refresh and I'm logged out" — a cold worker answers [] even
      // for a connected origin.
      const stored = storageGet(STORAGE_KEY);
      if (stored && stored !== "1") {
        activeRef.current = stored;
        setActiveAddress(stored);
        addressRef.current = stored;
        setAddress(stored);
        setStatus("connected");
      } else {
        setStatus("disconnected");
      }
      if (stored) void reconcile();
    };

    // If detection fails, keep listening for late injection
    let lateHandler: (() => void) | null = null;

    if (customProvider) {
      initWallet(customProvider);
    } else {
      detectProvider()
        .then(initWallet)
        .catch(() => {
          // Wallet not detected on initial check — keep listening for late injection.
          // Extension content scripts can take several seconds on cold browser starts.
          if (cancelled) return;
          // Detection failed: we are definitively not connected, and chrome
          // rendering a stored identity must stop waiting.
          setStatus("disconnected");
          lateHandler = () => {
            if (window.xcpwallet && !cancelled) {
              window.removeEventListener("xcp-wallet#initialized", lateHandler!);
              lateHandler = null;
              initWallet(window.xcpwallet);
            }
          };
          window.addEventListener("xcp-wallet#initialized", lateHandler);
        });
    }

    return () => {
      cancelled = true;
      clearInterval(reconcileTimer);
      window.removeEventListener("storage", onStorage);
      if (lateHandler) window.removeEventListener("xcp-wallet#initialized", lateHandler);
      walletRef.current?.off("accountsChanged", onAccountsChanged);
      walletRef.current?.off("disconnect", onDisconnect);
    };
  }, [adopt, reverify, clearSession, customProvider, pairedAddresses, describeIntent]);

  const connect = async () => {
    if (connectingRef.current) return;

    // Re-check for late-injected provider (extension may have loaded after initial detection).
    // Dispatch initialized event to trigger the useEffect's late listener which properly
    // sets up the wallet with event subscriptions (runs synchronously during dispatch).
    if (!customProvider && !walletRef.current && window.xcpwallet) {
      window.dispatchEvent(new Event("xcp-wallet#initialized"));
    }

    const wallet = walletRef.current;
    if (!wallet) {
      setConnectError("No XCP wallet extension detected — please install one");
      // The most important number on a site: someone who wanted to act and
      // could not, which no pageview report can show.
      eventsRef.current?.onMissing?.();
      return;
    }
    connectingRef.current = true;
    disconnectingRef.current = false;
    setConnecting(true);
    setConnectError(null);
    try {
      // Transport recovery is the provider's job: connect shares signing's
      // durableRequest retry, and the extension persists the approval so a
      // retry after the user clicked resolves with no second popup. This
      // layer only owns one backstop — if both attempts died but the approval
      // landed anyway, a single passive xcp_accounts check picks it up.
      let result: ConnectResult | null = null;
      try {
        result = await wallet.connect();
      } catch (e) {
        if (isWalletSdkError(e, "user_rejected")) throw e; // genuine denial — surface it
        await sleep(1500);
        const accounts = await wallet.getAccounts().catch(() => []);
        if (accounts.length === 0) throw e;
        result = { accounts, proof: null };
      }

      if (disconnectingRef.current) return;
      if (result && result.accounts.length > 0) {
        const addr = result.accounts[0];
        const addresses = await wallet.getAddresses();
        const access = walletAddressAccess(addr, addresses, canSignRef.current);
        const identity = access.identity ?? addr;
        // The proof is the only cryptographic tie between "the extension says
        // this address" and "this address's key signed for us, right now, for
        // this origin". Verifying it here does NOT gate connecting: this code
        // runs in the same page that received the proof, so it can't be the
        // security boundary (a server re-verifies against live on-chain
        // ownership where it matters). What it buys is an honest answer about
        // what we actually know — and an address type we can't check is a
        // coverage gap, not a red flag, so it must not be reported the same
        // way as a signature that didn't verify.
        const identityProof = connectionProofForIdentity(result, identity);
        const status = identityProof ? await checkProof(identityProof, identity) : "unverified";
        verifiedAddressRef.current = addr;
        adopt(addr, identityProof, status);
        // Reapproving paired access commonly leaves the active account
        // unchanged, so the account-keyed effect above will not rerun.
        await refreshAddressMetadata(addr, addresses);
        eventsRef.current?.onConnected?.(identity);
      } else {
        setConnectError("The wallet returned no account — open the extension and try again");
      }
    } catch (e) {
      if (!disconnectingRef.current) {
        // An explicit connect with no passively authorized account must not
        // leave an optimistic stored identity looking connected.
        clearSession();
        setConnectError(friendlyError(e));
      }
      // 4001 is the wallet's "user rejected" code. Distinguished from a
      // transport failure because they mean opposite things about intent.
      if (isWalletSdkError(e, "user_rejected")) eventsRef.current?.onRejected?.();
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    disconnectingRef.current = true;
    const wallet = walletRef.current;
    if (wallet) {
      try {
        await wallet.disconnect();
      } catch (e) {
        console.warn("[wallet] disconnect failed:", e);
      }
    }
    clearSession();
    setConnectError(null);
  };

  /**
   * The optimistic restore is what keeps a reload from reading as a logout —
   * a cold MV3 service worker answers xcp_accounts with [] even for a live
   * grant, so an empty answer can never be trusted to mean "revoked". The
   * cost is that a grant which really WAS revoked still looks connected here,
   * and the first thing the user learns is an opaque "not connected" error on
   * whatever they were trying to do.
   *
   * A 4100 from a signing call is the unambiguous answer that passive polling
   * can't give: the wallet itself says this origin isn't authorized. Treat it
   * as the disconnect we couldn't detect earlier, so the UI offers Connect
   * instead of failing the same way again.
   */
  const onUnauthorized = () => {
    clearSession();
    setConnectError("Wallet is no longer connected to this site — reconnect to continue");
  };

  const withAuthCheck = async <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      if (isWalletSdkError(e, "unauthorized")) onUnauthorized();
      throw e;
    }
  };

  const requireWallet = (): XcpWallet => {
    if (!walletRef.current) throw new Error("Wallet not available");
    return walletRef.current;
  };

  const signMessage = (message: string): Promise<string> => {
    const wallet = requireWallet();
    const identity = addressRef.current;
    const active = activeRef.current;
    // A promoted identity signs as the paired sibling granted by the wallet.
    // Paired access exists specifically so the active format does not need to
    // change while the site authenticates or signs a mixed-address workflow.
    const signer = identity && active && identity !== active ? identity : undefined;
    return withAuthCheck(() => wallet.signMessage(message, signer));
  };

  const signTransaction = (hex: string): Promise<string> => {
    const wallet = requireWallet();
    return withAuthCheck(() => wallet.signTransaction(hex));
  };

  const signPsbt = ((
    requestOrHex: SignPsbtRequest<any> | string,
    signInputs?: Record<string, number[]>,
    sighashTypes?: number[],
    inscription?: SignPsbtParams["inscription"],
  ): Promise<string> => {
    const wallet = requireWallet();
    return withAuthCheck(() =>
      typeof requestOrHex === "string"
        ? wallet.signPsbt(requestOrHex, signInputs, sighashTypes, inscription)
        : wallet.signPsbt(requestOrHex),
    );
  }) as WalletContextValue["signPsbt"];

  const signPsbts = (request: SignPsbtsRequest<any>): Promise<string[]> => {
    const wallet = requireWallet();
    return withAuthCheck(() => wallet.signPsbts(request));
  };

  const broadcastTransaction = (hex: string): Promise<string> => {
    return requireWallet().broadcastTransaction(hex);
  };

  return (
    <WalletContext
      value={{
        status,
        address,
        connectionProof,
        publicKey,
        activeAddress,
        proofStatus,
        connecting,
        connectError,
        customProvider: customProvider !== undefined,
        legacySource: addressAccess.legacySource,
        addressAccess,
        connect,
        disconnect,
        signMessage,
        signTransaction,
        signPsbt,
        signPsbts,
        broadcastTransaction,
      }}
    >
      {children}
    </WalletContext>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}

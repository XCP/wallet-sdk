import { fromWalletError, isWalletSdkError, WalletSdkError } from "../errors";
import { BTC_ADDRESS_REGEX, HEX_REGEX, TXID_REGEX } from "./constants";
import {
  assertProviderCanSignPsbt,
  assertProviderCanSignPsbts,
  type IntentDescriber,
  parseProviderPsbtSigningCapabilities,
} from "./psbt-capabilities";
import type {
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

/** Per-method timeouts: interactive methods get longer, passive methods are short. */
const Timeout = {
  fast: 10_000, // getAccounts, disconnect — should resolve near-instantly
  interactive: 120_000, // connect, sign*, broadcast — user-facing or network-critical
} as const;

/** The extension accepts 1..8 linked PSBT requests per xcp_signPsbts bundle;
 *  larger workloads chunk at the workflow layer. */
export const SIGN_PSBTS_BUNDLE_LIMIT = 8;

/** Extract a string field from a provider result, or throw. */
function unwrap(result: unknown, key: string, errorMsg: string): string {
  const value =
    result && typeof result === "object" && key in result
      ? (result as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string") throw new WalletSdkError("invalid_response", errorMsg);
  return value;
}

/** Wrap a provider.request call with a timeout so a hung wallet can't block forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WalletSdkError("timeout", "Wallet request timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Transport-death signatures from the extension's MV3 service worker restarting
// mid-request. User rejection and timeouts are deliberately excluded — those are
// terminal and must not be retried.
const TRANSIENT_DISCONNECT =
  /disconnect|context invalidated|message port closed|receiving end does not exist/i;
function isTransientDisconnect(error: unknown): boolean {
  if (isWalletSdkError(error, "disconnected")) return true;
  return TRANSIENT_DISCONNECT.test(error instanceof Error ? error.message : String(error ?? ""));
}

export interface XcpWalletOptions {
  /**
   * Ask the wallet for the paired Legacy/SegWit sibling alongside the active
   * account at connect time. The wallet shows the exact scope on its own
   * approval screen and only grants a pair it can derive, so asking is not
   * granting: a refusal, an imported single-key wallet, or an older build all
   * simply yield no paired addresses, and `getAddresses()` returns `active`
   * alone. Off by default; a site that trades across a pair turns it on.
   */
  pairedAddresses?: boolean;
  /** How a PSBT request's intent is named in a capability error. */
  describeIntent?: IntentDescriber;
}

/** Typed wrapper around a raw XcpProvider. */
export class XcpWallet {
  constructor(
    private readonly provider: XcpProvider,
    private readonly options: XcpWalletOptions = {},
  ) {}

  /** Every provider failure leaves here as a WalletSdkError, the wallet's own
   *  numeric code mapped and kept. */
  private request(args: { method: string; params?: unknown[] }, timeout: number): Promise<unknown> {
    return withTimeout(this.provider.request(args), timeout).catch((error: unknown) => {
      throw fromWalletError(error);
    });
  }

  // Retried once if the service worker drops mid-flight. The wallet persists the requests a user
  // decides on — sign flows by (origin, method, params), and connect approvals in the same way —
  // so the retry recovers a decision already made or rejoins an open prompt, never a second popup.
  //
  // Connect is included because the grant now outlives the worker: the wallet stores the approval,
  // completes it when the user clicks, and emits accountsChanged. A connect that died in flight has
  // usually already succeeded by the time we ask again.
  private async durableRequest(
    args: { method: string; params?: unknown[] },
    timeout: number,
  ): Promise<unknown> {
    try {
      return await this.request(args, timeout);
    } catch (error) {
      if (!isTransientDisconnect(error)) throw error;
      return this.request(args, timeout);
    }
  }

  async connect(): Promise<ConnectResult> {
    const params = this.options.pairedAddresses ? [{ capabilities: { pairedAddresses: true } }] : undefined;
    let result: unknown;
    try {
      result = await this.durableRequest(
        { method: "xcp_requestAccounts", ...(params ? { params } : {}) },
        Timeout.interactive,
      );
    } catch (error) {
      // On an ALREADY-CONNECTED origin a paired request may open the paired
      // grant on its own and rejects the whole call when it is declined —
      // which would turn a perfectly good connection into a connect error.
      // Declining paired access is not declining to connect. Ask the wallet
      // what it thinks (no prompt), and only surface the error if we really
      // are not connected.
      if (!this.options.pairedAddresses) throw error;
      const accounts = await this.getAccounts().catch(() => [] as string[]);
      if (accounts.length === 0) throw error;
      return { accounts, proof: null };
    }

    // Handle new { accounts, proof } response shape
    let accounts: string[];
    let proof: ConnectionProof | null = null;
    let proofs: ConnectionProof[] | undefined;

    if (result && typeof result === "object" && "accounts" in result) {
      const r = result as ConnectResult;
      accounts = r.accounts;
      proof = r.proof;
      proofs = Array.isArray(r.proofs) ? r.proofs : undefined;
    } else if (Array.isArray(result)) {
      // Backward compatibility with older extension versions
      accounts = result;
    } else {
      throw new WalletSdkError("invalid_response", "Wallet returned invalid accounts response");
    }

    for (const addr of accounts) {
      if (typeof addr !== "string" || !BTC_ADDRESS_REGEX.test(addr))
        throw new WalletSdkError("invalid_response", "Wallet returned invalid address");
    }
    return { accounts, proof, ...(proofs ? { proofs } : {}) };
  }

  async getAccounts(): Promise<string[]> {
    const result = await this.request({ method: "xcp_accounts" }, Timeout.fast);
    if (!Array.isArray(result))
      throw new WalletSdkError("invalid_response", "Wallet returned invalid accounts response");
    for (const addr of result) {
      if (typeof addr !== "string" || !BTC_ADDRESS_REGEX.test(addr))
        throw new WalletSdkError("invalid_response", "Wallet returned invalid address");
    }
    return result as string[];
  }

  async disconnect(): Promise<void> {
    await this.request({ method: "xcp_disconnect" }, Timeout.fast);
  }

  /**
   * The wallet's addresses WITH their public keys.
   *
   * Counterparty needs the source pubkey to compose anything whose message
   * exceeds an OP_RETURN — it falls back to bare multisig, which embeds that
   * key — and it can only find one itself after the address has spent. A
   * freshly funded wallet has never spent, so without this a first-ever
   * launch cannot compose at all.
   *
   * Passive and cheap: no prompt, no signature, just the keys the wallet
   * already holds. `active` is the identity and must be sound; `legacy` and
   * `segwit` arrive only with paired-address permission and are dropped
   * rather than trusted when malformed. Returns null on any failure (older
   * extension builds predate the method) so callers can fall back.
   */
  async getAddresses(): Promise<WalletAddresses | null> {
    try {
      const result = await this.request({ method: "xcp_getAddresses" }, Timeout.fast);
      if (!result || typeof result !== "object") return null;
      const entry = (value: unknown): WalletAddress | null => {
        if (!value || typeof value !== "object") return null;
        const { address, publicKey, type } = value as Record<string, unknown>;
        if (typeof address !== "string" || typeof publicKey !== "string") return null;
        if (!BTC_ADDRESS_REGEX.test(address) || !HEX_REGEX.test(publicKey)) return null;
        return { address, publicKey, type: typeof type === "string" ? type : "" };
      };
      const { active, legacy, segwit, signing } = result as Record<string, unknown>;
      const activeEntry = entry(active);
      if (!activeEntry) return null;
      const legacyEntry = entry(legacy);
      const segwitEntry = entry(segwit);
      const signingCapabilities = parseProviderPsbtSigningCapabilities(signing);
      return {
        active: activeEntry,
        ...(legacyEntry ? { legacy: legacyEntry } : {}),
        ...(segwitEntry ? { segwit: segwitEntry } : {}),
        ...(signingCapabilities ? { signing: signingCapabilities } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Sign with the active address, or — under the paired grant — with the
   *  active address's Legacy/SegWit sibling named by `address`. */
  async signMessage(message: string, address?: string): Promise<string> {
    const result = await this.durableRequest(
      {
        method: "xcp_signMessage",
        params: address ? [message, address] : [message],
      },
      Timeout.interactive,
    );
    // Handle both {signature: string} and raw string response shapes
    if (typeof result === "string") return result;
    return unwrap(result, "signature", "Wallet returned invalid sign message response");
  }

  async signTransaction(hex: string): Promise<string> {
    const result = await this.durableRequest(
      {
        method: "xcp_signTransaction",
        params: [hex],
      },
      Timeout.interactive,
    );
    const signed = unwrap(result, "hex", "Wallet returned invalid sign response");
    if (!HEX_REGEX.test(signed)) throw new WalletSdkError("invalid_response", "Wallet returned invalid hex");
    return signed;
  }

  /**
   * Sign one PSBT. Two call shapes, one behaviour:
   *
   *  - the positional form, `signPsbt(hex, signInputs?, sighashTypes?, inscription?)`,
   *    which the launchpad and the exchange use;
   *  - a complete request, `signPsbt({ method: 'xcp_signPsbt', params: [...] })`,
   *    built up front with an intent claim attached, which the marketplace
   *    uses so the wallet's approval screen renders the trade.
   *
   * Either way the wallet's reported capabilities, when it reports any, are
   * checked first so a request it is known to refuse fails with a reason
   * instead of an approval screen that cannot succeed.
   */
  async signPsbt(request: SignPsbtRequest<any>): Promise<string>;
  async signPsbt(
    psbtHex: string,
    signInputs?: Record<string, number[]>,
    sighashTypes?: number[],
    inscription?: SignPsbtParams["inscription"],
  ): Promise<string>;
  async signPsbt(
    requestOrHex: SignPsbtRequest<any> | string,
    signInputs?: Record<string, number[]>,
    sighashTypes?: number[],
    inscription?: SignPsbtParams["inscription"],
  ): Promise<string> {
    let request: SignPsbtRequest<any>;
    if (typeof requestOrHex === "string") {
      const params: SignPsbtParams = { hex: requestOrHex };
      if (signInputs) params.signInputs = signInputs;
      if (sighashTypes) params.sighashTypes = sighashTypes;
      if (inscription) params.inscription = inscription;
      request = { method: "xcp_signPsbt", params: [params] };
    } else {
      request = requestOrHex;
    }
    const capabilities = (await this.getAddresses())?.signing;
    assertProviderCanSignPsbt(request, capabilities, this.options.describeIntent);
    const result = await this.durableRequest(
      { method: request.method, params: [...request.params] },
      Timeout.interactive,
    );
    const signed = unwrap(result, "hex", "Wallet returned invalid PSBT response");
    if (!HEX_REGEX.test(signed)) throw new WalletSdkError("invalid_response", "Wallet returned invalid hex");
    return signed;
  }

  /** Sign a linked PSBT bundle (1..8 requests) in one approval. */
  async signPsbts(request: SignPsbtsRequest<any>): Promise<string[]> {
    const count = request.params[0].requests.length;
    if (count < 1 || count > SIGN_PSBTS_BUNDLE_LIMIT) {
      throw new WalletSdkError(
        "invalid_argument",
        `Wallet PSBT bundles support 1..${SIGN_PSBTS_BUNDLE_LIMIT} requests`,
      );
    }
    const capabilities = (await this.getAddresses())?.signing;
    assertProviderCanSignPsbts(request, capabilities, this.options.describeIntent);
    const result = await this.durableRequest(
      { method: request.method, params: [...request.params] },
      Timeout.interactive,
    );
    const hexes =
      result && typeof result === "object" && "hexes" in result
        ? (result as { hexes: unknown }).hexes
        : undefined;
    if (!Array.isArray(hexes) || hexes.length !== count) {
      throw new WalletSdkError("invalid_response", "Wallet returned invalid PSBT bundle response");
    }
    for (const hex of hexes) {
      if (typeof hex !== "string" || !HEX_REGEX.test(hex)) {
        throw new WalletSdkError("invalid_response", "Wallet returned invalid hex in PSBT bundle");
      }
    }
    return hexes as string[];
  }

  /** Broadcast uses interactive timeout — a false timeout is worse than waiting,
   *  since the transaction may have been broadcast successfully. */
  async broadcastTransaction(hex: string): Promise<string> {
    const result = await this.request(
      {
        method: "xcp_broadcastTransaction",
        params: [hex],
      },
      Timeout.interactive,
    );
    const txid = unwrap(result, "txid", "Wallet returned invalid broadcast response");
    if (!TXID_REGEX.test(txid)) throw new WalletSdkError("invalid_response", "Wallet returned invalid txid");
    return txid;
  }

  on<K extends keyof XcpWalletEvents>(event: K, handler: (...args: XcpWalletEvents[K]) => void): void {
    this.provider.on(event, handler as (...args: any[]) => void);
  }

  off<K extends keyof XcpWalletEvents>(event: K, handler: (...args: XcpWalletEvents[K]) => void): void {
    this.provider.removeListener(event, handler as (...args: any[]) => void);
  }
}

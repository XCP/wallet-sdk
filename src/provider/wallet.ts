import { fromWalletError, isWalletSdkError, WalletSdkError } from "@/errors";
import {
  assertProviderCanSignPsbt,
  assertProviderCanSignPsbts,
  type IntentDescriber,
  parseProviderPsbtSigningCapabilities,
} from "@/provider/capabilities";
import { BTC_ADDRESS_REGEX, HEX_REGEX, TXID_REGEX } from "@/provider/constants";
import type { XcpMethod, XcpRequest, XcpResult } from "@/provider/methods";
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
} from "@/provider/types";

/** Per-method timeouts. Passive methods are short; interactive ones wait for a person. */
const Timeout = {
  fast: 10_000,
  interactive: 120_000,
} as const;

/** The extension accepts 1..8 linked PSBT requests per `xcp_signPsbts` bundle. */
export const SIGN_PSBTS_BUNDLE_LIMIT = 8;

/** Service-worker restarts. Rejections and timeouts are terminal and excluded. */
const TRANSIENT_DISCONNECT =
  /disconnect|context invalidated|message port closed|receiving end does not exist/i;

function isTransientDisconnect(error: unknown): boolean {
  if (isWalletSdkError(error, "disconnected")) return true;
  return TRANSIENT_DISCONNECT.test(error instanceof Error ? error.message : String(error ?? ""));
}

function unwrap(result: unknown, key: string, message: string): string {
  const value =
    result && typeof result === "object" && key in result
      ? (result as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string") throw new WalletSdkError("invalid_response", message);
  return value;
}

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

/** The wallet's declared abilities. `null` means it did not say. */
export interface WalletFeatures {
  getAddresses: boolean;
  pairedAddresses: boolean;
  signPsbt: boolean | null;
  signPsbts: boolean | null;
  maxPsbtBundle: number | null;
}

export interface XcpWalletOptions {
  /**
   * Request the paired Legacy/SegWit sibling alongside the active account at
   * connect. The wallet shows the scope on its approval screen and grants a
   * pair only when it can derive one; otherwise `getAddresses()` returns
   * `active` alone. Off by default.
   */
  pairedAddresses?: boolean;
  /** Names a PSBT request's intent in a capability error. */
  describeIntent?: IntentDescriber;
}

/**
 * Typed wrapper over an injected `XcpProvider`. Failures leave as `WalletSdkError`.
 * Interactive requests retry once after a transient transport failure: the extension
 * persists approvals by (origin, method, params), so the retry resumes, never re-prompts.
 */
export class XcpWallet {
  constructor(
    private readonly provider: XcpProvider,
    private readonly options: XcpWalletOptions = {},
  ) {}

  private request<M extends XcpMethod>(args: XcpRequest<M>, timeout: number): Promise<XcpResult<M>> {
    return withTimeout(this.provider.request(args as { method: string; params?: unknown[] }), timeout).then(
      (result) => result as XcpResult<M>,
      (error: unknown) => {
        throw fromWalletError(error);
      },
    );
  }

  private async durableRequest<M extends XcpMethod>(
    args: XcpRequest<M>,
    timeout: number,
  ): Promise<XcpResult<M>> {
    try {
      return await this.request(args, timeout);
    } catch (error) {
      if (!isTransientDisconnect(error)) throw error;
      return this.request(args, timeout);
    }
  }

  /** With `pairedAddresses`, a declined pair on a connected origin is not a failed connect. */
  async connect(): Promise<ConnectResult> {
    let result: XcpResult<"xcp_requestAccounts">;
    try {
      result = await this.durableRequest(
        this.options.pairedAddresses
          ? { method: "xcp_requestAccounts", params: [{ capabilities: { pairedAddresses: true } }] }
          : { method: "xcp_requestAccounts" },
        Timeout.interactive,
      );
    } catch (error) {
      if (!this.options.pairedAddresses) throw error;
      const accounts = await this.getAccounts().catch(() => [] as string[]);
      if (accounts.length === 0) throw error;
      return { accounts, proof: null };
    }

    let accounts: string[];
    let proof: ConnectionProof | null = null;
    let proofs: ConnectionProof[] | undefined;

    if (result && typeof result === "object" && "accounts" in result) {
      accounts = result.accounts;
      proof = result.proof;
      proofs = Array.isArray(result.proofs) ? result.proofs : undefined;
    } else if (Array.isArray(result)) {
      // Older extension builds answer with the account list alone.
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

  /** `xcp_accounts`. Passive. Empty when the worker is cold or the wallet locked. */
  async getAccounts(): Promise<string[]> {
    const result = await this.request({ method: "xcp_accounts" }, Timeout.fast);
    if (!Array.isArray(result))
      throw new WalletSdkError("invalid_response", "Wallet returned invalid accounts response");
    for (const addr of result) {
      if (typeof addr !== "string" || !BTC_ADDRESS_REGEX.test(addr))
        throw new WalletSdkError("invalid_response", "Wallet returned invalid address");
    }
    return result;
  }

  async disconnect(): Promise<void> {
    await this.request({ method: "xcp_disconnect" }, Timeout.fast);
  }

  /**
   * Passive. Siblings only under a paired grant; `signing` only from reporting builds.
   * Null on any failure, including builds without the method. The key composes past
   * an OP_RETURN from a never-spent address.
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

  /** What the wallet reports it can do. One passive call. */
  async features(): Promise<WalletFeatures> {
    const addresses = await this.getAddresses();
    return {
      getAddresses: addresses !== null,
      pairedAddresses: Boolean(addresses?.legacy && addresses?.segwit),
      signPsbt: addresses?.signing?.psbt.supported ?? null,
      signPsbts: addresses?.signing?.psbtBatch.supported ?? null,
      maxPsbtBundle: addresses?.signing?.psbtBatch.maxRequests ?? null,
    };
  }

  /** `xcp_signMessage`. `address` selects a paired sibling to sign as. */
  async signMessage(message: string, address?: string): Promise<string> {
    const result = await this.durableRequest(
      { method: "xcp_signMessage", params: address ? [message, address] : [message] },
      Timeout.interactive,
    );
    if (typeof result === "string") return result;
    return unwrap(result, "signature", "Wallet returned invalid sign message response");
  }

  async signTransaction(hex: string): Promise<string> {
    const result = await this.durableRequest(
      { method: "xcp_signTransaction", params: [hex] },
      Timeout.interactive,
    );
    const signed = unwrap(result, "hex", "Wallet returned invalid sign response");
    if (!HEX_REGEX.test(signed)) throw new WalletSdkError("invalid_response", "Wallet returned invalid hex");
    return signed;
  }

  /** Positional or a complete request (which may carry an `intent`). Reported capabilities are checked first. */
  async signPsbt(request: SignPsbtRequest<unknown>): Promise<string>;
  async signPsbt(
    hex: string,
    signInputs?: Record<string, number[]>,
    sighashTypes?: number[],
    inscription?: SignPsbtParams["inscription"],
  ): Promise<string>;
  async signPsbt(
    requestOrHex: SignPsbtRequest<unknown> | string,
    signInputs?: Record<string, number[]>,
    sighashTypes?: number[],
    inscription?: SignPsbtParams["inscription"],
  ): Promise<string> {
    let params: SignPsbtParams<unknown>;
    if (typeof requestOrHex === "string") {
      params = { hex: requestOrHex };
      if (signInputs) params.signInputs = signInputs;
      if (sighashTypes) params.sighashTypes = sighashTypes;
      if (inscription) params.inscription = inscription;
    } else {
      params = requestOrHex.params[0];
    }
    const capabilities = (await this.getAddresses())?.signing;
    assertProviderCanSignPsbt(
      { method: "xcp_signPsbt", params: [params] },
      capabilities,
      this.options.describeIntent,
    );
    const result = await this.durableRequest(
      { method: "xcp_signPsbt", params: [params] },
      Timeout.interactive,
    );
    const signed = unwrap(result, "hex", "Wallet returned invalid PSBT response");
    if (!HEX_REGEX.test(signed)) throw new WalletSdkError("invalid_response", "Wallet returned invalid hex");
    return signed;
  }

  /** `xcp_signPsbts`. One approval for 1..8 linked PSBTs. */
  async signPsbts(request: SignPsbtsRequest<unknown>): Promise<string[]> {
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
      { method: "xcp_signPsbts", params: [request.params[0]] },
      Timeout.interactive,
    );
    const hexes = result && typeof result === "object" && "hexes" in result ? result.hexes : undefined;
    if (!Array.isArray(hexes) || hexes.length !== count) {
      throw new WalletSdkError("invalid_response", "Wallet returned invalid PSBT bundle response");
    }
    for (const hex of hexes) {
      if (typeof hex !== "string" || !HEX_REGEX.test(hex)) {
        throw new WalletSdkError("invalid_response", "Wallet returned invalid hex in PSBT bundle");
      }
    }
    return hexes;
  }

  /** `xcp_broadcastTransaction`. Interactive timeout: the transaction may have gone out. */
  async broadcastTransaction(hex: string): Promise<string> {
    const result = await this.request(
      { method: "xcp_broadcastTransaction", params: [hex] },
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

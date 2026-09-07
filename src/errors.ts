/** Every SDK failure is a `WalletSdkError` with a code; the wallet's numeric code is kept on `walletCode`. */

export type WalletSdkErrorCode =
  /** The person declined in the wallet's own prompt. Terminal; never retried. */
  | "user_rejected"
  /** The wallet says this origin is not connected. The session is over. */
  | "unauthorized"
  /** An older wallet build that lacks the method. */
  | "unsupported_method"
  /** The wallet's transport dropped mid-request. Usually transient. */
  | "disconnected"
  /** No provider to talk to at all. */
  | "wallet_missing"
  /** The wallet did not answer in time. */
  | "timeout"
  /** The wallet answered with something the SDK could not read. */
  | "invalid_response"
  /** Transaction envelopes or verified prevouts disagree across a trust boundary. */
  | "transaction_mismatch"
  /** The wallet reported it cannot sign this request as built. */
  | "capability"
  /** The node is rate limiting this browser and the relay's budget is spent. */
  | "rate_limited"
  /** A read failed for a reason that is not a rate limit. */
  | "network"
  /** The caller passed something the SDK refuses to send. */
  | "invalid_argument"
  /** More than one supported wallet is installed and none was chosen. */
  | "wallet_choice";

/** EIP-1193 codes the wallet extension uses, mapped to SDK codes. */
const WALLET_CODES: Record<number, WalletSdkErrorCode> = {
  4001: "user_rejected",
  4100: "unauthorized",
  4200: "unsupported_method",
  4900: "disconnected",
};

export class WalletSdkError extends Error {
  readonly code: WalletSdkErrorCode;
  /** The wallet's numeric JSON-RPC code, when the failure came from it. */
  readonly walletCode?: number;
  override readonly cause?: unknown;

  constructor(
    code: WalletSdkErrorCode,
    message: string,
    options: { cause?: unknown; walletCode?: number } = {},
  ) {
    super(message);
    this.name = "WalletSdkError";
    this.code = code;
    this.cause = options.cause;
    this.walletCode = options.walletCode;
  }
}

export function isWalletSdkError(error: unknown, code?: WalletSdkErrorCode): error is WalletSdkError {
  return error instanceof WalletSdkError && (code === undefined || error.code === code);
}

function walletCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Wallet request failed";
}

export function fromWalletError(error: unknown): WalletSdkError {
  if (error instanceof WalletSdkError) return error;
  const walletCode = walletCodeOf(error);
  const code = walletCode !== undefined ? WALLET_CODES[walletCode] : undefined;
  const message = messageOf(error);
  if (code) return new WalletSdkError(code, message, { cause: error, walletCode });
  if (/timed out|timeout/i.test(message))
    return new WalletSdkError("timeout", message, { cause: error, walletCode });
  return new WalletSdkError("network", message, { cause: error, walletCode });
}

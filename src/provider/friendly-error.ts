import { isWalletSdkError } from "@/errors";
import { DISCONNECTED, UNAUTHORIZED, UNSUPPORTED_METHOD, USER_REJECTED } from "@/provider/constants";

function hasCode(e: unknown): e is { code: number } {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as Record<string, unknown>).code === "number"
  );
}

const BY_CODE: Partial<Record<string, string>> = {
  user_rejected: "Transaction cancelled",
  unauthorized: "Wallet not authorized — please connect first",
  unsupported_method: "Method not supported by wallet",
  disconnected: "Wallet disconnected",
  wallet_missing: "No wallet extension detected — please install one",
  wallet_choice: "More than one wallet is installed — choose one to connect",
  timeout: "Request timed out — please try again",
  rate_limited: "Too many requests — please wait a moment",
  invalid_argument: "This request cannot be sent as built",
};

/** Parse wallet / compose errors into user-friendly messages. */
export function friendlyError(e: unknown): string {
  // The SDK's own errors carry a code; a capability refusal already says why.
  if (isWalletSdkError(e)) {
    if (e.code === "capability") return e.message;
    const known = BY_CODE[e.code];
    if (known) return known;
  }
  // A raw provider error that never went through XcpWallet (a custom provider's
  // own throw) may still carry the wallet's numeric code.
  if (hasCode(e)) {
    switch (e.code) {
      case USER_REJECTED:
        return "Transaction cancelled";
      case UNAUTHORIZED:
        return "Wallet not authorized — please connect first";
      case UNSUPPORTED_METHOD:
        return "Method not supported by wallet";
      case DISCONNECTED:
        return "Wallet disconnected";
    }
  }

  // Fall back to string matching for unstructured errors
  const msg = e instanceof Error ? e.message : String(e);

  if (msg.includes("User cancelled") || msg.includes("User denied") || msg.includes("User rejected"))
    return "Transaction cancelled";
  if (msg.includes("WALLET_LOCKED") || msg.includes("Wallet is locked"))
    return "Wallet is locked — please unlock and try again";
  if (msg.includes("insufficient") || msg.includes("Insufficient")) return "Insufficient balance";
  if (msg.includes("timeout") || msg.includes("Timeout")) return "Request timed out — please try again";
  if (msg.includes("Rate limit")) return "Too many requests — please wait a moment";
  if (msg.includes("dust")) return "Amount too small (below dust limit)";

  // Always log unrecognized errors for debugging (including production)
  console.warn("[wallet]", e);
  return "Something went wrong — please try again";
}

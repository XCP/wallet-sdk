import { base64 } from "@scure/base";
import { getNetwork, getStorage } from "@/config";
import { broadcastSignedTransaction } from "@/counterparty/broadcast";
import { verifyBip86RecoverableMessage, verifyLegacyRecoverableMessage } from "@/crypto/bip322";
import { WalletSdkError } from "@/errors";
import type { ProviderPsbtSigningCapabilities } from "@/provider/capabilities";
import type { ConnectionProof, XcpProvider } from "@/provider/types";

/**
 * Horizon Wallet as an `XcpProvider`.
 *
 * Horizon exposes `window.HorizonWalletProvider.request(method, params)` with
 * three methods: getAddresses, signPsbt, signMessage. No events, no accounts
 * query, no raw-transaction signing, no broadcast. This adapter answers the
 * `xcp_` surface from those three plus the node:
 *
 * - accounts are cached after the first getAddresses grant, so `xcp_accounts`
 *   and a restore never prompt;
 * - `xcp_signTransaction` is `unsupported_method`, which routes the compose
 *   pipeline to its PSBT path;
 * - `xcp_signPsbts` is one Horizon prompt per PSBT;
 * - `xcp_broadcastTransaction` POSTs to the node, then the public relays;
 * - messages declare BIP-137 for Legacy/SegWit, ECDSA-BIP86 for Taproot.
 */

export const HORIZON_MESSAGE_VERIFICATION: NonNullable<ConnectionProof["verification"]> = {
  method: "BIP-137",
  format: "legacy_recoverable",
};

export const HORIZON_TAPROOT_MESSAGE_VERIFICATION: NonNullable<ConnectionProof["verification"]> = {
  method: "ECDSA-BIP86",
  format: "legacy_recoverable",
};

export function horizonMessageVerification(address: string): NonNullable<ConnectionProof["verification"]> {
  return /^(bc1p|tb1p|bcrt1p)/i.test(address)
    ? HORIZON_TAPROOT_MESSAGE_VERIFICATION
    : HORIZON_MESSAGE_VERIFICATION;
}

/** Signing mechanics verified with the official 2.3.1 extension, not wallet-side intent proofs. */
function signingCapabilities(): ProviderPsbtSigningCapabilities {
  const method = {
    supported: true,
    sighashTypes: [0, 1, 0x83],
    inputScope: "selected" as const,
    externalInputs: "any" as const,
    taprootScriptPath: "untweaked-key" as const,
  };
  return {
    intentValidation: "none",
    psbt: { ...method },
    psbtBatch: {
      ...method,
      approvalMode: "per-psbt",
      maxRequests: 100,
      maxPolicyOfferAlternatives: 0,
      marketplaceBundles: [],
    },
  };
}

interface HorizonAddress {
  address: string;
  publicKey: string;
  type: "p2wpkh" | "p2pkh" | "p2tr";
  uuid?: string;
}

interface HorizonRequest {
  request(method: string, params?: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    HorizonWalletProvider?: HorizonRequest;
  }
}

const ADDRESSES_KEY = "xcp:horizon:addresses";

/** Horizon's error object is the JSON-RPC response; map its code space onto ours. */
function fromHorizonError(error: unknown): WalletSdkError {
  if (error instanceof WalletSdkError) return error;
  const rpc = (error as { error?: { code?: number; message?: string; data?: unknown } })?.error;
  const message = rpc?.message ?? (error instanceof Error ? error.message : "Horizon Wallet request failed");
  const options = { cause: error, walletCode: rpc?.code };
  if (rpc?.code === 4001 || /reject|cancel|denied/i.test(message))
    return new WalletSdkError("user_rejected", message, options);
  if (rpc?.code === 4100) return new WalletSdkError("unauthorized", message, options);
  if (rpc?.code === 4200 || rpc?.code === -32601)
    return new WalletSdkError("unsupported_method", message, options);
  if (rpc?.code === -32600 || rpc?.code === -32602)
    return new WalletSdkError("invalid_argument", message, options);
  if (rpc?.code === 4900) return new WalletSdkError("disconnected", message, options);
  return new WalletSdkError("network", message, options);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Horizon 2.3.1 can return the opposite recovery parity for a valid low-S
 * ECDSA signature. Repair only that metadata, and only if the existing
 * verifier proves the exact requested message and address. Never change r/s
 * or relax verification for other providers. */
function normalizeMessageSignature(message: string, signature: string, address: string): string {
  const verify =
    horizonMessageVerification(address).method === "ECDSA-BIP86"
      ? verifyBip86RecoverableMessage
      : verifyLegacyRecoverableMessage;
  if (verify(message, signature, address).valid) return signature;
  try {
    const bytes = base64.decode(signature);
    if (bytes.length !== 65 || bytes[0]! < 31 || bytes[0]! > 34) return signature;
    bytes[0] = 31 + ((bytes[0]! - 31) ^ 1);
    const corrected = base64.encode(bytes);
    return verify(message, corrected, address).valid ? corrected : signature;
  } catch {
    return signature;
  }
}

export function getHorizonProvider(): HorizonRequest | null {
  if (typeof window === "undefined") return null;
  return window.HorizonWalletProvider ?? null;
}

/** Resolves once Horizon has injected, or rejects after `timeoutMs`. */
export function detectHorizonProvider(timeoutMs = 3000): Promise<HorizonRequest> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const found = getHorizonProvider();
      if (found) return resolve(found);
      if (Date.now() - start >= timeoutMs) {
        return reject(new WalletSdkError("wallet_missing", "Horizon Wallet not detected"));
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

/** Wrap Horizon as an `XcpProvider`. `horizon` defaults to the injected object. */
export function createHorizonProvider(horizon: HorizonRequest | null = getHorizonProvider()): XcpProvider {
  if (!horizon) throw new WalletSdkError("wallet_missing", "Horizon Wallet not detected");

  const readCache = (): HorizonAddress[] => {
    try {
      const raw = getStorage()?.getItem(ADDRESSES_KEY);
      return raw ? (JSON.parse(raw) as HorizonAddress[]) : [];
    } catch {
      return [];
    }
  };
  const writeCache = (addresses: HorizonAddress[]) => {
    try {
      if (addresses.length === 0) getStorage()?.removeItem(ADDRESSES_KEY);
      else getStorage()?.setItem(ADDRESSES_KEY, JSON.stringify(addresses));
    } catch {}
  };

  // A resolved envelope may still carry `error`; Horizon Market checks both, so do we.
  const call = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    let response: unknown;
    try {
      response = await horizon.request(method, params);
    } catch (error) {
      throw fromHorizonError(error);
    }
    if (!isRecord(response))
      throw new WalletSdkError("invalid_response", "Horizon Wallet returned an invalid response");
    if (response.error) throw fromHorizonError(response);
    const result = response.result;
    if (!isRecord(result)) throw new WalletSdkError("invalid_response", "Horizon Wallet returned no result");
    if (result.error) throw fromHorizonError({ error: result.error });
    return result;
  };

  const grant = async (): Promise<HorizonAddress[]> => {
    const result = await call("getAddresses");
    const addresses = Array.isArray(result.addresses) ? (result.addresses as HorizonAddress[]) : [];
    if (addresses.length === 0)
      throw new WalletSdkError("invalid_response", "Horizon Wallet returned no addresses");
    writeCache(addresses);
    return addresses;
  };

  const signOne = async (params: Record<string, unknown>): Promise<string> => {
    const { hex, signInputs, sighashTypes, intent } = params as {
      hex: string;
      signInputs?: Record<string, number[]>;
      sighashTypes?: number[];
      intent?: unknown;
    };
    const inputs = signInputs ?? Object.fromEntries(readCache().map((a) => [a.address, [] as number[]]));
    // XCP Wallet indexes `sighashTypes` by input; Horizon (bitcoinjs underneath) takes an
    // allow-list and signs each input with the type stamped in the PSBT, so the same values
    // pass as a set. Horizon Market forwards its intent as `transactionInfo`.
    const result = await call("signPsbt", {
      hex,
      signInputs: inputs,
      ...(sighashTypes ? { sighashTypes: [...new Set(sighashTypes)] } : {}),
      ...(intent !== undefined ? { transactionInfo: intent } : {}),
    });
    if (typeof result.hex !== "string")
      throw new WalletSdkError("invalid_response", "Horizon Wallet returned no PSBT");
    return result.hex;
  };

  return {
    async request({ method, params }) {
      switch (method) {
        case "xcp_requestAccounts": {
          const cached = readCache();
          const addresses = cached.length > 0 ? cached : await grant();
          return { accounts: addresses.map((a) => a.address), proof: null };
        }
        case "xcp_accounts":
          return readCache().map((a) => a.address);
        case "xcp_disconnect":
          writeCache([]);
          return null;
        case "xcp_switchAccount": {
          const [address] = (params ?? []) as [string];
          const cached = readCache();
          const chosen = cached.find((a) => a.address === address);
          if (!chosen)
            throw new WalletSdkError("invalid_argument", "Horizon Wallet did not grant that address");
          writeCache([chosen, ...cached.filter((a) => a !== chosen)]);
          return null;
        }
        case "xcp_getAddresses": {
          const [active, ...rest] = readCache();
          if (!active) return null;
          // Horizon hands out both encodings of one key; presented as XCP Wallet's paired grant.
          const siblings = [active, ...rest].filter((a) => a.publicKey === active.publicKey);
          const legacy = siblings.find((a) => a.type === "p2pkh");
          const segwit = siblings.find((a) => a.type === "p2wpkh");
          const signing = signingCapabilities();
          return legacy && segwit ? { active, legacy, segwit, signing } : { active, signing };
        }
        case "xcp_getNetwork":
          return getNetwork();
        case "xcp_chainId":
          return "0x0";
        case "xcp_signMessage": {
          const [message, address] = (params ?? []) as [string, string?];
          if (typeof message !== "string")
            throw new WalletSdkError("invalid_argument", "A message is required");
          // Horizon 2.3.1 requires an address even for the active account.
          // Resolve it in the adapter so direct XcpWallet calls and session proofs agree.
          const cached = readCache();
          const signer = address === undefined ? cached[0] : cached.find((a) => a.address === address);
          if (!signer)
            throw new WalletSdkError(
              "unauthorized",
              "Connect and select a granted Horizon address before signing",
            );
          const result = await call("signMessage", { message, address: signer.address });
          if (typeof result.signature !== "string" || result.signature.length === 0) {
            throw new WalletSdkError("invalid_response", "Horizon Wallet returned no signature");
          }
          if (result.address !== undefined && result.address !== signer.address)
            throw new WalletSdkError("invalid_response", "Horizon Wallet signed for a different address");
          return normalizeMessageSignature(message, result.signature, signer.address);
        }
        case "xcp_signPsbt":
          return { hex: await signOne(((params ?? []) as [Record<string, unknown>])[0]) };
        case "xcp_signPsbts": {
          const [{ requests }] = (params ?? []) as [{ requests: Record<string, unknown>[] }];
          const hexes: string[] = [];
          for (const request of requests) hexes.push(await signOne(request));
          return { hexes };
        }
        case "xcp_broadcastTransaction": {
          const [hex] = (params ?? []) as [string];
          return { txid: await broadcastSignedTransaction(hex) };
        }
        default:
          throw Object.assign(new Error(`Horizon Wallet does not support ${method}`), { code: 4200 });
      }
    },
    // Horizon emits no events; the session's reconcile covers restores.
    on: () => {},
    removeListener: () => {},
  };
}

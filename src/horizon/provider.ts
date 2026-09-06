import { getCounterpartyApiBase, getNetwork, getStorage } from "@/config";
import { relayingFetch } from "@/counterparty/relay";
import { WalletSdkError } from "@/errors";
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
 * - `xcp_broadcastTransaction` goes to the configured node;
 * - message signatures are BIP-137 (p2pkh header), declared on the proof.
 */

export const HORIZON_MESSAGE_VERIFICATION: NonNullable<ConnectionProof["verification"]> = {
  method: "BIP-137",
  format: "legacy_recoverable",
};

interface HorizonAddress {
  address: string;
  publicKey: string;
  type: "p2wpkh" | "p2pkh";
  uuid?: string;
}

interface HorizonRequest {
  request(method: string, params?: unknown): Promise<{ result: Record<string, unknown> }>;
}

declare global {
  interface Window {
    HorizonWalletProvider?: HorizonRequest;
  }
}

const ADDRESSES_KEY = "xcp:horizon:addresses";

/** Horizon's error object is the JSON-RPC response; map its code space onto ours. */
function fromHorizonError(error: unknown): WalletSdkError {
  const rpc = (error as { error?: { code?: number; message?: string; data?: unknown } })?.error;
  const message = rpc?.message ?? (error instanceof Error ? error.message : "Horizon Wallet request failed");
  if (/reject|cancel|denied/i.test(message))
    return new WalletSdkError("user_rejected", message, { cause: error });
  if (rpc?.code === -32600) return new WalletSdkError("invalid_argument", message, { cause: error });
  return new WalletSdkError("network", message, { cause: error });
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

async function broadcastViaNode(signedHex: string): Promise<string> {
  const url = `${getCounterpartyApiBase()}/bitcoin/transactions?signedhex=${encodeURIComponent(signedHex)}`;
  const res = await relayingFetch(url, 30_000, { essential: true });
  const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: unknown };
  if (!res.ok || body.error) {
    throw new WalletSdkError(
      "network",
      typeof body.error === "string" ? body.error : `Broadcast failed: HTTP ${res.status}`,
    );
  }
  if (typeof body.result !== "string") throw new WalletSdkError("invalid_response", "Node returned no txid");
  return body.result;
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
    let result: Record<string, unknown>;
    try {
      result = (await horizon.request(method, params)).result;
    } catch (error) {
      throw fromHorizonError(error);
    }
    if (result && typeof result === "object" && "error" in result && result.error)
      throw fromHorizonError({ error: result.error });
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
          return legacy && segwit ? { active, legacy, segwit } : { active };
        }
        case "xcp_getNetwork":
          return getNetwork();
        case "xcp_chainId":
          return "0x0";
        case "xcp_signMessage": {
          const [message, address] = (params ?? []) as [string, string?];
          const result = await call("signMessage", { message, ...(address ? { address } : {}) });
          if (typeof result.signature !== "string") {
            throw new WalletSdkError("invalid_response", "Horizon Wallet returned no signature");
          }
          return result.signature;
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
          return { txid: await broadcastViaNode(hex) };
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

import { getCounterpartyApiBase } from "@/config";
import { WalletSdkError } from "@/errors";

/**
 * Broadcast for a wallet that cannot: Counterparty's node first (a POST; the
 * route refuses GET), then the public relays the extension also falls back to.
 * The first failure's message is the one surfaced, since the node's rejection
 * names the actual problem.
 */

interface Broadcaster {
  name: string;
  request(hex: string): { url: string; init: RequestInit };
  txid(res: Response): Promise<string | null>;
}

const BROADCASTERS: Broadcaster[] = [
  {
    name: "counterparty",
    request: (hex) => ({
      url: `${getCounterpartyApiBase()}/bitcoin/transactions?signedhex=${encodeURIComponent(hex)}`,
      init: { method: "POST", headers: { accept: "application/json" } },
    }),
    txid: async (res) => {
      const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: unknown };
      if (!res.ok || body.error) {
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
      }
      return typeof body.result === "string" ? body.result : null;
    },
  },
  {
    name: "mempool.space",
    request: (hex) => ({
      url: "https://mempool.space/api/tx",
      init: { method: "POST", headers: { "content-type": "text/plain" }, body: hex },
    }),
    txid: async (res) => {
      const text = (await res.text()).trim();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      return /^[0-9a-f]{64}$/.test(text) ? text : null;
    },
  },
  {
    name: "blockstream",
    request: (hex) => ({
      url: "https://blockstream.info/api/tx",
      init: { method: "POST", headers: { "content-type": "text/plain" }, body: hex },
    }),
    txid: async (res) => {
      const text = (await res.text()).trim();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      return /^[0-9a-f]{64}$/.test(text) ? text : null;
    },
  },
];

const TIMEOUT_MS = 30_000;

export async function broadcastSignedTransaction(hex: string): Promise<string> {
  let first: unknown;
  for (const broadcaster of BROADCASTERS) {
    const { url, init } = broadcaster.request(hex);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      const txid = await broadcaster.txid(res);
      if (txid) return txid;
      throw new Error(`${broadcaster.name} returned no txid`);
    } catch (error) {
      first ??= error;
    }
  }
  const message = first instanceof Error ? first.message : String(first ?? "Broadcast failed");
  throw new WalletSdkError("network", `Broadcast failed: ${message}`, { cause: first });
}

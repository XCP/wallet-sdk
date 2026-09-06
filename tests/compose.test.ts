import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import {
  type ComposeSigner,
  composeAndBroadcast,
  composeFromUtxoAndBroadcast,
  describeComposeError,
} from "@/transaction/compose";
import { recentlySpentUtxos } from "@/transaction/journal";

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TXID = "a".repeat(64);
// One input (txid ff..:0), one output, no witness. Enough for parseTxInputs.
const RAW_TX =
  "02000000" +
  "01" +
  "ff".repeat(32) +
  "00000000" +
  "00" +
  "ffffffff" +
  "01" +
  "e803000000000000" +
  "00" +
  "00000000";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function signer(): ComposeSigner & { signed: string[]; broadcast: string[] } {
  const signed: string[] = [];
  const broadcast: string[] = [];
  return {
    address: ADDR,
    publicKey: "02" + "ab".repeat(32),
    connectionProof: null,
    signed,
    broadcast,
    signTransaction: async (hex) => {
      signed.push(hex);
      return hex;
    },
    broadcastTransaction: async (hex) => {
      broadcast.push(hex);
      return TXID;
    },
  };
}

function stubCompose(responder: (url: URL) => { status?: number; body: unknown }) {
  const urls: URL[] = [];
  vi.stubGlobal("fetch", (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const { status = 200, body } = responder(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch);
  return urls;
}

beforeEach(() => {
  configureWalletSdk({ storage: memoryStorage() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  configureWalletSdk({ storage: null });
});

describe("composeAndBroadcast", () => {
  it("composes from the address, signs, broadcasts, and journals the inputs", async () => {
    const urls = stubCompose(() => ({ body: { result: { rawtransaction: RAW_TX } } }));
    const s = signer();
    const phases: string[] = [];
    const receipt = await composeAndBroadcast(
      s,
      "order",
      { give_asset: "XCP", give_quantity: 100n },
      { feeRate: 2, onPhase: (p) => phases.push(p) },
    );
    expect(receipt).toEqual({ txid: TXID, type: "order", signedHex: RAW_TX });
    expect(phases).toEqual(["composing", "signing", "broadcasting"]);
    expect(s.signed).toEqual([RAW_TX]);
    const compose = urls[0]!;
    expect(compose.pathname).toBe(`/v2/addresses/${ADDR}/compose/order`);
    expect(compose.searchParams.get("give_quantity")).toBe("100");
    expect(compose.searchParams.get("sat_per_vbyte")).toBe("2");
    expect(compose.searchParams.get("allow_unconfirmed_inputs")).toBe("true");
    expect(compose.searchParams.get("multisig_pubkey")).toBe(s.publicKey);
    // The next compose excludes what this one spent.
    expect(recentlySpentUtxos(ADDR)).toEqual([`${"ff".repeat(32)}:0`]);
  });

  it("falls back to confirmed-only inputs when Core rejects its own selection", async () => {
    let calls = 0;
    const urls = stubCompose(() => {
      calls++;
      return calls === 1
        ? { status: 400, body: { error: "['invalid UTXOs']" } }
        : { body: { result: { rawtransaction: RAW_TX } } };
    });
    await composeAndBroadcast(signer(), "send", { asset: "XCP" }, { feeRate: 1 });
    expect(urls.map((u) => u.searchParams.get("allow_unconfirmed_inputs"))).toEqual(["true", "false"]);
  });

  it("refuses a quantity that cannot be serialized exactly", async () => {
    stubCompose(() => ({ body: {} }));
    await expect(
      composeAndBroadcast(signer(), "send", { quantity: 2 ** 53 + 2 }, { feeRate: 1 }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("reports Core's own message, unwrapped from its list repr", async () => {
    stubCompose(() => ({ status: 400, body: { error: "['insufficient XCP balance to pay fee', 'x']" } }));
    let error: unknown;
    await composeAndBroadcast(signer(), "send", {}, { feeRate: 1 }).catch((e: unknown) => {
      error = e;
    });
    expect((error as Error).message).toBe("insufficient XCP balance to pay fee; x");
    expect(describeComposeError(error)).toMatch(/Not enough XCP/);
  });

  it("names a rate limit as such", async () => {
    stubCompose(() => ({ status: 429, body: { error: "rate limited" } }));
    let error: unknown;
    await composeAndBroadcast(signer(), "send", {}, { feeRate: 1 }).catch((e: unknown) => {
      error = e;
    });
    expect(error).toMatchObject({ code: "rate_limited" });
    expect(describeComposeError(error)).toMatch(/busy/);
  });

  it("requires a connected address", async () => {
    await expect(
      composeAndBroadcast({ ...signer(), address: null }, "send", {}, { feeRate: 1 }),
    ).rejects.toMatchObject({ code: "wallet_missing" });
  });
});

describe("composeFromUtxoAndBroadcast", () => {
  it("targets the UTXO path and journals nothing", async () => {
    const urls = stubCompose(() => ({ body: { result: { rawtransaction: RAW_TX } } }));
    const utxo = `${"cc".repeat(32)}:1`;
    await composeFromUtxoAndBroadcast(signer(), utxo, "detach", {}, { feeRate: 1 });
    expect(urls[0]!.pathname).toBe(`/v2/utxos/${utxo}/compose/detach`);
    expect(recentlySpentUtxos(ADDR)).toEqual([]);
  });

  it("rejects a malformed UTXO before any request", async () => {
    const urls = stubCompose(() => ({ body: {} }));
    await expect(composeFromUtxoAndBroadcast(signer(), "nope", "detach", {})).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(urls).toHaveLength(0);
  });
});

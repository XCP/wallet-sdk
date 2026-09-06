import { afterEach, describe, expect, it, vi } from "vitest";
import { all, fetchAssetBalance, fetchPendingDebits, fetchPool, get } from "@/counterparty/api";

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

function stub(responder: (url: URL) => { status?: number; body: unknown }) {
  const urls: URL[] = [];
  vi.stubGlobal("fetch", (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const { status = 200, body } = responder(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch);
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe("get", () => {
  it("builds the URL under the configured base and parses losslessly", async () => {
    const urls = stub(() => ({ body: '{"result":{"quantity":90071992547409930}}' }));
    const data = await get<{ result: { quantity: unknown } }>("/x", { a: 1, b: undefined, c: "z" });
    expect(urls[0]!.toString()).toBe("https://api.counterparty.io:4000/v2/x?a=1&c=z");
    expect(data.result.quantity).toBe("90071992547409930");
  });

  it("codes a 429 as rate_limited and any other failure as network", async () => {
    stub(() => ({ status: 429, body: {} }));
    await expect(get("/x")).rejects.toMatchObject({ code: "rate_limited" });
    stub(() => ({ status: 500, body: {} }));
    await expect(get("/x")).rejects.toMatchObject({ code: "network" });
  });
});

describe("paginate", () => {
  it("follows next_cursor to exhaustion", async () => {
    const urls = stub((url) => {
      const cursor = url.searchParams.get("cursor");
      if (cursor === null) return { body: { result: [1, 2], next_cursor: 10 } };
      if (cursor === "10") return { body: { result: [3], next_cursor: 20 } };
      return { body: { result: [4], next_cursor: null } };
    });
    expect(await all<number>("/rows", { limit: 2 })).toEqual([1, 2, 3, 4]);
    expect(urls).toHaveLength(3);
    expect(urls[0]!.searchParams.get("limit")).toBe("2");
  });
});

describe("typed reads", () => {
  it("sums spendable balance rows and skips UTXO-attached ones", async () => {
    stub(() => ({
      body: {
        result: [
          { address: ADDR, asset: "XCP", quantity: 5, utxo: null },
          { address: null, asset: "XCP", quantity: 100, utxo: "ab:0" },
        ],
      },
    }));
    expect(await fetchAssetBalance(ADDR, "XCP")).toBe(5n);
  });

  it("folds mempool DEBIT events by asset with their txids", async () => {
    stub(() => ({
      body: {
        result: [
          { tx_hash: "t1", event: "DEBIT", params: { address: ADDR, asset: "XCP", quantity: 3 } },
          { tx_hash: "t2", event: "DEBIT", params: { address: ADDR, asset: "XCP", quantity: 4 } },
          { tx_hash: "t3", event: "DEBIT", params: { address: "1other", asset: "XCP", quantity: 9 } },
          { tx_hash: "t4", event: "CREDIT", params: { address: ADDR, asset: "XCP", quantity: 1 } },
        ],
      },
    }));
    const debits = await fetchPendingDebits(ADDR);
    expect(debits.get("XCP")?.quantity).toBe(7n);
    expect([...debits.get("XCP")!.txids]).toEqual(["t1", "t2"]);
  });

  it("answers null for a pair with no pool", async () => {
    stub(() => ({ status: 404, body: { error: "not found" } }));
    expect(await fetchPool("A", "B")).toBeNull();
  });
});

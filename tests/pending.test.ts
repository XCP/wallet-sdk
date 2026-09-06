import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

// Module state (the snapshot cache) is per import; each test gets a fresh module.
async function load() {
  vi.resetModules();
  // The reloaded module reads the reloaded config; configure that instance.
  (await import("@/config")).configureWalletSdk({ storage });
  return import("@/transaction/pending");
}

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  configureWalletSdk({ storage });
});
afterEach(() => {
  vi.useRealTimers();
  configureWalletSdk({ storage: null });
});

describe("pending registry", () => {
  it("registers once per txid, newest first, and persists", async () => {
    const p = await load();
    p.registerPending({ txid: "a", kind: "order", label: "one", address: ADDR });
    p.registerPending({ txid: "b", kind: "order", label: "two", address: ADDR });
    p.registerPending({ txid: "a", kind: "order", label: "dup", address: ADDR });
    expect(p.readPending().map((i) => i.txid)).toEqual(["b", "a"]);
    expect(JSON.parse(storage.getItem(p.PENDING_STORAGE_KEY)!)).toHaveLength(2);
  });

  it("keeps the same snapshot object until a write", async () => {
    const p = await load();
    const first = p.readPending();
    expect(p.readPending()).toBe(first);
    p.registerPending({ txid: "a", kind: "mint", label: "x" });
    expect(p.readPending()).not.toBe(first);
  });

  it("stamps resolvedAt once and sweeps resolved rows after the TTL", async () => {
    vi.useFakeTimers();
    const p = await load();
    p.registerPending({ txid: "a", kind: "mint", label: "x" });
    p.updatePending("a", { resolved: "confirmed" });
    const stamped = p.readPending()[0]!.resolvedAt;
    vi.advanceTimersByTime(1000);
    p.updatePending("a", { misses: 1 });
    expect(p.readPending()[0]!.resolvedAt).toBe(stamped);
    p.sweepResolved(60_000);
    expect(p.readPending()).toHaveLength(1);
    vi.advanceTimersByTime(61_000);
    p.sweepResolved(60_000);
    expect(p.readPending()).toHaveLength(0);
  });

  it("sums unresolved spends of an asset for an address, excluding what the node already counts", async () => {
    const p = await load();
    p.registerPending({
      txid: "a",
      kind: "order",
      label: "x",
      address: ADDR,
      spends: [{ asset: "XCP", raw: "100" }],
    });
    p.registerPending({
      txid: "b",
      kind: "order",
      label: "y",
      address: ADDR,
      spends: [{ asset: "XCP", raw: "50" }],
    });
    p.registerPending({
      txid: "c",
      kind: "order",
      label: "z",
      address: "1other",
      spends: [{ asset: "XCP", raw: "7" }],
    });
    expect(p.pendingSpentRaw("XCP", ADDR)).toBe(150n);
    expect(p.pendingSpentRaw("XCP", ADDR, new Set(["b"]))).toBe(100n);
    p.updatePending("a", { resolved: "confirmed" });
    expect(p.pendingSpentRaw("XCP", ADDR)).toBe(50n);
  });

  it("notifies subscribers on writes and on invalidation", async () => {
    const p = await load();
    const seen = vi.fn();
    const off = p.subscribePending(seen);
    p.registerPending({ txid: "a", kind: "mint", label: "x" });
    p.invalidatePending();
    off();
    p.dismissPending("a");
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

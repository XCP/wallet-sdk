import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import { createHorizonProvider } from "@/horizon/provider";
import { XcpWallet } from "@/provider/wallet";
import { WalletSession } from "@/session";

const SEGWIT = "bc1qtsenny4t24882u7l854yzt0h2znq686mwhf2mt";
const LEGACY = "19QWXpMXeLkoEKEJv2xo9rn8wkPCyxACSX";
const OTHER = "bc1qsvqsa9arwz30g2z0w09twzn8gz3380h36yxacs";
const KEY = "032efcd34c2070d8fc9eaa4db599eb772c72802e54d575a7b05a4b2befc1f7e76f";
const OTHER_KEY = `02${"ab".repeat(32)}`;

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** Horizon's grant: both encodings of one key, plus an unrelated address. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeHorizon() {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "getAddresses") {
        return {
          result: {
            addresses: [
              { address: SEGWIT, publicKey: KEY, type: "p2wpkh" },
              { address: LEGACY, publicKey: KEY, type: "p2pkh" },
              { address: OTHER, publicKey: OTHER_KEY, type: "p2wpkh" },
            ],
          },
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

beforeEach(() => configureWalletSdk({ storage: memoryStorage() }));
afterEach(() => configureWalletSdk({ storage: null }));

describe("Horizon accounts", () => {
  it("presents both encodings of one key as a paired grant, and only those", async () => {
    const wallet = new XcpWallet(createHorizonProvider(fakeHorizon()));
    await wallet.connect();
    expect(await wallet.getAddresses()).toEqual({
      active: { address: SEGWIT, publicKey: KEY, type: "p2wpkh" },
      legacy: { address: LEGACY, publicKey: KEY, type: "p2pkh" },
      segwit: { address: SEGWIT, publicKey: KEY, type: "p2wpkh" },
    });
    await wallet.switchAccount(OTHER);
    expect(await wallet.getAddresses()).toEqual({
      active: { address: OTHER, publicKey: OTHER_KEY, type: "p2wpkh" },
    });
    expect(await wallet.getAccounts()).toEqual([OTHER, SEGWIT, LEGACY]);
  });

  it("lists every granted account on the session and switches without a new grant", async () => {
    const horizon = fakeHorizon();
    const session = new WalletSession({ provider: createHorizonProvider(horizon) });
    session.start();
    await session.connect();
    expect(session.getState()).toMatchObject({ address: SEGWIT, accounts: [SEGWIT, LEGACY, OTHER] });

    await session.switchAccount(LEGACY);
    await flush();
    expect(session.getState()).toMatchObject({
      address: LEGACY,
      activeAddress: LEGACY,
      accounts: [LEGACY, SEGWIT, OTHER],
    });
    expect(horizon.calls.filter((c) => c.method === "getAddresses")).toHaveLength(1);

    // A fresh session restores the choice from the cache.
    const restored = new WalletSession({ provider: createHorizonProvider(horizon) });
    restored.start();
    expect(restored.getState().address).toBe(LEGACY);
    session.stop();
    restored.stop();
  });

  it("settles a fresh grant on the address that holds balances, once", async () => {
    const horizon = fakeHorizon();
    const seen: string[] = [];
    vi.stubGlobal("fetch", (async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      const rows = url.includes(LEGACY) ? [{ address: LEGACY, asset: "XCP", quantity: 5, utxo: null }] : [];
      return new Response(JSON.stringify({ result: rows, next_cursor: null }), { status: 200 });
    }) as unknown as typeof fetch);
    const session = new WalletSession({ provider: createHorizonProvider(horizon) });
    session.start();
    await session.connect();
    await flush();
    await flush();
    expect(session.getState()).toMatchObject({ address: LEGACY, accounts: [LEGACY, SEGWIT, OTHER] });
    expect(seen.filter((u) => u.includes("/balances")).length).toBeLessThanOrEqual(3);
    session.stop();
    vi.unstubAllGlobals();
  });

  it("refuses an address the wallet never granted", async () => {
    const session = new WalletSession({ provider: createHorizonProvider(fakeHorizon()) });
    session.start();
    await session.connect();
    await expect(
      session.switchAccount("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"),
    ).rejects.toMatchObject({
      code: "invalid_argument",
    });
    session.stop();
  });
});

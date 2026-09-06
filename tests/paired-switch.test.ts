import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureWalletSdk } from "@/config";
import type { ConnectionProof, XcpProvider } from "@/provider/types";
import { WalletSession } from "@/session";

const LEGACY = "19QWXpMXeLkoEKEJv2xo9rn8wkPCyxACSX";
const SEGWIT = "bc1qsvqsa9arwz30g2z0w09twzn8gz3380h36yxacs";
const TAPROOT = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const PUBKEY = `02${"11".repeat(32)}`;
const segwitOnly = (address: string) => address.startsWith("bc1q");

const proofFor = (address: string): ConnectionProof => ({
  address,
  message: `m:${address}`,
  signature: "sig",
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** A wallet with a granted Legacy/SegWit pair whose active account the test moves. */
function pairedWallet(active: string) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const requests: { method: string; params?: unknown[] }[] = [];
  const state = { active };
  const provider: XcpProvider = {
    request: async ({ method, params }) => {
      requests.push({ method, params });
      switch (method) {
        case "xcp_requestAccounts":
          return {
            accounts: [state.active],
            proof: proofFor(state.active),
            proofs: [proofFor(LEGACY), proofFor(SEGWIT)],
          };
        case "xcp_accounts":
          return [state.active];
        case "xcp_getAddresses":
          return {
            active: {
              address: state.active,
              publicKey: PUBKEY,
              type: state.active === LEGACY ? "p2pkh" : "p2wpkh",
            },
            // The pair is the Legacy/SegWit siblings; a Taproot account stands alone.
            ...(state.active === TAPROOT
              ? {}
              : {
                  legacy: { address: LEGACY, publicKey: PUBKEY, type: "p2pkh" },
                  segwit: { address: SEGWIT, publicKey: PUBKEY, type: "p2wpkh" },
                }),
          };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    on: (event, fn) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
    },
    removeListener: (event, fn) => {
      listeners.get(event)?.delete(fn);
    },
  };
  const switchTo = (address: string) => {
    state.active = address;
    for (const fn of listeners.get("accountsChanged") ?? []) fn([address]);
  };
  return { provider, requests, switchTo };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => configureWalletSdk({ storage: memoryStorage() }));
afterEach(() => configureWalletSdk({ storage: null }));

describe("account switches under a paired grant", () => {
  it("keeps the SegWit identity and its proof when the active account moves inside the pair", async () => {
    const wallet = pairedWallet(LEGACY);
    const session = new WalletSession({
      provider: wallet.provider,
      pairedAddresses: true,
      canSign: segwitOnly,
    });
    session.start();
    await session.connect();
    await flush();
    expect(session.getState()).toMatchObject({
      address: SEGWIT,
      activeAddress: LEGACY,
      legacySource: LEGACY,
      connectionProof: proofFor(SEGWIT),
    });
    const connectsBefore = wallet.requests.filter((r) => r.method === "xcp_requestAccounts").length;

    wallet.switchTo(SEGWIT);
    await flush();
    expect(session.getState()).toMatchObject({
      address: SEGWIT,
      activeAddress: SEGWIT,
      legacySource: LEGACY,
      connectionProof: proofFor(SEGWIT),
    });
    expect(wallet.requests.filter((r) => r.method === "xcp_requestAccounts").length).toBe(connectsBefore);
    session.stop();
  });

  it("re-proves a switch to another account with a quiet connect, never a paired prompt", async () => {
    const wallet = pairedWallet(SEGWIT);
    const session = new WalletSession({
      provider: wallet.provider,
      pairedAddresses: true,
      canSign: segwitOnly,
    });
    session.start();
    await session.connect();
    await flush();
    wallet.requests.length = 0;

    wallet.switchTo(TAPROOT);
    await flush();
    await flush();
    const connects = wallet.requests.filter((r) => r.method === "xcp_requestAccounts");
    expect(connects).toEqual([{ method: "xcp_requestAccounts", params: undefined }]);
    expect(session.getState()).toMatchObject({
      address: TAPROOT,
      activeAddress: TAPROOT,
      legacySource: null,
    });
    session.stop();
  });
});

describe("lockOnEmptyReconcile", () => {
  it("demotes a connected session to locked when a poll answers empty, only when asked to", async () => {
    for (const lockOnEmptyReconcile of [false, true]) {
      const wallet = pairedWallet(SEGWIT);
      const session = new WalletSession({
        provider: wallet.provider,
        lockOnEmptyReconcile,
        reconcileMs: 5,
      });
      session.start();
      await session.connect();
      wallet.provider.request = async ({ method }) => (method === "xcp_accounts" ? [] : null);
      await new Promise((r) => setTimeout(r, 20));
      expect(session.getState().readyState).toBe(lockOnEmptyReconcile ? "locked" : "connected");
      session.stop();
    }
  });
});

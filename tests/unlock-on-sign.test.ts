import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import type { ConnectResult, SignPsbtsRequest, XcpProvider } from "@/provider/types";
import { WALLET_CONNECTED_STORAGE_KEY, WalletSession } from "@/session";

const SEGWIT = "bc1qsvqsa9arwz30g2z0w09twzn8gz3380h36yxacs";
const LEGACY = "19QWXpMXeLkoEKEJv2xo9rn8wkPCyxACSX";
const OTHER = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const PUBKEY = `02${"11".repeat(32)}`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let storage: Map<string, string>;
const sessions: WalletSession[] = [];
beforeEach(() => {
  storage = new Map();
  configureWalletSdk({
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
      removeItem: (key) => {
        storage.delete(key);
      },
    },
  });
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.stop();
  configureWalletSdk({ storage: null });
});

async function setup(paired = false) {
  const state = { active: paired ? LEGACY : SEGWIT, locked: false, paired };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const emit = (event: string, value?: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(value);
  };
  const response = (): ConnectResult => ({ accounts: [state.active], proof: null });
  const unlock = vi.fn(async (): Promise<ConnectResult> => {
    state.locked = false;
    return response();
  });
  const sign = vi.fn(async (method: string) =>
    method === "xcp_signPsbts" ? { hexes: ["aa"] } : method === "xcp_signMessage" ? "aa" : { hex: "aa" },
  );
  const request = vi.fn(
    async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
      if (method === "xcp_accounts") return state.locked ? [] : [state.active];
      if (method === "xcp_requestAccounts") return state.locked ? unlock() : response();
      if (method === "xcp_getAddresses" && state.locked) throw new Error("Wallet locked");
      if (method === "xcp_getAddresses")
        return {
          active: {
            address: state.active,
            publicKey: PUBKEY,
            type: state.active === LEGACY ? "p2pkh" : "p2wpkh",
          },
          ...(state.paired
            ? {
                legacy: { address: LEGACY, publicKey: PUBKEY, type: "p2pkh" },
                segwit: { address: SEGWIT, publicKey: PUBKEY, type: "p2wpkh" },
              }
            : {}),
        };
      if (method === "xcp_disconnect") return null;
      if (method.startsWith("xcp_sign")) {
        expect(state.locked).toBe(false);
        return sign(method);
      }
      throw new Error(`unexpected ${method} ${params}`);
    },
  );
  const provider: XcpProvider = {
    request,
    on: (event, listener) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(listener));
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
  };
  const session = new WalletSession({
    provider,
    pairedAddresses: true,
    canSign: (addr) => addr.startsWith("bc1"),
  });
  sessions.push(session);
  session.start();
  await session.connect();
  await flush();
  request.mockClear();
  const lock = (notify = true) => {
    state.locked = true;
    if (notify) emit("accountsChanged", []);
  };
  return { session, state, request, unlock, sign, lock, emit, response, provider };
}

const bundle = (): SignPsbtsRequest<unknown> => ({
  method: "xcp_signPsbts",
  params: [{ requests: [{ hex: "bb" }] }],
});

describe("unlock at the signing boundary", () => {
  it("restores paired identity on a locked reload, but validates the live grant before signing", async () => {
    const h = await setup(true);
    h.lock();
    h.session.stop();
    const restored = new WalletSession({
      provider: h.provider,
      pairedAddresses: true,
      canSign: (addr) => addr.startsWith("bc1"),
      lockOnEmptyReconcile: true,
    });
    sessions.push(restored);
    restored.start();
    await flush();
    expect(restored.getState()).toMatchObject({
      readyState: "locked",
      address: SEGWIT,
      legacySource: LEGACY,
    });
    expect(h.unlock).not.toHaveBeenCalled();
    await expect(restored.signMessage("login")).resolves.toBe("aa");
    expect(h.unlock).toHaveBeenCalledOnce();
    await restored.disconnect();
    expect(storage.has("xcp-wallet-addresses")).toBe(false);
  });

  it("never treats cached paired metadata as signing authority", async () => {
    const h = await setup(true);
    h.lock();
    h.session.stop();
    const cached = JSON.parse(storage.get("xcp-wallet-addresses")!);
    cached.addresses.segwit.address = OTHER;
    storage.set("xcp-wallet-addresses", JSON.stringify(cached));
    const restored = new WalletSession({
      provider: h.provider,
      pairedAddresses: true,
      canSign: (addr) => addr.startsWith("bc1"),
    });
    sessions.push(restored);
    restored.start();
    await flush();
    await expect(restored.signPsbt("bb")).rejects.toMatchObject({ code: "capability" });
    expect(h.sign).not.toHaveBeenCalled();
  });

  it("retains identity on lock and never opens a background unlock prompt", async () => {
    const h = await setup(true);
    h.lock();
    await flush();
    expect(h.session.getState()).toMatchObject({
      readyState: "locked",
      address: SEGWIT,
      legacySource: LEGACY,
    });
    expect(storage.get(WALLET_CONNECTED_STORAGE_KEY)).toBe(LEGACY);
    expect(h.unlock).not.toHaveBeenCalled();
    expect(h.sign).not.toHaveBeenCalled();
  });

  it.each(["message", "transaction", "psbt", "psbts"])(
    "unlocks before %s signing without requesting paired permission again",
    async (kind) => {
      const h = await setup(true);
      h.lock();
      const result =
        kind === "message"
          ? h.session.signMessage("login")
          : kind === "transaction"
            ? h.session.signTransaction("bb")
            : kind === "psbt"
              ? h.session.signPsbt("bb")
              : h.session.signPsbts(bundle());
      await expect(result).resolves.toEqual(kind === "psbts" ? ["aa"] : "aa");
      expect(h.unlock).toHaveBeenCalledOnce();
      expect(h.sign).toHaveBeenCalledOnce();
      expect(h.request.mock.calls.filter(([req]) => req.method === "xcp_requestAccounts")).toEqual([
        [{ method: "xcp_requestAccounts" }],
      ]);
      expect(h.session.getState()).toMatchObject({
        readyState: "connected",
        address: SEGWIT,
        legacySource: LEGACY,
      });
      if (kind === "message")
        expect(h.request).toHaveBeenCalledWith({ method: "xcp_signMessage", params: ["login", SEGWIT] });
    },
  );

  it("detects a lock even before the account event or polling arrives", async () => {
    const h = await setup();
    h.lock(false);
    await expect(h.session.signPsbt("bb")).resolves.toBe("aa");
    expect(h.unlock).toHaveBeenCalledOnce();
  });

  it("does not open connect when already unlocked", async () => {
    const h = await setup();
    await h.session.signPsbt("bb");
    expect(h.request.mock.calls.some(([req]) => req.method === "xcp_requestAccounts")).toBe(false);
  });

  it.each([4001, "timeout"])("preserves the connection after unlock fails: %s", async (failure) => {
    const h = await setup();
    h.lock();
    h.unlock.mockRejectedValueOnce(
      Object.assign(new Error(failure === "timeout" ? "Unlock timeout" : "Cancelled"), { code: failure }),
    );
    await expect(h.session.signPsbt("bb")).rejects.toMatchObject({
      code: failure === 4001 ? "user_rejected" : "timeout",
    });
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.session.getState()).toMatchObject({ readyState: "locked", address: SEGWIT });
    expect(storage.get(WALLET_CONNECTED_STORAGE_KEY)).toBe(SEGWIT);
    await expect(h.session.signPsbt("bb")).resolves.toBe("aa");
  });

  it.each(["different account", "lost pair", "disconnect", "switch away and back", "stop"])(
    "refuses signing after %s during unlock",
    async (change) => {
      const h = await setup(true);
      h.lock();
      h.unlock.mockImplementationOnce(async () => {
        h.state.locked = false;
        if (change === "different account") h.state.active = OTHER;
        if (change === "lost pair") h.state.paired = false;
        if (change === "disconnect") h.emit("disconnect");
        if (change === "switch away and back") {
          h.emit("accountsChanged", [OTHER]);
          h.emit("accountsChanged", [LEGACY]);
        }
        if (change === "stop") h.session.stop();
        return h.response();
      });
      await expect(h.session.signPsbts(bundle())).rejects.toMatchObject({ code: "capability" });
      expect(h.sign).not.toHaveBeenCalled();
    },
  );

  it("allows unlocking on the granted sibling without changing the marketplace identity", async () => {
    const h = await setup(true);
    h.lock();
    h.unlock.mockImplementationOnce(async () => {
      h.state.locked = false;
      h.state.active = SEGWIT;
      return h.response();
    });
    await expect(h.session.signMessage("login")).resolves.toBe("aa");
    expect(h.request).toHaveBeenCalledWith({ method: "xcp_signMessage", params: ["login"] });
    expect(h.session.address).toBe(SEGWIT);
  });

  it("shares one pending unlock and snapshots mutable batch requests before waiting", async () => {
    const h = await setup();
    h.lock();
    let release!: (result: ConnectResult) => void;
    h.unlock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const request = bundle();
    const first = h.session.signPsbts(request);
    const second = h.session.signMessage("login");
    await vi.waitFor(() => expect(h.unlock).toHaveBeenCalledOnce());
    request.params[0].requests[0]!.hex = "cc";
    h.state.locked = false;
    release(h.response());
    await Promise.all([first, second]);
    expect(h.unlock).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledWith({
      method: "xcp_signPsbts",
      params: [{ requests: [{ hex: "bb" }] }],
    });
  });

  it("never automatically repeats a failed signing request", async () => {
    const h = await setup();
    h.lock();
    h.sign.mockRejectedValueOnce(new Error("signing timeout"));
    await expect(h.session.signPsbt("bb")).rejects.toMatchObject({ code: "timeout" });
    expect(h.sign).toHaveBeenCalledOnce();
  });

  it("keeps identity if the wallet locks after readiness but before signing", async () => {
    const h = await setup();
    h.sign.mockImplementationOnce(async () => {
      h.lock();
      throw Object.assign(new Error("Wallet is locked"), { code: 4100 });
    });
    await expect(h.session.signPsbt("bb")).rejects.toMatchObject({ code: "unauthorized" });
    expect(h.session.getState()).toMatchObject({ address: SEGWIT, readyState: "locked" });
    expect(h.sign).toHaveBeenCalledOnce();
    expect(h.unlock).not.toHaveBeenCalled();
  });
});

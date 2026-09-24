import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import { fromWalletError, isReloadRequired, RELOAD_REQUIRED_MESSAGE } from "@/errors";
import { friendlyError } from "@/provider/friendly-error";
import type { XcpProvider } from "@/provider/types";
import { XcpWallet } from "@/provider/wallet";
import { WALLET_CONNECTED_STORAGE_KEY, WalletSession } from "@/session";

/**
 * XCP Wallet 4900s come in two kinds. A plain one is a service-worker restart: transient,
 * retried once. One carrying `data.reloadRequired` means the page's bridge to the extension
 * is dead (the wallet was updated or reloaded): retrying cannot help, the site's connection
 * is not revoked, and only reloading the page reconnects.
 */

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const PUBKEY = "02" + "ab".repeat(32);
const ADDRESS_METADATA_STORAGE_KEY = "xcp-wallet-addresses";

const reloadError = () =>
  Object.assign(new Error(RELOAD_REQUIRED_MESSAGE), { code: 4900, data: { reloadRequired: true } });
const restartError = () =>
  Object.assign(new Error("XCP Wallet restarted while handling this request. Please try again."), {
    code: 4900,
  });

type Handler = (method: string, params?: unknown[]) => unknown;

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function fakeProvider(handler: Handler) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const calls: string[] = [];
  const provider: XcpProvider = {
    request: async ({ method, params }) => {
      calls.push(method);
      return handler(method, params);
    },
    on: (event, fn) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
    },
    removeListener: (event, fn) => {
      listeners.get(event)?.delete(fn);
    },
  };
  const emit = (event: string, ...args: unknown[]) => {
    for (const fn of listeners.get(event) ?? []) fn(...args);
  };
  return { provider, calls, emit };
}

const connected: Handler = (method) => {
  switch (method) {
    case "xcp_requestAccounts":
      return { accounts: [ADDR], proof: null };
    case "xcp_accounts":
      return [ADDR];
    case "xcp_getAddresses":
      return { active: { address: ADDR, publicKey: PUBKEY, type: "p2wpkh" } };
    case "xcp_disconnect":
      return null;
    case "xcp_signMessage":
      return "sig";
    default:
      throw new Error(`unexpected ${method}`);
  }
};

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  configureWalletSdk({ storage });
});
afterEach(() => {
  configureWalletSdk({ storage: null });
});

describe("error mapping", () => {
  it("maps 4900 with data.reloadRequired to reload_required, and plain 4900 to disconnected", () => {
    const reload = fromWalletError(reloadError());
    expect(reload.code).toBe("reload_required");
    expect(reload.walletCode).toBe(4900);
    expect(fromWalletError(restartError()).code).toBe("disconnected");
    expect(isReloadRequired(reloadError())).toBe(true);
    expect(isReloadRequired(restartError())).toBe(false);
    expect(isReloadRequired({})).toBe(false);
    expect(
      isReloadRequired(Object.assign(new Error("x"), { code: 4900, data: { reloadRequired: "yes" } })),
    ).toBe(false);
    expect(friendlyError(reload)).toBe(RELOAD_REQUIRED_MESSAGE);
    expect(friendlyError(reloadError())).toBe(RELOAD_REQUIRED_MESSAGE);
  });
});

describe("XcpWallet retries", () => {
  it("never retries a reload-required failure, and reports it", async () => {
    let attempts = 0;
    const onReloadRequired = vi.fn();
    const wallet = new XcpWallet(
      fakeProvider(() => {
        attempts++;
        throw reloadError();
      }).provider,
      { onReloadRequired },
    );
    await expect(wallet.signMessage("hi")).rejects.toMatchObject({ code: "reload_required" });
    expect(attempts).toBe(1);
    expect(onReloadRequired).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to xcp_accounts for a paired connect whose bridge is dead", async () => {
    const { provider, calls } = fakeProvider(() => {
      throw reloadError();
    });
    const wallet = new XcpWallet(provider, { pairedAddresses: true });
    await expect(wallet.connect()).rejects.toMatchObject({ code: "reload_required" });
    expect(calls).toEqual(["xcp_requestAccounts"]);
  });

  it("still retries a plain 4900 exactly once", async () => {
    let attempts = 0;
    const onReloadRequired = vi.fn();
    const wallet = new XcpWallet(
      fakeProvider(() => {
        attempts++;
        if (attempts === 1) throw restartError();
        return { signature: "sig" };
      }).provider,
      { onReloadRequired },
    );
    await expect(wallet.signMessage("hi")).resolves.toBe("sig");
    expect(attempts).toBe(2);
    expect(onReloadRequired).not.toHaveBeenCalled();

    let tries = 0;
    const dead = new XcpWallet(
      fakeProvider(() => {
        tries++;
        throw restartError();
      }).provider,
    );
    await expect(dead.signMessage("hi")).rejects.toMatchObject({ code: "disconnected" });
    expect(tries).toBe(2);
  });
});

describe("session", () => {
  it("keeps the remembered connection on a reload-required disconnect event", async () => {
    const wallet = fakeProvider(connected);
    const session = new WalletSession({ provider: wallet.provider });
    session.start();
    await session.connect();
    expect(storage.getItem(ADDRESS_METADATA_STORAGE_KEY)).not.toBeNull();

    wallet.emit("disconnect", reloadError());
    const state = session.getState();
    expect(state).toMatchObject({
      readyState: "reload_required",
      connectAction: "reload",
      reloadRequired: true,
      address: ADDR,
      connectError: RELOAD_REQUIRED_MESSAGE,
    });
    expect(state.lastError?.code).toBe("reload_required");
    expect(storage.getItem(WALLET_CONNECTED_STORAGE_KEY)).toBe(ADDR);
    expect(storage.getItem(ADDRESS_METADATA_STORAGE_KEY)).not.toBeNull();
    session.stop();
  });

  it("still clears the session on a revocation disconnect ({})", async () => {
    const wallet = fakeProvider(connected);
    const session = new WalletSession({ provider: wallet.provider });
    session.start();
    await session.connect();
    wallet.emit("disconnect", {});
    expect(session.getState()).toMatchObject({
      readyState: "disconnected",
      reloadRequired: false,
      address: null,
    });
    expect(storage.getItem(WALLET_CONNECTED_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(ADDRESS_METADATA_STORAGE_KEY)).toBeNull();
    session.stop();
  });

  it("enters reload_required from a signing failure, without a retry, and refuses further signing locally", async () => {
    let signs = 0;
    const wallet = fakeProvider((method) => {
      if (method === "xcp_signMessage") {
        signs++;
        throw reloadError();
      }
      return connected(method);
    });
    const session = new WalletSession({ provider: wallet.provider });
    session.start();
    await session.connect();
    await expect(session.signMessage("hi")).rejects.toMatchObject({ code: "reload_required" });
    expect(signs).toBe(1);
    expect(session.getState()).toMatchObject({ readyState: "reload_required", address: ADDR });
    expect(storage.getItem(WALLET_CONNECTED_STORAGE_KEY)).toBe(ADDR);

    const before = wallet.calls.length;
    await expect(session.signMessage("again")).rejects.toMatchObject({ code: "reload_required" });
    await session.connect();
    expect(wallet.calls.length).toBe(before);
    expect(session.getState().readyState).toBe("reload_required");
    session.stop();
  });

  it("enters reload_required from a failed connect without clearing storage", async () => {
    storage.setItem(WALLET_CONNECTED_STORAGE_KEY, ADDR);
    const wallet = fakeProvider(() => {
      throw reloadError();
    });
    const session = new WalletSession({ provider: wallet.provider, reconcileMs: 60_000 });
    session.start();
    await session.connect();
    expect(session.getState()).toMatchObject({ readyState: "reload_required", connecting: false });
    expect(storage.getItem(WALLET_CONNECTED_STORAGE_KEY)).toBe(ADDR);
    expect(wallet.calls.filter((m) => m === "xcp_requestAccounts")).toHaveLength(1);
    session.stop();
  });

  it("stays in reload_required when another tab writes or clears the stored session", async () => {
    let onChange: ((value: string | null) => void) | null = null;
    const wallet = fakeProvider(connected);
    const session = new WalletSession({
      provider: wallet.provider,
      subscribeStorage: (_key, cb) => {
        onChange = cb;
        return () => {};
      },
    });
    session.start();
    await session.connect();
    wallet.emit("disconnect", reloadError());
    onChange!(ADDR);
    expect(session.getState().readyState).toBe("reload_required");
    onChange!(null);
    expect(session.getState()).toMatchObject({ readyState: "reload_required", connectAction: "reload" });
    session.stop();
  });

  it("plain 4900 on a signing call retries once and stays connected", async () => {
    let signs = 0;
    const wallet = fakeProvider((method) => {
      if (method === "xcp_signMessage") {
        signs++;
        if (signs === 1) throw restartError();
        return "sig";
      }
      return connected(method);
    });
    const session = new WalletSession({ provider: wallet.provider });
    session.start();
    await session.connect();
    await expect(session.signMessage("hi")).resolves.toBe("sig");
    expect(signs).toBe(2);
    expect(session.getState()).toMatchObject({ readyState: "connected", reloadRequired: false });
    session.stop();
  });
});

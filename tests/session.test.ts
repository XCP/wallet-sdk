import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import type { XcpProvider } from "@/provider/types";
import { WALLET_CONNECTED_STORAGE_KEY, WalletSession } from "@/session";

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const OTHER = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const PUBKEY = "02" + "ab".repeat(32);

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

const connected =
  (address = ADDR): Handler =>
  (method) => {
    switch (method) {
      case "xcp_requestAccounts":
        return { accounts: [address], proof: null };
      case "xcp_accounts":
        return [address];
      case "xcp_getAddresses":
        return { active: { address, publicKey: PUBKEY, type: "p2wpkh" } };
      case "xcp_disconnect":
        return null;
      case "xcp_signMessage":
        return "sig";
      default:
        throw new Error(`unexpected ${method}`);
    }
  };

const flush = () => new Promise((r) => setTimeout(r, 0));

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  configureWalletSdk({ storage });
});
afterEach(() => {
  configureWalletSdk({ storage: null });
});

describe("ready state", () => {
  it("starts detecting, then reports not_installed when detection fails", async () => {
    const session = new WalletSession({ detect: () => Promise.reject(new Error("none")) });
    expect(session.getState().readyState).toBe("detecting");
    session.start();
    await flush();
    expect(session.getState().readyState).toBe("not_installed");
    session.stop();
  });

  it("reports disconnected with a provider and nothing stored", () => {
    const session = new WalletSession({ provider: fakeProvider(connected()).provider });
    session.start();
    expect(session.getState().readyState).toBe("disconnected");
    expect(session.getState().customProvider).toBe(true);
    session.stop();
  });

  it("takes a provider that arrives late", async () => {
    let late: ((provider: XcpProvider) => void) | null = null;
    const session = new WalletSession({
      detect: () => Promise.reject(new Error("none")),
      onLateProvider: (init) => {
        late = init;
        return () => {};
      },
    });
    session.start();
    await flush();
    expect(session.getState().readyState).toBe("not_installed");
    late!(fakeProvider(connected()).provider);
    expect(session.getState().readyState).toBe("disconnected");
    session.stop();
  });
});

describe("connect and disconnect", () => {
  it("adopts the account, stores it, resolves the key, and notifies", async () => {
    const onConnected = vi.fn();
    const session = new WalletSession({
      provider: fakeProvider(connected()).provider,
      events: { onConnected },
    });
    session.start();
    await session.connect();
    const state = session.getState();
    expect(state.readyState).toBe("connected");
    expect(state.address).toBe(ADDR);
    expect(state.activeAddress).toBe(ADDR);
    expect(state.publicKey).toBe(PUBKEY);
    expect(state.addressAccess.kind).toBe("single");
    expect(storage.getItem(WALLET_CONNECTED_STORAGE_KEY)).toBe(ADDR);
    expect(onConnected).toHaveBeenCalledWith(ADDR);
    await session.disconnect();
    expect(session.getState().readyState).toBe("disconnected");
    expect(session.getState().address).toBeNull();
    expect(storage.getItem(WALLET_CONNECTED_STORAGE_KEY)).toBeNull();
    session.stop();
  });

  it("surfaces a rejection as a coded error and a message, and notifies", async () => {
    const onRejected = vi.fn();
    const { provider } = fakeProvider((method) => {
      if (method === "xcp_requestAccounts") throw Object.assign(new Error("User rejected"), { code: 4001 });
      return [];
    });
    const session = new WalletSession({ provider, events: { onRejected } });
    session.start();
    await session.connect();
    expect(session.getState().readyState).toBe("disconnected");
    expect(session.getState().lastError?.code).toBe("user_rejected");
    expect(session.getState().connectError).toBe("Transaction cancelled");
    expect(onRejected).toHaveBeenCalled();
    session.stop();
  });

  it("reports wallet_missing when nothing is there to connect to", async () => {
    const onMissing = vi.fn();
    const session = new WalletSession({ events: { onMissing } });
    session.start();
    await session.connect();
    expect(session.getState().lastError?.code).toBe("wallet_missing");
    expect(onMissing).toHaveBeenCalled();
    session.stop();
  });
});

describe("restore and reconcile", () => {
  it("restores a stored address optimistically before the wallet answers", () => {
    storage.setItem(WALLET_CONNECTED_STORAGE_KEY, ADDR);
    const session = new WalletSession({ provider: fakeProvider(connected()).provider });
    session.start();
    expect(session.getState().readyState).toBe("connected");
    expect(session.getState().address).toBe(ADDR);
    session.stop();
  });

  it("follows an accountsChanged event and ignores the empty one a lock emits", async () => {
    const wallet = fakeProvider(connected());
    const session = new WalletSession({ provider: wallet.provider });
    session.start();
    await session.connect();
    wallet.emit("accountsChanged", []);
    expect(session.getState().address).toBe(ADDR);
    wallet.emit("accountsChanged", [OTHER]);
    expect(session.getState().activeAddress).toBe(OTHER);
    expect(session.getState().proofStatus).toBe("unverified");
    session.stop();
  });

  it("clears the session on the provider's disconnect event", async () => {
    const wallet = fakeProvider(connected());
    const session = new WalletSession({ provider: wallet.provider });
    session.start();
    await session.connect();
    wallet.emit("disconnect");
    expect(session.getState().readyState).toBe("disconnected");
    expect(storage.getItem(WALLET_CONNECTED_STORAGE_KEY)).toBeNull();
    session.stop();
  });

  it("adopts a session another tab stored, and drops one another tab cleared", () => {
    let onChange: ((value: string | null) => void) | null = null;
    const session = new WalletSession({
      provider: fakeProvider(connected()).provider,
      subscribeStorage: (_key, cb) => {
        onChange = cb;
        return () => {};
      },
    });
    session.start();
    onChange!(ADDR);
    expect(session.getState().readyState).toBe("connected");
    expect(session.getState().address).toBe(ADDR);
    onChange!(null);
    expect(session.getState().readyState).toBe("disconnected");
    session.stop();
  });
});

describe("signing", () => {
  it("treats an unauthorized signing answer as the disconnect it could not see", async () => {
    const { provider } = fakeProvider((method) => {
      if (method === "xcp_signMessage") throw Object.assign(new Error("Unauthorized"), { code: 4100 });
      return connected()(method);
    });
    const session = new WalletSession({ provider });
    session.start();
    await session.connect();
    await expect(session.signMessage("hi")).rejects.toMatchObject({ code: "unauthorized" });
    expect(session.getState().readyState).toBe("disconnected");
    expect(session.getState().connectError).toMatch(/no longer connected/);
    session.stop();
  });

  it("refuses to sign without a wallet", async () => {
    const session = new WalletSession();
    session.start();
    await expect(session.signMessage("hi")).rejects.toMatchObject({ code: "wallet_missing" });
    session.stop();
  });
});

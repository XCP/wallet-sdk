import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import type { XcpProvider } from "@/provider/types";
import { WALLET_CONNECTED_STORAGE_KEY, WalletSession } from "@/session";
import { WALLET_CHOICE_STORAGE_KEY } from "@/wallets/choice";
import type { WalletCandidate, WalletDescriptor, WalletId } from "@/wallets/descriptor";
import type { WalletDiscovery } from "@/wallets/discovery";

const XCP_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const HORIZON_ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const PUBKEY = "02" + "ab".repeat(32);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function fakeProvider(address: string) {
  const calls: string[] = [];
  const provider: XcpProvider = {
    request: async ({ method }) => {
      calls.push(method);
      switch (method) {
        case "xcp_requestAccounts":
          return { accounts: [address], proof: null };
        case "xcp_accounts":
          return [address];
        case "xcp_getAddresses":
          return { active: { address, publicKey: PUBKEY, type: "p2wpkh" } };
        case "xcp_disconnect":
          return null;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    on: () => {},
    removeListener: () => {},
  };
  return { provider, calls };
}

/** Two wallets whose presence the test flips; no window involved. */
function fakeDiscovery() {
  const installed: Record<WalletId, boolean> = { xcp: false, horizon: false };
  const providers = { xcp: fakeProvider(XCP_ADDR), horizon: fakeProvider(HORIZON_ADDR) };
  const listeners = new Set<(c: WalletCandidate[]) => void>();
  const nudged: WalletId[] = [];
  const describe = (id: WalletId, extra: Partial<WalletDescriptor> = {}): WalletDescriptor => ({
    id,
    name: id === "xcp" ? "XCP Wallet" : "Horizon Wallet",
    icon: null,
    installUrl: `https://example.test/${id}`,
    installed: () => installed[id],
    provider: () => providers[id].provider,
    onInjected: () => () => {},
    nudge: () => void nudged.push(id),
    ...extra,
  });
  const wallets = [
    describe("xcp"),
    describe("horizon", { messageVerification: { method: "BIP-137", format: "legacy_recoverable" } }),
  ];
  const snapshot = (): WalletCandidate[] =>
    wallets.map((w) => ({
      id: w.id,
      name: w.name,
      icon: null,
      installUrl: w.installUrl,
      installed: installed[w.id],
    }));
  const discovery: WalletDiscovery = {
    wallets,
    descriptor: (id) => wallets.find((w) => w.id === id) ?? null,
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: () => {
      for (const w of wallets) if (!installed[w.id]) w.nudge?.();
      return snapshot();
    },
  };
  const install = (id: WalletId) => {
    installed[id] = true;
    for (const listener of listeners) listener(snapshot());
  };
  return { discovery, install, providers, nudged };
}

let storage: ReturnType<typeof memoryStorage>;
beforeEach(() => {
  storage = memoryStorage();
  configureWalletSdk({ storage });
});
afterEach(() => {
  configureWalletSdk({ storage: null });
});

describe("connect action", () => {
  it("is install with nothing installed, and connect() reports wallet_missing after a refresh", async () => {
    const { discovery, nudged } = fakeDiscovery();
    const onMissing = vi.fn();
    const session = new WalletSession({ wallets: discovery, events: { onMissing } });
    session.start();
    expect(session.getState()).toMatchObject({
      readyState: "not_installed",
      connectAction: "install",
      wallet: null,
    });
    expect(session.getState().wallets.map((c) => c.installed)).toEqual([false, false]);

    await session.connect();
    expect(nudged).toEqual(["xcp", "horizon"]);
    expect(session.getState().lastError?.code).toBe("wallet_missing");
    expect(onMissing).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("is connect with one wallet installed, and connect() binds to it without being told", async () => {
    const { discovery, install, providers } = fakeDiscovery();
    install("horizon");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    expect(session.getState()).toMatchObject({
      readyState: "disconnected",
      connectAction: "connect",
      wallet: null,
    });

    await session.connect();
    expect(session.getState()).toMatchObject({
      readyState: "connected",
      wallet: "horizon",
      address: HORIZON_ADDR,
    });
    expect(providers.horizon.calls).toContain("xcp_requestAccounts");
    expect(providers.xcp.calls).toEqual([]);
    expect(storage.getItem(WALLET_CHOICE_STORAGE_KEY)).toBe("horizon");
    expect(session.messageVerification).toEqual({ method: "BIP-137", format: "legacy_recoverable" });
    session.stop();
  });

  it("is choose with both installed and no memory; connect() without an id refuses, with an id proceeds", async () => {
    const { discovery, install, providers } = fakeDiscovery();
    install("xcp");
    install("horizon");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    expect(session.getState().connectAction).toBe("choose");

    await session.connect();
    expect(session.getState().lastError?.code).toBe("wallet_choice");
    expect(session.getState().readyState).toBe("disconnected");

    await session.connect("xcp");
    expect(session.getState()).toMatchObject({ readyState: "connected", wallet: "xcp", address: XCP_ADDR });
    expect(providers.horizon.calls).toEqual([]);
    expect(session.messageVerification).toBeUndefined();
    session.stop();
  });

  it("flips from connect to choose when a second wallet injects late, unless already bound", async () => {
    const { discovery, install } = fakeDiscovery();
    install("xcp");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    expect(session.getState().connectAction).toBe("connect");
    install("horizon");
    expect(session.getState().connectAction).toBe("choose");

    await session.connect("horizon");
    const { discovery: other, install: installOther } = fakeDiscovery();
    installOther("xcp");
    const bound = new WalletSession({ wallets: other });
    bound.start();
    await bound.connect();
    installOther("horizon");
    expect(bound.getState()).toMatchObject({ connectAction: "connect", wallet: "xcp" });
    session.stop();
    bound.stop();
  });

  it("connect(id) with a wallet that is not installed reports wallet_missing", async () => {
    const { discovery, install } = fakeDiscovery();
    install("xcp");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    await session.connect("horizon");
    expect(session.getState().lastError?.code).toBe("wallet_missing");
    expect(session.getState().connectError).toBeTruthy();
    session.stop();
  });
});

describe("remembered choice", () => {
  it("restores a stored address through the wallet it was connected with", () => {
    const { discovery, install, providers } = fakeDiscovery();
    install("xcp");
    install("horizon");
    storage.setItem(WALLET_CONNECTED_STORAGE_KEY, HORIZON_ADDR);
    storage.setItem(WALLET_CHOICE_STORAGE_KEY, "horizon");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    expect(session.getState()).toMatchObject({
      readyState: "connected",
      wallet: "horizon",
      address: HORIZON_ADDR,
    });
    expect(providers.xcp.calls).toEqual([]);
    session.stop();
  });

  it("treats a stored address with no recorded choice as XCP Wallet's", () => {
    const { discovery, install } = fakeDiscovery();
    install("xcp");
    install("horizon");
    storage.setItem(WALLET_CONNECTED_STORAGE_KEY, XCP_ADDR);
    const session = new WalletSession({ wallets: discovery });
    session.start();
    expect(session.getState()).toMatchObject({ readyState: "connected", wallet: "xcp" });
    session.stop();
  });

  it("waits for the remembered wallet to inject rather than restoring through the other one", () => {
    const { discovery, install } = fakeDiscovery();
    install("xcp");
    storage.setItem(WALLET_CONNECTED_STORAGE_KEY, HORIZON_ADDR);
    storage.setItem(WALLET_CHOICE_STORAGE_KEY, "horizon");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    expect(session.getState()).toMatchObject({
      readyState: "disconnected",
      wallet: null,
      connectAction: "connect",
    });
    install("horizon");
    expect(session.getState()).toMatchObject({
      readyState: "connected",
      wallet: "horizon",
      address: HORIZON_ADDR,
    });
    session.stop();
  });

  it("skips the chooser when both are installed and one is remembered", async () => {
    const { discovery, install } = fakeDiscovery();
    install("xcp");
    install("horizon");
    storage.setItem(WALLET_CHOICE_STORAGE_KEY, "horizon");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    expect(session.getState().connectAction).toBe("connect");
    await session.connect();
    expect(session.getState().wallet).toBe("horizon");
    session.stop();
  });

  it("starts clean when connect() picks a different wallet than the stored address came from", async () => {
    const { discovery, install } = fakeDiscovery();
    install("xcp");
    storage.setItem(WALLET_CONNECTED_STORAGE_KEY, HORIZON_ADDR);
    storage.setItem(WALLET_CHOICE_STORAGE_KEY, "horizon");
    const session = new WalletSession({ wallets: discovery });
    const seen: (string | null)[] = [];
    session.subscribe(() => seen.push(session.getState().address));
    session.start();
    await session.connect();
    expect(seen).not.toContain(HORIZON_ADDR);
    expect(session.getState()).toMatchObject({ wallet: "xcp", address: XCP_ADDR });
    expect(storage.getItem(WALLET_CHOICE_STORAGE_KEY)).toBe("xcp");
    session.stop();
  });
});

describe("switching and forgetting", () => {
  it("connect(other) while connected disconnects the first wallet and connects the second", async () => {
    const { discovery, install, providers } = fakeDiscovery();
    install("xcp");
    install("horizon");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    await session.connect("xcp");
    await session.connect("horizon");
    expect(session.getState()).toMatchObject({
      readyState: "connected",
      wallet: "horizon",
      address: HORIZON_ADDR,
    });
    expect(providers.horizon.calls).toContain("xcp_requestAccounts");
    expect(storage.getItem(WALLET_CONNECTED_STORAGE_KEY)).toBe(HORIZON_ADDR);
    expect(storage.getItem(WALLET_CHOICE_STORAGE_KEY)).toBe("horizon");
    session.stop();
  });

  it("forgetWallet disconnects, drops the memory and the binding, and asks again", async () => {
    const { discovery, install, providers } = fakeDiscovery();
    install("xcp");
    install("horizon");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    await session.connect("xcp");
    await session.forgetWallet();
    expect(providers.xcp.calls).toContain("xcp_disconnect");
    expect(storage.getItem(WALLET_CHOICE_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(WALLET_CONNECTED_STORAGE_KEY)).toBeNull();
    expect(session.getState()).toMatchObject({
      readyState: "disconnected",
      wallet: null,
      connectAction: "choose",
    });
    session.stop();
  });

  it("disconnect alone keeps the binding, so reconnecting is one step", async () => {
    const { discovery, install } = fakeDiscovery();
    install("xcp");
    install("horizon");
    const session = new WalletSession({ wallets: discovery });
    session.start();
    await session.connect("horizon");
    await session.disconnect();
    expect(session.getState()).toMatchObject({
      readyState: "disconnected",
      wallet: "horizon",
      connectAction: "connect",
    });
    await session.connect();
    expect(session.getState()).toMatchObject({ readyState: "connected", wallet: "horizon" });
    session.stop();
  });
});

describe("without discovery", () => {
  it("a supplied provider connects as before and reports connect as the action", async () => {
    const session = new WalletSession({ provider: fakeProvider(XCP_ADDR).provider });
    session.start();
    expect(session.getState()).toMatchObject({ connectAction: "connect", wallet: null, wallets: [] });
    await session.connect();
    expect(session.getState().readyState).toBe("connected");
    await session.forgetWallet();
    expect(session.getState().readyState).toBe("disconnected");
    session.stop();
  });
});

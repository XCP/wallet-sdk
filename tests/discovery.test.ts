import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XcpProvider } from "@/provider/types";
import { discoverWallets } from "@/wallets/discovery";
import { HORIZON_WALLET } from "@/wallets/horizon";
import { XCP_DISCOVER_EVENT, XCP_INITIALIZED_EVENT, XCP_WALLET } from "@/wallets/xcp";

/** Enough of `window` for the descriptors: globals plus an event target. */
function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const dispatched: string[] = [];
  const w = {
    xcpwallet: undefined as XcpProvider | undefined,
    HorizonWalletProvider: undefined as unknown,
    btc_providers: undefined as unknown[] | undefined,
    addEventListener: (event: string, fn: () => void) => {
      listeners.set(event, (listeners.get(event) ?? new Set()).add(fn));
    },
    removeEventListener: (event: string, fn: () => void) => {
      listeners.get(event)?.delete(fn);
    },
    dispatchEvent: (event: { type: string }) => {
      dispatched.push(event.type);
      for (const fn of listeners.get(event.type) ?? []) fn();
      return true;
    },
  };
  return { w, dispatched, listenerCount: (event: string) => listeners.get(event)?.size ?? 0 };
}

const provider = {} as XcpProvider;

let win: ReturnType<typeof fakeWindow>;
beforeEach(() => {
  win = fakeWindow();
  vi.stubGlobal("window", win.w);
  vi.stubGlobal(
    "Event",
    class {
      constructor(public type: string) {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("discoverWallets", () => {
  it("lists every supported wallet, recommended first, with installed flags", () => {
    win.w.xcpwallet = provider;
    const discovery = discoverWallets();
    expect(discovery.snapshot()).toEqual([
      expect.objectContaining({ id: "xcp", name: "XCP Wallet", installed: true }),
      expect.objectContaining({ id: "horizon", name: "Horizon Wallet", installed: false }),
    ]);
    expect(discovery.snapshot()[0]!.icon).toMatch(/^data:image\/png;base64,/);
    expect(discovery.snapshot()[1]!.icon).toBeNull();
  });

  it("notices XCP Wallet injecting after the page loaded, and asks it to announce", () => {
    const discovery = discoverWallets();
    const seen = vi.fn();
    const stop = discovery.subscribe(seen);
    expect(win.dispatched).toContain(XCP_DISCOVER_EVENT);

    win.w.xcpwallet = provider;
    win.w.dispatchEvent({ type: XCP_INITIALIZED_EVENT });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ id: "xcp", installed: true }),
      expect.objectContaining({ id: "horizon", installed: false }),
    ]);

    stop();
    expect(win.listenerCount(XCP_INITIALIZED_EVENT)).toBe(0);
  });

  it("finds Horizon by polling, since it announces nothing", () => {
    vi.useFakeTimers();
    const discovery = discoverWallets();
    const seen = vi.fn();
    discovery.subscribe(seen);
    vi.advanceTimersByTime(600);
    expect(seen).not.toHaveBeenCalled();

    win.w.HorizonWalletProvider = { request: async () => ({ result: {} }) };
    vi.advanceTimersByTime(300);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0][1]).toEqual(expect.objectContaining({ id: "horizon", installed: true }));
  });

  it("takes Horizon's icon from the btc_providers registry only when an <img> could show it", () => {
    win.w.btc_providers = [{ id: "HorizonWalletProvider", icon: "data:image/svg;base64,broken" }];
    expect(discoverWallets().snapshot()[1]!.icon).toBeNull();
    win.w.btc_providers = [{ id: "HorizonWalletProvider", icon: "data:image/svg+xml;base64,PHN2Zy8+" }];
    expect(discoverWallets().snapshot()[1]!.icon).toBe("data:image/svg+xml;base64,PHN2Zy8+");
  });

  it("refresh re-checks and nudges wallets that can announce themselves", () => {
    const discovery = discoverWallets();
    const seen = vi.fn();
    discovery.subscribe(seen);
    win.dispatched.length = 0;
    expect(discovery.refresh()[0]!.installed).toBe(false);
    expect(win.dispatched).toEqual([XCP_DISCOVER_EVENT]);
    expect(seen).not.toHaveBeenCalled();

    win.w.xcpwallet = provider;
    const candidates = discovery.refresh();
    expect(candidates[0]!.installed).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(discovery.refresh()).toBe(candidates);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("can be limited to a subset of wallets", () => {
    const discovery = discoverWallets([XCP_WALLET]);
    expect(discovery.snapshot().map((c) => c.id)).toEqual(["xcp"]);
    expect(discovery.descriptor("horizon")).toBeNull();
    expect(discovery.descriptor("xcp")).toBe(XCP_WALLET);
    expect(HORIZON_WALLET.messageVerification?.method).toBe("BIP-137");
  });
});

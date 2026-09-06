import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import { createHorizonProvider, HORIZON_MESSAGE_VERIFICATION } from "@/horizon/provider";
import { XcpWallet } from "@/provider/wallet";
import { WalletSession } from "@/session";

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const PUBKEY = "02" + "ab".repeat(32);
const TXID = "e".repeat(64);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** Horizon's wire: `request(method, params)` resolves `{ result }`, rejects with the JSON-RPC response. */
function fakeHorizon(handler: (method: string, params: unknown) => unknown) {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return { result: handler(method, params) as Record<string, unknown> };
    },
  };
}

const granting = (method: string, params: unknown) => {
  switch (method) {
    case "getAddresses":
      return { addresses: [{ address: ADDR, publicKey: PUBKEY, type: "p2wpkh", uuid: "u" }] };
    case "signPsbt":
      return { hex: `${(params as { hex: string }).hex}ff` };
    case "signMessage":
      return { signature: "c2ln", messageHash: "h", address: ADDR };
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
  vi.unstubAllGlobals();
  configureWalletSdk({ storage: null });
});

describe("createHorizonProvider", () => {
  it("connects through getAddresses once and answers accounts from the cache afterwards", async () => {
    const horizon = fakeHorizon(granting);
    const wallet = new XcpWallet(createHorizonProvider(horizon));
    expect(await wallet.getAccounts()).toEqual([]);
    expect(await wallet.connect()).toEqual({ accounts: [ADDR], proof: null });
    expect(await wallet.getAccounts()).toEqual([ADDR]);
    expect(await wallet.connect()).toEqual({ accounts: [ADDR], proof: null });
    expect(horizon.calls.filter((c) => c.method === "getAddresses")).toHaveLength(1);
    expect((await wallet.getAddresses())?.active).toMatchObject({ address: ADDR, publicKey: PUBKEY });
    await wallet.disconnect();
    expect(await wallet.getAccounts()).toEqual([]);
  });

  it("survives a reload: the grant is in storage", async () => {
    await new XcpWallet(createHorizonProvider(fakeHorizon(granting))).connect();
    const fresh = fakeHorizon(granting);
    expect(await new XcpWallet(createHorizonProvider(fresh)).getAccounts()).toEqual([ADDR]);
    expect(fresh.calls).toHaveLength(0);
  });

  it("signs PSBTs one prompt each, and a bundle as a sequence", async () => {
    const horizon = fakeHorizon(granting);
    const wallet = new XcpWallet(createHorizonProvider(horizon));
    await wallet.connect();
    expect(await wallet.signPsbt("aa", { [ADDR]: [0] }, [1])).toBe("aaff");
    expect(horizon.calls.at(-1)).toEqual({
      method: "signPsbt",
      params: { hex: "aa", signInputs: { [ADDR]: [0] }, sighashTypes: [1] },
    });
    const hexes = await wallet.signPsbts({
      method: "xcp_signPsbts",
      params: [{ requests: [{ hex: "bb" }, { hex: "cc" }] }],
    });
    expect(hexes).toEqual(["bbff", "ccff"]);
    expect(horizon.calls.filter((c) => c.method === "signPsbt")).toHaveLength(3);
  });

  it("reports raw-transaction signing as unsupported so the compose pipeline uses PSBTs", async () => {
    const wallet = new XcpWallet(createHorizonProvider(fakeHorizon(granting)));
    await expect(wallet.signTransaction("00")).rejects.toMatchObject({ code: "unsupported_method" });
  });

  it("broadcasts through the node", async () => {
    let broadcastUrl = "";
    vi.stubGlobal("fetch", (async (input: string | URL) => {
      broadcastUrl = String(input);
      return new Response(JSON.stringify({ result: TXID }), { status: 200 });
    }) as unknown as typeof fetch);
    const wallet = new XcpWallet(createHorizonProvider(fakeHorizon(granting)));
    expect(await wallet.broadcastTransaction("0200")).toBe(TXID);
    expect(broadcastUrl).toBe("https://api.counterparty.io:4000/v2/bitcoin/transactions?signedhex=0200");
  });

  it("maps a Horizon rejection to user_rejected", async () => {
    const horizon = {
      request: async () => {
        throw { jsonrpc: "2.0", id: "x", error: { code: 4001, message: "User rejected the request" } };
      },
    };
    const wallet = new XcpWallet(createHorizonProvider(horizon));
    await expect(wallet.connect()).rejects.toMatchObject({ code: "user_rejected" });
  });

  it("runs the session end to end with the BIP-137 dialect declared", async () => {
    const session = new WalletSession({
      provider: createHorizonProvider(fakeHorizon(granting)),
      messageVerification: HORIZON_MESSAGE_VERIFICATION,
    });
    session.start();
    await session.connect();
    expect(session.getState()).toMatchObject({ readyState: "connected", address: ADDR, publicKey: PUBKEY });
    expect(session.messageVerification).toEqual(HORIZON_MESSAGE_VERIFICATION);
    expect(await session.signMessage("hello")).toBe("c2ln");
    session.stop();
  });
});

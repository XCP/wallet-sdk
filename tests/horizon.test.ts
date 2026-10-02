import { secp256k1 } from "@noble/curves/secp256k1";
import { base64, hex } from "@scure/base";
import { p2tr, p2wpkh } from "@scure/btc-signer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import {
  legacyMessageHash,
  verifyBip86RecoverableMessage,
  verifyLegacyRecoverableMessage,
} from "@/crypto/bip322";
import {
  createHorizonProvider,
  HORIZON_MESSAGE_VERIFICATION,
  horizonMessageVerification,
} from "@/horizon/provider";
import { XcpWallet } from "@/provider/wallet";
import { WalletSession } from "@/session";
import fixtures from "./fixtures/horizon-2.3.1.json";

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const PUBKEY = "02" + "ab".repeat(32);
const PSBT = fixtures[3]!.hex;
const TWO_INPUT_PSBT = fixtures[0]!.hex;
const TXID = "e".repeat(64);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** Success resolves `{ result }`; errors may reject or resolve a JSON-RPC envelope. */
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
  it("repairs Horizon 2.3.1 recovery parity only when the exact address and message verify", async () => {
    // Captured from the official extension using the public, unfunded BIP-39
    // abandon/about test wallet, not generated with the implementation under test.
    const address = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
    const message = "Horizon SDK compatibility test";
    const signature =
      "Hy6ZLOXKFLzaVsfVeRy1RXXO6nIPUp61Mz2oaH/qSl4cJZinxe4LDyhy/fTFA3vHCnSdAOluEmS9hA9TnJpaeHU=";
    const horizon = fakeHorizon((method) =>
      method === "getAddresses"
        ? {
            addresses: [
              {
                address,
                publicKey: "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c",
                type: "p2wpkh",
              },
            ],
          }
        : { address, signature },
    );
    const wallet = new XcpWallet(createHorizonProvider(horizon));
    await wallet.connect();
    const corrected = await wallet.signMessage(message);
    const bytes = base64.decode(signature);
    bytes[0] = 32;
    expect(corrected).toBe(base64.encode(bytes));
    expect(verifyLegacyRecoverableMessage(message, corrected, address).valid).toBe(true);
    expect(verifyLegacyRecoverableMessage("different", corrected, address).valid).toBe(false);
    // A wrong message must not get a rewritten header or be made valid.
    expect(await wallet.signMessage("different")).toBe(signature);
    expect(verifyLegacyRecoverableMessage(message, corrected, ADDR).valid).toBe(false);
  });
  it.each(["p2wpkh", "p2tr"] as const)(
    "verifies a %s connect-time proof through Horizon's address-required message API",
    async (type) => {
      const key = new Uint8Array(32).fill(7);
      const pubkey = secp256k1.getPublicKey(key, true);
      const address = (type === "p2tr" ? p2tr(pubkey.subarray(1)) : p2wpkh(pubkey)).address!;
      const horizon = fakeHorizon((method, params) => {
        if (method === "getAddresses")
          return { addresses: [{ address, publicKey: hex.encode(pubkey), type }] };
        if (method !== "signMessage") throw new Error(`unexpected ${method}`);
        const request = params as { message: string; address: string };
        if (request.address !== address)
          throw { error: { code: -32600, message: "Missing or invalid address" } };
        const sig = secp256k1.sign(legacyMessageHash(request.message), key, { prehash: false });
        return {
          address,
          signature: base64.encode(new Uint8Array([31 + sig.recovery!, ...sig.toCompactRawBytes()])),
        };
      });
      const session = new WalletSession({
        provider: createHorizonProvider(horizon),
        messageVerification: HORIZON_MESSAGE_VERIFICATION,
        messageVerificationForAddress: horizonMessageVerification,
        origin: "https://site.test",
        proofOnConnect: true,
      });
      session.start();
      try {
        await session.connect();
        expect(session.getState()).toMatchObject({ address, proofStatus: "verified" });
        expect(horizon.calls.filter((call) => call.method === "signMessage")).toHaveLength(1);
      } finally {
        session.stop();
      }
    },
  );
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
    expect(await wallet.signPsbt(PSBT, { [ADDR]: [0] }, [1])).toBe(`${PSBT}ff`);
    expect(horizon.calls.at(-1)).toEqual({
      method: "signPsbt",
      params: { hex: PSBT, signInputs: { [ADDR]: [0] }, sighashTypes: [1] },
    });
    // A per-input list such as a listing's [ALL, SINGLE|ANYONECANPAY] reaches Horizon as the allowed set.
    await wallet.signPsbt(TWO_INPUT_PSBT, { [ADDR]: [1] }, [0x01, 0x83, 0x01]);
    expect(horizon.calls.at(-1)?.params).toMatchObject({ sighashTypes: [0x01, 0x83] });
    const hexes = await wallet.signPsbts({
      method: "xcp_signPsbts",
      params: [
        {
          requests: [
            { hex: PSBT, signInputs: { [ADDR]: [0] }, sighashTypes: [1] },
            { hex: PSBT, signInputs: { [ADDR]: [0] }, sighashTypes: [1] },
          ],
        },
      ],
    });
    expect(hexes).toEqual([`${PSBT}ff`, `${PSBT}ff`]);
    expect(horizon.calls.filter((c) => c.method === "signPsbt")).toHaveLength(4);
  });

  it("reports raw-transaction signing as unsupported so the compose pipeline uses PSBTs", async () => {
    const wallet = new XcpWallet(createHorizonProvider(fakeHorizon(granting)));
    await expect(wallet.signTransaction("00")).rejects.toMatchObject({ code: "unsupported_method" });
  });

  it("broadcasts with a POST to the node, and falls back to the public relays when it refuses", async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal("fetch", (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method });
      if (url.includes("counterparty.io"))
        return new Response(JSON.stringify({ result: TXID }), { status: 200 });
      return new Response(TXID, { status: 200 });
    }) as unknown as typeof fetch);
    const wallet = new XcpWallet(createHorizonProvider(fakeHorizon(granting)));
    expect(await wallet.broadcastTransaction("0200")).toBe(TXID);
    expect(calls).toEqual([
      { url: "https://api.counterparty.io:4000/v2/bitcoin/transactions?signedhex=0200", method: "POST" },
    ]);

    calls.length = 0;
    vi.stubGlobal("fetch", (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method });
      if (url.includes("counterparty.io")) throw new TypeError("Failed to fetch");
      return new Response(TXID, { status: 200 });
    }) as unknown as typeof fetch);
    expect(await wallet.broadcastTransaction("0200")).toBe(TXID);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.counterparty.io:4000/v2/bitcoin/transactions?signedhex=0200",
      "https://mempool.space/api/tx",
    ]);

    // The node's own rejection is the message that names the problem.
    vi.stubGlobal("fetch", (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("counterparty.io"))
        return new Response(JSON.stringify({ error: "txn-mempool-conflict" }), { status: 400 });
      return new Response("sendrawtransaction RPC error", { status: 400 });
    }) as unknown as typeof fetch);
    await expect(wallet.broadcastTransaction("0200")).rejects.toThrow("txn-mempool-conflict");
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
    const horizon = fakeHorizon(granting);
    const session = new WalletSession({
      provider: createHorizonProvider(horizon),
      messageVerification: HORIZON_MESSAGE_VERIFICATION,
      messageVerificationForAddress: horizonMessageVerification,
    });
    session.start();
    await session.connect();
    expect(session.getState()).toMatchObject({ readyState: "connected", address: ADDR, publicKey: PUBKEY });
    expect(session.messageVerification).toEqual(HORIZON_MESSAGE_VERIFICATION);
    expect(await session.signMessage("hello")).toBe("c2ln");
    expect(horizon.calls.at(-1)).toEqual({
      method: "signMessage",
      params: { message: "hello", address: ADDR },
    });
    session.stop();
  });

  it("uses the switched account, but honors an explicitly granted signer", async () => {
    const other = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
    const horizon = fakeHorizon((method, params) =>
      method === "getAddresses"
        ? {
            addresses: [
              { address: ADDR, publicKey: PUBKEY, type: "p2wpkh" },
              { address: other, publicKey: PUBKEY, type: "p2pkh" },
            ],
          }
        : method === "signMessage"
          ? { signature: "c2ln", address: (params as { address: string }).address }
          : granting(method, params),
    );
    const wallet = new XcpWallet(createHorizonProvider(horizon));
    await wallet.connect();
    await wallet.switchAccount(other);
    await wallet.signMessage("active");
    expect(horizon.calls.at(-1)?.params).toEqual({ message: "active", address: other });
    await wallet.signMessage("identity", ADDR);
    expect(horizon.calls.at(-1)?.params).toEqual({ message: "identity", address: ADDR });
    const count = horizon.calls.length;
    await expect(wallet.signMessage("no", "ungranted")).rejects.toMatchObject({ code: "unauthorized" });
    expect(horizon.calls).toHaveLength(count);
  });

  it("does not open a message prompt without an account grant", async () => {
    const horizon = fakeHorizon(granting);
    const wallet = new XcpWallet(createHorizonProvider(horizon));
    await expect(wallet.signMessage("hello")).rejects.toMatchObject({ code: "unauthorized" });
    expect(horizon.calls).toHaveLength(0);
  });

  it("authenticates the official extension's BIP-86 signature without calling it BIP-322", async () => {
    const address = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
    const message = "Horizon Taproot authentication test";
    // Official 2.3.1, public abandon/about BIP-39 test wallet, BIP-86 account 0.
    const signature =
      "H1hOLrmUhh2waBD/l6kYq3W0/KuxtF3XYHspJY5JZ0/ddnmjuqrnm1a3plch1pEZcioEKUu9CwR60rYKn5n94Dc=";
    const horizon = fakeHorizon((method) =>
      method === "getAddresses"
        ? {
            addresses: [
              {
                address,
                publicKey: "cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115",
                type: "p2tr",
              },
            ],
          }
        : { address, signature },
    );
    const wallet = new XcpWallet(createHorizonProvider(horizon));
    await wallet.connect();
    const corrected = await wallet.signMessage(message);
    expect(verifyBip86RecoverableMessage(message, corrected, address).valid).toBe(true);
    expect(verifyLegacyRecoverableMessage(message, corrected, address).valid).toBe(false);
    expect(verifyBip86RecoverableMessage("changed", corrected, address).valid).toBe(false);
    expect(await wallet.signMessage("changed")).toBe(signature);
    expect(horizonMessageVerification(address).method).toBe("ECDSA-BIP86");
  });

  it.each([
    [-32600, "Missing or invalid address", "invalid_argument"],
    [-32602, "Invalid params", "invalid_argument"],
    [-32601, "Method not found", "unsupported_method"],
    [4001, "User rejected request", "user_rejected"],
    [4100, "Not connected", "unauthorized"],
    [4900, "Disconnected", "disconnected"],
  ])("maps resolved JSON-RPC error %s without losing the wallet message", async (code, message, expected) => {
    const horizon = { request: async () => ({ jsonrpc: "2.0", id: "x", error: { code, message } }) };
    const wallet = new XcpWallet(createHorizonProvider(horizon));
    await expect(wallet.connect()).rejects.toMatchObject({ code: expected, message, walletCode: code });
  });

  it("also maps nested result errors", async () => {
    const wallet = new XcpWallet(
      createHorizonProvider(fakeHorizon(() => ({ error: { code: -32600, message: "Missing address" } }))),
    );
    await expect(wallet.connect()).rejects.toMatchObject({
      code: "invalid_argument",
      message: "Missing address",
    });
  });

  it.each([null, undefined, [], {}, { result: null }, { result: [] }, { result: "bad" }])(
    "rejects malformed response %j predictably",
    async (response) => {
      const wallet = new XcpWallet(createHorizonProvider({ request: async () => response }));
      await expect(wallet.connect()).rejects.toMatchObject({ code: "invalid_response" });
    },
  );

  it("rejects a signature response naming a different account", async () => {
    const horizon = fakeHorizon((method, params) =>
      method === "signMessage" ? { signature: "c2ln", address: "other" } : granting(method, params),
    );
    const wallet = new XcpWallet(createHorizonProvider(horizon));
    await wallet.connect();
    await expect(wallet.signMessage("hello")).rejects.toMatchObject({ code: "invalid_response" });
  });
});

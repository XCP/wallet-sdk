import { describe, expect, it, vi } from "vitest";
import { isWalletSdkError, type WalletSdkError } from "@/errors";
import { ProviderSigningCapabilityError } from "@/provider/capabilities";
import type { XcpProvider } from "@/provider/types";
import { XcpWallet } from "@/provider/wallet";

/**
 * XcpWallet against a scripted provider. This is the one module every host
 * depends on, so what is pinned here is the contract a host sees: which call
 * shapes reach the wallet, how its answers are read, and that every failure
 * arrives as a WalletSdkError with the right code.
 */

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const PUBKEY = "02" + "ab".repeat(32);
const TXID = "f".repeat(64);

type Handler = (args: { method: string; params?: unknown[] }) => unknown | Promise<unknown>;

function fakeProvider(handler: Handler) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const provider: XcpProvider = {
    request: async (args) => {
      calls.push(args);
      return handler(args);
    },
    on: () => {},
    removeListener: () => {},
  };
  return { provider, calls };
}

const walletError = (code: number, message: string) => Object.assign(new Error(message), { code });

describe("connect", () => {
  it("reads the modern { accounts, proof } shape and the legacy array shape", async () => {
    const proof = { address: ADDR, message: "m", signature: "s" };
    const modern = new XcpWallet(fakeProvider(() => ({ accounts: [ADDR], proof })).provider);
    expect(await modern.connect()).toEqual({ accounts: [ADDR], proof });

    const legacy = new XcpWallet(fakeProvider(() => [ADDR]).provider);
    expect(await legacy.connect()).toEqual({ accounts: [ADDR], proof: null });
  });

  it("asks for paired addresses only when told to, and keeps per-address proofs", async () => {
    const proofs = [
      { address: ADDR, message: "m", signature: "s" },
      { address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", message: "m", signature: "t" },
    ];
    const { provider, calls } = fakeProvider(() => ({ accounts: [ADDR], proof: proofs[0], proofs }));
    const result = await new XcpWallet(provider, { pairedAddresses: true }).connect();
    expect(calls[0]).toEqual({
      method: "xcp_requestAccounts",
      params: [{ capabilities: { pairedAddresses: true } }],
    });
    expect(result.proofs).toHaveLength(2);

    const plain = fakeProvider(() => ({ accounts: [ADDR], proof: null }));
    await new XcpWallet(plain.provider).connect();
    expect(plain.calls[0]).toEqual({ method: "xcp_requestAccounts" });
  });

  it("treats a declined paired grant on a connected origin as still connected", async () => {
    const { provider } = fakeProvider(({ method }) => {
      if (method === "xcp_requestAccounts") throw walletError(4001, "User rejected");
      if (method === "xcp_accounts") return [ADDR];
      throw new Error("unexpected");
    });
    const result = await new XcpWallet(provider, { pairedAddresses: true }).connect();
    expect(result).toEqual({ accounts: [ADDR], proof: null });
  });

  it("refuses an address the wallet made up", async () => {
    const wallet = new XcpWallet(fakeProvider(() => ["not-an-address"]).provider);
    await expect(wallet.connect()).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("errors", () => {
  it("maps the wallet's numeric codes to SDK codes and keeps the original", async () => {
    const wallet = new XcpWallet(
      fakeProvider(() => Promise.reject(walletError(4001, "User rejected"))).provider,
    );
    let caught: unknown;
    await wallet.signMessage("hi").catch((e: unknown) => {
      caught = e;
    });
    expect(isWalletSdkError(caught, "user_rejected")).toBe(true);
    expect((caught as WalletSdkError).walletCode).toBe(4001);
    expect((caught as WalletSdkError).message).toBe("User rejected");
    expect(((caught as WalletSdkError).cause as Error).message).toBe("User rejected");
  });

  it("does not retry a rejection, but does retry one transport death", async () => {
    let attempts = 0;
    const rejecting = new XcpWallet(
      fakeProvider(() => {
        attempts++;
        throw walletError(4001, "User rejected");
      }).provider,
    );
    await expect(rejecting.signMessage("hi")).rejects.toMatchObject({ code: "user_rejected" });
    expect(attempts).toBe(1);

    let tries = 0;
    const flaky = new XcpWallet(
      fakeProvider(() => {
        tries++;
        if (tries === 1) throw walletError(4900, "Extension context invalidated");
        return { signature: "sig" };
      }).provider,
    );
    await expect(flaky.signMessage("hi")).resolves.toBe("sig");
    expect(tries).toBe(2);
  });

  it("times out as a timeout, not as a network error", async () => {
    vi.useFakeTimers();
    try {
      const never = new XcpWallet(fakeProvider(() => new Promise(() => {})).provider);
      const pending = never.getAccounts();
      const settled = pending.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_001);
      const error = await settled;
      expect(isWalletSdkError(error, "timeout")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getAddresses", () => {
  it("keeps a sound active entry and drops malformed optional siblings", async () => {
    const wallet = new XcpWallet(
      fakeProvider(() => ({
        active: { address: ADDR, publicKey: PUBKEY, type: "p2wpkh" },
        legacy: { address: "garbage", publicKey: PUBKEY },
        signing: {
          psbt: { supported: true, sighashTypes: [1], inputScope: "selected" },
          psbtBatch: { supported: true, sighashTypes: [1], inputScope: "all", maxRequests: 8 },
        },
      })).provider,
    );
    const addresses = await wallet.getAddresses();
    expect(addresses?.active.address).toBe(ADDR);
    expect(addresses?.legacy).toBeUndefined();
    expect(addresses?.signing?.psbtBatch.maxRequests).toBe(8);
  });

  it("answers null, never throws, when the wallet predates the method", async () => {
    const wallet = new XcpWallet(
      fakeProvider(() => Promise.reject(walletError(4200, "Unsupported"))).provider,
    );
    expect(await wallet.getAddresses()).toBeNull();
  });
});

describe("signing", () => {
  it("sends the positional PSBT form and the request form as the same wire call", async () => {
    const { provider, calls } = fakeProvider(({ method }) =>
      method === "xcp_getAddresses" ? null : { hex: "deadbeef" },
    );
    const wallet = new XcpWallet(provider);
    await wallet.signPsbt("aa", { [ADDR]: [0] }, [1]);
    await wallet.signPsbt({
      method: "xcp_signPsbt",
      params: [{ hex: "aa", signInputs: { [ADDR]: [0] }, sighashTypes: [1] }],
    });
    const sent = calls.filter((c) => c.method === "xcp_signPsbt");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.params).toEqual(sent[1]!.params);
  });

  it("refuses a bundle the wallet's reported capabilities cannot sign, before asking it", async () => {
    const { provider, calls } = fakeProvider(({ method }) =>
      method === "xcp_getAddresses"
        ? {
            active: { address: ADDR, publicKey: PUBKEY, type: "p2wpkh" },
            signing: {
              psbt: { supported: true, sighashTypes: [1], inputScope: "selected" },
              psbtBatch: { supported: true, sighashTypes: [1], inputScope: "all", maxRequests: 1 },
            },
          }
        : { hexes: [] },
    );
    const wallet = new XcpWallet(provider);
    const request = {
      method: "xcp_signPsbts" as const,
      params: [{ requests: [{ hex: "aa" }, { hex: "bb" }] }] as const,
    };
    let caught: unknown;
    await wallet.signPsbts(request).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(ProviderSigningCapabilityError);
    expect(isWalletSdkError(caught, "capability")).toBe(true);
    expect((caught as ProviderSigningCapabilityError).reason).toBe("batch_limit");
    expect(calls.some((c) => c.method === "xcp_signPsbts")).toBe(false);
  });

  it("signs a message as a sibling when one is named", async () => {
    const { provider, calls } = fakeProvider(() => "sig");
    await new XcpWallet(provider).signMessage("hello", ADDR);
    expect(calls[0]).toEqual({ method: "xcp_signMessage", params: ["hello", ADDR] });
  });

  it("checks the broadcast txid it hands back", async () => {
    const good = new XcpWallet(fakeProvider(() => ({ txid: TXID })).provider);
    expect(await good.broadcastTransaction("00")).toBe(TXID);
    const bad = new XcpWallet(fakeProvider(() => ({ txid: "nope" })).provider);
    await expect(bad.broadcastTransaction("00")).rejects.toMatchObject({ code: "invalid_response" });
  });
});

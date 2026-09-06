import { secp256k1 } from "@noble/curves/secp256k1";
import { base64, hex } from "@scure/base";
import { Address, OutScript, p2wpkh } from "@scure/btc-signer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import { legacyMessageHash } from "@/crypto/bip322";
import { parseProofMessage } from "@/provider/proof";
import type { XcpProvider } from "@/provider/types";
import { WalletSession } from "@/session";

const PRIV = new Uint8Array(32).fill(7);
const PUB = secp256k1.getPublicKey(PRIV, true);
const ADDR = Address().encode(OutScript.decode(p2wpkh(PUB).script));
const ORIGIN = "https://site.test";

/** BIP-137 with the compressed p2pkh header, the way Horizon signs every family. */
function signLikeHorizon(message: string): string {
  const sig = secp256k1.sign(legacyMessageHash(message), PRIV, { prehash: false, lowS: true });
  return base64.encode(new Uint8Array([31 + sig.recovery!, ...sig.toCompactRawBytes()]));
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** A wallet that grants without proving, like Horizon through its adapter. */
function provingNothing() {
  const signed: string[] = [];
  const provider: XcpProvider = {
    request: async ({ method, params }) => {
      switch (method) {
        case "xcp_requestAccounts":
          return { accounts: [ADDR], proof: null };
        case "xcp_accounts":
          return [ADDR];
        case "xcp_getAddresses":
          return { active: { address: ADDR, publicKey: hex.encode(PUB), type: "p2wpkh" } };
        case "xcp_signMessage": {
          const [message] = params as [string];
          signed.push(message);
          return signLikeHorizon(message);
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    on: () => {},
    removeListener: () => {},
  };
  return { provider, signed };
}

beforeEach(() => configureWalletSdk({ storage: memoryStorage() }));
afterEach(() => {
  configureWalletSdk({ storage: null });
  vi.restoreAllMocks();
});

describe("proofOnConnect", () => {
  it("asks the wallet to sign the connection proof, verifies it by the declared dialect, and keeps it", async () => {
    const wallet = provingNothing();
    const session = new WalletSession({
      provider: wallet.provider,
      origin: ORIGIN,
      proofOnConnect: true,
      messageVerification: { method: "BIP-137", format: "legacy_recoverable" },
    });
    session.start();
    await session.connect();
    const state = session.getState();
    expect(wallet.signed).toHaveLength(1);
    expect(parseProofMessage(wallet.signed[0]!)?.origin).toBe(ORIGIN);
    expect(state.proofStatus).toBe("verified");
    expect(state.connectionProof).toMatchObject({
      address: ADDR,
      verification: { method: "BIP-137", format: "legacy_recoverable" },
    });
    session.stop();
  });

  it("does nothing without the option, and connects unverified when the prompt is declined", async () => {
    const quiet = provingNothing();
    const session = new WalletSession({ provider: quiet.provider, origin: ORIGIN });
    session.start();
    await session.connect();
    expect(quiet.signed).toHaveLength(0);
    expect(session.getState()).toMatchObject({ readyState: "connected", connectionProof: null });
    session.stop();

    const declining = provingNothing();
    const original = declining.provider.request;
    declining.provider.request = async (args) => {
      if (args.method === "xcp_signMessage") throw Object.assign(new Error("User rejected"), { code: 4001 });
      return original(args);
    };
    const asked = new WalletSession({ provider: declining.provider, origin: ORIGIN, proofOnConnect: true });
    asked.start();
    await asked.connect();
    expect(asked.getState()).toMatchObject({
      readyState: "connected",
      address: ADDR,
      connectionProof: null,
      proofStatus: "unverified",
    });
    asked.stop();
  });
});

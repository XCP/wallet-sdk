import { secp256k1 } from "@noble/curves/secp256k1";
import { hex } from "@scure/base";
import { Address, OutScript, p2wpkh, Transaction } from "@scure/btc-signer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import { WalletSdkError } from "@/errors";
import { type ComposeSigner, composeAndBroadcast } from "@/transaction/compose";

/**
 * The PSBT path: a signer that cannot sign raw transactions (Horizon) gets the
 * PSBT Core returns alongside the raw hex, and the pipeline finalizes and
 * extracts what comes back.
 */

const PRIV = new Uint8Array(32).fill(9);
const PUB = secp256k1.getPublicKey(PRIV, true);
const SPK = p2wpkh(PUB).script;
const ADDR = Address().encode(OutScript.decode(SPK));
const TXID = "b".repeat(64);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** One p2wpkh input, one output, as Core would return it: raw hex plus an unsigned PSBT. */
function unsignedPair() {
  const tx = new Transaction();
  tx.addInput({
    txid: hex.decode("cc".repeat(32)),
    index: 0,
    witnessUtxo: { script: SPK, amount: 10_000n },
  });
  tx.addOutputAddress(ADDR, 9_000n);
  return { raw: hex.encode(tx.unsignedTx), psbt: hex.encode(tx.toPSBT()) };
}

/** What a wallet hands back: the same PSBT with a signature and final witness. */
function signedBy(psbtHex: string): string {
  const tx = Transaction.fromPSBT(hex.decode(psbtHex));
  tx.sign(PRIV);
  tx.finalize();
  return hex.encode(tx.toPSBT());
}

beforeEach(() => configureWalletSdk({ storage: memoryStorage() }));
afterEach(() => {
  vi.unstubAllGlobals();
  configureWalletSdk({ storage: null });
});

describe("compose PSBT path", () => {
  it("falls back to signPsbt when raw signing is unsupported, then finalizes and extracts", async () => {
    const { raw, psbt } = unsignedPair();
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ result: { rawtransaction: raw, psbt } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    );

    const psbtCalls: unknown[][] = [];
    const broadcast: string[] = [];
    const signer: ComposeSigner = {
      address: ADDR,
      publicKey: hex.encode(PUB),
      connectionProof: null,
      signTransaction: async () => {
        throw new WalletSdkError("unsupported_method", "no raw signing");
      },
      signPsbt: async (p, signInputs, sighashTypes) => {
        psbtCalls.push([signInputs, sighashTypes]);
        return signedBy(p);
      },
      broadcastTransaction: async (h) => {
        broadcast.push(h);
        return TXID;
      },
    };

    const receipt = await composeAndBroadcast(signer, "send", { asset: "XCP" }, { feeRate: 1 });
    expect(receipt.txid).toBe(TXID);
    expect(psbtCalls).toEqual([[{ [ADDR]: [0] }, [1]]]);
    // What went out is a fully signed raw transaction spending the composed input.
    const sent = Transaction.fromRaw(hex.decode(broadcast[0]!), { allowUnknownInputs: true });
    expect(sent.inputsLength).toBe(1);
    expect(hex.encode(sent.getInput(0).txid!)).toBe("cc".repeat(32));
    expect(sent.getInput(0).finalScriptWitness?.length).toBe(2);
  });

  it("fails clearly when the signer has no PSBT path either", async () => {
    const { raw, psbt } = unsignedPair();
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ result: { rawtransaction: raw, psbt } }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    const signer: ComposeSigner = {
      address: ADDR,
      publicKey: null,
      connectionProof: null,
      signTransaction: async () => {
        throw new WalletSdkError("unsupported_method", "no raw signing");
      },
      broadcastTransaction: async () => TXID,
    };
    await expect(composeAndBroadcast(signer, "send", {}, { feeRate: 1 })).rejects.toMatchObject({
      code: "unsupported_method",
    });
  });
});

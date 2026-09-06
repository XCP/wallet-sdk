import { secp256k1 } from "@noble/curves/secp256k1";
import { base64, hex } from "@scure/base";
import { Address, OutScript, p2wpkh, Transaction } from "@scure/btc-signer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import { WalletSdkError } from "@/errors";
import { type ComposeSigner, composeAndBroadcast } from "@/transaction/compose";

/**
 * The PSBT path, as Core actually serves it: `psbt` is base64 from bitcoind's
 * converttopsbt and carries no prevout data. The pipeline fills each input from
 * the node's copy of the parent transaction, hands the wallet hex, and finalizes
 * and extracts what comes back.
 */

const PRIV = new Uint8Array(32).fill(9);
const PUB = secp256k1.getPublicKey(PRIV, true);
const SPK = p2wpkh(PUB).script;
const ADDR = Address().encode(OutScript.decode(SPK));
const PARENT_TXID = "cc".repeat(32);
const PARENT_HEX = "02000000000101" + "00".repeat(40); // opaque; only segwit inputs need the outputs
const TXID = "b".repeat(64);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** What Core returns: raw hex plus a base64 PSBT with no witnessUtxo on its input. */
function coreCompose() {
  const tx = new Transaction({ allowUnknownInputs: true });
  tx.addInput({ txid: hex.decode(PARENT_TXID), index: 0 });
  tx.addOutputAddress(ADDR, 9_000n);
  return { rawtransaction: hex.encode(tx.unsignedTx), psbt: base64.encode(tx.toPSBT()) };
}

/** A wallet that signs whatever it is given, if the prevout was filled in. */
function walletSign(psbtHex: string): string {
  const tx = Transaction.fromPSBT(hex.decode(psbtHex));
  expect(tx.getInput(0).witnessUtxo?.amount).toBe(10_000n);
  tx.sign(PRIV);
  tx.finalize();
  return hex.encode(tx.toPSBT());
}

function stubNode(compose: { rawtransaction: string; psbt: string }) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/bitcoin/transactions/")) {
      return new Response(
        JSON.stringify({
          result: {
            txid: PARENT_TXID,
            hex: PARENT_HEX,
            vout: [{ value: 0.0001, n: 0, scriptPubKey: { hex: hex.encode(SPK) } }],
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ result: compose }), { status: 200 });
  }) as unknown as typeof fetch);
  return urls;
}

beforeEach(() => configureWalletSdk({ storage: memoryStorage() }));
afterEach(() => {
  vi.unstubAllGlobals();
  configureWalletSdk({ storage: null });
});

describe("compose PSBT path", () => {
  it("decodes Core's base64, fills prevouts from the node, signs, finalizes and broadcasts", async () => {
    const urls = stubNode(coreCompose());
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
        return walletSign(p);
      },
      broadcastTransaction: async (h) => {
        broadcast.push(h);
        return TXID;
      },
    };

    const receipt = await composeAndBroadcast(signer, "send", { asset: "XCP" }, { feeRate: 1 });
    expect(receipt.txid).toBe(TXID);
    expect(psbtCalls).toEqual([[{ [ADDR]: [0] }, [1]]]);
    expect(urls.some((u) => u.endsWith(`/v2/bitcoin/transactions/${PARENT_TXID}`))).toBe(true);
    const sent = Transaction.fromRaw(hex.decode(broadcast[0]!), { allowUnknownInputs: true });
    expect(hex.encode(sent.getInput(0).txid!)).toBe(PARENT_TXID);
    expect(sent.getInput(0).finalScriptWitness?.length).toBe(2);
  });

  it("fails clearly when the signer has no PSBT path either", async () => {
    stubNode(coreCompose());
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

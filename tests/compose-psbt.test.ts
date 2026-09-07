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
const parent = new Transaction({ allowUnknownInputs: true });
parent.addOutputAddress(ADDR, 10_000n);
parent.addInput({ txid: hex.decode("cc".repeat(32)), index: 0, finalScriptSig: hex.decode("51") });
const PARENT_TXID = parent.id;
const PARENT_HEX = parent.hex;
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

function stubNode(compose: { rawtransaction: string; psbt: string }, parentHex = PARENT_HEX) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/bitcoin/transactions/")) {
      return new Response(
        JSON.stringify({
          result: {
            txid: PARENT_TXID,
            hex: parentHex,
            // Deliberately wrong: exact witness amounts come from bytes.
            vout: [{ value: 0.00010001, n: 0, scriptPubKey: { hex: hex.encode(SPK) } }],
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

  it("rejects a node PSBT that differs from its raw transaction before signing", async () => {
    const original = coreCompose();
    const changed = Transaction.fromPSBT(base64.decode(original.psbt));
    changed.updateOutput(0, { amount: 8_000n });
    stubNode({ ...original, psbt: base64.encode(changed.toPSBT()) });
    const signTransaction = vi.fn();
    const broadcastTransaction = vi.fn();
    await expect(
      composeAndBroadcast(
        { address: ADDR, publicKey: null, connectionProof: null, signTransaction, broadcastTransaction },
        "send",
        {},
        { feeRate: 0.1 },
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(signTransaction).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it("rejects parent bytes with the wrong transaction hash before PSBT signing", async () => {
    const other = new Transaction({ allowUnknownInputs: true });
    other.addInput({ txid: hex.decode("dd".repeat(32)), index: 0 });
    other.addOutputAddress(ADDR, 10_000n);
    stubNode(coreCompose(), other.hex);
    const signPsbt = vi.fn();
    const broadcastTransaction = vi.fn();
    await expect(
      composeAndBroadcast(
        {
          address: ADDR,
          publicKey: null,
          connectionProof: null,
          signTransaction: async () => {
            throw new WalletSdkError("unsupported_method", "PSBT only");
          },
          signPsbt,
          broadcastTransaction,
        },
        "send",
        {},
        { feeRate: 0.1 },
      ),
    ).rejects.toThrow("Parent transaction hash");
    expect(signPsbt).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it("rejects a supplied PSBT prevout whose amount disagrees with parent bytes", async () => {
    const original = coreCompose();
    const changed = Transaction.fromPSBT(base64.decode(original.psbt));
    changed.updateInput(0, { witnessUtxo: { script: SPK, amount: 10_001n } });
    stubNode({ ...original, psbt: base64.encode(changed.toPSBT()) });
    const signPsbt = vi.fn();
    const broadcastTransaction = vi.fn();
    await expect(
      composeAndBroadcast(
        {
          address: ADDR,
          publicKey: null,
          connectionProof: null,
          signTransaction: async () => {
            throw new WalletSdkError("unsupported_method", "PSBT only");
          },
          signPsbt,
          broadcastTransaction,
        },
        "send",
        {},
        { feeRate: 0.1 },
      ),
    ).rejects.toThrow("prevout disagrees");
    expect(signPsbt).not.toHaveBeenCalled();
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });

  it("rechecks the account after resolving PSBT prevouts", async () => {
    stubNode(coreCompose());
    const signer: ComposeSigner = {
      address: ADDR,
      publicKey: null,
      connectionProof: null,
      signTransaction: async () => {
        signer.address = "1CounterpartyXXXXXXXXXXXXXXXUWLpVr";
        throw new WalletSdkError("unsupported_method", "PSBT only");
      },
      signPsbt: vi.fn(),
      broadcastTransaction: vi.fn(),
    };
    await expect(composeAndBroadcast(signer, "send", {}, { feeRate: 0.1 })).rejects.toThrow(
      "address changed",
    );
    expect(signer.signPsbt).not.toHaveBeenCalled();
    expect(signer.broadcastTransaction).not.toHaveBeenCalled();
  });

  it("rejects a provider's validly signed PSBT for a different amount before broadcast", async () => {
    stubNode(coreCompose());
    const broadcastTransaction = vi.fn();
    await expect(
      composeAndBroadcast(
        {
          address: ADDR,
          publicKey: null,
          connectionProof: null,
          signTransaction: async () => {
            throw new WalletSdkError("unsupported_method", "PSBT only");
          },
          signPsbt: async (encoded) => {
            const changed = Transaction.fromPSBT(hex.decode(encoded));
            changed.updateOutput(0, { amount: 8_000n });
            return walletSign(hex.encode(changed.toPSBT()));
          },
          broadcastTransaction,
        },
        "send",
        {},
        { feeRate: 0.1 },
      ),
    ).rejects.toThrow("amounts changed");
    expect(broadcastTransaction).not.toHaveBeenCalled();
  });
});

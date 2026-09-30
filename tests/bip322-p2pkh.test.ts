import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { base64, hex } from "@scure/base";
import { Address, OutScript, p2pkh, p2wpkh, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { legacyMessageHash, pubkeyFromBip322, verifyBip322 } from "@/crypto/bip322";
import { verifyDeclaredConnectionSignature } from "@/provider/proof";
import type { ConnectionProof } from "@/provider/types";
import { sourcePublicKey } from "@/transaction/compose";

/**
 * P2PKH message signatures in both forms: the classic 65-byte BIP-137
 * signature XCP Wallet 0.14 moves legacy addresses to, and the two-item
 * BIP-322 stack older wallets keep sending. The stack is built here through
 * btc-signer's own legacy sighash, independent of the SDK's hand-rolled one.
 */

// bitcore-message's reference vector (compressed, header 31).
const VECTOR = {
  address: "1F3sAm6ZtwLAUnj7d38pGFxtP3RVEvtsbV",
  message: "This is an example of a signed message.",
  signature: "H9L5yLFjti0QTHhPyFrZCT1V/MMnBtXKmoiKDZ78NDBjERki6ZTQZdSMCtkgoNmp17By9ItJr8o7ChX0XxY91nk=",
};

const PRIV = new Uint8Array(32).fill(9);
const MESSAGE = "xcp-wallet\norigin:https://example.test\nnonce:abc\nissued:1";

const addressOf = (pubkey: Uint8Array) => Address().encode(OutScript.decode(p2pkh(pubkey).script));
const pubkeyOf = (compressed: boolean) => secp256k1.getPublicKey(PRIV, compressed);

function classic(message: string, compressed: boolean, headerBase = compressed ? 31 : 27): string {
  const sig = secp256k1.sign(legacyMessageHash(message), PRIV, { prehash: false, lowS: true });
  const out = new Uint8Array(65);
  out[0] = headerBase + sig.recovery;
  out.set(sig.toCompactRawBytes(), 1);
  return base64.encode(out);
}

function stack(message: string, compressed: boolean): string {
  const pubkey = pubkeyOf(compressed);
  const script = p2pkh(pubkey).script;
  const opts = { version: 0, lockTime: 0, allowUnknownInputs: true, allowUnknownOutputs: true };
  const tag = sha256(new TextEncoder().encode("BIP0322-signed-message"));
  const messageHash = sha256(new Uint8Array([...tag, ...tag, ...new TextEncoder().encode(message)]));
  const toSpend = new Transaction(opts);
  toSpend.addInput({ txid: new Uint8Array(32), index: 0xffffffff, sequence: 0 });
  toSpend.addOutput({ script, amount: 0n });
  toSpend.updateInput(0, { finalScriptSig: new Uint8Array([0x00, 0x20, ...messageHash]) }, true);
  const toSign = new Transaction(opts);
  toSign.addInput({ txid: toSpend.id, index: 0, sequence: 0 });
  toSign.addOutput({ script: Uint8Array.of(0x6a), amount: 0n });
  const digest = (
    toSign as unknown as { preimageLegacy(idx: number, script: Uint8Array, hashType: number): Uint8Array }
  ).preimageLegacy(0, script, 0x01);
  const der = secp256k1.sign(digest, PRIV, { prehash: false, lowS: true }).toDERRawBytes();
  const sig = new Uint8Array([...der, 0x01]);
  return base64.encode(new Uint8Array([2, sig.length, ...sig, pubkey.length, ...pubkey]));
}

describe("verifyBip322 on a P2PKH address", () => {
  it("verifies the classic reference vector and recovers its compressed key", () => {
    expect(verifyBip322(VECTOR.address, VECTOR.message, VECTOR.signature)).toBe(true);
    const key = pubkeyFromBip322(VECTOR.address, VECTOR.signature, VECTOR.message);
    expect(key).toHaveLength(66);
    expect(addressOf(hex.decode(key!))).toBe(VECTOR.address);
    expect(verifyBip322(VECTOR.address, `${VECTOR.message}!`, VECTOR.signature)).toBe(false);
  });

  it.each([true, false])("verifies a classic signature (compressed: %s) and recovers that encoding", (c) => {
    const address = addressOf(pubkeyOf(c));
    const signature = classic(MESSAGE, c);
    expect(verifyBip322(address, MESSAGE, signature)).toBe(true);
    expect(pubkeyFromBip322(address, signature, MESSAGE)).toBe(hex.encode(pubkeyOf(c)));
  });

  it("fails when the header's compression flag names the other encoding", () => {
    const bytes = base64.decode(VECTOR.signature);
    bytes[0] = bytes[0]! - 4;
    const flipped = base64.encode(bytes);
    expect(verifyBip322(VECTOR.address, VECTOR.message, flipped)).toBe(false);
    expect(pubkeyFromBip322(VECTOR.address, flipped, VECTOR.message)).toBeNull();

    expect(verifyBip322(addressOf(pubkeyOf(false)), MESSAGE, classic(MESSAGE, true))).toBe(false);
    expect(verifyBip322(addressOf(pubkeyOf(true)), MESSAGE, classic(MESSAGE, false))).toBe(false);
  });

  it.each([35, 39])("refuses a SegWit header (%i range) on a P2PKH address", (base) => {
    const address = addressOf(pubkeyOf(true));
    const signature = classic(MESSAGE, true, base);
    expect(verifyBip322(address, MESSAGE, signature)).toBe(false);
    expect(pubkeyFromBip322(address, signature, MESSAGE)).toBeNull();
  });

  it("verifies the signed bytes exactly: a CRLF message only against the CRLF text", () => {
    const crlf = "line one\r\nline two";
    const address = addressOf(pubkeyOf(true));
    const signature = classic(crlf, true);
    expect(verifyBip322(address, crlf, signature)).toBe(true);
    expect(verifyBip322(address, "line one\nline two", signature)).toBe(false);
  });

  it.each([true, false])("still verifies the two-item legacy stack (compressed: %s)", (c) => {
    const address = addressOf(pubkeyOf(c));
    const signature = stack(MESSAGE, c);
    expect(verifyBip322(address, MESSAGE, signature)).toBe(true);
    expect(verifyBip322(address, `${MESSAGE}!`, signature)).toBe(false);
    expect(pubkeyFromBip322(address, signature)).toBe(hex.encode(pubkeyOf(c)));
  });

  it("recovers nothing from a classic signature without the message, or for another address", () => {
    const signature = classic(MESSAGE, true);
    expect(pubkeyFromBip322(addressOf(pubkeyOf(true)), signature)).toBeNull();
    expect(pubkeyFromBip322(VECTOR.address, signature, MESSAGE)).toBeNull();
    expect(verifyBip322(VECTOR.address, MESSAGE, signature)).toBe(false);
  });

  it("leaves SegWit addresses on BIP-322 simple: a classic signature is not accepted there", () => {
    const wpkh = Address().encode(OutScript.decode(p2wpkh(pubkeyOf(true)).script));
    expect(verifyBip322(wpkh, MESSAGE, classic(MESSAGE, true, 39))).toBe(false);
  });
});

describe("P2PKH proofs whatever the label", () => {
  const address = addressOf(pubkeyOf(true));
  const labels: (ConnectionProof["verification"] | undefined)[] = [
    undefined,
    { method: "BIP-322", format: "p2pkh" },
    { method: "BIP-137", format: "legacy_recoverable" },
  ];

  it.each(labels)("accepts both forms under %o", (verification) => {
    for (const signature of [classic(MESSAGE, true), stack(MESSAGE, true)]) {
      const proof = { address, message: MESSAGE, signature, ...(verification ? { verification } : {}) };
      expect(verifyDeclaredConnectionSignature(proof, MESSAGE, signature, address)).toBe(true);
      expect(verifyDeclaredConnectionSignature(proof, `${MESSAGE}!`, signature, address)).toBe(false);
    }
  });

  it("refuses a SegWit header on a P2PKH proof declared BIP-137", () => {
    const signature = classic(MESSAGE, true, 39);
    const proof: ConnectionProof = {
      address,
      message: MESSAGE,
      signature,
      verification: { method: "BIP-137", format: "legacy_recoverable" },
    };
    expect(verifyDeclaredConnectionSignature(proof, MESSAGE, signature, address)).toBe(false);
  });

  it("gives compose the recovered key from a classic connection proof", () => {
    const legacy = addressOf(pubkeyOf(false));
    const key = sourcePublicKey({
      address: legacy,
      publicKey: null,
      connectionProof: { address: legacy, message: MESSAGE, signature: classic(MESSAGE, false) },
      signTransaction: async (h) => h,
      broadcastTransaction: async () => "",
    });
    expect(key).toBe(hex.encode(pubkeyOf(false)));
  });
});

import { secp256k1 } from "@noble/curves/secp256k1";
import { base64 } from "@scure/base";
import { Address, p2tr, p2wpkh, TEST_NETWORK } from "@scure/btc-signer";
import { afterEach, describe, expect, it } from "vitest";
import { configureWalletSdk } from "@/config";
import {
  legacyMessageHash,
  verifyBip86RecoverableMessage,
  verifyLegacyRecoverableMessage,
} from "@/crypto/bip322";
import { verifyDeclaredConnectionSignature } from "@/provider/proof";
import type { ConnectionProof } from "@/provider/types";

const key = new Uint8Array(32).fill(7);
const pub = secp256k1.getPublicKey(key, true);
const message = "Exact BIP-86 ownership proof";
const sig = secp256k1.sign(legacyMessageHash(message), key, { prehash: false });
const signature = base64.encode(new Uint8Array([31 + sig.recovery, ...sig.toCompactRawBytes()]));
const address = p2tr(pub.subarray(1)).address!;
const proof: ConnectionProof = {
  address,
  message,
  signature,
  verification: { method: "ECDSA-BIP86", format: "legacy_recoverable" },
};
afterEach(() => configureWalletSdk({ network: "mainnet" }));

describe("explicit BIP-86 recoverable messages", () => {
  it("requires the declared dialect, exact address, message and signature", () => {
    expect(verifyDeclaredConnectionSignature(proof, message, signature, address)).toBe(true);
    expect(verifyBip86RecoverableMessage("other", signature, address).valid).toBe(false);
    expect(
      verifyBip86RecoverableMessage(
        message,
        signature,
        p2tr(secp256k1.getPublicKey(new Uint8Array(32).fill(8)).subarray(1)).address!,
      ).valid,
    ).toBe(false);
    expect(verifyBip86RecoverableMessage(message, signature, p2wpkh(pub).address!).valid).toBe(false);
    expect(verifyLegacyRecoverableMessage(message, signature, address).valid).toBe(false);
    for (const verification of [
      undefined,
      { method: "BIP-137", format: "legacy_recoverable" },
      { method: "BIP-322", format: "p2tr" },
    ] as const) {
      expect(verifyDeclaredConnectionSignature({ ...proof, verification }, message, signature, address)).toBe(
        false,
      );
    }
    expect(
      verifyDeclaredConnectionSignature(
        {
          ...proof,
          verification: { method: "ECDSA-BIP86", format: "unknown" },
        } as unknown as ConnectionProof,
        message,
        signature,
        address,
      ),
    ).toBe(false);
    const changed = base64.decode(signature);
    changed[20] ^= 1;
    expect(verifyBip86RecoverableMessage(message, base64.encode(changed), address).valid).toBe(false);
  });

  it("does not accept an untweaked output or a script-tree address for the same key", () => {
    expect(
      verifyBip86RecoverableMessage(
        message,
        signature,
        Address().encode({ type: "tr", pubkey: pub.subarray(1) }),
      ).valid,
    ).toBe(false);
    expect(
      verifyBip86RecoverableMessage(
        message,
        signature,
        p2tr(pub.subarray(1), { script: new Uint8Array([0x51]) }, undefined, true).address!,
      ).valid,
    ).toBe(false);
  });

  it("enforces network and compressed legacy headers", () => {
    const testnetAddress = p2tr(pub.subarray(1), undefined, TEST_NETWORK).address!;
    expect(verifyBip86RecoverableMessage(message, signature, testnetAddress).valid).toBe(false);
    configureWalletSdk({ network: "testnet" });
    expect(verifyBip86RecoverableMessage(message, signature, testnetAddress).valid).toBe(true);
    expect(verifyBip86RecoverableMessage(message, signature, address).valid).toBe(false);
    for (const header of [0, 27, 30, 35, 39, 255]) {
      const bytes = base64.decode(signature);
      bytes[0] = header;
      expect(verifyBip86RecoverableMessage(message, base64.encode(bytes), testnetAddress).valid).toBe(false);
    }
    expect(verifyBip86RecoverableMessage(message, "%%%", testnetAddress).valid).toBe(false);
  });
});

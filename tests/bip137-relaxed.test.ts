import { secp256k1 } from "@noble/curves/secp256k1";
import { base64 } from "@scure/base";
import { Address, OutScript, p2wpkh } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { legacyMessageHash, verifyLegacyRecoverableMessage } from "@/crypto/bip322";

/** Horizon signs a SegWit address's message with the p2pkh header (31..34). */

const PRIV = new Uint8Array(32).fill(11);
const PUB = secp256k1.getPublicKey(PRIV, true);
const WPKH_ADDR = Address().encode(OutScript.decode(p2wpkh(PUB).script));
const MESSAGE = "xcp-wallet\norigin:https://xcp.fun\nnonce:n\nissued:1";

function signWithP2pkhHeader(message: string): string {
  const sig = secp256k1.sign(legacyMessageHash(message), PRIV, { prehash: false, lowS: true });
  const out = new Uint8Array(65);
  out[0] = 31 + sig.recovery;
  out.set(sig.toCompactRawBytes(), 1);
  return base64.encode(out);
}

describe("BIP-137 header family", () => {
  it("accepts a p2pkh-header signature for a wpkh address by default", () => {
    expect(verifyLegacyRecoverableMessage(MESSAGE, signWithP2pkhHeader(MESSAGE), WPKH_ADDR)).toEqual({
      valid: true,
    });
  });

  it("refuses it under strictHeader", () => {
    const verdict = verifyLegacyRecoverableMessage(MESSAGE, signWithP2pkhHeader(MESSAGE), WPKH_ADDR, {
      strictHeader: true,
    });
    expect(verdict.valid).toBe(false);
  });

  it("still ties the recovered key to the exact address", () => {
    const other = Address().encode(
      OutScript.decode(p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(12), true)).script),
    );
    expect(verifyLegacyRecoverableMessage(MESSAGE, signWithP2pkhHeader(MESSAGE), other).valid).toBe(false);
  });
});

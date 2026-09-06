import { secp256k1 } from "@noble/curves/secp256k1";
import { base64 } from "@scure/base";
import { Address, OutScript, p2pkh, p2sh, p2wpkh } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { legacyMessageHash, verifyLegacyRecoverableMessage } from "@/crypto/bip322";
import { verifyDeclaredConnectionSignature } from "@/provider/proof";

/**
 * BIP-137 recoverable signatures, built here from a known key rather than
 * captured from a device: the construction is fully specified (header byte
 * = 27 + recovery id + 4 per address family, then the compact signature over
 * the Bitcoin Signed Message digest), so a self-made vector exercises the
 * same code paths a Trezor's would, and the negative cases are what matter.
 */

const PRIV = new Uint8Array(32).fill(7);
const PUB = secp256k1.getPublicKey(PRIV, true);
const MESSAGE = "xcp-wallet\norigin:https://example.test\nnonce:abc\nissued:1";

type Family = "pkh" | "sh-wpkh" | "wpkh";
const HEADER_BASE: Record<Family, number> = { pkh: 31, "sh-wpkh": 35, wpkh: 39 };

function addressFor(family: Family): string {
  const script =
    family === "pkh"
      ? p2pkh(PUB).script
      : family === "sh-wpkh"
        ? p2sh(p2wpkh(PUB)).script
        : p2wpkh(PUB).script;
  return Address().encode(OutScript.decode(script));
}

function sign(message: string, family: Family): string {
  const digest = legacyMessageHash(message);
  const sig = secp256k1.sign(digest, PRIV, { prehash: false, lowS: true });
  // noble hands back r, s and the recovery id; BIP-137 wants [header, r, s].
  const out = new Uint8Array(65);
  out[0] = HEADER_BASE[family] + sig.recovery;
  out.set(sig.toCompactRawBytes(), 1);
  return base64.encode(out);
}

describe("verifyLegacyRecoverableMessage", () => {
  it.each<Family>(["pkh", "sh-wpkh", "wpkh"])("verifies a %s signature against its own address", (family) => {
    const verdict = verifyLegacyRecoverableMessage(MESSAGE, sign(MESSAGE, family), addressFor(family));
    expect(verdict).toEqual({ valid: true });
  });

  it("rejects a header that names a different address family than the address", () => {
    const verdict = verifyLegacyRecoverableMessage(MESSAGE, sign(MESSAGE, "pkh"), addressFor("wpkh"));
    expect(verdict.valid).toBe(false);
  });

  it("rejects a signature over a different message", () => {
    const verdict = verifyLegacyRecoverableMessage("other", sign(MESSAGE, "wpkh"), addressFor("wpkh"));
    expect(verdict.valid).toBe(false);
  });

  it("rejects the wrong length and non-base64 outright", () => {
    expect(
      verifyLegacyRecoverableMessage(MESSAGE, base64.encode(new Uint8Array(64)), addressFor("wpkh")).valid,
    ).toBe(false);
    expect(verifyLegacyRecoverableMessage(MESSAGE, "%%%", addressFor("wpkh")).valid).toBe(false);
  });
});

describe("verifyDeclaredConnectionSignature", () => {
  it("verifies a BIP-137 proof only when it is declared as one", () => {
    const address = addressFor("wpkh");
    const signature = sign(MESSAGE, "wpkh");
    const declared = {
      address,
      message: MESSAGE,
      signature,
      verification: { method: "BIP-137" as const, format: "legacy_recoverable" as const },
    };
    expect(verifyDeclaredConnectionSignature(declared, MESSAGE, signature, address)).toBe(true);

    // The same bytes, undeclared, are treated as BIP-322 and must fail there —
    // a dialect is never a fallback for another.
    const undeclared = { address, message: MESSAGE, signature };
    let verdict: boolean;
    try {
      verdict = verifyDeclaredConnectionSignature(undeclared, MESSAGE, signature, address);
    } catch {
      verdict = false;
    }
    expect(verdict).toBe(false);
  });
});

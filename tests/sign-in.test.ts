import { secp256k1 } from "@noble/curves/secp256k1";
import { base64 } from "@scure/base";
import { Address, OutScript, p2pkh } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { legacyMessageHash } from "@/crypto/bip322";
import { createProofMessage, validateProof } from "@/provider/proof";
import { createSignInMessage, randomNonce, signIn, verifySignIn } from "@/provider/sign-in";

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ORIGIN = "https://xcp.fun";

describe("sign-in", () => {
  it("builds the challenge outside the wallet's reserved connection-proof namespace", () => {
    const message = createSignInMessage({ origin: ORIGIN, nonce: "n1", issued: 42 });
    expect(message).toBe("xcp-sign-in\norigin:https://xcp.fun\nnonce:n1\nissued:42");
    // XCP Wallet refuses xcp_signMessage for anything starting with this.
    expect(message.startsWith("xcp-wallet\n")).toBe(false);
    expect(randomNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(randomNonce()).not.toBe(randomNonce());
  });

  it("signs a fresh challenge as the session identity", async () => {
    const seen: string[] = [];
    const proof = await signIn(
      {
        address: ADDR,
        signMessage: async (m) => {
          seen.push(m);
          return "sig";
        },
      },
      ORIGIN,
      "nonce",
    );
    expect(proof.address).toBe(ADDR);
    expect(proof.signature).toBe("sig");
    expect(seen[0]).toMatch(/^xcp-sign-in\norigin:https:\/\/xcp\.fun\nnonce:nonce\nissued:\d+$/);
    expect(seen[0]!.startsWith("xcp-wallet\n")).toBe(false);
  });

  it("refuses to sign without a connected address", async () => {
    await expect(signIn({ address: null, signMessage: async () => "" }, ORIGIN)).rejects.toMatchObject({
      code: "wallet_missing",
    });
  });

  it("checks structure, origin, address and age before the signature", async () => {
    const message = createSignInMessage({
      origin: ORIGIN,
      nonce: "n",
      issued: Math.floor(Date.now() / 1000),
    });
    const proof = { address: ADDR, message, signature: "not-a-signature" };
    expect((await verifySignIn(proof, "https://other", ADDR)).reason).toMatch(/Origin mismatch/);
    expect((await verifySignIn(proof, ORIGIN, "1other")).reason).toMatch(/address/);
    const stale = { ...proof, message: createSignInMessage({ origin: ORIGIN, nonce: "n", issued: 1 }) };
    expect((await verifySignIn(stale, ORIGIN, ADDR)).reason).toMatch(/expired/);
    // Structure passes; the garbage signature is what fails.
    expect((await verifySignIn(proof, ORIGIN, ADDR)).reason).toMatch(/Signature/);
  });

  it("lets the host reject a nonce it has seen", async () => {
    const message = createSignInMessage({
      origin: ORIGIN,
      nonce: "used",
      issued: Math.floor(Date.now() / 1000),
    });
    const proof = { address: ADDR, message, signature: "x" };
    // The signature check runs first and fails here; the nonce hook is reached only after a valid signature.
    const result = await verifySignIn(proof, ORIGIN, ADDR, { nonceSeen: () => true });
    expect(result.valid).toBe(false);
  });

  it("verifies a real sign-in and a connection proof, and never takes a sign-in as a connection proof", async () => {
    const priv = new Uint8Array(32).fill(5);
    const address = Address().encode(OutScript.decode(p2pkh(secp256k1.getPublicKey(priv, true)).script));
    const sign = (message: string) => {
      const sig = secp256k1.sign(legacyMessageHash(message), priv, { prehash: false, lowS: true });
      return base64.encode(new Uint8Array([31 + sig.recovery, ...sig.toCompactRawBytes()]));
    };
    const issued = Math.floor(Date.now() / 1000);
    const signInProof = await signIn({ address, signMessage: async (m) => sign(m) }, ORIGIN, "n");
    expect(await verifySignIn(signInProof, ORIGIN, address)).toEqual({ valid: true });

    const message = createProofMessage({ origin: ORIGIN, nonce: "n", issued });
    const connectionProof = { address, message, signature: sign(message) };
    expect(await verifySignIn(connectionProof, ORIGIN, address)).toEqual({ valid: true });

    expect((await validateProof(signInProof, ORIGIN, address)).reason).toMatch(/format/);
    expect((await validateProof(connectionProof, ORIGIN, address)).valid).toBe(true);
  });
});

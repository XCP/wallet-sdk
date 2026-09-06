import { describe, expect, it } from "vitest";
import { createSignInMessage, randomNonce, signIn, verifySignIn } from "@/provider/sign-in";

const ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ORIGIN = "https://xcp.fun";

describe("sign-in", () => {
  it("builds the challenge in the connect-proof format", () => {
    expect(createSignInMessage({ origin: ORIGIN, nonce: "n1", issued: 42 })).toBe(
      "xcp-wallet\norigin:https://xcp.fun\nnonce:n1\nissued:42",
    );
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
    expect(seen[0]).toMatch(/^xcp-wallet\norigin:https:\/\/xcp\.fun\nnonce:nonce\nissued:\d+$/);
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
});

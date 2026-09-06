import { describe, expect, it } from "vitest";
import { connectionProofForIdentity, walletAddressAccess } from "../src/address-access";
import type { ConnectResult, WalletAddresses } from "../src/provider/types";

const LEGACY = "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2";
const SEGWIT = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

const paired: WalletAddresses = {
  active: { address: LEGACY, publicKey: "02ab", type: "p2pkh" },
  legacy: { address: LEGACY, publicKey: "02ab", type: "p2pkh" },
  segwit: { address: SEGWIT, publicKey: "02ab", type: "p2wpkh" },
};

describe("walletAddressAccess", () => {
  it("is single when nothing was paired", () => {
    expect(walletAddressAccess(LEGACY, null)).toEqual({
      kind: "single",
      identity: LEGACY,
      legacySource: null,
      pairedSegwitAddress: null,
    });
    expect(walletAddressAccess(LEGACY, { active: paired.active }).kind).toBe("single");
  });

  it("keeps the active account as identity when the site accepts it", () => {
    const access = walletAddressAccess(LEGACY, paired);
    expect(access.kind).toBe("paired");
    expect(access.identity).toBe(LEGACY);
    // The identity IS the legacy address, so it is not also an asset source.
    expect(access.legacySource).toBeNull();
    expect(access.pairedSegwitAddress).toBe(SEGWIT);
  });

  it("promotes the SegWit sibling when the site cannot sign as Legacy", () => {
    const segwitOnly = (address: string) => address.startsWith("bc1");
    const access = walletAddressAccess(LEGACY, paired, segwitOnly);
    expect(access.identity).toBe(SEGWIT);
    expect(access.legacySource).toBe(LEGACY);
  });

  it("does not trust a pair whose active address is not the one asked about", () => {
    expect(walletAddressAccess(SEGWIT, paired).kind).toBe("single");
  });
});

describe("connectionProofForIdentity", () => {
  const proofFor = (address: string) => ({
    address,
    message: "xcp-wallet\norigin:https://x\nnonce:n\nissued:1",
    signature: "sig",
  });

  it("prefers the proof for the identity, wherever it sits", () => {
    const result: ConnectResult = {
      accounts: [LEGACY],
      proof: proofFor(LEGACY),
      proofs: [proofFor(LEGACY), proofFor(SEGWIT)],
    };
    expect(connectionProofForIdentity(result, SEGWIT)?.address).toBe(SEGWIT);
    expect(connectionProofForIdentity(result, LEGACY)?.address).toBe(LEGACY);
  });

  it("answers null when no proof covers the identity", () => {
    expect(connectionProofForIdentity({ accounts: [LEGACY], proof: proofFor(LEGACY) }, SEGWIT)).toBeNull();
  });
});

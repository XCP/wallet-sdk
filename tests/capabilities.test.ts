import { describe, expect, it } from "vitest";
import {
  assertProviderCanSignPsbts,
  ProviderSigningCapabilityError,
  parseProviderPsbtSigningCapabilities,
  psbtBundleLimit,
  SIGN_PSBTS_BUNDLE_LIMIT,
  supportsMarketplaceBundle,
} from "@/provider/capabilities";

const report = {
  psbt: { supported: true, sighashTypes: [1, 131], inputScope: "selected" },
  psbtBatch: { supported: true, sighashTypes: [1], inputScope: "all", maxRequests: 8 },
};

describe("parseProviderPsbtSigningCapabilities", () => {
  it("accepts a well-formed report", () => {
    const parsed = parseProviderPsbtSigningCapabilities(report);
    expect(parsed?.psbt.sighashTypes).toEqual([1, 131]);
    expect(parsed?.psbtBatch.maxRequests).toBe(8);
    expect(parsed?.psbtBatch.inputScope).toBe("all");
  });

  it("rejects anything malformed rather than guessing", () => {
    expect(parseProviderPsbtSigningCapabilities(undefined)).toBeNull();
    expect(parseProviderPsbtSigningCapabilities({ psbt: report.psbt })).toBeNull();
    expect(
      parseProviderPsbtSigningCapabilities({
        ...report,
        psbt: { ...report.psbt, sighashTypes: [1, 999] },
      }),
    ).toBeNull();
    expect(
      parseProviderPsbtSigningCapabilities({
        ...report,
        psbtBatch: { ...report.psbtBatch, maxRequests: 1001 },
      }),
    ).toBeNull();
  });
});

describe("assertProviderCanSignPsbts", () => {
  it("does nothing when the wallet reported no capabilities", () => {
    expect(() =>
      assertProviderCanSignPsbts({ method: "xcp_signPsbts", params: [{ requests: [] }] }, null),
    ).not.toThrow();
  });

  it("refuses a bundle larger than the wallet allows, before any PSBT is parsed", () => {
    const capabilities = parseProviderPsbtSigningCapabilities({
      ...report,
      psbtBatch: { ...report.psbtBatch, maxRequests: 2 },
    })!;
    const request = {
      method: "xcp_signPsbts" as const,
      params: [{ requests: [{ hex: "00" }, { hex: "00" }, { hex: "00" }] }] as const,
    };
    let error: unknown;
    try {
      assertProviderCanSignPsbts(request, capabilities);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderSigningCapabilityError);
    expect((error as ProviderSigningCapabilityError).code).toBe("capability");
    expect((error as ProviderSigningCapabilityError).reason).toBe("batch_limit");
  });

  it("names the intent the way the host describes it", () => {
    const capabilities = parseProviderPsbtSigningCapabilities({
      ...report,
      psbtBatch: { ...report.psbtBatch, supported: false },
    })!;
    const request = {
      method: "xcp_signPsbts" as const,
      params: [{ requests: [{ hex: "00", intent: { action: "buy_listings" } }] }] as const,
    };
    expect(() =>
      assertProviderCanSignPsbts(request, capabilities, (intent) =>
        (intent as { action?: string })?.action === "buy_listings" ? "checkout" : "transaction",
      ),
    ).toThrow(/cannot sign this checkout/);
  });
});

describe("bundle capabilities", () => {
  const bundles = {
    ...report,
    psbtBatch: {
      ...report.psbtBatch,
      maxRequests: 12,
      maxPolicyOfferAlternatives: 100,
      marketplaceBundles: [
        "attach-and-list",
        "fund-policy-offer",
        "commit-and-reveal",
        "next-kind",
        7,
        "next-kind",
      ],
    },
  };
  const policyOffer = {
    intent: { standard: "counterparty-marketplace", version: 1, action: "fund_policy_offer" },
  };

  it("keeps every reported kind, unknown ones included, and drops what is not a string", () => {
    const parsed = parseProviderPsbtSigningCapabilities(bundles)!;
    expect(parsed.psbtBatch.marketplaceBundles).toEqual([
      "attach-and-list",
      "fund-policy-offer",
      "commit-and-reveal",
      "next-kind",
    ]);
    expect(parsed.psbtBatch.maxPolicyOfferAlternatives).toBe(100);
    expect(supportsMarketplaceBundle(parsed, "commit-and-reveal")).toBe(true);
    expect(supportsMarketplaceBundle(parsed, "bulk-listing")).toBe(false);
  });

  it("reads an older report as no bundles and no policy-offer sets", () => {
    const parsed = parseProviderPsbtSigningCapabilities(report)!;
    expect(parsed.psbtBatch.marketplaceBundles).toEqual([]);
    expect(parsed.psbtBatch.maxPolicyOfferAlternatives).toBe(0);
    expect(supportsMarketplaceBundle(parsed, "attach-and-list")).toBe(false);
    expect(supportsMarketplaceBundle(null, "attach-and-list")).toBe(false);
  });

  it("names no bundle when the batch method is unsupported", () => {
    const parsed = parseProviderPsbtSigningCapabilities({
      ...bundles,
      psbtBatch: { ...bundles.psbtBatch, supported: false },
    });
    expect(supportsMarketplaceBundle(parsed, "commit-and-reveal")).toBe(false);
  });

  it("refuses a malformed policy-offer bound", () => {
    expect(
      parseProviderPsbtSigningCapabilities({
        ...bundles,
        psbtBatch: { ...bundles.psbtBatch, maxPolicyOfferAlternatives: -1 },
      }),
    ).toBeNull();
  });

  it("uses the wallet's own bundle size, the default only when it reports none", () => {
    const parsed = parseProviderPsbtSigningCapabilities(bundles)!;
    expect(psbtBundleLimit([{}], null)).toBe(SIGN_PSBTS_BUNDLE_LIMIT);
    expect(psbtBundleLimit([{}], parsed)).toBe(12);
    expect(psbtBundleLimit(Array(20).fill(policyOffer), parsed)).toBe(100);
    // A mixed bundle is not a policy-offer set.
    expect(psbtBundleLimit([policyOffer, {}], parsed)).toBe(12);
    // Nor is one the wallet does not list.
    const unlisted = parseProviderPsbtSigningCapabilities({
      ...bundles,
      psbtBatch: { ...bundles.psbtBatch, marketplaceBundles: [] },
    })!;
    expect(psbtBundleLimit(Array(20).fill(policyOffer), unlisted)).toBe(12);
  });

  it("refuses past the wallet's own size with batch_limit", () => {
    const parsed = parseProviderPsbtSigningCapabilities(bundles)!;
    const requests = Array.from({ length: 13 }, () => ({ hex: "00" }));
    expect(() =>
      assertProviderCanSignPsbts({ method: "xcp_signPsbts", params: [{ requests }] }, parsed),
    ).toThrow(/at most 12/);
  });
});

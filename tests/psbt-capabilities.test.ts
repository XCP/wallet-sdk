import { describe, expect, it } from "vitest";
import {
  assertProviderCanSignPsbts,
  parseProviderPsbtSigningCapabilities,
  ProviderSigningCapabilityError,
} from "../src/provider/psbt-capabilities";

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
        psbtBatch: { ...report.psbtBatch, maxRequests: 1000 },
      }),
    ).toBeNull();
  });
});

describe("assertProviderCanSignPsbts", () => {
  it("does nothing when the wallet reported no capabilities", () => {
    expect(() =>
      assertProviderCanSignPsbts(
        { method: "xcp_signPsbts", params: [{ requests: [] }] },
        null,
      ),
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
    expect((error as ProviderSigningCapabilityError).code).toBe("batch_limit");
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

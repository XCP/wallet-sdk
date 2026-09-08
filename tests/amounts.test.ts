import { describe, expect, it } from "vitest";
import {
  AmountValidationError,
  COUNTERPARTY_MAX_INT,
  type DecimalPlaces,
  parseAmountDraft,
  parseRawInteger,
  rawToInput,
  serializeDecimal,
  serializeRawInteger,
} from "@/amounts";
import amountVectors from "../contracts/amounts-v1.json";

const vectors = amountVectors as {
  drafts: {
    id: string;
    draft: string;
    decimals: DecimalPlaces;
    status: string;
    raw?: string;
    canonical?: string;
    code?: string;
  }[];
  editing: { id: string; decimals: DecimalPlaces; drafts: string[]; statuses: string[] }[];
  rawToInput: { raw: string; decimals: DecimalPlaces; input: string }[];
  rawIntegers: { input: string; valid: boolean; raw?: string }[];
};

describe("versioned amount contract", () => {
  it.each(vectors.drafts)("$id", (vector) => {
    const result = parseAmountDraft(vector.draft, { decimals: vector.decimals });
    expect(result.status).toBe(vector.status);
    expect(result.draft).toBe(vector.draft);
    if (result.status === "valid") {
      expect(result.raw.toString()).toBe(vector.raw);
      expect(result.canonical).toBe(vector.canonical);
    } else {
      expect(result).not.toHaveProperty("raw");
      expect(result).not.toHaveProperty("canonical");
      if (result.status === "invalid") expect(result.code).toBe(vector.code);
    }
  });

  it.each(vectors.editing)("retains every draft in $id", (vector) => {
    const results = vector.drafts.map((draft) => parseAmountDraft(draft, { decimals: vector.decimals }));
    expect(results.map((result) => result.status)).toEqual(vector.statuses);
    expect(results.map((result) => result.draft)).toEqual(vector.drafts);
    for (const result of results) if (result.status !== "valid") expect(result).not.toHaveProperty("raw");
  });

  it.each(vectors.rawToInput)("round trips $raw at $decimals places", (vector) => {
    expect(rawToInput(vector.raw, vector.decimals)).toBe(vector.input);
    const parsed = parseAmountDraft(vector.input, { decimals: vector.decimals });
    expect(parsed.status === "valid" && parsed.raw.toString()).toBe(vector.raw);
  });

  it.each(vectors.rawIntegers)("validates raw $input", (vector) => {
    if (vector.valid) expect(serializeRawInteger(vector.input)).toBe(vector.raw);
    else expect(() => parseRawInteger(vector.input)).toThrow(AmountValidationError);
  });

  it("requires explicit known precision, validates bounds and refuses truncation", () => {
    expect(() => parseAmountDraft("1", { decimals: undefined as unknown as DecimalPlaces })).toThrow(
      RangeError,
    );
    expect(() => parseAmountDraft("1", { decimals: 9 as DecimalPlaces })).toThrow(RangeError);
    expect(parseAmountDraft("0", { decimals: 8, minRaw: 1n })).toMatchObject({
      status: "invalid",
      code: "amount_range",
    });
    expect(parseAmountDraft("100", { decimals: 0, maxRaw: 99n })).toMatchObject({
      status: "invalid",
      code: "amount_range",
    });
    expect(parseAmountDraft("1234", { decimals: 0, maxLength: 3 })).toMatchObject({
      status: "invalid",
      draft: "1234",
      code: "amount_too_long",
    });
  });

  it("does not recover digits from an unsafe numeric value", () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity]) {
      expect(() => parseRawInteger(value)).toThrow(AmountValidationError);
    }
    expect(parseRawInteger(Number.MAX_SAFE_INTEGER)).toBe(9_007_199_254_740_991n);
    expect(parseRawInteger(COUNTERPARTY_MAX_INT)).toBe(COUNTERPARTY_MAX_INT);
  });

  it("formats finite decimal fields without changing their units", () => {
    for (const value of [0.1, 1.56, "0.05", 0, 0.00000001]) {
      expect(serializeDecimal(value, { min: 0 })).toBe(
        typeof value === "number" && value === 0.00000001 ? "0.00000001" : String(value),
      );
    }
    expect(serializeDecimal(-1.5)).toBe("-1.5");
    for (const value of [NaN, Infinity, -Infinity, "NaN", "Infinity", "1,5", "1e3", " 1 "]) {
      expect(() => serializeDecimal(value)).toThrow(AmountValidationError);
    }
    expect(() => serializeDecimal(-0.1, { min: 0 })).toThrow(AmountValidationError);
    expect(() => serializeDecimal(1, { min: 0, max: 1, maxExclusive: true })).toThrow(AmountValidationError);
  });
});

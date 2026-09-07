import { afterEach, describe, expect, it, vi } from "vitest";
import { configureWalletSdk } from "@/config";
import { fetchAssetBalance, fetchPoolQuote, get } from "@/counterparty/api";
import { serializeComposeParams, serializeFeeRate } from "@/counterparty/params";
import { type ComposeSigner, composeAndBroadcast } from "@/transaction/compose";

afterEach(() => {
  vi.unstubAllGlobals();
  configureWalletSdk({ storage: null });
});

describe("Core field-aware parameters", () => {
  it("keeps text and booleans separate from raw quantities and fractional commissions", () => {
    const query = serializeComposeParams("fairminter", {
      asset: "A95428956661682177",
      description: "1,234 tokens — 日本語",
      divisible: true,
      burn_payment: "false",
      hard_cap: "10000000000000001",
      price: 100n,
      minted_asset_commission: 0.05,
    });
    expect(Object.fromEntries(query)).toMatchObject({
      description: "1,234 tokens — 日本語",
      divisible: "true",
      burn_payment: "false",
      hard_cap: "10000000000000001",
      price: "100",
      minted_asset_commission: "0.05",
    });
    expect(
      serializeComposeParams("broadcast", { value: -1.56, fee_fraction: 0.05, text: "1e5 is text" }).get(
        "value",
      ),
    ).toBe("-1.56");
  });

  it.each([
    "1,234",
    "1_234",
    "1.0",
    "1e3",
    "-1",
    "+1",
    "١٠٠",
    " 1 ",
    "NaN",
    "Infinity",
    "9223372036854775808",
  ])("rejects raw %s even without an input component", (quantity) => {
    for (const [type, field] of [
      ["send", "quantity"],
      ["order", "give_quantity"],
      ["fairmint", "quantity"],
      ["pooldeposit", "quantity_a"],
      ["poolwithdraw", "min_quantity_b"],
      ["attach", "utxo_value"],
    ]) {
      expect(() => serializeComposeParams(type!, { [field!]: quantity })).toThrow();
    }
  });

  it("validates MPMA quantities individually without changing commas in text lists", () => {
    const query = serializeComposeParams("mpma", {
      assets: "XCP,TOKEN",
      destinations: "one,two",
      quantities: "1,10000000000000001",
      memos: ["first", "second"],
    });
    expect(query.get("quantities")).toBe("1,10000000000000001");
    expect(query.getAll("memos")).toEqual(["first", "second"]);
    expect(() => serializeComposeParams("mpma", { quantities: "1,1e5" })).toThrow();
  });

  it("refuses fractions Core's float-times-UNIT conversion would silently truncate", () => {
    for (const [type, field] of [
      ["fairminter", "minted_asset_commission"],
      ["broadcast", "fee_fraction"],
    ]) {
      for (const value of ["0.29", 0.29, "0.000000001"]) {
        expect(() => serializeComposeParams(type!, { [field!]: value })).toThrow("amount_precision");
      }
      expect(serializeComposeParams(type!, { [field!]: "0.05" }).get(field!)).toBe("0.05");
    }
  });

  it("rejects unknown fields, invalid booleans, unsafe numbers and nonfinite fee overrides", () => {
    expect(() => serializeComposeParams("order", { give_quantitiy: 1n })).toThrow("Unrecognized");
    expect(() => serializeComposeParams("send", { quantity: 1e16 })).toThrow();
    expect(() => serializeComposeParams("send", { memo_is_hex: "maybe" })).toThrow();
    expect(() => serializeComposeParams("send", { memo_is_hex: ["true"] })).toThrow();
    expect(() => serializeComposeParams("toString", {})).toThrow("Unsupported");
    expect(() => serializeComposeParams("fairminter", { minted_asset_commission: 1 })).toThrow();
    for (const value of [NaN, Infinity, -Infinity, -0.1]) expect(() => serializeFeeRate(value)).toThrow();
    expect(serializeFeeRate(0)).toBe("0");
    expect(serializeFeeRate(0.1)).toBe("0.1");
    expect(serializeFeeRate(1.56)).toBe("1.56");
  });
});

describe("actual transport boundaries", () => {
  it.each([0.1, 1.56])("serializes raw digits and %s sat/vB through compose", async (feeRate) => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "test boundary" }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetch);
    const signer: ComposeSigner = {
      address: "1CounterpartyXXXXXXXXXXXXXXXUWLpVr",
      publicKey: null,
      connectionProof: null,
      signTransaction: vi.fn(),
      broadcastTransaction: vi.fn(),
    };
    await expect(
      composeAndBroadcast(
        signer,
        "order",
        { give_asset: "XCP", give_quantity: 10_000_000_000_000_001n },
        { feeRate },
      ),
    ).rejects.toThrow("test boundary");
    const call = fetch.mock.calls[0] as unknown as [string];
    const query = new URL(call[0]).searchParams;
    expect(query.get("give_quantity")).toBe("10000000000000001");
    expect(query.get("sat_per_vbyte")).toBe(String(feeRate));
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(signer.broadcastTransaction).not.toHaveBeenCalled();
  });

  it("blocks invalid direct compose calls before fee lookup, network or signing", async () => {
    const fetch = vi.fn();
    const feeRateSource = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const signer: ComposeSigner = {
      address: "1CounterpartyXXXXXXXXXXXXXXXUWLpVr",
      publicKey: null,
      connectionProof: null,
      signTransaction: vi.fn(),
      broadcastTransaction: vi.fn(),
    };
    await expect(
      composeAndBroadcast(signer, "send", { quantity: "1,234" }, { feeRateSource }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    for (const feeRate of [NaN, Infinity, -0.1]) {
      await expect(composeAndBroadcast(signer, "send", { quantity: 1n }, { feeRate })).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(feeRateSource).not.toHaveBeenCalled();
    expect(signer.signTransaction).not.toHaveBeenCalled();
  });

  it("validates quote quantities through typed and generic reads", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ result: {} }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await fetchPoolQuote("XCP", "TOKEN", 10_000_000_000_000_001n);
    const call = fetch.mock.calls[0] as unknown as [string];
    expect(new URL(call[0]).searchParams.get("quantity")).toBe("10000000000000001");
    fetch.mockClear();
    await expect(get("/pools/XCP/TOKEN/quote?quantity=1e5")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(get("/addresses/source/compose/send?quantity=1e5")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    for (const quantity of ["1e5", "1,234", 1e16]) {
      await expect(get("/pools/XCP/TOKEN/quote", { quantity })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(get("/pools/XCP/TOKEN/quote/deposit", { quantity })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(get("/addresses/source/compose/send", { quantity })).rejects.toMatchObject({
        code: "invalid_argument",
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not invent a zero balance from unreadable raw response data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ result: [{ asset: "XCP", quantity: "1,234", utxo: null }] }), {
            status: 200,
          }),
      ),
    );
    await expect(fetchAssetBalance("source", "XCP")).rejects.toMatchObject({ code: "invalid_response" });
  });
});

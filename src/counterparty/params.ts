import {
  AmountValidationError,
  type ExactInteger,
  parseAmountDraft,
  serializeDecimal,
  serializeRawInteger,
} from "@/amounts";
import { WalletSdkError } from "@/errors";

export type ComposeParameter = ExactInteger | boolean | readonly string[];
type Kind = "integer" | "decimal" | "commission" | "boolean" | "text" | "integers" | "texts";
type Fields = Record<string, Kind>;

/**
 * Core 67e10db3: api/compose.py signatures and composer.CONSTRUCT_PARAMS.
 * Numeric syntax/range belongs here; balances, zero meanings, activation
 * heights, lot multiples and other consensus rules remain Core's authority.
 * No human-unit normalization occurs at this boundary.
 */
function fields(integer = "", text = "", boolean = "", decimal = ""): Fields {
  const result: Fields = {};
  for (const [names, kind] of [
    [integer, "integer"],
    [text, "text"],
    [boolean, "boolean"],
    [decimal, "decimal"],
  ] as const) {
    for (const name of names.split(" ").filter(Boolean)) result[name] = kind;
  }
  return result;
}

const CONSTRUCT = fields(
  "confirmation_target exact_fee max_fee segwit_dust_size fee_per_kb fee_provided regular_dust_size multisig_dust_size",
  "encoding inputs_set custom_inputs exclude_utxos multisig_pubkey change_address more_outputs pubkeys unspent_tx_hash dust_return_pubkey p2sh_pretx_txid",
  "validate allow_unconfirmed_inputs use_utxos_with_balances exclude_utxos_with_balances disable_utxo_locks use_all_inputs_set verbose return_only_data message_only inscription return_psbt extended_tx_info old_style_api segwit",
  "sat_per_vbyte",
);

const MESSAGES: Record<string, Fields> = {
  bet: fields(
    "bet_type deadline wager_quantity counterwager_quantity expiration leverage target_value",
    "feed_address",
  ),
  broadcast: { ...fields("timestamp", "text mime_type", "", "value"), fee_fraction: "commission" },
  btcpay: fields("", "order_match_id"),
  burn: fields("quantity", "", "overburn"),
  cancel: fields("", "offer_hash"),
  destroy: fields("quantity", "asset tag"),
  dispenser: fields(
    "give_quantity escrow_quantity mainchainrate status",
    "asset open_address oracle_address",
  ),
  dividend: fields("quantity_per_unit", "asset dividend_asset"),
  issuance: fields("quantity", "asset transfer_destination description mime_type", "divisible lock reset"),
  mpma: {
    ...fields("", "assets destinations memo", "memos_are_hex memo_is_hex"),
    quantities: "integers",
    memos: "texts",
  },
  order: fields("give_quantity get_quantity expiration fee_required", "give_asset get_asset"),
  send: fields("quantity", "destination asset memo", "memo_is_hex use_enhanced_send no_dispense"),
  sweep: fields("flags", "destination memo"),
  dispense: fields("quantity", "dispenser"),
  fairminter: {
    ...fields(
      "lot_price lot_size max_mint_per_tx max_mint_per_address hard_cap premint_quantity start_block end_block soft_cap soft_cap_deadline_block pool_quantity price quantity_by_price",
      "asset asset_parent description mime_type lp_asset",
      "burn_payment lock_description lock_quantity divisible",
    ),
    minted_asset_commission: "commission",
  },
  fairmint: fields("quantity", "asset"),
  pooldeposit: fields("quantity_a quantity_b min_lp_quantity", "asset_a asset_b lp_asset"),
  poolwithdraw: fields("quantity min_quantity_a min_quantity_b", "asset_a asset_b lp_asset"),
  attach: fields("quantity utxo_value destination_vout", "asset"),
  detach: fields("", "destination utxos"),
  movetoutxo: fields("utxo_value", "destination"),
};

function scalar(value: ComposeParameter): ExactInteger {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("expected a numeric scalar");
  }
  return value;
}

function serialize(kind: Kind, value: ComposeParameter, name: string): string | readonly string[] {
  switch (kind) {
    case "integer":
      return serializeRawInteger(scalar(value));
    case "decimal":
      return serializeDecimal(scalar(value), name === "sat_per_vbyte" ? { min: 0 } : {});
    case "commission": {
      const text = serializeDecimal(scalar(value), { min: 0, max: 1, maxExclusive: true });
      const exact = parseAmountDraft(text, { decimals: 8 });
      // Core currently does int(float(fraction) * 1e8). Refuse a fraction
      // that this operation truncates differently from its exact decimal
      // intent (e.g. 0.29), rather than bumping/rounding the user's value.
      if (exact.status !== "valid" || BigInt(Math.trunc(Number(text) * 1e8)) !== exact.raw)
        throw new AmountValidationError("amount_precision");
      return text;
    }
    case "boolean": {
      if (
        typeof value !== "boolean" &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "bigint"
      ) {
        throw new Error("expected a boolean");
      }
      const text = String(value).toLowerCase();
      if (text === "true" || text === "1") return "true";
      if (text === "false" || text === "0") return "false";
      throw new Error("expected a boolean");
    }
    case "text":
      if (typeof value !== "string") throw new Error("expected text");
      return value;
    case "integers":
      if (typeof value !== "string") throw new Error("expected comma-separated raw integers");
      return value
        .split(",")
        .map((item) => serializeRawInteger(item))
        .join(",");
    case "texts":
      if (typeof value === "string") return value;
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
        throw new Error("expected text list");
      return value;
  }
}

/** Validate present fields; Core still reports missing required fields. */
export function serializeComposeParams(
  type: string,
  params: Record<string, ComposeParameter>,
): URLSearchParams {
  const message = Object.hasOwn(MESSAGES, type) ? MESSAGES[type] : undefined;
  if (!message) throw new WalletSdkError("invalid_argument", `Unsupported compose message: ${type}`);
  const schema = { ...CONSTRUCT, ...message };
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    const kind = Object.hasOwn(schema, name) ? schema[name] : undefined;
    if (!kind) throw new WalletSdkError("invalid_argument", `Unrecognized compose parameter: ${name}`);
    try {
      const serialized = serialize(kind, value, name);
      for (const item of typeof serialized === "string" ? [serialized] : serialized) query.append(name, item);
    } catch (error) {
      throw new WalletSdkError(
        "invalid_argument",
        `${name}: ${error instanceof Error ? error.message : "invalid value"}`,
        { cause: error },
      );
    }
  }
  return query;
}

/** Explicit fee override, independent of the estimated default rate. */
export function serializeFeeRate(value: ExactInteger): string {
  try {
    return serializeDecimal(value, { min: 0 });
  } catch (error) {
    throw new WalletSdkError(
      "invalid_argument",
      `sat_per_vbyte: ${error instanceof Error ? error.message : "invalid value"}`,
      { cause: error },
    );
  }
}

/** The quote API receives the same raw integer contract as compose. */
export function serializeQuoteQuantity(value: ExactInteger): string {
  try {
    return serializeRawInteger(value);
  } catch (error) {
    throw new WalletSdkError(
      "invalid_argument",
      `quantity: ${error instanceof Error ? error.message : "invalid value"}`,
      { cause: error },
    );
  }
}

# Strict transaction amounts

`@xcp/wallet-sdk/amounts` is a pure, dependency-free entry. Its contract is based
on Counterparty Core `67e10db3ee266068c1effc4e83653df39ace5ca8`: quantities
are raw integers; divisible assets use eight places; indivisible assets use
zero; ordinary quantity fields are bounded by `2^63 - 1`. Core's route types
and message-specific validation remain authoritative.

```ts
import { parseAmountDraft, rawToInput } from "@xcp/wallet-sdk/amounts";

const draft = "100000000.00000001";
const amount = parseAmountDraft(draft, { decimals: 8, minRaw: 1n });
if (amount.status === "valid") {
  // Exact bigint 10000000000000001n, ready for a raw quantity parameter.
  quote({ quantity: amount.raw });
}
rawToInput("100", 0); // "100", never "1"
```

The result is `empty`, `incomplete`, `invalid`, or `valid`. Every result retains
the exact `draft`. Only `valid` includes `raw: bigint` and an equivalent plain
`canonical` string. Invalid results have a stable `code` for app-owned messages:
`amount_syntax`, `amount_precision`, `amount_range`, or `amount_too_long`.

`decimals` must explicitly be an integer from zero through eight. Asset
divisibility must be known before choosing it. `minRaw` defaults to zero,
`maxRaw` to `COUNTERPARTY_MAX_INT`, and `maxLength` to 128. Bounds are in raw
units. Fields with different limits or a positive-only requirement must pass
those bounds. Trailing decimal marks such as `5.` are incomplete. Extra decimal
places, including zeroes, are invalid; no rounding occurs.

## Keep the draft, validate the current intent

Assign the complete edited text to the field state, even when invalid. Do not
remove rejected characters: sequential `1e5` must stay invalid, never become
`15`; an indivisible `0.5` must never become `05`. Do not fall back to a previous
valid amount or zero while a different invalid draft is visible. Gate requests
and submission on the current validation result, including after asset changes.

The grammar uses ASCII digits and a period, without grouping, whitespace, unit
suffixes, signs or exponents. Locale, fiat currency and display formatting do
not affect it. Keyboard adapters, composition, paste/drop and autofill are UI
responsibilities. In particular, text inputs can remove line breaks or truncate
clipboard text before `onChange`; validate the original text and preserve a
visible invalid state rather than accepting a concatenated/truncated number.
Replay the supplied vectors through actual editing and submit paths in each app.

## Other boundaries

- `parseRawInteger` returns an exact bigint or throws `AmountValidationError`.
  `serializeRawInteger` returns digit strings. Both reject unsafe JavaScript
  numbers and malformed strings; defaults are zero through Core's maximum.
- `rawToInput` performs strict exact conversion with explicit precision. It
  throws on invalid raw data instead of displaying an invented zero.
- `serializeDecimal` handles finite Core floating fields such as sat/vB rates
  or commission fractions, without raw-unit scaling. It accepts optional
  `min`, `max`, `maxExclusive` and `maxDecimals` bounds. Drafts should still use
  `parseAmountDraft`; this serializer is not an input editor.
- Legacy `parseUnitsToRaw`, `big`, `approx`, and rounding helpers keep their
  existing arithmetic/display semantics. They are not strict draft validation.

`contracts/amounts-v1.json` is also exported as `/amounts/vectors`. The JSON uses
strings for all raw values so JavaScript, Python and other clients can consume
the same cases losslessly. Add vectors to this version compatibly; change the
contract version if grammar or result semantics change.

## Quote and compose parameters

`serializeComposeParams`, `serializeQuoteQuantity` and `serializeFeeRate` are
exported from the SDK's main entry. The actual compose pipeline uses them before
requesting a default fee or contacting Core. Generic `get()` calls to compose or
pool quote paths also apply the relevant validation; `fetchPoolQuote` uses the
same raw serializer. Serialization is idempotent: already raw `100000000` stays
`100000000` and is never scaled again.

The field schema is pinned to Core's `api/compose.py` function signatures and
`api/composer.py` `CONSTRUCT_PARAMS` at the commit above. It covers the declared
bet, broadcast, btcpay, burn, cancel, destroy, dispenser, dividend, issuance,
MPMA, order, send, sweep, dispense, fairminter, fairmint, pooldeposit,
poolwithdraw, attach, detach and movetoutxo parameters.

| Field family | Wire rule |
|---|---|
| Raw token quantities, BTC satoshis, caps, pool/LP amounts | Exact nonnegative integer strings, at most Core `MAX_INT`; callers already applied divisibility. |
| Block heights/counts, timestamps, status and flags | Whole integers; Core owns narrower field limits and activation-dependent rules. |
| `sat_per_vbyte` | Finite, nonnegative decimal; `0.1` and `1.56` remain fractional. Explicit zero differs from an omitted option. |
| `minted_asset_commission` | Finite fraction, zero inclusive to one exclusive; `0.05` means 5%, without multiplying by asset units. |
| Broadcast `value`, `fee_fraction` | Finite decimal fields; Core owns their protocol-specific range and interpretation. |
| Assets, addresses, descriptions, memos | Text preserved as text, including punctuation or digits. |
| Boolean options | Boolean values or their plain `true`/`false`/`1`/`0` representations. |
| MPMA `quantities`, `memos` | Each raw quantity validated independently; memo list uses repeated query parameters. |

Unknown message/field names now fail explicitly. Required fields, balances,
zero meanings, asset existence, lot multiples, protocol activation, compound
construction strings (`inputs_set`, `more_outputs`) and mempool conflicts are
still validated by Core. Existing callers of undocumented/new fields need a
schema update, not a permissive fallback. `quantityParam` remains a legacy
generic stringifier; it is no longer used as the compose boundary validator.

Core currently encodes fairminter commission and broadcast fee fractions using
`int(float(fraction) * 1e8)`. Some valid decimal fractions, such as `0.29`, lose
one raw unit through binary floating point truncation. The SDK refuses those
two fields with `amount_precision` when Core's encoding differs from the exact
decimal intent, and also refuses more than eight places or fractions outside
zero inclusive to one exclusive. It never adjusts the user's fraction to hide
this Core limitation. Fractional miner fee rates and broadcast values are not
subject to this integer-fraction check.

## What transaction verification proves

The compose pipeline parses the complete returned transaction and checks:

1. Core's raw transaction and PSBT describe the same Bitcoin envelope.
2. A provider's returned signed transaction/PSBT preserves version, locktime,
   input outpoints/sequences, output scripts and exact output amounts. Changes
   to script signatures and witnesses are expected. Mismatch blocks broadcast.
3. Before PSBT signing, each parent transaction's raw bytes hash to the requested
   input transaction ID. Exact prevout amounts/scripts come from those bytes;
   provided PSBT prevouts must agree. JSON BTC floats are not used for money.
4. The signer's address has not changed before signing or before broadcast.

These checks bind transaction bytes across API and signing boundaries. They do
**not** independently decode every Counterparty message or prove that Core
encoded the user's asset/quantity/destination intent correctly. They do not
replace the wallet's signature validation, exact fee/amount approval, or the
host's freshness and current-draft checks. A node's `params` or normalized
display fields are not cryptographic evidence of the encoded message. Direct
`signPsbt`/provider calls outside the compose pipeline retain their own wallet
verification responsibilities.

Tests include a raw transaction fixture from Core's composer tests with pinned
provenance, one-satoshi/envelope mutations, actual PSBT signing with test-only
keys, mismatched parents/prevouts, and transport calls stopped before signing.

## Localizing compose failures

`useCompose()` retains its readable `error` string and also returns `errorCode`
and `errorDetails`. Amount failures retain their `amount_*` code even through
the compose wrapper; envelope/prevout disagreements use `transaction_mismatch`;
other SDK failures retain their SDK code. Unknown failures use `unknown_error`.
Hosts can translate these codes and offer the original `errorDetails.diagnostic`
and optional numeric `walletCode` in a details view. The SDK does not translate
or guess structured parameters from node text. Reset, account-change error
clearing, progress, and success clear both metadata fields to `null`.

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

# Casa Tookan development-wallet contract

Observed on 2026-10-20 against [the development wallet](https://devapp.casatookan.com/),
version 2.1.0, build `bfbcddd-dirty` (08:06 AM). This is a working integration
contract for this build, not a guarantee about other builds.

The [published signing engine](https://devapp.casatookan.com/signer-core.js) has
SHA-256 `7e49e42a354014604718f49b18a341b40c057ece816e91716e2d3017d74eb579`.
That matches the hash pinned in the development app. Its header says the native
modules also pin a core hash; installed native binaries were not inspected.

Evidence has two scopes:

- **Wallet:** real provider calls through the official web bridge and approval UI,
  using an unfunded wallet and synthetic prevouts. No broadcast.
- **Engine:** the exact downloaded engine run locally with a deterministic test
  key. These tests bypass provider preparation, permissions and UI.

The [adapter contract](casatookan.md) enables the verified signing mechanics with conservative size and batch limits.
The [recorded results](qa/casatookan-2026-10-20.json) include 28 wallet scenarios,
69 engine probes, and the earlier selected-input/preservation checks.

## Signing capabilities

| Capability | Observation | Evidence |
| --- | --- | --- |
| P2PKH and P2WPKH | Selected inputs, preserved foreign signatures, non-ALL sighashes and batches work. Shared transactions finalize. | Wallet |
| BIP-86 Taproot key path | Schnorr signatures verify; missing `tapInternalKey` is populated; finalization works. | Wallet, engine |
| Nested P2SH-P2WPKH | Rejected as not belonging to the casa, including when the underlying key belongs to it. | Wallet, engine |
| P2WSH multisig | Rejected as not belonging to the casa. | Engine |
| Taproot script trees | Ownership matching recognizes the no-tree BIP-86 output, not arbitrary tree-bearing outputs. | Engine source; script-path UI not tested |
| PSBT v0 and v2 | Accepted; v2 remains v2. | Wallet: SegWit/Taproot; engine: all three supported types |
| ECDSA sighashes | `1`, `2`, `3`, `129`, `130`, `131` verify. | Wallet: SegWit; engine: Legacy/SegWit, v0/v2 |
| Taproot sighashes | `0`, `1`, `2`, `3`, `129`, `130`, `131` verify. | Wallet, engine v0/v2 |
| Foreign signatures | Retained byte-for-byte and still verify after signing another input. | Wallet: Legacy/SegWit |
| Unknown PSBT fields | A supplied proprietary input field was stripped. Do not assume arbitrary metadata survives. | Engine |

## Provider options

`window.unisat.signPsbt(psbtHex, options)` returns PSBT hex.

```ts
{
  autoFinalize: false,
  toSignInputs: [
    { index: 0, address: selectedAddress, sighashTypes: [131] }
  ]
}
```

- `autoFinalize` defaults to true. **`autoFinalized` is ignored**, including
  `autoFinalized: false`; the resulting PSBT is finalized.
- `toSignInputs` omitted means all recognized inputs in the current casa.
  An empty array fails with `E_NOT_OWN_INPUT`.
- `index` selects the actual input. `sighashTypes` is an allowlist, not a request
  to change the PSBT's sighash. Defaults are ALL for Legacy/SegWit and
  DEFAULT/ALL for Taproot. A mismatch fails with `E_SIGHASH` at signing.
- `address` must belong to the current casa, but does **not** bind the selected
  input to that address. A Taproot connection with its Taproot address in the
  options successfully signed the same casa's Legacy input.
- `publicKey` is ignored. Supplying another key did not prevent the real input's
  owner from signing.
- Duplicate input indices are accepted by the engine. Normalize and validate
  selections in our adapter.
- Finalization attempts to finalize the transaction, not just the selected
  inputs. Use `autoFinalize: false` for incomplete collaborative PSBTs.

Therefore, validate each selected prevout against the intended account locally;
neither the connected address nor an options field substitutes for that check.

## Batches and failures

`signPsbts(psbtHexs, options)` accepts one shared options object or an array of
per-PSBT options. Two different sighash policies in one batch were verified.
Results are ordered. The UI presents the requests together for one approval.

| Scenario | Result |
| --- | --- |
| 20-item SegWit batch | All returned signatures verified. |
| 20 distinct Taproot transactions | Returned in order; all signatures verified against their respective transactions. |
| Empty batch | `E_NO_KEY`, before approval. |
| Valid first PSBT, malformed second | Entire request rejected before approval. |
| Valid first PSBT, disallowed sighash on second | Approval shown; entire promise rejects with `E_SIGHASH`, no results returned. |
| Cancel batch | `4001`, no results returned. |
| Two simultaneous signing calls | One succeeds; the other returns `E_BUSY`. |

The web signer prepares every item before approval, then signs sequentially and
returns only after all succeed. A later failure can occur after an earlier item
was signed internally, but that earlier result is not returned to the caller.
There is no tested partial-success response. Serialize independent approvals.

## Sizes and preparation

- A 65,780-byte PSBT passed through the real wallet and its signature verified.
- A 262,388-byte PSBT failed before approval with `-32603`,
  `Maximum call stack size exceeded`.
- A separate 100-input fixture, carrying full parent transactions, reproduced
  the same failure. The issue is not specific to the large OP_RETURN fixture.
- The local engine accepted a 324,053-byte, 100-input SegWit PSBT, signed every
  input, and passed signature verification. It also accepted the 262,388-byte
  data fixture and batches of 100.
- A larger local 500-input run was stopped after prolonged execution. It does
  not establish either support or a hard limit.

The failure is in provider preparation. `hydratePsbt` removes empty
`finalScriptSig` fields and re-encodes with
`btoa(String.fromCharCode(...o.toPSBT()))`. Spreading the entire byte array into
one call hits the JavaScript argument/stack limit. The earlier hex-to-base64
conversion already uses 32,768-byte chunks.

There is no explicit batch-count or byte-size cap in the inspected paths.
The successful sizes above are tested examples, not advertised maxima.
Do not infer unlimited capacity or the same runtime limit on phones.

Include prevouts in requests. When both UTXO fields are absent, preparation
fetches parent transactions sequentially. The inspected transaction fetch path
has no deduplication cache; asset divisibility lookups do have a cache.

## Message signatures

- Legacy/SegWit use recoverable Bitcoin Signed Message ECDSA, verifiable through
  the SDK's existing BIP-137 path.
- Taproot also returns recoverable ECDSA under its untweaked internal key.
  The real signature passes `verifyBip86RecoverableMessage` and fails the
  BIP-137 and BIP-322 paths. Use the explicit `ECDSA-BIP86` proof dialect already
  supported for Horizon; never silently fall back from BIP-322.
- `signMessage(message, "bip322-simple")` is rejected as unsupported.

## Transaction checks still belong in our integration

The engine verifies full parent transaction IDs and rejects contradictory
witness/non-witness prevout data. It also permits witness-only Legacy signing
with an unverified-fee warning. Retain our full-parent requirement for Legacy.

With finalization disabled, engine tests returned signatures for negative-fee,
dust-output, zero-fee and future-locktime transactions. These are observations
about signing policy, not claims that those transactions can relay or confirm.
Retain our transaction validity, fee, asset and marketplace-intent checks.

The approval modal prevented normal in-page account switching in the web UI;
the test was cancelled. This does not establish behavior for native
interruptions or external revocation during approval. Retain the adapter's
account/event-revision checks before returning a signature.

## Remaining external evidence

Most integration questions are answered by this build. The concrete report to
the developers is the large-PSBT preparation overflow, with the ignored options
as compatibility details rather than missing signing features.

What this environment cannot establish is which signer-core hash ships in each
iOS/Android release, native lifecycle behavior, or practical mobile size limits.
Those need installed-device tests. End-to-end marketplace offer/fill and
Counterparty asset semantics remain our integration work, not questions about
whether Casa can produce these signatures.

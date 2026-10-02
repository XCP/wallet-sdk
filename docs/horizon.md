# Horizon Wallet compatibility

The adapter supports Horizon's `getAddresses`, `signMessage` and `signPsbt`
API. The official Chrome Web Store 2.3.1 extension was tested in an isolated,
unfunded wallet using the public BIP-39 abandon/about test mnemonic. No
transactions were broadcast. Signing compatibility is not a funded settlement test.

## Actions tested

| Action | Native SegWit | Taproot | Evidence / requirement |
|---|---|---|---|
| Connect and authenticate | Yes | Yes | Real signatures; SDK connection proof; Taproot proof accepted by the marketplace server locally |
| List a prepared asset | Yes | Yes | Selected-input SINGLE\|ANYONECANPAY signatures |
| Attach, buy, exact-offer buyer and seller signing | Yes | Taproot key-path mechanics verified | Synthetic transaction shapes; full funded marketplace round trips remain untested |
| Collection / trait offer funding | Yes | Yes | Real marketplace v3 zero-fee parent builders, unsigned market anchor input |
| Accept a collection / trait offer | Yes | Yes | Real marketplace v3 child, wallet signs input 1 only, offer input remains unsigned |
| Hard-cancel / release offer funds | Yes | Yes | Real marketplace cancellation builder |
| Counterparty commit and reveal | Yes, two approvals | No for the Core 11.5 output-key reveal | Actual SDK pair signed and finalized; Taproot reveal fails in extension with “Can not sign for input #0” |
| Paired Legacy / SegWit | Conditional | Not a Legacy pair | Requires both same-key addresses in the actual grant; never fabricate a sibling |

The eight captured collection/trait funding, acceptance and cancellation PSBTs
are in `tests/fixtures/horizon-2.3.1.json`. Regression tests verify each ECDSA
or Schnorr signature, unchanged transaction bytes, and only the selected inputs
signed. The captured SDK commit/reveal pair is also checked and finalized offline.
Earlier listing, attachment, buy and exact-offer captures were checked separately.

## Authentication

Horizon requires an explicit signing address. The adapter supplies the active
granted address, or checks an explicitly requested one against the grant.
It handles JSON-RPC errors whether the promise rejects or resolves an error.

Horizon 2.3.1 sometimes returns the opposite ECDSA recovery parity. The adapter
flips only that bit, only if the corrected signature verifies the exact message
and requested address. It never changes r/s or accepts a different identity.

Legacy and SegWit proofs declare `{ method: "BIP-137", format: "legacy_recoverable" }`.
Taproot declares `{ method: "ECDSA-BIP86", format: "legacy_recoverable" }`.
This is an explicit Horizon convention, **not Taproot BIP-137 or BIP-322**:
recover the ECDSA public key over Bitcoin Signed Message, take its x-only
internal key, apply the no-script-tree BIP-86 tweak, and require the exact address.
A script-tree address, untweaked output, wrong key, wrong message, malformed
signature, or undeclared dialect fails. Existing BIP-137/BIP-322 behavior is unchanged.

Discovery configures the address-dependent dialect automatically. Direct
adapter users should supply `messageVerificationForAddress: horizonMessageVerification`
to `WalletSession`. Keep `HORIZON_MESSAGE_VERIFICATION` only for explicitly
Legacy/SegWit sessions. Servers must add the new dialect explicitly using
`verifyBip86RecoverableMessage`, or `verifyDeclaredConnectionSignature`, as well
as their existing origin, nonce, timestamp and replay checks. Updating the SDK
alone does not update an application's server verifier.

Horizon returns a 32-byte x-only internal public key for Taproot. Hosts must
accept it where an internal key is required instead of requiring a 33-byte
compressed key or stripping its first byte.

## Generic signing versus wallet-side validation

The adapter reports selected-input signing, unsigned external inputs, the tested
DEFAULT / ALL / SINGLE|ANYONECANPAY sighashes, and sequential batches of up to
100 requests. `intentValidation: "none"` and `approvalMode: "per-psbt"` explicitly
say that Horizon does not validate marketplace intents or the whole bundle.
`marketplaceBundles` remains empty. Do not require a `fund-policy-offer` bundle
just to establish whether a generic wallet can sign its Bitcoin transactions,
and do not treat generic signing as independent wallet validation of the offer.

For generic signers, the marketplace validates the expected policy, delivery,
accounting, raw parent/child transactions and input selection before signing;
the API/signer still verifies signatures, prevouts, eligibility and settlement.
Users review marketplace terms in the site and approve each transaction in Horizon.
In tests with deliberately nonexistent prevouts, Horizon's review displayed zero
inputs and zero amounts despite embedded witness data. This does not establish
what the review displays with real chain prevouts; it is not evidence of a
wallet-side review of collection terms.

The adapter passes `sighashTypes` as Horizon's allow-list; the actual type lives
in each PSBT input. It passes the intent as `transactionInfo`. Signing a batch
opens one prompt per transaction; rejection stops the sequence. Signing does not
broadcast. Raw transaction signing is unsupported, so composes use the PSBT path
and broadcast through the node's relay.

## Confirmed limits and why

- **Taproot-source Core 11.5 inscription / large-message reveals:** the envelope
  requires the address's tweaked output key, but Horizon's script-path branch
  signs with the untweaked private key. The SDK refuses before the commit prompt.
  Use Native SegWit for this flow; full Taproot support needs a Horizon change.
- **One approval for a linked bundle:** Horizon exposes only single-PSBT requests.
  The SDK sequences them; it cannot turn them into one wallet review.
- **Immediate wallet lock, account-switch and revocation events:** no event API or
  passive account query. Cached grants cannot detect those changes immediately.
- **A signing prompt opened across auto-lock:** the tested build can land on its
  home/login page instead of resuming. Unlock and start a fresh request.
- **Default Horizon accounts are not Legacy/SegWit pairs:** the default mode grants
  SegWit and a separately derived BIP-86 Taproot key. Freewallet/Counterwallet mode
  uses the legacy derivation with Legacy/SegWit encodings. Pair support depends on
  what the selected account actually grants. Imported-address variants and funded
  paired-asset preparation are not exhaustively tested.

## Matching source

The GitHub `main` checkout is 1.7.11 and does not describe the store's Taproot
implementation. The matching version declaration is on
[`redesign` at 8be4563](https://github.com/UnspendableLabs/Horizon-Wallet/tree/8be4563425f07fbb81c1ad9a49fcf9da644cf93e)
(version 2.3.1+1). Relevant files are `lib/data/services/address_service/address_service_web.dart`,
`lib/data/services/transaction_service/transaction_service_web.dart`,
`lib/presentation/forms/sign_message/bloc/sign_message_bloc.dart`, and
`lib/domain/entities/wallet_config.dart`. Source review supports, but does not
replace, the extension tests above.

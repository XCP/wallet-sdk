# Horizon Wallet: what the adapter does, and what would make it better

Horizon exposes `window.HorizonWalletProvider.request(method, params)` with
three methods, `getAddresses`, `signPsbt` and `signMessage`, and registers
itself in `window.btc_providers`. The adapter (`@xcp/wallet-sdk/horizon`)
answers the SDK's provider surface from those three plus the node.

## How each difference is handled

| Horizon | Adapter |
|---|---|
| No active account: `getAddresses` returns every address, both encodings of a key included | The list becomes `accounts`; both encodings of one key are presented as a paired grant; a fresh grant settles on the address holding Counterparty balances; `switchAccount()` reorders the cached grant |
| No passive accounts query | The grant is cached under `xcp:horizon:addresses`; restores and reverifies never prompt |
| No connect-time proof | With `proofOnConnect` the session asks for one signature over the standard proof message |
| `signMessage` requires an explicit address, including the active account | The adapter supplies the selected cached address; an explicitly granted identity takes precedence |
| 2.3.1 can return the opposite recovery parity for an otherwise valid signature | The adapter flips only the recovery parity, and only when the existing verifier proves the exact message and requested address; r/s and the shared verifier are unchanged |
| Errors can resolve as `{ error }`, resolve inside `{ result: { error } }`, or reject | All paths produce a typed `WalletSdkError` preserving the message and numeric wallet code; malformed results produce `invalid_response` |
| Messages are BIP-137 with the p2pkh header for every family | Proofs and challenge signatures are declared `{ method: "BIP-137", format: "legacy_recoverable" }`; the verifiers derive the address's own family from the recovered key |
| PSBT only, `sighashTypes` is an allow-list, the type itself is stamped in the PSBT | Raw signing answers `unsupported_method`, which routes composes to the PSBT path; prevouts are filled from the node; the per-input list is passed as its set |
| No broadcast | The node broadcasts through the relay |
| No bundles | `signPsbts` is one prompt per PSBT |
| No events | Lock, revocation and switches inside the wallet are invisible until a request fails |

## Limits observed with Horizon 2.3.1

- Taproot sign-in through its message API. Horizon returns a legacy recoverable
  signature, not a Taproot BIP-322 proof. The adapter reports `capability` before
  opening an unusable message prompt and asks for a SegWit or Legacy account.
  Taproot account discovery and transaction signing remain available. It never
  silently substitutes a different identity or weakens the signature verifier.
- Collection/trait offer authorization requiring the `fund-policy-offer` bundle
  contract. Sequential `signPsbt` calls are not proof that the wallet validates
  the bundle as a whole; the adapter does not advertise that capability.
- Inscription commit/reveal support remains unverified; no capability is advertised.
- Instant reaction to lock or account switch.
- Recovering an already-open signing popup after wallet auto-lock. Unlock the
  wallet and start a new request; the SDK does not automatically repeat approvals.

### Compatibility evidence

The official Chrome Web Store build 2.3.1 was tested against an isolated,
unfunded test wallet. Discovery, account grants and switching worked. Supplying
the missing address allowed SegWit marketplace authentication. A subsequent SDK
connection-proof test exposed the incorrect recovery parity; the adapter repair
was checked against the real extension and a captured signature regression vector.
Taproot message
authentication remained unsupported. Six synthetic PSBT cases (SegWit and
Taproot listing signatures, attachment, buy, offer buyer and offer seller)
passed cryptographic signature checks with only the requested inputs signed.
No transactions were broadcast. Funded settlement and a real Legacy/SegWit
paired grant have not been tested. The public GitHub checkout tested alongside
it reports 1.7.11 and must not be assumed to match the store build.

## Asks for UnspendableLabs

1. `accountsChanged` and `disconnect` events, and a passive accounts method.
2. An active address, or at least a stable order, on `getAddresses`.
3. BIP-322 message signatures, or a SegWit header on BIP-137 ones.
4. Render `transactionInfo` on the signing screen.
5. A working icon in the registry entry (the current one is a truncated data URI).

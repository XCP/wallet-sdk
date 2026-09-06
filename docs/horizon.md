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
| Messages are BIP-137 with the p2pkh header for every family | Proofs and challenge signatures are declared `{ method: "BIP-137", format: "legacy_recoverable" }`; the verifiers derive the address's own family from the recovered key |
| PSBT only, `sighashTypes` is an allow-list, the type itself is stamped in the PSBT | Raw signing answers `unsupported_method`, which routes composes to the PSBT path; prevouts are filled from the node; the per-input list is passed as its set |
| No broadcast | The node broadcasts through the relay |
| No bundles | `signPsbts` is one prompt per PSBT |
| No events | Lock, revocation and switches inside the wallet are invisible until a request fails |

## Not possible on Horizon

- Inscription launches (a taproot script-path signature).
- Instant reaction to lock or account switch.

## Asks for UnspendableLabs

1. `accountsChanged` and `disconnect` events, and a passive accounts method.
2. An active address, or at least a stable order, on `getAddresses`.
3. BIP-322 message signatures, or a SegWit header on BIP-137 ones.
4. Render `transactionInfo` on the signing screen.
5. A working icon in the registry entry (the current one is a truncated data URI).

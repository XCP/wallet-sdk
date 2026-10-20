# Casa Tookan pilot

The adapter is opt-in and is not included in `KNOWN_WALLETS`:

```ts
import { CASATOOKAN_WALLET, discoverWallets, KNOWN_WALLETS } from "@xcp/wallet-sdk/web";

const wallets = discoverWallets([...KNOWN_WALLETS, CASATOOKAN_WALLET]);
// Pass wallets to WalletProvider or WalletSession.
```

Direct consumers can import `createCasaTookanProvider` from
`@xcp/wallet-sdk/casatookan`.

## Supported boundary

- Bitcoin mainnet, Legacy (`p2pkh`) and Native SegWit (`p2wpkh`).
- Passive account restore and explicit connection. Only the active account is
  exposed; no paired-address permission is inferred.
- ECDSA Bitcoin Signed Message proofs, verified against the exact message and
  account before returning them. The SDK declares the BIP-137 verification dialect.
- One PSBT per approval, with every input belonging to that account and every
  signature using SIGHASH_ALL. Legacy inputs require full parent transactions.
- Raw compose signing returns `unsupported_method`, invoking the SDK's existing
  PSBT fallback. Signing never broadcasts; explicit broadcast uses the SDK relay.
- Disconnect clears this adapter's local session. Revoke the site's permission in
  Casa Tookan to revoke the underlying grant.

Taproot, nested SegWit, selected-input signing, marketplace intents, reusable
authorizations, batches and commit/reveal are refused. This adapter does not
provide XCP Wallet's semantic intent validation. Sites must retain their own
transaction review.

Detection requires Casa Tookan's marker plus its Unisat-compatible bridge; a
standalone Unisat extension is not detected as Casa Tookan.

## Evidence and remaining native QA

Implementation follows the [integration guide](https://docs.casatookan.com/integrate.html)
and the public `https://devapp.casatookan.com/` bridge inspected on 2026-10-20.
Its `signPsbt` handler reads `autoFinalize`, not Unisat's `autoFinalized`.
Unit tests use deterministic test keys and a bridge double. They are not evidence
that the installed iOS/Android signer behaves identically.

Before enabling a production site:

1. Record the installed Casa Tookan version and platform. Connect each supported
   address type, reload, disconnect, reconnect and switch profiles.
2. Verify a message signature through the site's normal server verifier.
3. Sign an ordinary PSBT in each address type. Check returned prevouts, signatures,
   outputs, fee and finalization against the original request. Use an unfunded
   test fixture first; broadcasting is a separate funded test.
4. Reject a request, revoke permission during approval and switch away and back.
   No stale result should reach the site.
5. Confirm batch, partial-input, non-ALL and commit/reveal requests fail before
   opening an approval.

The native browser injects providers. No downloaded injection script,
development iframe bridge, CSP relaxation or CEID authentication is needed.

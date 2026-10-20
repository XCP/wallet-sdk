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

The [development-wallet contract](casatookan-dev-spec.md) records the tested provider behavior.

- Mainnet P2PKH, Native SegWit and BIP-86 Taproot key-path signing.
- Active-account-only grants, passive restore, revocation detection and account-change checks.
- Verified message proofs: BIP-137 for Legacy/SegWit, explicitly declared ECDSA-BIP86 for Taproot.
- Selected inputs, unsigned foreign inputs, and preserved foreign signatures. ECDSA sighashes
  1/2/3/129/130/131; Taproot additionally supports DEFAULT (0).
- One approval for up to 20 PSBTs, with per-request selections and sighashes. A failed or
  incomplete batch returns no results. Overlapping approvals are refused until the first finishes.
- A conservative 64 KiB per-PSBT integration limit avoids the dev wallet's preparation overflow.
  Every input must include prevout data; selected Legacy inputs require full parent transactions.
- Returned signatures are checked against the original transaction, key, prevouts and sighash.
  Existing signatures cannot disappear or change. Original PSBT metadata is retained, including
  proprietary fields stripped by Casa. Responses must remain partially signed as requested.
- Raw compose signing uses the SDK's PSBT fallback. Signing never broadcasts; explicit broadcast
  uses the SDK relay. Disconnect clears the local session; revoke the underlying grant in Casa.

Application `intent` metadata is accepted but **not validated or displayed by Casa**. The capability
report declares `intentValidation: "none"` and no wallet-validated marketplace bundles. Sites must
retain their own transaction and asset validation. Nested SegWit, multisig, Taproot script paths,
inscription/commit-reveal requests and paired-address grants remain unsupported.

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
5. Exercise selected inputs and batch approvals, and confirm unsupported script-path
   and oversized requests fail before approval.

The native browser injects providers. No downloaded injection script,
development iframe bridge, CSP relaxation or CEID authentication is needed.

## Development signer verification â€” 2026-10-20

Tested against `devapp.casatookan.com`, version 2.1.0, build
`bfbcddd-dirty`, with a newly created, unfunded wallet and the official web
bridge. A temporary HTTPS preview hosted XCPDEX's production build and a
signing fixture using this adapter.

- Legacy and Native SegWit accounts connected through XCPDEX.
- Both accounts signed the same test message; this SDK verified each signature.
  Changing the SegWit message made verification fail.
- Both accounts signed and finalized a one-input, one-output SIGHASH_ALL PSBT.
  Each synthetic parent paid 10,000 sats to the active account; its child returned
  9,000 sats to that account. The returned signatures were also verified against
  their transaction digests with `@noble/curves`. Nothing was broadcast.
- Rejecting a message returned `user_rejected`; retrying succeeded.
- XCPDEX displayed a connection rejection and supported disconnect, reconnect,
  and passive restoration without another approval.

Revoking permission while the page was closed exposed stale optimistic identity.
The adapter now invalidates it on an empty or unsupported passive account.
The browser regression also exposed missing listeners after React's development
effect restart; session restart now reattaches them.

This establishes compatibility with the web development signer. The installed
iOS/Android signer, funded DEX composition, and changes during a pending native
approval still need the native checks above.

## Expanded adapter verification — 2026-10-20

The real dev-wallet UI also passed Taproot connection and verified message signing,
a PSBT v2 shared transaction retaining a foreign SegWit signature (finalized and extracted),
a reusable SINGLE|ANYONECANPAY authorization, and twenty ordered transactions with mixed
ALL/131 sighashes in one approval. These calls used the expanded SDK adapter, not direct
bridge calls. All prevouts were synthetic and no transaction was broadcast.
Results: [adapter QA](qa/casatookan-adapter-2026-10-20.json).

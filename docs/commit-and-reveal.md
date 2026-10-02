# Taproot commit and reveal

A Counterparty message composed with Taproot encoding (an inscription, or a
message too long for an OP_RETURN) is two transactions. The *commit* funds a
P2TR output that commits to an envelope leaf carrying the message. The
*reveal* spends that output through the leaf and publishes the message. From
Counterparty Core 11.5 the reveal is unsigned and must be signed by the source
address's key: the envelope ends `<source key> OP_CHECKSIG`, and Core records
the message only when that key signed.

`useCompose` and `composeAndBroadcast` broadcast one transaction, so they refuse
`encoding: "taproot"`, `inscription: true` and any Core answer carrying a reveal
(`reveal_unsupported`). A site sends such a message as a `commit-and-reveal`
bundle instead.

## Requirements

XCP Wallet 0.14.1 or newer lists `commit-and-reveal` in
`getAddresses().signing.psbtBatch.marketplaceBundles` when it can sign one: a
software wallet whose active address is Native SegWit (P2WPKH) or Taproot
(P2TR), against a Counterparty API at 11.5 or newer.

Horizon 2.3.1 also supports the pair from a Native SegWit source, through two
separate approvals. Its adapter reports generic intent validation and untweaked
script-path signing rather than claiming to validate a marketplace bundle.
Taproot-source Core 11.5 reveals need the address's tweaked output key; Horizon
uses the untweaked key in this branch and cannot sign them. The SDK rejects that
case before prompting for the commit, with a request to use Native SegWit.
Other missing capability reports remain `capability` / `unsupported` before a
prompt. See [Horizon compatibility](horizon.md) for extension evidence.

## Use

```ts
import { finalizeCommitAndReveal } from "@xcp/wallet-sdk";

const { signCommitAndReveal, broadcastTransaction, address } = useWallet();

const signed = await signCommitAndReveal({
  source: address,           // the active P2WPKH or P2TR address
  commitPsbt,                // hex; every input the source's, with witnessUtxo
  revealPsbt,                // hex; one input spending commit output 0, one tapleaf
  // commitSighashType: 0x00 from a Taproot source (default 0x01, ALL)
  // revealSighashType: 0x01 (default 0x00, DEFAULT)
  // commitIntent: a counterparty-marketplace intent when the message is a marketplace action
});
const raw = finalizeCommitAndReveal(signed);
await broadcastTransaction(raw.commit);
await broadcastTransaction(raw.reveal);
```

`XcpWallet.signCommitAndReveal` and `WalletSession.signCommitAndReveal` are the
same without React. `commitAndRevealRequest(params)` builds the request alone,
for a host with its own transport; `signPsbts` accepts it too.

## The request

One `xcp_signPsbts` call with two requests, in this order:

| | `hex` | `signInputs` | `sighashTypes` | `intent` |
|---|---|---|---|---|
| 0 | commit PSBT | `{ [source]: [0, …, n-1] }`, every input | ALL (`0x01`) per input, or DEFAULT (`0x00`) from P2TR | optional marketplace intent, else `{ standard: "counterparty-reveal", version: 1, action: "fund_commit" }` |
| 1 | reveal PSBT | `{ [source]: [0] }` | `[0x00]` or `[0x01]` | exactly `{ standard: "counterparty-reveal", version: 1, action: "sign_reveal" }` |

The answer is `{ hexes: [signedCommit, signedReveal] }`, neither finalized. The
reveal's signature is a `tapScriptSig` on the envelope leaf. The SDK checks that
each signed PSBT is the same transaction it asked for (`transaction_mismatch`
otherwise). `finalizeCommitAndReveal` finalizes the commit and writes the
reveal's witness `[signature, leaf, control block]`, which btc-signer does not
build for an envelope leaf.

## What the wallet proves

Before signing either transaction the wallet checks the pair from its own
bytes. Any failure blocks both.

- The commit is funded only by the source: every input P2WPKH or P2TR with its
  `witnessUtxo`, all requested, none already signed. It carries no Counterparty
  payload of its own, and output 0 pays P2TR.
- The reveal has exactly one input, spending commit output 0, whose
  `witnessUtxo` is that output. It carries exactly one tapleaf (leaf version
  `0xc0`) and nothing signed.
- The leaf is a canonical envelope, `OP_FALSE OP_IF … OP_ENDIF <key> OP_CHECKSIG`,
  and is the output's only leaf. `<key>` is the source's x-only key (for a
  Taproot source, its internal or output key). The output's internal key is
  that key, another key of the source, or the BIP-341 unspendable (NUMS) key.
- The envelope decodes to a Counterparty message, the reveal carries the bare
  zero-value `CNTRPRTY` marker (`6a08434e545250525459`), and its fee is at a
  sane rate.

`commitAndRevealRequest` refuses early, as `invalid_argument`, what it can see
cheaply: a source that is not P2WPKH or P2TR, a reveal that is not one input
spending commit output 0 through one tapleaf, a missing marker, or a sighash
outside the contract.

## From a Core 11.5 compose

Compose with `encoding=taproot` from the active address, with `multisig_pubkey`
set to the address's public key from `getAddresses()` so the envelope closes
with it. Build the commit PSBT from `rawtransaction`, giving each input its
`witnessUtxo` (`lock_scripts`, `inputs_values`). Build the reveal PSBT from
`reveal_rawtransaction`, giving input 0 `witnessUtxo` = commit output 0
(`reveal_lock_scripts[0]`, `reveal_inputs_values[0]`) and one `tapLeafScript`:
`[reveal_control_block, envelope_script + "c0"]`.

`xcp_signPsbt` no longer takes a `reveal` parameter; a reveal is always signed
by the wallet, through this bundle.

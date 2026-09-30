import { base64, hex as hexCodec } from "@scure/base";
import { Address, TaprootControlBlock } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { scureNetwork } from "@/crypto/network";
import { WalletSdkError } from "@/errors";
import type { SignPsbtParams, SignPsbtsRequest } from "@/provider/types";
import { assertSameTransaction, readPsbt } from "@/transaction/verify";

/**
 * A Taproot-encoded Counterparty message (an inscription, or a message too long
 * for OP_RETURN) is two transactions: the commit, which funds a P2TR output
 * committing to an envelope leaf, and the reveal, which spends that output
 * through the leaf and publishes the message. From Core 11.5 the reveal must be
 * signed by the source key. XCP Wallet 0.14.1+ signs both in one approval as a
 * `commit-and-reveal` bundle, listed in `signing.psbtBatch.marketplaceBundles`.
 *
 * The wallet proves the pair from its bytes before signing; the checks here only
 * refuse, before any prompt, a request the wallet would refuse anyway.
 */

export const COMMIT_REVEAL_STANDARD = "counterparty-reveal";

/** Request 1's intent, exactly. */
export const REVEAL_INTENT = { standard: COMMIT_REVEAL_STANDARD, version: 1, action: "sign_reveal" } as const;
/** Request 0's intent when the message is not a marketplace action. */
export const COMMIT_INTENT = { standard: COMMIT_REVEAL_STANDARD, version: 1, action: "fund_commit" } as const;

/** The bare zero-value `CNTRPRTY` OP_RETURN every reveal carries. */
export const REVEAL_MARKER_SCRIPT = "6a08434e545250525459";

const SIGHASH_DEFAULT = 0x00;
const SIGHASH_ALL = 0x01;

export interface CommitAndRevealParams<Intent = unknown> {
  /** The address both transactions are signed by: the wallet's active P2WPKH or P2TR address. */
  source: string;
  /** Unsigned commit PSBT, hex, every input the source's with its `witnessUtxo`. */
  commitPsbt: string;
  /** Unsigned reveal PSBT, hex: one input spending commit output 0, one tapleaf (the envelope). */
  revealPsbt: string;
  /** Every commit input's sighash: ALL (default), or DEFAULT from a P2TR source. */
  commitSighashType?: typeof SIGHASH_DEFAULT | typeof SIGHASH_ALL;
  /** The reveal's sighash: DEFAULT (default) or ALL. */
  revealSighashType?: typeof SIGHASH_DEFAULT | typeof SIGHASH_ALL;
  /** A `counterparty-marketplace` intent when the message is a marketplace action; `COMMIT_INTENT` otherwise. */
  commitIntent?: Intent;
}

/** The two signed PSBTs, hex, neither finalized. The reveal's signature is a `tapScriptSig` on the envelope leaf. */
export interface CommitAndRevealResult {
  commit: string;
  reveal: string;
}

/** Whether a bundle request claims the reveal half of a `commit-and-reveal` pair. */
export function isRevealIntent(intent: unknown): boolean {
  return (
    typeof intent === "object" &&
    intent !== null &&
    (intent as { standard?: unknown }).standard === COMMIT_REVEAL_STANDARD &&
    (intent as { action?: unknown }).action === "sign_reveal"
  );
}

/** The caller's bytes, as hex, never re-serialized. */
const asHex = (encoded: string) =>
  /^[0-9a-f]+$/i.test(encoded) && encoded.length % 2 === 0
    ? encoded.toLowerCase()
    : hexCodec.encode(base64.decode(encoded));

const refuse = (message: string): never => {
  throw new WalletSdkError("invalid_argument", message);
};

function sourceType(source: string): "wpkh" | "tr" {
  let type: string | undefined;
  try {
    type = Address(scureNetwork()).decode(source).type;
  } catch {
    return refuse("commit-and-reveal source is not an address");
  }
  if (type !== "wpkh" && type !== "tr") refuse("commit-and-reveal needs a Native SegWit or Taproot source");
  return type as "wpkh" | "tr";
}

/**
 * The `xcp_signPsbts` request for a commit and its reveal. Refuses a pair whose
 * reveal does not spend commit output 0 through one tapleaf, or lacks the marker.
 */
export function commitAndRevealRequest<Intent = unknown>(
  params: CommitAndRevealParams<Intent>,
): SignPsbtsRequest<Intent | typeof COMMIT_INTENT | typeof REVEAL_INTENT> {
  const { source, commitPsbt, revealPsbt } = params;
  const type = sourceType(source);
  const commitSighash = params.commitSighashType ?? SIGHASH_ALL;
  const revealSighash = params.revealSighashType ?? SIGHASH_DEFAULT;
  if (commitSighash !== SIGHASH_ALL && !(commitSighash === SIGHASH_DEFAULT && type === "tr"))
    refuse("Commit inputs sign SIGHASH_ALL, or SIGHASH_DEFAULT from a Taproot source");
  if (revealSighash !== SIGHASH_DEFAULT && revealSighash !== SIGHASH_ALL)
    refuse("The reveal signs SIGHASH_DEFAULT or SIGHASH_ALL");

  const commit = readPsbt(commitPsbt);
  const reveal = readPsbt(revealPsbt);
  if (commit.inputsLength < 1 || commit.outputsLength < 1) refuse("Commit PSBT has no inputs or outputs");
  if (reveal.inputsLength !== 1) refuse("The reveal must have exactly one input");
  const spent = reveal.getInput(0);
  if (!spent.txid || hexCodec.encode(spent.txid) !== commit.id || spent.index !== 0)
    refuse("The reveal must spend commit output 0");
  if (spent.tapLeafScript?.length !== 1) refuse("The reveal input must carry exactly one tapleaf");
  const marked = Array.from({ length: reveal.outputsLength }, (_, i) => reveal.getOutput(i)).some(
    (output) =>
      output.amount === 0n && output.script && hexCodec.encode(output.script) === REVEAL_MARKER_SCRIPT,
  );
  if (!marked) refuse("The reveal must carry the zero-value CNTRPRTY marker output");

  const commitInputs = Array.from({ length: commit.inputsLength }, (_, index) => index);
  const commitRequest: SignPsbtParams<Intent | typeof COMMIT_INTENT> = {
    hex: asHex(commitPsbt),
    signInputs: { [source]: commitInputs },
    sighashTypes: commitInputs.map(() => commitSighash),
    intent: params.commitIntent ?? COMMIT_INTENT,
  };
  const revealRequest: SignPsbtParams<typeof REVEAL_INTENT> = {
    hex: asHex(revealPsbt),
    signInputs: { [source]: [0] },
    sighashTypes: [revealSighash],
    intent: REVEAL_INTENT,
  };
  return { method: "xcp_signPsbts", params: [{ requests: [commitRequest, revealRequest] }] };
}

/** Bind the wallet's answer to what was asked: two PSBTs, each the same transaction as its request. */
export function readCommitAndRevealResult(
  request: SignPsbtsRequest<unknown>,
  hexes: readonly string[],
): CommitAndRevealResult {
  const [commitRequest, revealRequest] = request.params[0].requests;
  if (hexes.length !== 2 || !commitRequest || !revealRequest)
    throw new WalletSdkError("invalid_response", "Wallet did not return a commit and a reveal");
  assertSameTransaction(readPsbt(commitRequest.hex), readPsbt(hexes[0]!));
  assertSameTransaction(readPsbt(revealRequest.hex), readPsbt(hexes[1]!));
  return { commit: hexes[0]!, reveal: hexes[1]! };
}

/**
 * Finalize both signed PSBTs into raw transactions, commit first. The commit's
 * inputs finalize as usual; the reveal's witness is `[signature, envelope leaf,
 * control block]`, which btc-signer does not build for an envelope leaf itself.
 * Broadcast the commit, then the reveal.
 */
export function finalizeCommitAndReveal(signed: CommitAndRevealResult): { commit: string; reveal: string } {
  const fail = (message: string, cause?: unknown): never => {
    throw new WalletSdkError("invalid_response", message, { cause });
  };
  const commit = readPsbt(signed.commit);
  try {
    commit.finalize();
  } catch (cause) {
    fail("Signed commit cannot be finalized", cause);
  }
  const reveal = readPsbt(signed.reveal);
  const input = reveal.inputsLength === 1 ? reveal.getInput(0) : undefined;
  const leaf = input?.tapLeafScript?.length === 1 ? input.tapLeafScript[0] : undefined;
  const signature = input?.tapScriptSig?.length === 1 ? input.tapScriptSig[0] : undefined;
  if (!input || !leaf || !signature) return fail("Signed reveal lacks its one leaf signature");
  const [controlBlock, scriptWithVersion] = leaf;
  const script = scriptWithVersion.subarray(0, -1);
  const version = scriptWithVersion[scriptWithVersion.length - 1]!;
  if (hexCodec.encode(signature[0].leafHash) !== hexCodec.encode(tapLeafHash(script, version)))
    fail("Reveal signature is not over the envelope leaf");
  if (!input.txid || hexCodec.encode(input.txid) !== commit.id)
    fail("Reveal does not spend the signed commit");
  try {
    reveal.updateInput(
      0,
      { finalScriptWitness: [signature[1], script, TaprootControlBlock.encode(controlBlock)] },
      true,
    );
    return { commit: hexCodec.encode(commit.extract()), reveal: hexCodec.encode(reveal.extract()) };
  } catch (cause) {
    return fail("Signed reveal cannot be finalized", cause);
  }
}

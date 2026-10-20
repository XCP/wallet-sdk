import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hex } from "@scure/base";
import { p2pkh, p2tr, p2wpkh, RawTx, Transaction } from "@scure/btc-signer";
import { WalletSdkError } from "@/errors";
import type { WalletAddress } from "@/provider/types";
import { assertSameTransaction, readPsbt, readRawTransaction, VERIFY_TX_OPTIONS } from "@/transaction/verify";

export const CASA_BATCH_LIMIT = 20;
// Larger requests overflow the dev wallet's PSBT preparation, before signing.
export const CASA_PSBT_BYTES = 65_536;
export const CASA_SIGHASHES = [0, 1, 2, 3, 129, 130, 131];

export interface CasaSigningOptions {
  autoFinalize: false;
  toSignInputs: { index: number; address: string; sighashTypes: number[] }[];
}

const sameBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a === undefined || b === undefined ? a === b : hex.encode(a) === hex.encode(b);

function prevout(tx: Transaction, index: number) {
  const input = tx.getInput(index);
  let output = input.witnessUtxo;
  if (input.nonWitnessUtxo) {
    const parent = readRawTransaction(hex.encode(RawTx.encode(input.nonWitnessUtxo)));
    if (!input.txid || parent.id !== hex.encode(input.txid) || input.index === undefined)
      throw new WalletSdkError("transaction_mismatch", "PSBT parent does not match its input");
    const candidate = parent.getOutput(input.index);
    if (candidate.amount === undefined || !candidate.script)
      throw new WalletSdkError("invalid_argument", "PSBT parent output is missing");
    if (output && (output.amount !== candidate.amount || !sameBytes(output.script, candidate.script)))
      throw new WalletSdkError("transaction_mismatch", "PSBT prevouts disagree");
    output = { amount: candidate.amount, script: candidate.script };
  }
  if (!output) throw new WalletSdkError("invalid_argument", "Include prevout data for every input");
  return output;
}

function payment(account: WalletAddress) {
  const key = hex.decode(account.publicKey);
  return account.type === "p2tr" ? p2tr(key.slice(1)) : account.type === "p2pkh" ? p2pkh(key) : p2wpkh(key);
}

export function prepareCasaPsbt(value: unknown, account: WalletAddress) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WalletSdkError("invalid_argument", "A PSBT request is required");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => !["hex", "signInputs", "sighashTypes", "intent"].includes(key)))
    throw new WalletSdkError("capability", "Casa Tookan does not support inscription or reveal signing");
  if (typeof request.hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(request.hex))
    throw new WalletSdkError("invalid_argument", "A hex PSBT is required");
  if (request.hex.length / 2 > CASA_PSBT_BYTES)
    throw new WalletSdkError("capability", "Casa Tookan supports PSBTs up to 64 KiB in this integration");
  const tx = Transaction.fromPSBT(hex.decode(request.hex), {
    ...VERIFY_TX_OPTIONS,
    unknown: "ignore",
    proprietary: "ignore",
  });
  if (!tx.inputsLength || !tx.outputsLength)
    throw new WalletSdkError("invalid_argument", "A transaction needs inputs and outputs");
  let indices = Array.from({ length: tx.inputsLength }, (_, index) => index);
  if (request.signInputs !== undefined) {
    if (!request.signInputs || typeof request.signInputs !== "object" || Array.isArray(request.signInputs))
      throw new WalletSdkError("invalid_argument", "Invalid signing inputs");
    const entries = Object.entries(request.signInputs);
    const selected: unknown = entries[0]?.[1];
    if (entries.length !== 1 || entries[0]?.[0] !== account.address || !Array.isArray(selected))
      throw new WalletSdkError("capability", "Select inputs belonging to the active Casa Tookan account");
    if (
      selected.length === 0 ||
      new Set(selected).size !== selected.length ||
      selected.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= tx.inputsLength)
    )
      throw new WalletSdkError("invalid_argument", "Select distinct, valid input indices");
    indices = [...selected];
  }
  if (
    request.sighashTypes !== undefined &&
    (!Array.isArray(request.sighashTypes) || request.sighashTypes.length !== tx.inputsLength)
  )
    throw new WalletSdkError("invalid_argument", "Sighash types must be indexed by transaction input");
  const prevouts = Array.from({ length: tx.inputsLength }, (_, index) => prevout(tx, index));
  const expected = payment(account).script;
  const options: CasaSigningOptions = {
    autoFinalize: false,
    toSignInputs: indices.map((index) => {
      const input = tx.getInput(index);
      if (!sameBytes(prevouts[index]!.script, expected))
        throw new WalletSdkError(
          "capability",
          "Selected input does not belong to the active Casa Tookan account",
        );
      if (account.type === "p2pkh" && !input.nonWitnessUtxo)
        throw new WalletSdkError("invalid_argument", "Legacy signing requires the full parent transaction");
      if (input.tapLeafScript?.length || input.tapMerkleRoot || input.redeemScript || input.witnessScript)
        throw new WalletSdkError(
          "capability",
          "Casa Tookan supports single-key inputs and BIP-86 key-path signing",
        );
      if (input.finalScriptSig?.length || input.finalScriptWitness?.length)
        throw new WalletSdkError("invalid_argument", "Selected input is already finalized");
      const sighash = input.sighashType ?? (account.type === "p2tr" ? 0 : 1);
      if (!CASA_SIGHASHES.includes(sighash) || (sighash === 0 && account.type !== "p2tr"))
        throw new WalletSdkError("capability", "Unsupported Casa Tookan sighash");
      if (request.sighashTypes !== undefined && (request.sighashTypes as unknown[])[index] !== sighash)
        throw new WalletSdkError("invalid_argument", "Requested sighash differs from the PSBT");
      if ((sighash & 0x1f) === 3 && index >= tx.outputsLength)
        throw new WalletSdkError("invalid_argument", "SIGHASH_SINGLE requires a matching output");
      return { index, address: account.address, sighashTypes: [sighash] };
    }),
  };
  return { hex: request.hex, tx, options, account, prevouts };
}

function legacyDigest(tx: Transaction, index: number, script: Uint8Array, hashType: number) {
  const raw = RawTx.decode(tx.unsignedTx);
  const mode = hashType & 0x1f;
  raw.inputs = raw.inputs.map((input, i) => ({
    ...input,
    finalScriptSig: i === index ? script : new Uint8Array(),
    sequence: i !== index && mode !== 1 ? 0 : input.sequence,
  }));
  if (hashType & 0x80) raw.inputs = [raw.inputs[index]!];
  if (mode === 2) raw.outputs = [];
  if (mode === 3)
    raw.outputs = raw.outputs
      .slice(0, index + 1)
      .map((output, i) => (i === index ? output : { amount: 0xffffffffffffffffn, script: new Uint8Array() }));
  return sha256(sha256(Uint8Array.from([...RawTx.encode(raw), hashType, 0, 0, 0])));
}

export function verifyCasaPsbt(prepared: ReturnType<typeof prepareCasaPsbt>, signed: unknown): string {
  if (typeof signed !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(signed))
    throw new WalletSdkError("invalid_response", "Casa Tookan returned an invalid PSBT");
  const result = readPsbt(signed);
  const { tx, options, account, prevouts } = prepared;
  assertSameTransaction(tx, result);
  const selected = new Set(options.toSignInputs.map(({ index }) => index));
  for (let index = 0; index < tx.inputsLength; index++) {
    const before = tx.getInput(index);
    const after = result.getInput(index);
    const output = prevout(result, index);
    if (
      output.amount !== prevouts[index]!.amount ||
      !sameBytes(output.script, prevouts[index]!.script) ||
      before.sighashType !== after.sighashType
    )
      throw new WalletSdkError("transaction_mismatch", "Casa Tookan changed input signing data");
    for (const [key, signature] of before.partialSig ?? []) {
      if (!after.partialSig?.some(([k, sig]) => sameBytes(k, key) && sameBytes(sig, signature)))
        throw new WalletSdkError("transaction_mismatch", "Casa Tookan changed an existing signature");
    }
    for (const field of ["tapKeySig", "tapScriptSig", "finalScriptSig", "finalScriptWitness"] as const) {
      if (
        (!selected.has(index) || before[field] !== undefined) &&
        JSON.stringify(before[field]) !== JSON.stringify(after[field])
      )
        throw new WalletSdkError(
          "transaction_mismatch",
          "Casa Tookan changed an existing or unselected signature",
        );
    }
    if (!selected.has(index) && (before.partialSig?.length ?? 0) !== (after.partialSig?.length ?? 0))
      throw new WalletSdkError("transaction_mismatch", "Casa Tookan signed an unselected input");
  }
  const publicKey = hex.decode(account.publicKey);
  for (const { index, sighashTypes } of options.toSignInputs) {
    const input = result.getInput(index);
    const hashType = sighashTypes[0]!;
    let valid = false;
    try {
      if (account.type === "p2tr") {
        const sig = input.tapKeySig;
        const expectedLength = hashType === 0 ? 64 : 65;
        if (sig?.length === expectedLength && (hashType === 0 || sig[64] === hashType)) {
          const digest = tx.preimageWitnessV1(
            index,
            prevouts.map((p) => p.script),
            hashType,
            prevouts.map((p) => p.amount),
          );
          valid = schnorr.verify(sig.slice(0, 64), digest, payment(account).script.slice(2));
          if (valid) tx.updateInput(index, { tapKeySig: sig, tapInternalKey: publicKey.slice(1) }, true);
        }
      } else {
        const sig = input.partialSig?.find(([key]) => sameBytes(key, publicKey))?.[1];
        if (sig && sig[sig.length - 1] === hashType) {
          const script = p2pkh(publicKey).script;
          const digest =
            account.type === "p2pkh"
              ? legacyDigest(tx, index, script, hashType)
              : tx.preimageWitnessV0(index, script, hashType, prevouts[index]!.amount);
          valid = secp256k1.verify(
            secp256k1.Signature.fromDER(sig.slice(0, -1)).toCompactRawBytes(),
            digest,
            publicKey,
          );
          if (valid) tx.updateInput(index, { partialSig: [[publicKey, sig]] }, true);
        }
      }
    } catch {
      valid = false;
    }
    if (!valid)
      throw new WalletSdkError(
        "invalid_response",
        "Casa Tookan returned a missing or invalid input signature",
      );
  }
  // Return the original metadata with verified signatures; Casa strips proprietary fields.
  return hex.encode(tx.toPSBT());
}

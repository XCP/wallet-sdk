import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { assertSameTransaction, readPsbt, readRawTransaction, VERIFY_TX_OPTIONS } from "@/transaction/verify";
import fixture from "./fixtures/core-compose.json";

const original = readRawTransaction(fixture.rawtransaction);

function variant(change: {
  amount?: bigint;
  script?: Uint8Array;
  index?: number;
  sequence?: number;
  version?: number;
  lockTime?: number;
  signature?: Uint8Array;
}) {
  const transaction = new Transaction({
    ...VERIFY_TX_OPTIONS,
    version: change.version ?? original.version,
    lockTime: change.lockTime ?? original.lockTime,
  });
  for (let i = 0; i < original.outputsLength; i++) {
    const output = original.getOutput(i);
    transaction.addOutput({
      ...output,
      ...(i === 0 && change.amount !== undefined ? { amount: change.amount } : {}),
      ...(i === 0 && change.script ? { script: change.script } : {}),
    });
  }
  for (let i = 0; i < original.inputsLength; i++) {
    const input = original.getInput(i);
    transaction.addInput({
      ...input,
      ...(change.index !== undefined ? { index: change.index } : {}),
      ...(change.sequence !== undefined ? { sequence: change.sequence } : {}),
      ...(change.signature ? { finalScriptSig: change.signature } : {}),
    });
  }
  return transaction;
}

describe("Core fixture Bitcoin envelope verification", () => {
  it("accepts the actual Core fixture and equivalent base64 PSBT", () => {
    expect(original.outputsLength).toBe(3);
    const psbt = base64.encode(original.toPSBT());
    expect(() => assertSameTransaction(original, readPsbt(psbt))).not.toThrow();
  });

  it("allows script signatures to change while binding the exact envelope", () => {
    const signed = readRawTransaction(variant({ signature: hex.decode("51") }).hex);
    expect(() => assertSameTransaction(original, signed)).not.toThrow();
  });

  it.each([
    ["one satoshi", { amount: original.getOutput(0).amount! + 1n }],
    ["recipient script", { script: hex.decode("6a") }],
    ["input outpoint", { index: 1 }],
    ["sequence", { sequence: 1 }],
    ["version", { version: 1 }],
    ["locktime", { lockTime: 1 }],
  ] as const)("rejects changed %s", (_name, change) => {
    expect(() => assertSameTransaction(original, variant(change))).toThrow(
      "Transaction inputs, outputs or amounts changed",
    );
  });

  it.each(["", "0", "nothex", fixture.rawtransaction.slice(0, -2)])(
    "rejects malformed transaction bytes",
    (raw) => {
      expect(() => readRawTransaction(raw)).toThrow("Invalid transaction bytes");
    },
  );
});

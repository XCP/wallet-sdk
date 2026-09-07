import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { WalletSdkError } from "@/errors";

export const VERIFY_TX_OPTIONS = {
  allowUnknownInputs: true,
  allowUnknownOutputs: true,
  allowLegacyWitnessUtxo: true,
  disableScriptCheck: true,
} as const;

export function readRawTransaction(raw: string): Transaction {
  try {
    const tx = Transaction.fromRaw(hex.decode(raw), VERIFY_TX_OPTIONS);
    if (tx.inputsLength === 0 || tx.outputsLength === 0) throw new Error("missing inputs or outputs");
    return tx;
  } catch (cause) {
    throw new WalletSdkError("invalid_response", "Invalid transaction bytes", { cause });
  }
}

export function readPsbt(encoded: string): Transaction {
  try {
    const bytes =
      /^[0-9a-f]+$/i.test(encoded) && encoded.length % 2 === 0 ? hex.decode(encoded) : base64.decode(encoded);
    return Transaction.fromPSBT(bytes, VERIFY_TX_OPTIONS);
  } catch (cause) {
    throw new WalletSdkError("invalid_response", "Invalid PSBT bytes", { cause });
  }
}

/**
 * Compare the Bitcoin envelope: version, locktime, input outpoints/sequences,
 * output scripts and exact amounts. Only scriptSig/witness signatures may differ.
 * This does NOT prove that Core encoded the requested Counterparty message.
 */
export function assertSameTransaction(expected: Transaction, actual: Transaction): void {
  if (hex.encode(expected.unsignedTx) !== hex.encode(actual.unsignedTx)) {
    throw new WalletSdkError("transaction_mismatch", "Transaction inputs, outputs or amounts changed");
  }
}

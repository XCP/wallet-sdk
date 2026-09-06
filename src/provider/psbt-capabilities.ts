import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { WalletSdkError } from "../errors";

/**
 * The wallet's own account of what it can sign, and a check against it.
 *
 * A newer extension reports, per method, which sighash types it produces,
 * whether it can sign a subset of a transaction's inputs or needs all of
 * them, and what it requires of inputs that belong to someone else. A host
 * that builds multi-party PSBTs — the marketplace's settlement flows — can
 * reject a request the wallet is known to refuse before opening the approval
 * screen, with a reason a person can act on. Older builds report nothing,
 * and then the wallet's own validation stays authoritative.
 */

export interface ProviderPsbtSigningMethodCapabilities {
  supported: boolean;
  sighashTypes: number[];
  inputScope: "selected" | "all";
  externalInputs?: "any" | "presigned";
}

export interface ProviderPsbtSigningCapabilities {
  psbt: ProviderPsbtSigningMethodCapabilities;
  psbtBatch: ProviderPsbtSigningMethodCapabilities & {
    maxRequests: number;
  };
}

interface SignPsbtParamsLike {
  hex: string;
  signInputs?: Record<string, number[]>;
  sighashTypes?: number[];
  intent?: unknown;
}

export interface SignPsbtRequestLike {
  method: "xcp_signPsbt";
  params: readonly [SignPsbtParamsLike];
}

export interface SignPsbtsRequestLike {
  method: "xcp_signPsbts";
  params: readonly [{ requests: readonly SignPsbtParamsLike[] }];
}

export type ProviderSigningCapabilityErrorCode =
  | "unsupported"
  | "batch_limit"
  | "input_scope"
  | "sighash"
  | "invalid_request";

/** A WalletSdkError with code `capability`; `reason` says which rule refused. */
export class ProviderSigningCapabilityError extends WalletSdkError {
  constructor(
    message: string,
    public readonly reason: ProviderSigningCapabilityErrorCode,
  ) {
    super("capability", message);
    this.name = "ProviderSigningCapabilityError";
  }
}

/** How a request's intent is named in an error. A host that attaches typed
 *  intents supplies its own vocabulary; the default is the plain word. */
export type IntentDescriber = (intent: unknown) => string;

const describeAsTransaction: IntentDescriber = () => "transaction";

const PSBT_OPTS = {
  allowUnknownInputs: true,
  allowUnknownOutputs: true,
  allowLegacyWitnessUtxo: true,
  disableScriptCheck: true,
} as const;

const methodCapabilities = (value: unknown): ProviderPsbtSigningMethodCapabilities | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { supported, sighashTypes, inputScope, externalInputs } = value as Record<string, unknown>;
  if (
    typeof supported !== "boolean" ||
    !Array.isArray(sighashTypes) ||
    sighashTypes.some((item) => !Number.isSafeInteger(item) || item < 0 || item > 0xff) ||
    (inputScope !== "selected" && inputScope !== "all") ||
    (externalInputs !== undefined && externalInputs !== "any" && externalInputs !== "presigned")
  ) {
    return null;
  }
  return {
    supported,
    sighashTypes: [...sighashTypes] as number[],
    inputScope,
    ...(externalInputs ? { externalInputs } : {}),
  };
};

/** Parse the optional, untrusted capability report returned by xcp_getAddresses. */
export function parseProviderPsbtSigningCapabilities(value: unknown): ProviderPsbtSigningCapabilities | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { psbt, psbtBatch } = value as Record<string, unknown>;
  const single = methodCapabilities(psbt);
  const batch = methodCapabilities(psbtBatch);
  const maxRequests =
    psbtBatch && typeof psbtBatch === "object" && !Array.isArray(psbtBatch)
      ? (psbtBatch as Record<string, unknown>).maxRequests
      : undefined;
  if (
    !single ||
    !batch ||
    !Number.isSafeInteger(maxRequests) ||
    (maxRequests as number) < 0 ||
    (maxRequests as number) > 100
  ) {
    return null;
  }
  return {
    psbt: single,
    psbtBatch: { ...batch, maxRequests: maxRequests as number },
  };
}

interface PsbtInputShape {
  hasSignatures: boolean;
  sighashType?: number;
}

const psbtInputShapes = (psbtHex: string): PsbtInputShape[] => {
  try {
    const transaction = Transaction.fromPSBT(hex.decode(psbtHex), PSBT_OPTS);
    return Array.from({ length: transaction.inputsLength }, (_, inputIndex) => {
      const input = transaction.getInput(inputIndex);
      return {
        hasSignatures: Boolean(
          input?.partialSig?.length ||
            input?.tapKeySig ||
            input?.finalScriptSig?.length ||
            input?.finalScriptWitness?.length,
        ),
        ...(input?.sighashType === undefined ? {} : { sighashType: input.sighashType }),
      };
    });
  } catch (error) {
    throw new ProviderSigningCapabilityError(
      `Cannot check wallet compatibility because the PSBT is invalid: ${String(error)}`,
      "invalid_request",
    );
  }
};

function assertMethodCanSign(
  method: ProviderPsbtSigningMethodCapabilities,
  request: SignPsbtParamsLike,
  describe: IntentDescriber,
): void {
  const action = describe(request.intent);
  if (!method.supported) {
    throw new ProviderSigningCapabilityError(
      `The connected wallet account cannot sign this ${action}.`,
      "unsupported",
    );
  }
  const inputs = psbtInputShapes(request.hex);
  const inputCount = inputs.length;
  // A request with no explicit selection asks for every input.
  const requested = request.signInputs
    ? Object.values(request.signInputs).flat()
    : inputs.map((_, index) => index);
  if (
    requested.length === 0 ||
    new Set(requested).size !== requested.length ||
    requested.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= inputCount)
  ) {
    throw new ProviderSigningCapabilityError(
      `The ${action} has an invalid wallet input selection.`,
      "invalid_request",
    );
  }
  const ordered = [...requested].sort((left, right) => left - right);
  if (
    method.inputScope === "all" &&
    (ordered.length !== inputCount || ordered.some((inputIndex, index) => inputIndex !== index))
  ) {
    throw new ProviderSigningCapabilityError(
      `This wallet can sign only transactions where it controls every Bitcoin input. The ${action} combines wallet inputs with another party or a reusable authorization and is not supported yet.`,
      "input_scope",
    );
  }
  if (method.externalInputs === "presigned") {
    const requestedSet = new Set(requested);
    for (let inputIndex = 0; inputIndex < inputCount; inputIndex++) {
      if (requestedSet.has(inputIndex)) continue;
      const input = inputs[inputIndex]!;
      if (!input.hasSignatures) {
        throw new ProviderSigningCapabilityError(
          `This wallet requires the other party to sign input ${inputIndex} before it can complete this ${action}.`,
          "input_scope",
        );
      }
      const externalSighash = input.sighashType ?? 0x01;
      if (!method.sighashTypes.includes(externalSighash)) {
        throw new ProviderSigningCapabilityError(
          `This wallet cannot preserve the signature already present on input ${inputIndex} for this ${action}.`,
          "sighash",
        );
      }
    }
  }
  // No sighash list means the default, SIGHASH_ALL, for every input.
  for (const inputIndex of requested) {
    const sighashType = request.sighashTypes ? request.sighashTypes[inputIndex] : 0x01;
    if (sighashType === undefined || !method.sighashTypes.includes(sighashType)) {
      throw new ProviderSigningCapabilityError(
        `This wallet cannot create the signature required for this ${action}.`,
        "sighash",
      );
    }
  }
}

/**
 * Reject a known-incompatible single request before opening the wallet.
 * Missing capabilities mean an older provider, so its own validation remains authoritative.
 */
export function assertProviderCanSignPsbt(
  request: SignPsbtRequestLike,
  capabilities: ProviderPsbtSigningCapabilities | null | undefined,
  describe: IntentDescriber = describeAsTransaction,
): void {
  if (!capabilities) return;
  assertMethodCanSign(capabilities.psbt, request.params[0], describe);
}

/** Prove every batch item before the first provider request, preserving atomic UX. */
export function assertProviderCanSignPsbts(
  request: SignPsbtsRequestLike,
  capabilities: ProviderPsbtSigningCapabilities | null | undefined,
  describe: IntentDescriber = describeAsTransaction,
): void {
  if (!capabilities) return;
  const requests = request.params[0].requests;
  if (requests.length < 1 || requests.length > capabilities.psbtBatch.maxRequests) {
    throw new ProviderSigningCapabilityError(
      `This wallet can sign at most ${capabilities.psbtBatch.maxRequests} linked transactions at once.`,
      "batch_limit",
    );
  }
  for (const item of requests) assertMethodCanSign(capabilities.psbtBatch, item, describe);
}

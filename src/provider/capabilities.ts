import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { WalletSdkError } from "@/errors";
import { isRevealIntent } from "@/provider/commit-reveal";

/**
 * The wallet's reported PSBT signing contract and a pre-flight check against it.
 * Absent capabilities defer to the wallet's own validation.
 */

export interface ProviderPsbtSigningMethodCapabilities {
  supported: boolean;
  sighashTypes: number[];
  inputScope: "selected" | "all";
  externalInputs?: "any" | "presigned";
}

/**
 * Linked `xcp_signPsbts` bundle kinds a wallet proves as a whole. Unknown kinds a newer
 * wallet reports are kept as strings, so a site can test for them before the SDK names them.
 */
export type MarketplaceBundleKind =
  | "attach-and-list"
  | "bulk-fanout"
  | "prepare-assets"
  | "bulk-attach"
  | "bulk-listing"
  | "authorize-offers"
  | "fund-and-authorize-offers"
  | "fund-policy-offer"
  | "acceptance-cpfp"
  /** A Taproot commit and its reveal, signed with the source key. XCP Wallet 0.14.1+, Core API 11.5+. */
  | "commit-and-reveal"
  | (string & {});

export interface ProviderPsbtSigningCapabilities {
  psbt: ProviderPsbtSigningMethodCapabilities;
  psbtBatch: ProviderPsbtSigningMethodCapabilities & {
    /** Most requests in one bundle. */
    maxRequests: number;
    /** Most alternatives in one `fund-policy-offer` bundle, the one kind allowed past `maxRequests`; 0 when not reported. */
    maxPolicyOfferAlternatives: number;
    /** Bundle kinds this wallet proves as a whole; `[]` when not reported (older wallets). */
    marketplaceBundles: MarketplaceBundleKind[];
  };
}

/** Bundle size when the wallet reports no capabilities: what every XCP Wallet accepts. */
export const SIGN_PSBTS_BUNDLE_LIMIT = 8;
/** A reported bundle size above this is not believed. */
const MAX_REPORTED_BUNDLE = 1000;

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

/** Names a request's intent in an error message. */
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
  if (!single || !batch) return null;
  const { maxRequests, maxPolicyOfferAlternatives, marketplaceBundles } = psbtBatch as Record<
    string,
    unknown
  >;
  const isCount = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_REPORTED_BUNDLE;
  if (!isCount(maxRequests)) return null;
  if (maxPolicyOfferAlternatives !== undefined && !isCount(maxPolicyOfferAlternatives)) return null;
  return {
    psbt: single,
    psbtBatch: {
      ...batch,
      maxRequests: maxRequests as number,
      maxPolicyOfferAlternatives: (maxPolicyOfferAlternatives as number | undefined) ?? 0,
      marketplaceBundles: Array.isArray(marketplaceBundles)
        ? [...new Set(marketplaceBundles.filter((kind): kind is string => typeof kind === "string"))]
        : [],
    },
  };
}

/** Whether the wallet reports that it proves this bundle kind as a whole. */
export function supportsMarketplaceBundle(
  capabilities: ProviderPsbtSigningCapabilities | null | undefined,
  kind: MarketplaceBundleKind,
): boolean {
  return Boolean(
    capabilities?.psbtBatch.supported && capabilities.psbtBatch.marketplaceBundles.includes(kind),
  );
}

/**
 * Refuse, as `capability` / `unsupported`, a wallet that does not list
 * `commit-and-reveal` (older than XCP Wallet 0.14.1, hardware, a Legacy or
 * nested SegWit account, a Core API before 11.5, or no report at all).
 */
export function assertCommitAndRevealSupported(
  capabilities: ProviderPsbtSigningCapabilities | null | undefined,
): void {
  if (!supportsMarketplaceBundle(capabilities, "commit-and-reveal")) {
    throw new ProviderSigningCapabilityError(
      "This wallet cannot sign a Taproot commit and reveal. XCP Wallet 0.14.1 or newer can, from a Native SegWit or Taproot software account.",
      "unsupported",
    );
  }
}

const isPolicyOfferAlternative = (intent: unknown) =>
  typeof intent === "object" &&
  intent !== null &&
  (intent as { standard?: unknown }).standard === "counterparty-marketplace" &&
  (intent as { action?: unknown }).action === "fund_policy_offer";

/**
 * Most requests the wallet accepts in this bundle: its `maxRequests`, or for a
 * `fund-policy-offer` set (every request a `fund_policy_offer` intent) its
 * `maxPolicyOfferAlternatives` when larger. Without a report, the default.
 */
export function psbtBundleLimit(
  requests: readonly { intent?: unknown }[],
  capabilities: ProviderPsbtSigningCapabilities | null | undefined,
): number {
  if (!capabilities) return SIGN_PSBTS_BUNDLE_LIMIT;
  const { maxRequests, maxPolicyOfferAlternatives } = capabilities.psbtBatch;
  const policyOffers =
    requests.length > 0 &&
    requests.every((request) => isPolicyOfferAlternative(request.intent)) &&
    supportsMarketplaceBundle(capabilities, "fund-policy-offer");
  return policyOffers ? Math.max(maxRequests, maxPolicyOfferAlternatives) : maxRequests;
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

export function assertProviderCanSignPsbt(
  request: SignPsbtRequestLike,
  capabilities: ProviderPsbtSigningCapabilities | null | undefined,
  describe: IntentDescriber = describeAsTransaction,
): void {
  if (!capabilities) return;
  assertMethodCanSign(capabilities.psbt, request.params[0], describe);
}

export function assertProviderCanSignPsbts(
  request: SignPsbtsRequestLike,
  capabilities: ProviderPsbtSigningCapabilities | null | undefined,
  describe: IntentDescriber = describeAsTransaction,
): void {
  if (!capabilities) return;
  const requests = request.params[0].requests;
  const limit = psbtBundleLimit(requests, capabilities);
  if (requests.length < 1 || requests.length > limit) {
    throw new ProviderSigningCapabilityError(
      `This wallet can sign at most ${limit} linked transactions at once.`,
      "batch_limit",
    );
  }
  if (requests.length === 2 && isRevealIntent(requests[1]!.intent)) {
    assertCommitAndRevealCanSign(requests[0]!, requests[1]!, capabilities, describe);
    return;
  }
  for (const item of requests) assertMethodCanSign(capabilities.psbtBatch, item, describe);
}

/**
 * A `commit-and-reveal` pair: the commit under the batch contract; the reveal by
 * its own rule (input 0 alone, DEFAULT or ALL), which the wallet applies in place
 * of the batch sighash list, since a SegWit source's reveal signs DEFAULT.
 */
function assertCommitAndRevealCanSign(
  commit: SignPsbtParamsLike,
  reveal: SignPsbtParamsLike,
  capabilities: ProviderPsbtSigningCapabilities,
  describe: IntentDescriber,
): void {
  assertCommitAndRevealSupported(capabilities);
  assertMethodCanSign(capabilities.psbtBatch, commit, describe);
  const signers = Object.values(reveal.signInputs ?? {});
  if (
    signers.length !== 1 ||
    signers[0]!.length !== 1 ||
    signers[0]![0] !== 0 ||
    reveal.sighashTypes?.length !== 1 ||
    (reveal.sighashTypes[0] !== 0x00 && reveal.sighashTypes[0] !== 0x01)
  ) {
    throw new ProviderSigningCapabilityError(
      "The reveal must be signed on input 0 alone, with SIGHASH_DEFAULT or SIGHASH_ALL.",
      "invalid_request",
    );
  }
}

import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { hex } from "@scure/base";
import { p2tr, p2wpkh, Script, TAPROOT_UNSPENDABLE_KEY, Transaction } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { isWalletSdkError } from "@/errors";
import { ProviderSigningCapabilityError } from "@/provider/capabilities";
import {
  COMMIT_INTENT,
  type CommitAndRevealParams,
  commitAndRevealRequest,
  finalizeCommitAndReveal,
  REVEAL_INTENT,
  REVEAL_MARKER_SCRIPT,
} from "@/provider/commit-reveal";
import type { XcpProvider } from "@/provider/types";
import { XcpWallet } from "@/provider/wallet";
import capturedHorizon from "./fixtures/horizon-2.3.1-commit-reveal.json";

/**
 * The commit-and-reveal bundle against a scripted XCP Wallet: the request it
 * sends is the contract XCP Wallet 0.14.1 proves (commit on every input, reveal
 * on input 0 with the sign_reveal claim), it is sent only to a wallet that lists
 * the kind, and the answer is bound to the transactions asked for.
 */

const PRIV = new Uint8Array(32).fill(3);
const PUB = secp256k1.getPublicKey(PRIV, true);
const XONLY = schnorr.getPublicKey(PRIV);
const WPKH = p2wpkh(PUB);
const TR = p2tr(XONLY);
const PARENT = "22".repeat(32);

const envelope = Script.encode([
  "OP_0",
  "IF",
  new TextEncoder().encode("CNTRPRTY-message"),
  "ENDIF",
  XONLY,
  "CHECKSIG",
]);

function pair(
  options: { source?: { script: Uint8Array }; spendIndex?: number; marker?: boolean; inputs?: number } = {},
) {
  const source = options.source ?? WPKH;
  const commitOutput = p2tr(TAPROOT_UNSPENDABLE_KEY, { script: envelope }, undefined, true);
  const commit = new Transaction();
  for (let i = 0; i < (options.inputs ?? 2); i++) {
    commit.addInput({ txid: PARENT, index: i, witnessUtxo: { script: source.script, amount: 20_000n } });
  }
  commit.addOutput({ script: commitOutput.script, amount: 10_000n });
  commit.addOutput({ script: source.script, amount: 25_000n });

  const reveal = new Transaction({ allowUnknownOutputs: true });
  reveal.addInput({
    txid: commit.id,
    index: options.spendIndex ?? 0,
    witnessUtxo: { script: commitOutput.script, amount: 10_000n },
    tapLeafScript: commitOutput.tapLeafScript,
  });
  if (options.marker !== false) reveal.addOutput({ script: hex.decode(REVEAL_MARKER_SCRIPT), amount: 0n });
  reveal.addOutput({ script: source.script, amount: 9_000n });
  return { commitPsbt: hex.encode(commit.toPSBT()), revealPsbt: hex.encode(reveal.toPSBT()) };
}

const signing = (bundles: string[], batchSighashes = [1, 0x83]) => ({
  psbt: { supported: true, sighashTypes: [1, 0x81, 0x83], inputScope: "selected", externalInputs: "any" },
  psbtBatch: {
    supported: true,
    sighashTypes: batchSighashes,
    inputScope: "selected",
    externalInputs: "any",
    maxRequests: 8,
    maxPolicyOfferAlternatives: 100,
    marketplaceBundles: bundles,
  },
});

function wallet(report: unknown, answer?: (requests: { hex: string }[]) => unknown) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const provider: XcpProvider = {
    request: async (args) => {
      calls.push(args);
      if (args.method === "xcp_getAddresses") {
        return {
          active: { address: WPKH.address, publicKey: hex.encode(PUB), type: "p2wpkh" },
          ...(report ? { signing: report } : {}),
        };
      }
      const [{ requests }] = args.params as [{ requests: { hex: string }[] }];
      return answer ? answer(requests) : { hexes: requests.map((r) => r.hex) };
    },
    on: () => {},
    removeListener: () => {},
  };
  return { wallet: new XcpWallet(provider), calls };
}

const params = (overrides: Partial<CommitAndRevealParams> = {}): CommitAndRevealParams => ({
  source: WPKH.address!,
  ...pair(),
  ...overrides,
});

describe("signCommitAndReveal", () => {
  it("allows a declared generic SegWit script-path signer, but refuses its Taproot reveal before any prompt", async () => {
    const report = { ...signing([]), intentValidation: "none" };
    Object.assign(report.psbtBatch, { taprootScriptPath: "untweaked-key", approvalMode: "per-psbt" });
    const { wallet: w, calls } = wallet(report);
    await w.signCommitAndReveal(params());
    expect(calls.filter((c) => c.method === "xcp_signPsbts")).toHaveLength(1);
    calls.length = 0;
    await expect(
      w.signCommitAndReveal(params({ source: TR.address!, ...pair({ source: TR }) })),
    ).rejects.toThrow("tweaked output key");
    expect(calls.filter((c) => c.method === "xcp_signPsbts")).toHaveLength(0);
  });
  it("sends the commit on every input and the reveal on input 0 with the sign_reveal claim", async () => {
    const { wallet: w, calls } = wallet(signing(["attach-and-list", "commit-and-reveal"]));
    const input = params();
    const result = await w.signCommitAndReveal(input);

    const sent = calls.filter((c) => c.method === "xcp_signPsbts");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.params).toEqual([
      {
        requests: [
          {
            hex: input.commitPsbt,
            signInputs: { [WPKH.address!]: [0, 1] },
            sighashTypes: [0x01, 0x01],
            intent: COMMIT_INTENT,
          },
          {
            hex: input.revealPsbt,
            signInputs: { [WPKH.address!]: [0] },
            sighashTypes: [0x00],
            intent: { standard: "counterparty-reveal", version: 1, action: "sign_reveal" },
          },
        ],
      },
    ]);
    expect(REVEAL_INTENT).toEqual({ standard: "counterparty-reveal", version: 1, action: "sign_reveal" });
    expect(result).toEqual({ commit: input.commitPsbt, reveal: input.revealPsbt });
  });

  it("passes a marketplace intent on the commit through and honours the chosen sighashes", async () => {
    // A Taproot account reports DEFAULT in its batch contract.
    const { wallet: w, calls } = wallet(signing(["commit-and-reveal"], [0, 1, 0x83]));
    const intent = { standard: "counterparty-marketplace", version: 1, action: "attach_for_listing" };
    const source = TR.address!;
    await w.signCommitAndReveal({
      source,
      ...pair({ source: TR }),
      commitIntent: intent,
      commitSighashType: 0x00,
      revealSighashType: 0x01,
    });
    const [{ requests }] = calls.find((c) => c.method === "xcp_signPsbts")!.params as [
      { requests: { intent: unknown; sighashTypes: number[]; signInputs: Record<string, number[]> }[] },
    ];
    expect(requests[0]!.intent).toEqual(intent);
    expect(requests[0]!.sighashTypes).toEqual([0x00, 0x00]);
    expect(requests[0]!.signInputs).toEqual({ [source]: [0, 1] });
    expect(requests[1]!.sighashTypes).toEqual([0x01]);
  });

  it.each([
    ["an older wallet that lists other bundles", signing(["attach-and-list", "fund-policy-offer"])],
    ["a wallet that reports no signing contract", null],
  ])("is a capability error for %s, and asks nothing", async (_, report) => {
    const { wallet: w, calls } = wallet(report);
    let error: unknown;
    await w.signCommitAndReveal(params()).catch((e: unknown) => {
      error = e;
    });
    expect(error).toBeInstanceOf(ProviderSigningCapabilityError);
    expect(isWalletSdkError(error, "capability")).toBe(true);
    expect((error as ProviderSigningCapabilityError).reason).toBe("unsupported");
    expect(calls.some((c) => c.method === "xcp_signPsbts")).toBe(false);
  });

  it.each<[string, Partial<CommitAndRevealParams>]>([
    ["a Legacy source", { source: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH" }],
    ["a reveal that spends commit output 1", pair({ spendIndex: 1 })],
    ["a reveal without the CNTRPRTY marker", pair({ marker: false })],
    ["SIGHASH_DEFAULT on a SegWit commit", { commitSighashType: 0x00 }],
    ["a reveal sighash other than DEFAULT or ALL", { revealSighashType: 0x83 as 0x01 }],
    ["a commit that is not a PSBT", { commitPsbt: "00" }],
  ])("refuses %s before asking the wallet anything", async (_, overrides) => {
    const { wallet: w, calls } = wallet(signing(["commit-and-reveal"]));
    await expect(w.signCommitAndReveal(params(overrides))).rejects.toMatchObject({
      code: expect.stringMatching(/invalid_argument|invalid_response/),
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a signed answer for a different reveal, and a short answer", async () => {
    const other = pair({ inputs: 1 });
    const swapped = wallet(signing(["commit-and-reveal"]), (requests) => ({
      hexes: [requests[0]!.hex, other.revealPsbt],
    }));
    await expect(swapped.wallet.signCommitAndReveal(params())).rejects.toMatchObject({
      code: "transaction_mismatch",
    });

    const short = wallet(signing(["commit-and-reveal"]), (requests) => ({ hexes: [requests[0]!.hex] }));
    await expect(short.wallet.signCommitAndReveal(params())).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("a commit-and-reveal bundle through signPsbts", () => {
  it("is checked by the reveal's own rule, so a SegWit source's DEFAULT reveal is not refused", async () => {
    const { wallet: w, calls } = wallet(signing(["commit-and-reveal"]));
    await w.signPsbts(commitAndRevealRequest(params()));
    expect(calls.some((c) => c.method === "xcp_signPsbts")).toBe(true);
  });

  it("is refused when the wallet does not list the kind", async () => {
    const { wallet: w } = wallet(signing([]));
    await expect(w.signPsbts(commitAndRevealRequest(params()))).rejects.toMatchObject({
      code: "capability",
      reason: "unsupported",
    });
  });

  it("refuses a reveal asked to sign more than input 0", async () => {
    const { wallet: w } = wallet(signing(["commit-and-reveal"]));
    const request = commitAndRevealRequest(params());
    const [commit, reveal] = request.params[0].requests;
    await expect(
      w.signPsbts({
        method: "xcp_signPsbts",
        params: [{ requests: [commit!, { ...reveal!, signInputs: { [WPKH.address!]: [0, 1] } }] }],
      }),
    ).rejects.toMatchObject({ code: "capability", reason: "invalid_request" });
  });
});

describe("finalizeCommitAndReveal", () => {
  it("verifies and finalizes an actual Horizon SegWit commit and script-path reveal", () => {
    const { request, result } = capturedHorizon;
    const commit = Transaction.fromPSBT(hex.decode(result.commit));
    const reveal = Transaction.fromPSBT(hex.decode(result.reveal), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    expect(hex.encode(commit.unsignedTx)).toBe(
      hex.encode(Transaction.fromPSBT(hex.decode(request.commitPsbt)).unsignedTx),
    );
    expect(hex.encode(reveal.unsignedTx)).toBe(
      hex.encode(
        Transaction.fromPSBT(hex.decode(request.revealPsbt), {
          allowUnknownInputs: true,
          allowUnknownOutputs: true,
        }).unsignedTx,
      ),
    );
    const input = reveal.getInput(0);
    const [key, sig] = input.tapScriptSig![0]!;
    const scriptAndVersion = input.tapLeafScript![0]![1];
    const digest = reveal.preimageWitnessV1(
      0,
      [input.witnessUtxo!.script],
      0,
      [input.witnessUtxo!.amount],
      undefined,
      scriptAndVersion.subarray(0, -1),
      scriptAndVersion.at(-1),
    );
    expect(schnorr.verify(sig, digest, key.pubKey)).toBe(true);
    const raw = finalizeCommitAndReveal(result);
    expect(Transaction.fromRaw(hex.decode(raw.commit)).id).toBe(commit.id);
    expect(
      Transaction.fromRaw(hex.decode(raw.reveal), { allowUnknownOutputs: true }).getInput(0)
        .finalScriptWitness,
    ).toHaveLength(3);
  });
  it("finalizes the commit and builds the reveal's script-path witness", async () => {
    const { commitPsbt, revealPsbt } = pair();
    const commit = Transaction.fromPSBT(hex.decode(commitPsbt));
    commit.sign(PRIV);
    const reveal = Transaction.fromPSBT(hex.decode(revealPsbt), { allowUnknownOutputs: true });
    reveal.signIdx(PRIV, 0);
    const raw = finalizeCommitAndReveal({
      commit: hex.encode(commit.toPSBT()),
      reveal: hex.encode(reveal.toPSBT()),
    });
    const commitTx = Transaction.fromRaw(hex.decode(raw.commit));
    const revealTx = Transaction.fromRaw(hex.decode(raw.reveal), { allowUnknownOutputs: true });
    const witness = revealTx.getInput(0).finalScriptWitness!;
    expect(witness).toHaveLength(3);
    expect(hex.encode(witness[1]!)).toBe(hex.encode(envelope));
    expect(hex.encode(revealTx.getInput(0).txid!)).toBe(commitTx.id);
  });

  it("refuses a reveal the wallet did not sign", () => {
    const { commitPsbt, revealPsbt } = pair();
    const commit = Transaction.fromPSBT(hex.decode(commitPsbt));
    commit.sign(PRIV);
    expect(() =>
      finalizeCommitAndReveal({ commit: hex.encode(commit.toPSBT()), reveal: revealPsbt }),
    ).toThrow(/leaf signature/);
  });
});

import { hex as hexCodec } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { getCounterpartyApiBase } from "@/config";
import { fetchMedianFeeRate } from "@/counterparty/fees";
import { relayingFetch } from "@/counterparty/relay";
import { pubkeyFromBip322 } from "@/crypto/bip322";
import { isWalletSdkError, WalletSdkError } from "@/errors";
import { quantityParam } from "@/numeric";
import { BTC_ADDRESS_REGEX } from "@/provider/constants";
import { friendlyError } from "@/provider/friendly-error";
import type { ConnectionProof } from "@/provider/types";
import {
  msSinceLastSpend,
  pendingChangeInputs,
  recentlySpentUtxos,
  registerBroadcast,
} from "@/transaction/journal";
import { withAddressTransactionLock } from "@/transaction/lock";
import { ownTransactionOutputs, parseTxInputs, type TxInput } from "@/transaction/raw-tx";

export type ComposeValue = string | number | bigint;
/** Numbers past 2^53 are refused by `quantityParam`, not rounded. */
export type Quantity = ComposeValue;
export type ComposeParams = Record<string, ComposeValue>;
export type ComposePhase = "composing" | "signing" | "broadcasting";

/** What the pipeline needs from whoever holds the key. `WalletSession` satisfies it. */
export interface ComposeSigner {
  address: string | null;
  publicKey: string | null;
  connectionProof: ConnectionProof | null;
  signTransaction(hex: string): Promise<string>;
  /** Used when `signTransaction` answers `unsupported_method` (Horizon). */
  signPsbt?(hex: string, signInputs?: Record<string, number[]>, sighashTypes?: number[]): Promise<string>;
  broadcastTransaction(hex: string): Promise<string>;
}

export interface ComposeOptions {
  /** sat/vB; defaults to `feeRateSource()`. */
  feeRate?: number;
  feeRateSource?: () => Promise<number>;
  onPhase?: (phase: ComposePhase) => void;
}

interface Unsigned {
  hex: string;
  psbt: string | null;
  inputs: TxInput[];
}

export interface ComposeReceipt {
  txid: string;
  type: string;
  signedHex: string;
}

const UTXO_REGEX = /^[a-f0-9]{64}:\d+$/;
const GENERIC_ERROR = "Something went wrong — please try again";

// Matched narrowly so the retry never masks an empty wallet, only the propagation window after our own broadcast.
const INSUFFICIENT_UTXO_PATTERN = /insufficient funds for the target amount|no utxos found for/i;
const UTXO_RACE_RETRY_WINDOW_MS = 8_000;
const UTXO_RACE_RETRY_DELAY_MS = 2_000;
// Core rejecting its own mempool-based selection; retried confirmed-only.
const STALE_UTXO_PATTERN = /invalid UTXOs|UTXO not found|transaction not found/i;
// Not "insufficient funds for the target amount": that is the race above.
const NO_SPENDABLE_BTC_PATTERN = /no utxos found for|no unspent outputs/i;

/** Core reports compose failures as a Python list repr, e.g. `['a', 'b']`; the second entry usually explains the first. */
function normalizeCoreError(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(String).join("; ");
  const text = typeof raw === "string" ? raw.trim() : "";
  const list = /^\[(.*)\]$/s.exec(text);
  if (!list) return text;
  if (list[1]!.trim() === "") return "";
  const parts = [...list[1]!.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    (m[1] ?? m[2] ?? "").replace(/\\(['"\\])/g, "$1"),
  );
  return parts.length > 0 ? parts.join("; ") : text;
}

/** Known errors get friendly text; unknown ones keep Core's message, which is specific. */
export function describeComposeError(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).trim();

  if (
    isWalletSdkError(e, "rate_limited") ||
    /rate limit|too many requests|(?:API error|HTTP)[: ]+429/i.test(raw)
  ) {
    return "Counterparty API is busy — wait a moment and try again.";
  }
  // Which balance is short matters: XCP fee, BTC for the miner fee, or the asset.
  if (/insufficient XCP balance to pay fee/i.test(raw)) {
    return "Not enough XCP to pay the Counterparty fee for this action.";
  }
  if (/insufficient funds for the target amount/i.test(raw)) {
    return "Not enough spendable BTC for the transaction and miner fee. Wait for pending change to confirm or add BTC.";
  }
  // "no utxos found" is the first-timer failure and contains none of friendlyError's keywords.
  if (NO_SPENDABLE_BTC_PATTERN.test(raw)) {
    return "No spendable bitcoin at this address — every transaction needs BTC for the miner fee, on top of any XCP it spends.";
  }
  if (/insufficient/i.test(raw) && !/^insufficient balance$/i.test(raw)) return raw;

  const friendly = friendlyError(e);
  if (friendly !== GENERIC_ERROR) return friendly;
  return raw && raw !== "[object Object]" ? raw : friendly;
}

/**
 * Source public key for messages that exceed an OP_RETURN (bare multisig embeds it).
 * Core can only find one itself after the address has spent. Wallet first (covers
 * taproot), then the BIP-322 connection proof; null when neither answers.
 */
export function sourcePublicKey(signer: ComposeSigner): string | null {
  if (!signer.address) return null;
  if (signer.publicKey) return signer.publicKey;
  return signer.connectionProof?.address === signer.address
    ? pubkeyFromBip322(signer.address, signer.connectionProof.signature)
    : null;
}

/** One retry, only when the failure has the "not enough" shape and our own broadcast was seconds ago. */
async function withUtxoRaceRetry<T>(address: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const sinceSpend = msSinceLastSpend(address);
    if (
      INSUFFICIENT_UTXO_PATTERN.test(msg) &&
      sinceSpend !== null &&
      sinceSpend < UTXO_RACE_RETRY_WINDOW_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, UTXO_RACE_RETRY_DELAY_MS));
      return fn();
    }
    throw e;
  }
}

/** Quantities go through `quantityParam`: `String()` on an unsafe double puts wrong digits into a transaction. */
async function composeRequest(
  path: string,
  type: string,
  params: ComposeParams,
  extraParams: Record<string, string> | undefined,
  options: ComposeOptions,
): Promise<Unsigned> {
  const feeRate = options.feeRate ?? (await (options.feeRateSource ?? fetchMedianFeeRate)());
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    try {
      qp.set(k, quantityParam(v));
    } catch (e) {
      throw new WalletSdkError(
        "invalid_argument",
        `${k}: ${e instanceof Error ? e.message : "unusable value"}`,
      );
    }
  }
  if (extraParams) {
    for (const [k, v] of Object.entries(extraParams)) qp.set(k, v);
  }
  qp.set("sat_per_vbyte", String(feeRate));
  qp.set("verbose", "true");

  const url = `${getCounterpartyApiBase()}/${path}/compose/${type}?${qp.toString()}`;
  // Essential: exempt from the relay budget, since a user cannot route around composing.
  const res = await relayingFetch(url, 30_000, { essential: true });
  const body = await res.text();
  let data: { error?: unknown; result?: { rawtransaction?: string; psbt?: string } } = {};
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    if (!res.ok) throw new WalletSdkError("network", `Counterparty API request failed: HTTP ${res.status}`);
    throw new WalletSdkError("invalid_response", "Counterparty API returned an unreadable response");
  }
  if (res.status === 429) throw new WalletSdkError("rate_limited", "Counterparty API rate limit: HTTP 429");
  if (!res.ok || data.error) {
    throw new WalletSdkError("network", normalizeCoreError(data.error) || `Compose failed: ${res.status}`);
  }
  if (!data.result?.rawtransaction) {
    throw new WalletSdkError("invalid_response", "Compose response did not include a transaction");
  }
  return {
    hex: data.result.rawtransaction,
    psbt: data.result.psbt ?? null,
    inputs: parseTxInputs(data.result.rawtransaction),
  };
}

/** Sign every input as `address` through the PSBT path, then finalize and extract the raw transaction. */
async function signViaPsbt(signer: ComposeSigner, address: string, unsigned: Unsigned): Promise<string> {
  if (!signer.signPsbt)
    throw new WalletSdkError("unsupported_method", "Wallet cannot sign raw transactions or PSBTs");
  if (!unsigned.psbt) throw new WalletSdkError("invalid_response", "Compose response did not include a PSBT");
  const indices = unsigned.inputs.map((_, index) => index);
  const signed = await signer.signPsbt(
    unsigned.psbt,
    { [address]: indices },
    indices.map(() => 0x01),
  );
  const tx = Transaction.fromPSBT(hexCodec.decode(signed), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
  try {
    tx.finalize();
  } catch {
    // Already finalized by the wallet.
  }
  return hexCodec.encode(tx.extract());
}

function requireAddress(signer: ComposeSigner): string {
  if (!signer.address) throw new WalletSdkError("wallet_missing", "Wallet not connected");
  if (!BTC_ADDRESS_REGEX.test(signer.address))
    throw new WalletSdkError("invalid_argument", "Invalid wallet address");
  return signer.address;
}

/** Compose, sign, broadcast and journal, under the address lock across tabs. */
async function run(
  signer: ComposeSigner,
  source: string,
  type: string,
  recordOwnChange: boolean,
  getUnsigned: () => Promise<Unsigned>,
  options: ComposeOptions,
): Promise<ComposeReceipt> {
  options.onPhase?.("composing");
  return withAddressTransactionLock(source, async () => {
    const unsigned = await withUtxoRaceRetry(source, getUnsigned);
    const { inputs } = unsigned;

    options.onPhase?.("signing");
    let signedHex: string;
    try {
      signedHex = await signer.signTransaction(unsigned.hex);
    } catch (e) {
      if (!isWalletSdkError(e, "unsupported_method")) throw e;
      signedHex = await signViaPsbt(signer, source, unsigned);
    }

    options.onPhase?.("broadcasting");
    const txid = await signer.broadcastTransaction(signedHex);

    // Already broadcast: a journal failure must not read as a failed transaction.
    try {
      registerBroadcast(
        source,
        txid,
        inputs,
        recordOwnChange ? ownTransactionOutputs(signedHex, source) : [],
      );
    } catch (journalError) {
      console.warn("Could not record broadcast UTXO state", journalError);
    }
    return { txid, type, signedHex };
  });
}

/** Compose a message from the signer's address. */
export async function composeAndBroadcast(
  signer: ComposeSigner,
  type: string,
  params: ComposeParams,
  options: ComposeOptions = {},
): Promise<ComposeReceipt> {
  const address = requireAddress(signer);
  const multisigPubkey = sourcePublicKey(signer);

  const composeWith = (allowUnconfirmed: boolean, inputsSet?: string[]) => {
    const excludeUtxos = recentlySpentUtxos(address);
    return composeRequest(
      `addresses/${address}`,
      type,
      params,
      {
        exclude_utxos_with_balances: "true",
        // Lets the next action chain off pending change instead of failing on confirmed-only selection.
        allow_unconfirmed_inputs: allowUnconfirmed ? "true" : "false",
        // Core's UTXO lock is per-process; on a multi-worker node two composes can be handed the same input.
        ...(excludeUtxos.length > 0 ? { exclude_utxos: excludeUtxos.join(",") } : {}),
        ...(inputsSet && inputsSet.length > 0 ? { inputs_set: inputsSet.join(",") } : {}),
        // Read by Core only when the message falls back to multisig.
        ...(multisigPubkey ? { multisig_pubkey: multisigPubkey } : {}),
      },
      options,
    );
  };

  return run(
    signer,
    address,
    type,
    type !== "attach",
    async () => {
      const pendingInputs = pendingChangeInputs(address);
      if (pendingInputs.length > 0) {
        try {
          // Complete entries: Core composes from them without its backend knowing the parent.
          return await composeWith(true, pendingInputs);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // Pending change may be too small for this action; fall back to Core's own selection.
          if (!INSUFFICIENT_UTXO_PATTERN.test(message) && !STALE_UTXO_PATTERN.test(message)) throw e;
        }
      }
      try {
        return await composeWith(true);
      } catch (e) {
        // Core may offer an unconfirmed UTXO and then refuse it; retry confirmed-only.
        if (!STALE_UTXO_PATTERN.test(e instanceof Error ? e.message : String(e))) throw e;
        return await composeWith(false);
      }
    },
    options,
  );
}

/** Compose against one exact UTXO (detach, and anything else UTXO-bound). Nothing to journal. */
export async function composeFromUtxoAndBroadcast(
  signer: ComposeSigner,
  utxo: string,
  type: string,
  params: ComposeParams,
  options: ComposeOptions = {},
): Promise<ComposeReceipt> {
  const address = requireAddress(signer);
  if (!UTXO_REGEX.test(utxo)) throw new WalletSdkError("invalid_argument", "Invalid UTXO format");
  return run(
    signer,
    address,
    type,
    false,
    async () => ({
      ...(await composeRequest(`utxos/${utxo}`, type, params, undefined, options)),
      inputs: [],
    }),
    options,
  );
}

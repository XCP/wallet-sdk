"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getCounterpartyApiBase } from "@/config";
import { fetchMedianFeeRate } from "@/counterparty/fees";
import { relayingFetch } from "@/counterparty/relay";
import { pubkeyFromBip322 } from "@/crypto/bip322";
import { quantityParam } from "@/numeric";
import { BTC_ADDRESS_REGEX } from "@/provider/constants";
import { friendlyError } from "@/provider/friendly-error";
import { useWallet } from "@/react/use-wallet";
import {
  msSinceLastSpend,
  pendingChangeInputs,
  recentlySpentUtxos,
  registerBroadcast,
} from "@/transaction/journal";
import { withAddressTransactionLock } from "@/transaction/lock";
import { ownTransactionOutputs, parseTxInputs, type TxInput } from "@/transaction/raw-tx";

type ComposeValue = string | number | bigint;

/** Numbers past 2^53 are refused by `quantityParam`, not rounded. */
export type Quantity = string | number | bigint;

const UTXO_REGEX = /^[a-f0-9]{64}:\d+$/;

const GENERIC_ERROR = "Something went wrong — please try again";

/** Core reports compose failures as a Python list repr, e.g. `['a', 'b']`; the second entry usually explains the first. */
function normalizeCoreError(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(String).join("; ");
  const text = typeof raw === "string" ? raw.trim() : "";
  const list = /^\[(.*)\]$/s.exec(text);
  if (!list) return text;
  // An empty list carries no information; let the caller's fallback speak.
  if (list[1]!.trim() === "") return "";
  const parts = [...list[1]!.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    (m[1] ?? m[2] ?? "").replace(/\\(['"\\])/g, "$1"),
  );
  return parts.length > 0 ? parts.join("; ") : text;
}

/** Known errors get friendly text; unknown ones keep Core's message, which is specific. */
function composeError(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).trim();

  // Which balance is short matters: XCP fee, BTC for the miner fee, or the asset.
  if (/rate limit|too many requests|(?:API error|HTTP)[: ]+429/i.test(raw)) {
    return "Counterparty API is busy — wait a moment and try again.";
  }
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

export type ComposeStatus = "idle" | "composing" | "signing" | "broadcasting" | "confirmed" | "error";

export type ComposeState =
  | { status: "idle"; txid: null; error: null }
  | { status: "composing"; txid: null; error: null }
  | { status: "signing"; txid: null; error: null }
  | { status: "broadcasting"; txid: null; error: null }
  | { status: "confirmed"; txid: string; error: null }
  | { status: "error"; txid: null; error: string };

const INITIAL_STATE: ComposeState = { status: "idle", txid: null, error: null };

// Matched narrowly so the retry never masks an empty wallet, only the propagation window after our own broadcast.
const INSUFFICIENT_UTXO_PATTERN = /insufficient funds for the target amount|no utxos found for/i;
const UTXO_RACE_RETRY_WINDOW_MS = 8_000;
const UTXO_RACE_RETRY_DELAY_MS = 2_000;

// Core rejecting its own mempool-based selection; retried confirmed-only.
const STALE_UTXO_PATTERN = /invalid UTXOs|UTXO not found|transaction not found/i;

// Not "insufficient funds for the target amount": that is the race above.
const NO_SPENDABLE_BTC_PATTERN = /no utxos found for|no unspent outputs/i;

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
  params: Record<string, ComposeValue>,
  extraParams?: Record<string, string>,
  feeRateOverride?: number,
  feeRateSource: () => Promise<number> = fetchMedianFeeRate,
): Promise<string> {
  const feeRate = feeRateOverride ?? (await feeRateSource());
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    try {
      qp.set(k, quantityParam(v));
    } catch (e) {
      throw new Error(`${k}: ${e instanceof Error ? e.message : "unusable value"}`);
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
  let data: { error?: unknown; result?: { rawtransaction?: string } } = {};
  try {
    data = body ? JSON.parse(body) : {};
  } catch {
    if (!res.ok) throw new Error(`Counterparty API request failed: HTTP ${res.status}`);
    throw new Error("Counterparty API returned an unreadable response");
  }

  if (res.status === 429) {
    throw new Error("Counterparty API rate limit: HTTP 429");
  }

  if (!res.ok || data.error) {
    throw new Error(normalizeCoreError(data.error) || `Compose failed: ${res.status}`);
  }

  if (!data.result?.rawtransaction) throw new Error("Compose response did not include a transaction");
  return data.result.rawtransaction;
}

export interface UseComposeOptions {
  /** Called once per successful broadcast with the compose type. */
  onBroadcast?: (txid: string, type: string) => void;
  /** Default fee-rate source; mempool.space next-block median unless given. */
  feeRate?: () => Promise<number>;
}

export function useCompose(options: UseComposeOptions = {}) {
  const { address, connectionProof, publicKey, signTransaction, broadcastTransaction } = useWallet();
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /**
   * Source public key for messages that exceed an OP_RETURN (bare multisig embeds it).
   * Core can only find one itself after the address has spent. Wallet first (covers
   * taproot), then the BIP-322 connection proof; null when neither answers.
   */
  const multisigPubkey = useMemo(() => {
    if (!address) return null;
    if (publicKey) return publicKey;
    return connectionProof?.address === address ? pubkeyFromBip322(address, connectionProof.signature) : null;
  }, [address, publicKey, connectionProof]);
  const [state, setState] = useState<ComposeState>(INITIAL_STATE);
  const busyRef = useRef(false);

  // A wallet change clears an error the change made moot.
  const lastAddressRef = useRef(address);
  useEffect(() => {
    if (lastAddressRef.current !== address) {
      lastAddressRef.current = address;
      setState((s) => (s.status === "error" ? INITIAL_STATE : s));
    }
  }, [address]);

  /** The address lock spans compose, sign, broadcast and the journal write, across tabs. */
  const run = async (
    source: string,
    recordOwnChange: boolean,
    type: string,
    getUnsigned: () => Promise<{ hex: string; inputs: TxInput[] }>,
  ): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;

    try {
      setState({ status: "composing", txid: null, error: null });
      await withAddressTransactionLock(source, async () => {
        const { hex: unsignedHex, inputs } = await withUtxoRaceRetry(source, getUnsigned);

        setState({ status: "signing", txid: null, error: null });
        const signedHex = await signTransaction(unsignedHex);

        setState({ status: "broadcasting", txid: null, error: null });
        const txid = await broadcastTransaction(signedHex);

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
        setState({ status: "confirmed", txid, error: null });
        optionsRef.current.onBroadcast?.(txid, type);
      });
    } catch (e) {
      setState({ status: "error", txid: null, error: composeError(e) });
    } finally {
      busyRef.current = false;
    }
  };

  const execute = (type: string, params: Record<string, ComposeValue>, feeRateOverride?: number): void => {
    if (!address) {
      setState({ status: "error", txid: null, error: "Wallet not connected" });
      return;
    }
    if (!BTC_ADDRESS_REGEX.test(address)) {
      setState({ status: "error", txid: null, error: "Invalid wallet address" });
      return;
    }
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
        feeRateOverride,
        optionsRef.current.feeRate,
      );
    };

    run(address, type !== "attach", type, async () => {
      let hex: string;
      const pendingInputs = pendingChangeInputs(address);
      if (pendingInputs.length > 0) {
        try {
          // Complete entries: Core composes from them without its backend knowing the parent.
          hex = await composeWith(true, pendingInputs);
          return { hex, inputs: parseTxInputs(hex) };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // Pending change may be too small for this action; fall back to Core's own selection.
          if (!INSUFFICIENT_UTXO_PATTERN.test(message) && !STALE_UTXO_PATTERN.test(message)) {
            throw e;
          }
        }
      }
      try {
        hex = await composeWith(true);
      } catch (e) {
        // Core may offer an unconfirmed UTXO and then refuse it; retry confirmed-only.
        if (!STALE_UTXO_PATTERN.test(e instanceof Error ? e.message : String(e))) throw e;
        hex = await composeWith(false);
      }
      return { hex, inputs: parseTxInputs(hex) };
    });
  };

  const executeUtxo = (utxo: string, type: string, params: Record<string, ComposeValue>): void => {
    if (!address) {
      setState({ status: "error", txid: null, error: "Wallet not connected" });
      return;
    }
    if (!UTXO_REGEX.test(utxo)) {
      setState({ status: "error", txid: null, error: "Invalid UTXO format" });
      return;
    }
    // One exact UTXO: nothing to journal.
    run(address, false, type, async () => {
      const hex = await composeRequest(
        `utxos/${utxo}`,
        type,
        params,
        undefined,
        undefined,
        optionsRef.current.feeRate,
      );
      return { hex, inputs: [] };
    });
  };

  const composeOrder = (params: {
    give_asset: string;
    give_quantity: Quantity;
    get_asset: string;
    get_quantity: Quantity;
    expiration?: number;
    /** sat/vB override; defaults to the next-block median at compose time. */
    fee_rate?: number;
  }) =>
    execute(
      "order",
      {
        give_asset: params.give_asset,
        give_quantity: params.give_quantity,
        get_asset: params.get_asset,
        get_quantity: params.get_quantity,
        expiration: params.expiration ?? 5000,
        fee_required: 0,
      },
      params.fee_rate,
    );

  const composeDispenser = (params: {
    asset: string;
    give_quantity: Quantity;
    escrow_quantity: Quantity;
    mainchainrate: Quantity;
    status?: number;
    /** sat/vB override; defaults to the next-block median at compose time. */
    fee_rate?: number;
  }) =>
    execute(
      "dispenser",
      {
        asset: params.asset,
        give_quantity: params.give_quantity,
        escrow_quantity: params.escrow_quantity,
        mainchainrate: params.mainchainrate,
        status: params.status ?? 0,
      },
      params.fee_rate,
    );

  const composeDispense = (params: { dispenser: string; quantity: Quantity }) =>
    execute("dispense", {
      dispenser: params.dispenser,
      quantity: params.quantity,
    });

  const composeAttach = (params: { asset: string; quantity: Quantity }) =>
    execute("attach", {
      asset: params.asset,
      quantity: params.quantity,
    });

  const composePoolDeposit = (params: {
    asset_a: string;
    asset_b: string;
    quantity_a: Quantity;
    quantity_b: Quantity;
    min_lp_quantity?: Quantity;
    lp_asset?: string;
    /** sat/vB override; defaults to the next-block median at compose time. */
    fee_rate?: number;
  }) =>
    execute(
      "pooldeposit",
      {
        asset_a: params.asset_a,
        asset_b: params.asset_b,
        quantity_a: params.quantity_a,
        quantity_b: params.quantity_b,
        min_lp_quantity: params.min_lp_quantity ?? 0,
        ...(params.lp_asset ? { lp_asset: params.lp_asset } : {}),
      },
      params.fee_rate,
    );

  const composePoolWithdraw = (params: {
    lp_asset: string;
    quantity: Quantity;
    min_quantity_a?: Quantity;
    min_quantity_b?: Quantity;
    /** sat/vB override; defaults to the next-block median at compose time. */
    fee_rate?: number;
  }) =>
    execute(
      "poolwithdraw",
      {
        lp_asset: params.lp_asset,
        quantity: params.quantity,
        min_quantity_a: params.min_quantity_a ?? 0,
        min_quantity_b: params.min_quantity_b ?? 0,
      },
      params.fee_rate,
    );

  const composeDetach = (utxo: string) => executeUtxo(utxo, "detach", {});

  /** Cancel an open DEX order by its transaction hash. */
  const composeCancel = (params: { offer_hash: string }) =>
    execute("cancel", { offer_hash: params.offer_hash });

  /** Mint from a fairminter; quantity is raw earn units (whole lots). */
  const composeFairmint = (params: { asset: string; quantity: Quantity }) =>
    execute("fairmint", {
      asset: params.asset,
      quantity: params.quantity,
    });

  const reset = () => setState(INITIAL_STATE);

  return {
    ...state,
    /**
     * Compose any Counterparty message by name. The named builders below are
     * conveniences over this; a site's own policy — the launchpad's XCP-69
     * fairminter, say — lives in the site as a thin call to it.
     */
    compose: execute,
    /** Compose against one exact UTXO (detach, and anything else UTXO-bound). */
    composeFromUtxo: executeUtxo,
    composeOrder,
    composeDispenser,
    composeDispense,
    composeAttach,
    composePoolDeposit,
    composePoolWithdraw,
    composeDetach,
    composeCancel,
    composeFairmint,
    reset,
  };
}

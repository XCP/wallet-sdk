"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/react/use-wallet";
import {
  type ComposeOptions,
  type ComposeParams,
  type ComposeReceipt,
  composeAndBroadcast,
  composeFromUtxoAndBroadcast,
  describeComposeError,
  type Quantity,
} from "@/transaction/compose";

export type { Quantity } from "@/transaction/compose";

export type ComposeStatus = "idle" | "composing" | "signing" | "broadcasting" | "confirmed" | "error";

export type ComposeState =
  | { status: "idle"; txid: null; error: null }
  | { status: "composing"; txid: null; error: null }
  | { status: "signing"; txid: null; error: null }
  | { status: "broadcasting"; txid: null; error: null }
  | { status: "confirmed"; txid: string; error: null }
  | { status: "error"; txid: null; error: string };

const INITIAL_STATE: ComposeState = { status: "idle", txid: null, error: null };

export interface UseComposeOptions {
  /** Called once per successful broadcast with the compose type. */
  onBroadcast?: (txid: string, type: string) => void;
  /** Fee-rate source; mempool.space's precise next-block rate unless given. */
  feeRate?: () => Promise<number>;
}

/** Compose → sign → broadcast with UI state. One action at a time per hook. */
export function useCompose(options: UseComposeOptions = {}) {
  const { session, address } = useWallet();
  const optionsRef = useRef(options);
  optionsRef.current = options;
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

  const run = useCallback((type: string, action: (compose: ComposeOptions) => Promise<ComposeReceipt>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const compose: ComposeOptions = {
      feeRateSource: optionsRef.current.feeRate,
      onPhase: (phase) => setState({ status: phase, txid: null, error: null }),
    };
    void action(compose)
      .then((receipt) => {
        setState({ status: "confirmed", txid: receipt.txid, error: null });
        optionsRef.current.onBroadcast?.(receipt.txid, type);
      })
      .catch((e: unknown) => setState({ status: "error", txid: null, error: describeComposeError(e) }))
      .finally(() => {
        busyRef.current = false;
      });
  }, []);

  const signer = session.asSigner();

  const compose = (type: string, params: ComposeParams, feeRate?: number): void =>
    run(type, (options) => composeAndBroadcast(signer, type, params, { ...options, feeRate }));

  const composeFromUtxo = (utxo: string, type: string, params: ComposeParams): void =>
    run(type, (options) => composeFromUtxoAndBroadcast(signer, utxo, type, params, options));

  const composeOrder = (params: {
    give_asset: string;
    give_quantity: Quantity;
    get_asset: string;
    get_quantity: Quantity;
    expiration?: number;
    fee_rate?: number;
  }) =>
    compose(
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
    fee_rate?: number;
  }) =>
    compose(
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
    compose("dispense", { dispenser: params.dispenser, quantity: params.quantity });

  const composeAttach = (params: { asset: string; quantity: Quantity }) =>
    compose("attach", { asset: params.asset, quantity: params.quantity });

  const composePoolDeposit = (params: {
    asset_a: string;
    asset_b: string;
    quantity_a: Quantity;
    quantity_b: Quantity;
    min_lp_quantity?: Quantity;
    lp_asset?: string;
    fee_rate?: number;
  }) =>
    compose(
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
    fee_rate?: number;
  }) =>
    compose(
      "poolwithdraw",
      {
        lp_asset: params.lp_asset,
        quantity: params.quantity,
        min_quantity_a: params.min_quantity_a ?? 0,
        min_quantity_b: params.min_quantity_b ?? 0,
      },
      params.fee_rate,
    );

  const composeDetach = (utxo: string) => composeFromUtxo(utxo, "detach", {});

  const composeCancel = (params: { offer_hash: string }) =>
    compose("cancel", { offer_hash: params.offer_hash });

  /** `quantity` in raw earn units. */
  const composeFairmint = (params: { asset: string; quantity: Quantity }) =>
    compose("fairmint", { asset: params.asset, quantity: params.quantity });

  const reset = () => setState(INITIAL_STATE);

  return {
    ...state,
    compose,
    composeFromUtxo,
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

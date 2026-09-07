"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AmountValidationError } from "@/amounts";
import { WalletSdkError } from "@/errors";
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

export interface ComposeErrorDetails {
  /** Original diagnostic for an optional details view; never translate by matching this text. */
  diagnostic: string;
  walletCode?: number;
}

export type ComposeState = (
  | { status: "idle"; txid: null; error: null }
  | { status: "composing"; txid: null; error: null }
  | { status: "signing"; txid: null; error: null }
  | { status: "broadcasting"; txid: null; error: null }
  | { status: "confirmed"; txid: string; error: null }
  | { status: "error"; txid: null; error: string }
) & { errorCode: string | null; errorDetails: ComposeErrorDetails | null };

const CLEAR_ERROR = { errorCode: null, errorDetails: null };
const INITIAL_STATE: ComposeState = { status: "idle", txid: null, error: null, ...CLEAR_ERROR };

function errorMetadata(error: unknown): Pick<ComposeState, "errorCode" | "errorDetails"> {
  const amountError =
    error instanceof AmountValidationError
      ? error
      : error instanceof WalletSdkError && error.cause instanceof AmountValidationError
        ? error.cause
        : null;
  return {
    errorCode: amountError?.code ?? (error instanceof WalletSdkError ? error.code : "unknown_error"),
    errorDetails: {
      diagnostic:
        error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error",
      ...(error instanceof WalletSdkError && error.walletCode !== undefined
        ? { walletCode: error.walletCode }
        : {}),
    },
  };
}

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
      onPhase: (phase) => setState({ status: phase, txid: null, error: null, ...CLEAR_ERROR }),
    };
    void action(compose)
      .then((receipt) => {
        setState({ status: "confirmed", txid: receipt.txid, error: null, ...CLEAR_ERROR });
        optionsRef.current.onBroadcast?.(receipt.txid, type);
      })
      .catch((e: unknown) =>
        setState({ status: "error", txid: null, error: describeComposeError(e), ...errorMetadata(e) }),
      )
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

  const composeDispense = (params: { dispenser: string; quantity: Quantity; fee_rate?: number }) =>
    compose("dispense", { dispenser: params.dispenser, quantity: params.quantity }, params.fee_rate);

  const composeAttach = (params: { asset: string; quantity: Quantity; fee_rate?: number }) =>
    compose("attach", { asset: params.asset, quantity: params.quantity }, params.fee_rate);

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

  const composeCancel = (params: { offer_hash: string; fee_rate?: number }) =>
    compose("cancel", { offer_hash: params.offer_hash }, params.fee_rate);

  /** `quantity` in raw earn units. */
  const composeFairmint = (params: { asset: string; quantity: Quantity; fee_rate?: number }) =>
    compose("fairmint", { asset: params.asset, quantity: params.quantity }, params.fee_rate);

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

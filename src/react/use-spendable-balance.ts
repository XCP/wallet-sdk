"use client";

import { useSyncExternalStore } from "react";
import useSWR from "swr";
import { fetchAssetBalance, fetchPendingDebits } from "@/counterparty/api";
import { maxRaw } from "@/numeric";
import { pendingSpentRaw, readPending, readPendingServer, subscribePending } from "@/transaction/pending";

/**
 * Confirmed balance minus debits the node already sees minus this browser's own
 * unresolved broadcasts. The mempool read is keyed by address only, so every asset
 * on a page shares one request.
 */
export function useSpendableBalance(address: string | null, asset: string | null, scope = "default") {
  const pendingItems = useSyncExternalStore(subscribePending, readPending, readPendingServer);
  const resolvedCount = pendingItems.filter((item) => item.resolved).length;

  const confirmed = useSWR(
    address && asset ? [address, asset, scope, "confirmed-balance", resolvedCount] : null,
    ([addr, token]) => fetchAssetBalance(addr, token),
    { refreshInterval: 30_000 },
  );
  const pending = useSWR(
    address ? [address, "counterparty-pending-debits"] : null,
    ([addr]) => fetchPendingDebits(addr),
    { refreshInterval: 30_000, dedupingInterval: 5_000 },
  );

  const fromNode = asset ? pending.data?.get(asset) : undefined;
  const local = asset ? pendingSpentRaw(asset, address, fromNode?.txids) : 0n;
  const balance =
    confirmed.data === undefined
      ? undefined
      : maxRaw(0n, confirmed.data - (fromNode?.quantity ?? 0n) - local);

  return {
    balance,
    confirmedBalance: confirmed.data,
    pendingOutgoing: (fromNode?.quantity ?? 0n) + local,
    balanceError: confirmed.error as Error | undefined,
    pendingError: pending.error as Error | undefined,
    /** The read failed and nothing is cached. Callers should proceed; consensus checks the balance. */
    balanceUnavailable: confirmed.data === undefined && confirmed.error !== undefined,
    isLoading: confirmed.isLoading,
    refresh: async () => {
      await Promise.all([confirmed.mutate(), pending.mutate()]);
    },
  };
}

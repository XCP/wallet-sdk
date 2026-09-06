"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  dismissPending,
  invalidatePending,
  PENDING_STORAGE_KEY,
  type PendingItem,
  readPending,
  readPendingServer,
  registerPending,
  subscribePending,
  sweepResolved,
  updatePending,
} from "@/transaction/pending";
import { subscribeStorageKey } from "@/web";

const RESOLVED_TTL_MS = 10 * 60 * 1000;
const SWEEP_MS = 15_000;

/** The pending registry as React state, synced across tabs. Resolution polling is the host's. */
export function usePending() {
  const items: PendingItem[] = useSyncExternalStore(subscribePending, readPending, readPendingServer);

  useEffect(() => subscribeStorageKey(PENDING_STORAGE_KEY, invalidatePending), []);
  useEffect(() => {
    const timer = setInterval(() => sweepResolved(RESOLVED_TTL_MS), SWEEP_MS);
    return () => clearInterval(timer);
  }, []);

  return { items, registerPending, updatePending, dismissPending };
}

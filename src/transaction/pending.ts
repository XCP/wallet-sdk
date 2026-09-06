import { getStorage } from "@/config";
import { sumRaw } from "@/numeric";

/**
 * Broadcast-but-unresolved actions, in host storage. Snapshots are referentially
 * stable between writes (a `useSyncExternalStore` requirement).
 */

export type PendingKind = "order" | "dispense" | "mint" | "pool" | "launch" | "send" | "other";

export interface PendingSpend {
  asset: string;
  /** Decimal string: a raw quantity can exceed what JSON.parse hands back intact. */
  raw: string;
}

export interface PendingItem {
  txid: string;
  kind: PendingKind;
  label: string;
  addedAt: number;
  /** The address that broadcast this. Absent only on legacy rows. */
  address?: string;
  /** Set by the host's poller. */
  resolved?: string;
  /** Stamped once, on the transition to resolved. */
  resolvedAt?: number;
  /** Every asset this action debits. */
  spends?: PendingSpend[];
  /** Consecutive authoritative 404s. */
  misses?: number;
}

export const PENDING_STORAGE_KEY = "xcp:pending:v1";
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** Optimistic subtraction stops after ~6 blocks even if the row stays visible. */
const SUBTRACT_MS = 60 * 60 * 1000;
const MAX_ITEMS = 20;
const EMPTY: PendingItem[] = [];

let cache: PendingItem[] | null = null;
const listeners = new Set<() => void>();

function load(): PendingItem[] {
  try {
    const raw = getStorage()?.getItem(PENDING_STORAGE_KEY);
    const items: PendingItem[] = raw ? JSON.parse(raw) : [];
    return items.filter((i) => Date.now() - i.addedAt < MAX_AGE_MS);
  } catch {
    return EMPTY;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function write(items: PendingItem[]) {
  cache = items;
  // Guarded: this runs right after a broadcast, and a storage refusal must not read as a failed transaction.
  try {
    getStorage()?.setItem(PENDING_STORAGE_KEY, JSON.stringify(items));
  } catch {}
  notify();
}

export function readPending(): PendingItem[] {
  if (cache === null) cache = load();
  return cache;
}

/** For `useSyncExternalStore`'s server snapshot. */
export function readPendingServer(): PendingItem[] {
  return EMPTY;
}

export function registerPending(item: Omit<PendingItem, "addedAt">): void {
  const items = readPending();
  if (items.some((i) => i.txid === item.txid)) return;
  write([{ ...item, addedAt: Date.now() }, ...items].slice(0, MAX_ITEMS));
}

export function updatePending(txid: string, patch: Partial<PendingItem>): void {
  write(
    readPending().map((i) => {
      if (i.txid !== txid) return i;
      const next = { ...i, ...patch };
      if (patch.resolved && !i.resolved) next.resolvedAt = Date.now();
      return next;
    }),
  );
}

/** Drop resolved rows older than `maxAgeMs`. Writes only when something leaves. */
export function sweepResolved(maxAgeMs: number): void {
  const now = Date.now();
  const items = readPending();
  const keep = items.filter((i) => !i.resolved || now - (i.resolvedAt ?? i.addedAt) < maxAgeMs);
  if (keep.length !== items.length) write(keep);
}

export function dismissPending(txid: string): void {
  write(readPending().filter((i) => i.txid !== txid));
}

/** Raw units of `asset` spent by unresolved pending actions from `address`, within the subtraction window. */
export function pendingSpentRaw(
  asset: string,
  address?: string | null,
  excludeTxids: ReadonlySet<string> = new Set(),
): bigint {
  const now = Date.now();
  return sumRaw(
    readPending()
      .filter(
        (i) =>
          !i.resolved &&
          !excludeTxids.has(i.txid) &&
          (!i.address || !address || i.address === address) &&
          now - i.addedAt < SUBTRACT_MS,
      )
      .flatMap((i) => (i.spends ?? []).filter((spend) => spend.asset === asset).map((spend) => spend.raw)),
  );
}

/** Another context wrote the store: drop the cache so the next read reloads. */
export function invalidatePending(): void {
  cache = null;
  notify();
}

export function subscribePending(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

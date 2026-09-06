import { getStorage } from "@/config";

/**
 * Address-scoped journal of our own broadcasts, in host storage. Core's UTXO lock is
 * per-process and a public node has many, so the next compose must exclude what we
 * just spent itself. Change outputs are recorded with value and script so Core can
 * compose from them before its backend has indexed the parent.
 * No module cache: reads happen under the address lock and must see other tabs' writes.
 */

const KEY_PREFIX = "xcp:utxo-chain:v2:";
const MAX_AGE_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 50;
const TXID_PATTERN = /^[a-f0-9]{64}$/i;
const SCRIPT_PATTERN = /^(?:[a-f0-9]{2})+$/i;

interface SpentUtxo {
  utxo: string; // "txid:vout"
  addedAt: number;
}

interface ChainableUtxo {
  utxo: string;
  value: number;
  scriptPubKey: string;
  addedAt: number;
}

interface Journal {
  spent: SpentUtxo[];
  chainable: ChainableUtxo[];
}

export interface OwnTxOutput {
  vout: number;
  value: number;
  scriptPubKey: string;
}

function normalizedAddress(address: string): string {
  return /^(?:bc1|tb1|bcrt1)/i.test(address) ? address.toLowerCase() : address;
}

function storageKey(address: string): string {
  return `${KEY_PREFIX}${normalizedAddress(address)}`;
}

function isSpentUtxo(value: unknown): value is SpentUtxo {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SpentUtxo>;
  return (
    typeof item.utxo === "string" &&
    /^[a-f0-9]{64}:\d+$/i.test(item.utxo) &&
    typeof item.addedAt === "number" &&
    Number.isFinite(item.addedAt)
  );
}

function isChainableUtxo(value: unknown): value is ChainableUtxo {
  if (!isSpentUtxo(value)) return false;
  const item = value as Partial<ChainableUtxo>;
  return (
    typeof item.value === "number" &&
    Number.isSafeInteger(item.value) &&
    item.value >= 0 &&
    typeof item.scriptPubKey === "string" &&
    item.scriptPubKey.length <= 20_000 &&
    SCRIPT_PATTERN.test(item.scriptPubKey)
  );
}

function fresh<T extends { addedAt: number }>(items: T[]): T[] {
  const now = Date.now();
  return items.filter((item) => now - item.addedAt >= 0 && now - item.addedAt < MAX_AGE_MS);
}

function load(address: string): Journal {
  const storage = getStorage();
  if (!storage) return { spent: [], chainable: [] };
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey(address)) ?? "{}");
    if (!parsed || typeof parsed !== "object") return { spent: [], chainable: [] };
    const journal = parsed as Partial<Journal>;
    const spent = Array.isArray(journal.spent) ? fresh(journal.spent.filter(isSpentUtxo)) : [];
    const spentSet = new Set(spent.map((item) => item.utxo));
    const chainable = Array.isArray(journal.chainable)
      ? fresh(journal.chainable.filter(isChainableUtxo)).filter((item) => !spentSet.has(item.utxo))
      : [];
    return { spent, chainable };
  } catch {
    return { spent: [], chainable: [] };
  }
}

function write(address: string, journal: Journal) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey(address), JSON.stringify(journal));
  } catch {
    // Private mode or quota: the exclusion just won't survive a reload.
  }
}

/** Recently-spent UTXOs still worth excluding, "txid:vout" each. */
export function recentlySpentUtxos(address: string): string[] {
  return load(address).spent.map((item) => item.utxo);
}

/** Complete entries that Core can consume without resolving their parents. */
export function pendingChangeInputs(address: string): string[] {
  return load(address).chainable.map((item) => `${item.utxo}:${item.value}:${item.scriptPubKey}`);
}

/** `exclude_utxos` cannot surface change that has not propagated; a wallet with one UTXO is briefly, correctly, insufficient. See the compose retry. */
export function msSinceLastSpend(address: string): number | null {
  const spent = load(address).spent;
  if (spent.length === 0) return null;
  return Date.now() - Math.max(...spent.map((item) => item.addedAt));
}

/** `ownOutputs` must be ordinary wallet-owned change; pass [] for attach/detach. */
export function registerBroadcast(
  address: string,
  txid: string,
  inputs: { txid: string; vout: number }[],
  ownOutputs: OwnTxOutput[],
) {
  if (!getStorage()) return;
  if (!TXID_PATTERN.test(txid)) return;

  const now = Date.now();
  const journal = load(address);
  const additions = inputs
    .filter((input) => TXID_PATTERN.test(input.txid) && Number.isSafeInteger(input.vout) && input.vout >= 0)
    .map((input) => ({ utxo: `${input.txid}:${input.vout}`, addedAt: now }));
  const spentByThisTx = new Set(additions.map((item) => item.utxo));
  const spent = [...additions, ...journal.spent]
    .filter((item, index, all) => all.findIndex((other) => other.utxo === item.utxo) === index)
    .slice(0, MAX_ENTRIES);

  const newChange: ChainableUtxo[] = ownOutputs
    .filter(
      (output) =>
        Number.isSafeInteger(output.vout) &&
        output.vout >= 0 &&
        Number.isSafeInteger(output.value) &&
        output.value >= 0 &&
        output.scriptPubKey.length <= 20_000 &&
        SCRIPT_PATTERN.test(output.scriptPubKey),
    )
    .map((output) => ({
      utxo: `${txid}:${output.vout}`,
      value: output.value,
      scriptPubKey: output.scriptPubKey,
      addedAt: now,
    }));
  const chainable = [...newChange, ...journal.chainable]
    .filter((item) => !spentByThisTx.has(item.utxo))
    .filter((item, index, all) => all.findIndex((other) => other.utxo === item.utxo) === index)
    .slice(0, MAX_ENTRIES);

  write(address, { spent, chainable });
}

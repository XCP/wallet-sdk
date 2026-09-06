import { getCounterpartyApiBase } from "@/config";
import { relayingFetch } from "@/counterparty/relay";
import { WalletSdkError } from "@/errors";
import { parseJsonLossless, type Raw, sumRaw, toBigInt } from "@/numeric";

/**
 * Counterparty v2 reads. Paths are relative to the configured base; parsing is
 * lossless; pagination follows `next_cursor` to exhaustion.
 */

export type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

export interface ReadOptions {
  timeoutMs?: number;
  /** Exempt from the relay budget. Reserved for reads a user action depends on. */
  essential?: boolean;
}

export interface Page<T> {
  result: T[];
  next_cursor: number | string | null;
  result_count?: number;
}

function url(path: string, query?: Query): string {
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qp.set(k, String(v));
  const q = qp.toString();
  return `${getCounterpartyApiBase()}${path.startsWith("/") ? path : `/${path}`}${q ? `?${q}` : ""}`;
}

export async function get<T = unknown>(path: string, query?: Query, options: ReadOptions = {}): Promise<T> {
  const res = await relayingFetch(url(path, query), options.timeoutMs ?? 10_000, {
    essential: options.essential,
  });
  if (res.status === 429) throw new WalletSdkError("rate_limited", "Counterparty API rate limit: HTTP 429");
  if (!res.ok) throw new WalletSdkError("network", `HTTP ${res.status}`);
  return parseJsonLossless(await res.text()) as T;
}

/** `result`, or null on 404. */
export async function getResult<T>(path: string, query?: Query, options?: ReadOptions): Promise<T | null> {
  try {
    const data = await get<{ result?: T | null }>(path, query, options);
    return data.result ?? null;
  } catch (e) {
    if (e instanceof WalletSdkError && e.message === "HTTP 404") return null;
    throw e;
  }
}

/** Every row of a paginated endpoint, page by page. `limit` per page defaults to 1000. */
export async function* paginate<T>(
  path: string,
  query: Query = {},
  options?: ReadOptions,
): AsyncGenerator<T> {
  let cursor: Page<T>["next_cursor"] = null;
  const limit = query.limit ?? 1000;
  for (;;) {
    const page: Page<T> = await get<Page<T>>(path, { ...query, limit, cursor: cursor ?? undefined }, options);
    for (const row of page.result ?? []) yield row;
    if (page.next_cursor === null || page.next_cursor === undefined) return;
    cursor = page.next_cursor;
  }
}

export async function all<T>(path: string, query?: Query, options?: ReadOptions): Promise<T[]> {
  const rows: T[] = [];
  for await (const row of paginate<T>(path, query, options)) rows.push(row);
  return rows;
}

// ---- typed endpoints the sites share ----

export interface BalanceRow {
  address: string | null;
  asset: string;
  quantity: Raw;
  /** Set on UTXO-attached balances; those are not spendable from the address. */
  utxo: string | null;
  utxo_address?: string | null;
}

export function fetchAddressBalances(address: string, options?: ReadOptions): Promise<BalanceRow[]> {
  return all<BalanceRow>(`/addresses/${encodeURIComponent(address)}/balances`, { type: "address" }, options);
}

/** Spendable balance of one asset, UTXO-attached rows excluded, as an exact bigint. */
export async function fetchAssetBalance(
  address: string,
  asset: string,
  options?: ReadOptions,
): Promise<bigint> {
  const data = await get<{ result: BalanceRow | BalanceRow[] | null }>(
    `/addresses/${encodeURIComponent(address)}/balances/${encodeURIComponent(asset)}`,
    { type: "address" },
    options,
  );
  const rows = Array.isArray(data.result) ? data.result : data.result ? [data.result] : [];
  return sumRaw(rows.filter((r) => !r.utxo).map((r) => r.quantity));
}

export interface MempoolEvent {
  tx_hash: string;
  event: string;
  params: Record<string, unknown>;
  timestamp?: number;
}

export function fetchAddressMempool(
  address: string,
  eventNames?: string[],
  options?: ReadOptions,
): Promise<MempoolEvent[]> {
  return get<{ result: MempoolEvent[] }>(
    "/addresses/mempool",
    { addresses: address, event_name: eventNames?.join(","), verbose: true, limit: 100 },
    options,
  ).then((d) => (Array.isArray(d.result) ? d.result : []));
}

export interface PendingAssetDebit {
  quantity: bigint;
  txids: Set<string>;
}

/** Unconfirmed debits of `address` the node already sees, by asset. */
export async function fetchPendingDebits(
  address: string,
  options?: ReadOptions,
): Promise<Map<string, PendingAssetDebit>> {
  const byAsset = new Map<string, PendingAssetDebit>();
  for (const event of await fetchAddressMempool(address, ["DEBIT"], options)) {
    const params = event.params;
    if (
      event.event !== "DEBIT" ||
      !event.tx_hash ||
      params?.address !== address ||
      typeof params.asset !== "string"
    )
      continue;
    const quantity = toBigInt(params.quantity as Raw);
    if (quantity === null)
      throw new WalletSdkError("invalid_response", "Counterparty returned an unreadable pending debit");
    const current = byAsset.get(params.asset) ?? { quantity: 0n, txids: new Set<string>() };
    current.quantity += quantity;
    current.txids.add(event.tx_hash);
    byAsset.set(params.asset, current);
  }
  return byAsset;
}

export interface Order {
  tx_hash: string;
  tx_index: number;
  block_index: number;
  source: string;
  give_asset: string;
  give_quantity: Raw;
  give_remaining: Raw;
  get_asset: string;
  get_quantity: Raw;
  get_remaining: Raw;
  expire_index: number;
  status: string;
}

export function fetchOrder(txHash: string, options?: ReadOptions): Promise<Order | null> {
  return getResult<Order>(`/orders/${encodeURIComponent(txHash)}`, { verbose: false }, options);
}

/** Open orders on a pair, both directions. */
export function fetchOpenOrders(asset1: string, asset2: string, options?: ReadOptions): Promise<Order[]> {
  return all<Order>(
    `/orders/${encodeURIComponent(asset1)}/${encodeURIComponent(asset2)}`,
    { status: "open", verbose: false },
    options,
  );
}

export interface TransactionRow {
  tx_hash: string;
  tx_index: number;
  block_index: number | null;
  source: string;
  destination: string | null;
  transaction_type?: string;
}

export function fetchTransaction(txHash: string, options?: ReadOptions): Promise<TransactionRow | null> {
  return getResult<TransactionRow>(
    `/transactions/${encodeURIComponent(txHash)}`,
    { verbose: false },
    options,
  );
}

export async function fetchLastBlockIndex(options?: ReadOptions): Promise<number> {
  const data = await get<{ result: { block_index: number } }>("/blocks/last", undefined, options);
  return data.result.block_index;
}

export interface PoolRow {
  asset_a: string;
  asset_b: string;
  reserve_a: Raw;
  reserve_b: Raw;
  lp_asset: string;
}

/** Null when the pair has no pool (Counterparty answers 404). */
export function fetchPool(asset1: string, asset2: string, options?: ReadOptions): Promise<PoolRow | null> {
  return getResult<PoolRow>(
    `/pools/${encodeURIComponent(asset1)}/${encodeURIComponent(asset2)}`,
    undefined,
    options,
  );
}

export interface PoolQuoteRow {
  estimated_output: Raw;
  pool_output: Raw;
  book_output: Raw;
  book_orders_matched?: number;
  give_remaining?: Raw;
  price_impact: number;
  pool_exists?: boolean;
  fee_bps?: number;
  message?: string;
}

export function fetchPoolQuote(
  giveAsset: string,
  getAsset: string,
  quantity: Raw | bigint,
  options?: ReadOptions,
): Promise<PoolQuoteRow> {
  return get<{ result: PoolQuoteRow }>(
    `/pools/${encodeURIComponent(giveAsset)}/${encodeURIComponent(getAsset)}/quote`,
    { quantity: String(quantity) },
    options,
  ).then((d) => d.result);
}

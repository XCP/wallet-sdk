/**
 * mempool.space's precise fee ladder, cached 30s. The `/recommended` sibling
 * floors at 1 and rounds, so it cannot express the sub-1 market that exists today.
 */

export interface PreciseFees {
  /** Rate to land in the next block. */
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  /** The floor the network still relays at. Read, never hardcoded: it was 1 and is 0.1 today. */
  minimumFee: number;
}

export const PRECISE_FEES_URL = "https://mempool.space/api/v1/fees/precise";

const CACHE_MS = 30_000;
/** Only if mempool.space is unreachable on the very first read. */
const FALLBACK_SAT_VB = 2;

let cached: PreciseFees | null = null;
let cachedAt = 0;

export async function fetchPreciseFees(): Promise<PreciseFees | null> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;
  try {
    const res = await fetch(PRECISE_FEES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fees = (await res.json()) as PreciseFees;
    if (!Number.isFinite(fees.fastestFee)) throw new Error("unusable fee response");
    cached = fees;
    cachedAt = now;
    return fees;
  } catch {
    return cached;
  }
}

/**
 * Next-block rate floored by the network's own minimum. Two decimals below 10
 * and whole numbers above: at 0.42 the second digit is a fifth of the fee, at 42 it is noise.
 */
export function feeRateFrom(fees: PreciseFees | null | undefined): number | null {
  if (!fees || !Number.isFinite(fees.fastestFee)) return null;
  const floor = Number.isFinite(fees.minimumFee) ? fees.minimumFee : 0.1;
  const rate = Math.max(fees.fastestFee, floor);
  return rate < 10 ? Number(rate.toFixed(2)) : Math.round(rate);
}

/** The rate a transaction composed right now should pay. */
export async function fetchFeeRate(): Promise<number> {
  return feeRateFrom(await fetchPreciseFees()) ?? FALLBACK_SAT_VB;
}

/** mempool.space estimates, cached 30s, fractional sat/vB kept, floored at the 1 sat/vB relay minimum. */

const MIN_RELAY_SAT_VB = 1;
const CACHE_MS = 30_000;
const FALLBACK_SAT_VB = 3;

let cachedMedian: number | null = null;
let medianAt = 0;
let cachedFast: number | null = null;
let fastAt = 0;

export async function fetchMedianFeeRate(): Promise<number> {
  const now = Date.now();
  if (cachedMedian && now - medianAt < CACHE_MS) return cachedMedian;
  try {
    const res = await fetch("https://mempool.space/api/v1/fees/mempool-blocks");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: { medianFee: number }[] = await res.json();
    cachedMedian = Math.max(data[0]?.medianFee ?? FALLBACK_SAT_VB, MIN_RELAY_SAT_VB);
    medianAt = now;
    return cachedMedian;
  } catch {
    return cachedMedian ?? FALLBACK_SAT_VB;
  }
}

/** `/fees/precise` keeps decimals; `/recommended` rounds up. */
export async function fetchPriorityFeeRate(): Promise<number> {
  const now = Date.now();
  if (cachedFast && now - fastAt < CACHE_MS) return cachedFast;
  try {
    const res = await fetch("https://mempool.space/api/v1/fees/precise");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: { fastestFee: number } = await res.json();
    cachedFast = Math.max(data.fastestFee ?? 0, MIN_RELAY_SAT_VB);
    fastAt = now;
    return cachedFast;
  } catch {
    return (await fetchMedianFeeRate()) + 2;
  }
}

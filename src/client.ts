import { parseJsonLossless } from "./numeric";
import { relayingFetch } from "./relay";

/**
 * One JSON read, the way every XCP site does it.
 *
 * Through the relay when the URL is the Counterparty node (a no-op for any
 * other host), and parsed losslessly: `res.json()` rounds integers above
 * 2^53 while parsing, and raw supplies and balances routinely sit above it.
 * Oversized integers arrive as strings; everything else keeps its shape.
 */
export async function fetchJson(url: string, timeoutMs = 10_000): Promise<any> {
  const res = await relayingFetch(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseJsonLossless(await res.text());
}

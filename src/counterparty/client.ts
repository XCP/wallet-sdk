import { relayingFetch } from "@/counterparty/relay";
import { parseJsonLossless } from "@/numeric";

/** Relayed when the URL is the node; parsed losslessly (integers above 2^53 arrive as strings). */
export async function fetchJson(url: string, timeoutMs = 10_000): Promise<any> {
  const res = await relayingFetch(url, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseJsonLossless(await res.text());
}

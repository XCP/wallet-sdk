import { getCounterpartyApiBase, getStorage } from "@/config";
import { WalletSdkError } from "@/errors";

/**
 * A Counterparty read: direct first, then through the same-origin relay (`/api/cp`).
 * Cloud Armor denials arrive with no status (no CORS headers), so a TypeError is
 * treated as a throttle. Direct stays primary: the relay has one egress IP for every visitor.
 */

/** Same-origin, so it is reachable exactly when the page is. */
const RELAY_BASE = "/api/cp";

/** Only the configured node is relayed; anything else would be an open proxy. */
export function counterpartyRelay(url: string): string | null {
  if (!url.startsWith(getCounterpartyApiBase())) return null;
  try {
    const parsed = new URL(url);
    return `${RELAY_BASE}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/** 4xx client errors would answer the same from anywhere. */
const relayable = (status: number) => status >= 500 || status === 403 || status === 429;

/**
 * Throttle flag, shared across tabs via storage. A limiter counts rejected requests,
 * so a known-throttled window goes straight to the relay instead of feeding it.
 */
const THROTTLE_KEY = "xcp:cp-throttled-until";

/** Long enough for a per-minute window to drain, short enough that a false
 *  positive — being offline, say — costs one quiet minute and no more. */
const THROTTLE_MS = 60_000;

let throttledUntil = 0;

function throttled(): boolean {
  try {
    // Storage is the shared truth, read every time and in both directions. A
    // sibling tab that learned it should stand this one down; a sibling that
    // RECOVERED should let it back up, and an in-memory flag that outranked
    // storage would make this tab sit out the rest of a timer that is no
    // longer true for anyone.
    const stored = Number(getStorage()?.getItem(THROTTLE_KEY) ?? 0);
    throttledUntil = Number.isFinite(stored) ? stored : 0;
  } catch {
    // No storage: the in-memory flag is all this tab has, and it still
    // stands this tab down on its own.
  }
  return Date.now() < throttledUntil;
}

function noteThrottled(): void {
  throttledUntil = Date.now() + THROTTLE_MS;
  try {
    getStorage()?.setItem(THROTTLE_KEY, String(throttledUntil));
  } catch {
    // Guarded deliberately: a throw here reaches whatever called the read.
  }
}

function noteRecovered(): void {
  if (throttledUntil === 0) return;
  throttledUntil = 0;
  try {
    getStorage()?.removeItem(THROTTLE_KEY);
  } catch {
    // Nothing to undo.
  }
}

/** Relay budget per browser per minute. Background reads spend it; essential reads do not. */
const BUDGET_KEY = "xcp:cp-relay-budget";
const BUDGET_WINDOW_MS = 60_000;
/** Enough for a page to fill itself and keep its most important number
 *  current, far short of what its pollers would send unprompted. */
const BUDGET_PER_WINDOW = 8;

interface Budget {
  windowStart: number;
  used: number;
}

function readBudget(): Budget {
  const fresh = { windowStart: Date.now(), used: 0 };
  try {
    const raw = getStorage()?.getItem(BUDGET_KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Partial<Budget>;
    if (
      typeof parsed.windowStart !== "number" ||
      typeof parsed.used !== "number" ||
      Date.now() - parsed.windowStart >= BUDGET_WINDOW_MS
    ) {
      return fresh;
    }
    return { windowStart: parsed.windowStart, used: parsed.used };
  } catch {
    // No storage: this tab keeps its own budget, which still bounds it.
    return fresh;
  }
}

function claimBudget(): boolean {
  const budget = readBudget();
  if (budget.used >= BUDGET_PER_WINDOW) return false;
  budget.used += 1;
  try {
    getStorage()?.setItem(BUDGET_KEY, JSON.stringify(budget));
  } catch {
    // Guarded: a throw here would reach whatever called the read.
  }
  return true;
}

/** Thrown instead of returning empty so SWR keeps its last value and backs off. */
export class RelayBudgetExhausted extends WalletSdkError {
  constructor() {
    super("rate_limited", "Counterparty is rate limiting this browser. Waiting before retrying.");
    this.name = "RelayBudgetExhausted";
  }
}

/** Distinguishes a throttle (wait) from an outage; a direct 429 can reach the caller unchanged. */
export function isRateLimited(error: unknown): boolean {
  if (error instanceof RelayBudgetExhausted) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /HTTP (?:429|403)\b|rate limit/i.test(message);
}

/** Each attempt gets its own deadline; a shared signal would already be aborted when the fallback ran. */
export async function relayingFetch(
  url: string,
  timeoutMs: number,
  { essential = false }: { essential?: boolean } = {},
): Promise<Response> {
  const relay = counterpartyRelay(url);
  const viaRelay = () => fetch(relay!, { signal: AbortSignal.timeout(timeoutMs) });

  /** The relay, if this read is allowed to have it. */
  const lifeboat = async (): Promise<Response | null> => {
    if (!relay) return null;
    if (!essential && !claimBudget()) return null;
    return viaRelay();
  };

  // Known throttled: do not knock on a door we know is shut. A rate limiter
  // counts what it rejects, so a doomed direct attempt is not free — it is the
  // thing keeping the window from draining.
  if (relay && throttled()) {
    const relayed = await lifeboat();
    if (relayed) return relayed;
    throw new RelayBudgetExhausted();
  }

  try {
    const direct = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!relay) return direct;
    if (!relayable(direct.status)) {
      noteRecovered();
      return direct;
    }
    // A readable 429 is the same news as an unreadable one, and the only kind
    // we ever get to see — counterparty-core's own /rate-limited route sends
    // it with CORS headers attached.
    if (direct.status === 429 || direct.status === 403) noteThrottled();
    const relayed = await lifeboat().catch(() => null);
    return relayed?.ok ? relayed : direct;
  } catch (error) {
    // No status to inspect: a dead network and a response the browser refused
    // to expose arrive here identically. Only one is worth a retry, so both
    // get one — and both are worth standing the pollers down for, because if
    // it IS the limiter then every further attempt extends it.
    if (!relay) throw error;
    noteThrottled();
    const relayed = await lifeboat();
    if (relayed) return relayed;
    throw new RelayBudgetExhausted();
  }
}

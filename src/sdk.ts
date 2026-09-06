import { configureWalletSdk, getCounterpartyApiBase, type WalletSdkConfig } from "@/config";
import { fetchMedianFeeRate, fetchPriorityFeeRate } from "@/counterparty/fees";
import { cloneMarket, fillMarket, quoteAfterMempool } from "@/counterparty/pool-quote";
import { relayingFetch } from "@/counterparty/relay";
import { WalletSdkError } from "@/errors";
import { parseJsonLossless } from "@/numeric";
import { WalletSession, type WalletSessionOptions } from "@/session";

export interface CounterpartyReadOptions {
  timeoutMs?: number;
  /** Exempt from the relay budget. Reserved for reads a user action depends on. */
  essential?: boolean;
}

/** Counterparty reads, addressed by path under the configured node base. */
export interface CounterpartyApi {
  readonly base: string;
  /** GET `path` (for example `/addresses/{a}/balances`), parsed losslessly. */
  get<T = unknown>(path: string, options?: CounterpartyReadOptions): Promise<T>;
  /** GET an absolute URL through the relay rules. */
  fetch(url: string, timeoutMs?: number, options?: { essential?: boolean }): Promise<Response>;
  fees: {
    median: typeof fetchMedianFeeRate;
    priority: typeof fetchPriorityFeeRate;
  };
  quote: {
    afterMempool: typeof quoteAfterMempool;
    fill: typeof fillMarket;
    cloneMarket: typeof cloneMarket;
  };
}

export interface WalletSdk {
  counterparty: CounterpartyApi;
  /** A session bound to `options`; call `start()` to begin detection. */
  session(options?: WalletSessionOptions): WalletSession;
}

function joinPath(base: string, path: string): string {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Applies `config`; returns grouped access to the reads and the session. Flat module exports remain available. */
export function createWalletSdk(config: WalletSdkConfig = {}): WalletSdk {
  configureWalletSdk(config);
  const counterparty: CounterpartyApi = {
    get base() {
      return getCounterpartyApiBase();
    },
    async get<T>(path: string, options: CounterpartyReadOptions = {}): Promise<T> {
      const url = joinPath(getCounterpartyApiBase(), path);
      const res = await relayingFetch(url, options.timeoutMs ?? 10_000, { essential: options.essential });
      if (!res.ok) throw new WalletSdkError("network", `HTTP ${res.status}`);
      return parseJsonLossless(await res.text()) as T;
    },
    fetch: (url, timeoutMs = 10_000, options) => relayingFetch(url, timeoutMs, options),
    fees: { median: fetchMedianFeeRate, priority: fetchPriorityFeeRate },
    quote: { afterMempool: quoteAfterMempool, fill: fillMarket, cloneMarket },
  };
  return {
    counterparty,
    session: (options = {}) => new WalletSession(options),
  };
}

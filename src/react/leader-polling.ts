"use client";

import { useEffect, useRef, useState } from "react";
import { type Middleware, type SWRHook, unstable_serialize } from "swr";

/**
 * SWR middleware: per key, the visible tab holding a Web Lock polls and broadcasts;
 * other tabs with the key mounted set `refreshInterval` to 0 and write the broadcast
 * into their cache. Lock hand-off is the browser's. Without Web Locks or
 * BroadcastChannel every tab polls, as before.
 */

const LOCK_PREFIX = "xcp:swr:";
const CHANNEL = "xcp:swr";

interface Broadcast {
  key: string;
  data: unknown;
}

const supported =
  typeof navigator !== "undefined" && "locks" in navigator && typeof BroadcastChannel !== "undefined";

let channel: BroadcastChannel | null = null;
const listeners = new Map<string, Set<(data: unknown) => void>>();

function getChannel(): BroadcastChannel | null {
  if (!supported) return null;
  if (channel) return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<Broadcast>) => {
    const message = event.data;
    if (!message || typeof message.key !== "string") return;
    for (const listener of listeners.get(message.key) ?? []) listener(message.data);
  };
  return channel;
}

function publish(key: string, data: unknown): void {
  try {
    getChannel()?.postMessage({ key, data } satisfies Broadcast);
  } catch {
    // Not structured-cloneable; followers keep their own fetch.
  }
}

function subscribe(key: string, listener: (data: unknown) => void): () => void {
  if (!getChannel()) return () => {};
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(key);
  };
}

/** Only a visible tab requests a lock; a hidden leader releases it. */
function useLeader(name: string | null): boolean {
  const [held, setHeld] = useState<string | null>(null);

  useEffect(() => {
    if (name === null || !supported) return;

    let active = true;
    let pending: AbortController | null = null;
    let release: (() => void) | null = null;

    const acquire = () => {
      if (!active || pending || release || document.visibilityState !== "visible") return;
      const controller = new AbortController();
      pending = controller;
      navigator.locks
        .request(name, { signal: controller.signal }, async () => {
          pending = null;
          if (!active || document.visibilityState !== "visible") return;
          setHeld(name);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => {})
        .finally(() => {
          if (pending === controller) pending = null;
          setHeld((current) => (current === name ? null : current));
        });
    };

    const drop = () => {
      pending?.abort();
      pending = null;
      release?.();
      release = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") acquire();
      else drop();
    };

    acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      drop();
    };
  }, [name]);

  if (name === null) return false;
  if (!supported) return true;
  return held === name;
}

export const leaderPolling: Middleware = (useSWRNext: SWRHook) => (key, fetcher, config) => {
  const serialized = unstable_serialize(key);
  const interval = config.refreshInterval;
  const polled =
    serialized !== "" && (typeof interval === "function" || (typeof interval === "number" && interval > 0));
  const leader = useLeader(polled ? `${LOCK_PREFIX}${serialized}` : null);

  // Read at success time: a fetch started as leader may land after the lock moved.
  const leaderRef = useRef(leader);
  leaderRef.current = leader;

  const swr = useSWRNext(key, fetcher, {
    ...config,
    refreshInterval: polled && leader ? interval : 0,
    onSuccess: (data, successKey, successConfig) => {
      if (polled && leaderRef.current) publish(serialized, data);
      config.onSuccess?.(data, successKey, successConfig);
    },
  });

  const mutateRef = useRef(swr.mutate);
  mutateRef.current = swr.mutate;

  useEffect(() => {
    if (!polled || leader) return;
    return subscribe(serialized, (data) => {
      void mutateRef.current(data as never, { revalidate: false });
    });
  }, [serialized, polled, leader]);

  return swr;
};

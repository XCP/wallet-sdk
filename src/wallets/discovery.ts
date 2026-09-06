import type { WalletCandidate, WalletDescriptor, WalletId } from "@/wallets/descriptor";
import { HORIZON_WALLET } from "@/wallets/horizon";
import { registeredProvider, usableIcon } from "@/wallets/registry";
import { XCP_WALLET } from "@/wallets/xcp";

/** Order is display order: the recommended wallet first. */
export const KNOWN_WALLETS: readonly WalletDescriptor[] = [XCP_WALLET, HORIZON_WALLET];

/** A live view of which supported wallets the page has. */
export interface WalletDiscovery {
  readonly wallets: readonly WalletDescriptor[];
  descriptor(id: WalletId): WalletDescriptor | null;
  snapshot(): WalletCandidate[];
  /** Fires when a wallet appears. Injection listeners run while there is a subscriber. */
  subscribe(listener: (candidates: WalletCandidate[]) => void): () => void;
  /** Re-check now, asking wallets that announce themselves to do so again. */
  refresh(): WalletCandidate[];
}

function candidate(descriptor: WalletDescriptor): WalletCandidate {
  const registered = descriptor.registryId ? registeredProvider(descriptor.registryId) : null;
  return {
    id: descriptor.id,
    name: descriptor.name,
    icon: descriptor.icon ?? usableIcon(registered?.icon),
    installUrl: descriptor.installUrl,
    installed: descriptor.installed(),
  };
}

const sameCandidates = (a: WalletCandidate[], b: WalletCandidate[]) =>
  a.length === b.length &&
  a.every((left, i) => {
    const right = b[i]!;
    return left.id === right.id && left.installed === right.installed && left.icon === right.icon;
  });

export function discoverWallets(wallets: readonly WalletDescriptor[] = KNOWN_WALLETS): WalletDiscovery {
  const listeners = new Set<(candidates: WalletCandidate[]) => void>();
  let last = wallets.map(candidate);
  let stopInjectionListeners: (() => void) | null = null;

  const snapshot = () => wallets.map(candidate);

  const publish = () => {
    const next = snapshot();
    if (sameCandidates(last, next)) return last;
    last = next;
    for (const listener of listeners) listener(next);
    return next;
  };

  const listenForInjection = () => {
    const stops = wallets.filter((w) => !w.installed()).map((w) => w.onInjected(publish));
    return () => {
      for (const stop of stops) stop();
    };
  };

  return {
    wallets,
    descriptor: (id) => wallets.find((w) => w.id === id) ?? null,
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      if (!stopInjectionListeners) stopInjectionListeners = listenForInjection();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopInjectionListeners?.();
          stopInjectionListeners = null;
        }
      };
    },
    refresh: () => {
      for (const w of wallets) if (!w.installed()) w.nudge?.();
      return publish();
    },
  };
}

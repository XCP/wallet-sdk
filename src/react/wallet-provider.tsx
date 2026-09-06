"use client";

import { createContext, type ReactNode, useEffect, useMemo, useSyncExternalStore } from "react";
import { WalletSession, type WalletSessionOptions, type WalletSessionState } from "@/session";
import type { WalletId } from "@/wallets/descriptor";
import { webSessionOptions } from "@/web";

export interface WalletProviderProps extends WalletSessionOptions {
  children: ReactNode;
}

export interface WalletContextValue extends WalletSessionState {
  /** Alias of `readyState`. */
  status: WalletSessionState["readyState"];
  session: WalletSession;
  /** `walletId` answers a chooser; omitted, the only installed or remembered wallet is used. */
  connect: (walletId?: WalletId) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Disconnect and drop the remembered wallet, so the chooser shows again. */
  forgetWallet: () => Promise<void>;
  signMessage: WalletSession["signMessage"];
  signTransaction: WalletSession["signTransaction"];
  signPsbt: WalletSession["signPsbt"];
  signPsbts: WalletSession["signPsbts"];
  broadcastTransaction: WalletSession["broadcastTransaction"];
}

export const WalletContext = createContext<WalletContextValue | null>(null);

const SERVER_STATE: WalletSessionState = new WalletSession().getState();

/** One session per mount, started on mount. Options are read once. */
export function WalletProvider({ children, ...options }: WalletProviderProps) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session is created once per mount
  const session = useMemo(() => new WalletSession({ ...webSessionOptions(), ...options }), []);

  useEffect(() => session.start(), [session]);

  const state = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.getState(),
    () => SERVER_STATE,
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      ...state,
      status: state.readyState,
      session,
      connect: (walletId) => session.connect(walletId),
      disconnect: () => session.disconnect(),
      forgetWallet: () => session.forgetWallet(),
      signMessage: (message) => session.signMessage(message),
      signTransaction: (hex) => session.signTransaction(hex),
      signPsbt: ((...args: Parameters<WalletSession["signPsbt"]>) =>
        (session.signPsbt as (...a: unknown[]) => Promise<string>)(...args)) as WalletSession["signPsbt"],
      signPsbts: (request) => session.signPsbts(request),
      broadcastTransaction: (hex) => session.broadcastTransaction(hex),
    }),
    [state, session],
  );

  return <WalletContext value={value}>{children}</WalletContext>;
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useWallet } from "@/react/use-wallet";
import type { ConnectAction } from "@/session";
import type { WalletCandidate, WalletId } from "@/wallets/descriptor";

export interface WalletChooserState {
  /** Whether the site should be showing its chooser panel. */
  open: boolean;
  /** Why it is open: `install` lists store links, `choose` lists installed wallets. `reload`: the button reloads the page. */
  action: ConnectAction;
  candidates: WalletCandidate[];
  /** The connect button's handler: connects outright, opens the panel, or (under `reload`) reloads the page. */
  connect: () => Promise<void>;
  /** A row's handler: connects through that wallet and closes the panel. */
  choose: (id: WalletId) => Promise<void>;
  close: () => void;
}

/** Drives a connect button and the panel behind it; the panel's markup is the site's. */
export function useWalletChooser(): WalletChooserState {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const { connectAction, wallets, readyState } = wallet;

  const connect = useCallback(async () => {
    if (connectAction === "reload") {
      // The wallet was updated or restarted; only a fresh page reaches it again.
      globalThis.location?.reload();
      return;
    }
    if (connectAction === "choose") {
      setOpen(true);
      return;
    }
    // With nothing installed, connect() re-checks for a late wallet, reports missing, and the panel takes over.
    await wallet.connect();
    if (wallet.session.getState().readyState === "not_installed") setOpen(true);
  }, [connectAction, wallet.connect, wallet.session]);

  const choose = useCallback(
    async (id: WalletId) => {
      setOpen(false);
      await wallet.connect(id);
    },
    [wallet.connect],
  );

  const close = useCallback(() => setOpen(false), []);

  // A wallet installed while the install panel is up, or a connection landing from another tab, ends the panel.
  useEffect(() => {
    if (readyState === "connected") setOpen(false);
  }, [readyState]);

  return { open, action: connectAction, candidates: wallets, connect, choose, close };
}

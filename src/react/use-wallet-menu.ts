"use client";

import { useMemo } from "react";
import { useWallet } from "@/react/use-wallet";
import type { WalletCandidate } from "@/wallets/descriptor";

/** What a connected wallet menu shows and does; the markup is the site's. */
export interface WalletMenuState {
  /** The wallet the session is bound to, as the chooser lists it; null for a custom provider. */
  wallet: WalletCandidate | null;
  address: string | null;
  activeAddress: string | null;
  /** Every granted account, active first. Worth a picker past one. */
  accounts: string[];
  switchAccount: (address: string) => Promise<void>;
  /** More than one supported wallet is installed. */
  canSwitchWallet: boolean;
  /** Disconnect and forget the choice, so the next connect asks which wallet. */
  switchWallet: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useWalletMenu(): WalletMenuState {
  const { wallet, wallets, address, activeAddress, accounts, switchAccount, forgetWallet, disconnect } =
    useWallet();
  return useMemo(
    () => ({
      wallet: wallets.find((candidate) => candidate.id === wallet) ?? null,
      address,
      activeAddress,
      accounts,
      switchAccount,
      canSwitchWallet: wallets.filter((candidate) => candidate.installed).length > 1,
      switchWallet: forgetWallet,
      disconnect,
    }),
    [wallet, wallets, address, activeAddress, accounts, switchAccount, forgetWallet, disconnect],
  );
}

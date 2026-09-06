"use client";

import { useContext } from "react";
import { WalletContext, type WalletContextValue } from "@/react/wallet-provider";

/** The wallet session state and actions. Requires a `WalletProvider` ancestor. */
export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used within WalletProvider");
  return value;
}

import { NETWORK, TEST_NETWORK } from "@scure/btc-signer";
import { type BitcoinNetwork, getNetwork } from "@/config";

const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef } as const;

export type ScureNetwork = typeof NETWORK;

const BY_NAME: Record<BitcoinNetwork, ScureNetwork> = {
  mainnet: NETWORK,
  testnet: TEST_NETWORK,
  regtest: REGTEST,
};

/** The scure network for the configured `network`. */
export function scureNetwork(name: BitcoinNetwork = getNetwork()): ScureNetwork {
  return BY_NAME[name];
}

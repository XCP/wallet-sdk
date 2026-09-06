import type { ConnectResult, SignPsbtParams } from "@/provider/types";

/**
 * The wallet's JSON-RPC methods. `XcpWallet` types its requests against this;
 * the injected provider stays untyped. Results are the wire shapes, older ones included.
 */
export interface XcpMethods {
  /** Connect: prompts on first use, silent for an approved origin. */
  xcp_requestAccounts: {
    params: [] | [{ capabilities: { pairedAddresses: boolean } }];
    /** Modern builds answer { accounts, proof }; older ones a bare list. */
    result: ConnectResult | string[];
  };
  /** Passive: the approved accounts, or [] when the worker is cold or the wallet locked. */
  xcp_accounts: { params: []; result: string[] };
  xcp_disconnect: { params: []; result: unknown };
  /** Passive: the active address with its public key, siblings under a paired grant. */
  xcp_getAddresses: { params: []; result: unknown };
  /** Message, optionally the sibling address to sign as under a paired grant. */
  xcp_signMessage: { params: [string] | [string, string]; result: string | { signature: string } };
  xcp_signTransaction: { params: [string]; result: { hex: string } };
  xcp_signPsbt: { params: [SignPsbtParams<unknown>]; result: { hex: string } };
  xcp_signPsbts: { params: [{ requests: readonly SignPsbtParams<unknown>[] }]; result: { hexes: string[] } };
  xcp_broadcastTransaction: { params: [string]; result: { txid: string } };
  /** "mainnet" | "testnet" | ... as the wallet names it. */
  xcp_getNetwork: { params: []; result: string };
  /** "0x0" for Bitcoin mainnet. */
  xcp_chainId: { params: []; result: string };
  /** A fully funded plain-Bitcoin PSBT for an exact payment; not a trusted-site mode. */
  xcp_signBitcoinPsbt: {
    params: [{ hex: string; signInputs: Record<string, number[]>; sighashTypes?: number[] }];
    result: { hex: string };
  };
  xcp_getBalances: { params: [] | [Record<string, unknown>]; result: unknown };
  xcp_getAssets: { params: [] | [Record<string, unknown>]; result: unknown };
  xcp_getHistory: { params: [] | [Record<string, unknown>]; result: unknown };
}

export type XcpMethod = keyof XcpMethods;
export type XcpParams<M extends XcpMethod> = XcpMethods[M]["params"];
export type XcpResult<M extends XcpMethod> = XcpMethods[M]["result"];

/** One request, typed by its method. */
export type XcpRequest<M extends XcpMethod = XcpMethod> = M extends XcpMethod
  ? { method: M; params?: XcpParams<M> }
  : never;

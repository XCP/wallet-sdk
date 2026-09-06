/** Validation patterns */
// bech32 accepts testnet (tb1) and regtest (bcrt1) HRPs too, so a runner-backed
// development provider passes the same checks as the extension.
export const BTC_ADDRESS_REGEX = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^(bc|tb|bcrt)1[a-zA-HJ-NP-Z0-9]{25,59}$/;
export const HEX_REGEX = /^[0-9a-fA-F]+$/;
export const TXID_REGEX = /^[0-9a-f]{64}$/;

/** Well-known wallet JSON-RPC error codes (EIP-1193) */
export const USER_REJECTED = 4001;
export const UNAUTHORIZED = 4100;
export const UNSUPPORTED_METHOD = 4200;
export const DISCONNECTED = 4900;

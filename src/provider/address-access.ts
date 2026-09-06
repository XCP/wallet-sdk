import type { ConnectionProof, ConnectResult, WalletAddresses } from "@/provider/types";

/**
 * Identity under a paired grant. When `canSign` rejects the active Legacy account
 * and accepts the granted SegWit sibling, the sibling is the identity and the
 * Legacy account is an asset source.
 */

export type WalletAddressAccess =
  | { kind: "checking"; identity: null; legacySource: null; pairedSegwitAddress: null }
  | { kind: "single"; identity: string; legacySource: null; pairedSegwitAddress: null }
  | {
      kind: "paired";
      /** The address this site signs and trades as. */
      identity: string;
      /** The Legacy sibling when it is not the identity: an asset source, never a signer here. */
      legacySource: string | null;
      pairedSegwitAddress: string;
    };

export const CHECKING_ADDRESS_ACCESS: WalletAddressAccess = {
  kind: "checking",
  identity: null,
  legacySource: null,
  pairedSegwitAddress: null,
};

/** A site's rule for which addresses it can verify signatures from. */
export type CanSignPolicy = (address: string) => boolean;

export const ANY_ADDRESS: CanSignPolicy = () => true;

/** Paired builds return one proof per granted address; older builds only the active one. */
export function connectionProofForIdentity(result: ConnectResult, identity: string): ConnectionProof | null {
  const candidates = [result.proof, ...(result.proofs ?? [])];
  return candidates.find((proof) => proof?.address === identity) ?? null;
}

export function walletAddressAccess(
  activeAddress: string,
  addresses: WalletAddresses | null,
  canSign: CanSignPolicy = ANY_ADDRESS,
): WalletAddressAccess {
  if (!addresses || addresses.active.address !== activeAddress || !addresses.legacy || !addresses.segwit) {
    return { kind: "single", identity: activeAddress, legacySource: null, pairedSegwitAddress: null };
  }

  const identity =
    !canSign(activeAddress) && canSign(addresses.segwit.address) ? addresses.segwit.address : activeAddress;
  return {
    kind: "paired",
    identity,
    legacySource:
      canSign(identity) && addresses.legacy.address !== identity ? addresses.legacy.address : null,
    pairedSegwitAddress: addresses.segwit.address,
  };
}

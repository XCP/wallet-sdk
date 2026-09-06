import type { ConnectionProof, ConnectResult, WalletAddresses } from "./provider/types";

/**
 * Which of the wallet's addresses a site treats as the person.
 *
 * The extension can grant a site a PAIR: the active account plus its Legacy
 * or SegWit sibling, both signable. Most sites do not care and take the
 * active address as the identity. A site that only verifies SegWit and
 * Taproot signatures — the marketplace — cannot let a Legacy `1...` account
 * be the identity, so when the wallet sits on one and the sibling was
 * granted, the sibling becomes the identity and the Legacy account its asset
 * SOURCE: coins stay where they are, delivery goes wherever the holder says,
 * and the site's signatures always come from an address it can check.
 *
 * `canSign` is that site policy. The default accepts every address, which
 * collapses this to "the active address is the identity", and is what the
 * launchpad and the exchange want.
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

/** Select the connect-time proof for the address the site uses as its
 *  identity. Paired extension builds can return one proof per granted
 *  address while older builds return only the active account's proof. */
export function connectionProofForIdentity(result: ConnectResult, identity: string): ConnectionProof | null {
  const candidates = [result.proof, ...(result.proofs ?? [])];
  return candidates.find((proof) => proof?.address === identity) ?? null;
}

/** Interpret the addresses the extension actually granted, under `canSign`. */
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

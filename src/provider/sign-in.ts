import { WalletSdkError } from "@/errors";
import { PROOF_PREFIX, validateProof, verifyDeclaredConnectionSignature } from "@/provider/proof";
import type { ConnectionProof } from "@/provider/types";

/**
 * Sign-in with a wallet: the connection proof's fields (origin / nonce / issued)
 * under its own first line, `xcp-sign-in`. XCP Wallet reserves messages that
 * start `xcp-wallet\n` for the proofs it signs at connect and refuses to sign
 * them for a site, so a sign-in never uses that namespace. `verifySignIn`
 * accepts both: a sign-in, or a connection proof exchanged for a session.
 */

export const SIGN_IN_PREFIX = "xcp-sign-in";

export interface SignInChallenge {
  origin: string;
  nonce: string;
  issued: number;
}

export function createSignInMessage({ origin, nonce, issued }: SignInChallenge): string {
  return [SIGN_IN_PREFIX, `origin:${origin}`, `nonce:${nonce}`, `issued:${issued}`].join("\n");
}

export function randomNonce(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SignInSigner {
  address: string | null;
  signMessage(message: string): Promise<string>;
  /** Declared on the proof so the verifier picks the right dialect. */
  messageVerification?: ConnectionProof["verification"];
}

/** Client side: a fresh challenge signed by the session's identity. */
export async function signIn(
  signer: SignInSigner,
  origin: string,
  nonce = randomNonce(),
): Promise<ConnectionProof> {
  if (!signer.address) throw new WalletSdkError("wallet_missing", "Wallet not connected");
  const message = createSignInMessage({ origin, nonce, issued: Math.floor(Date.now() / 1000) });
  const signature = await signer.signMessage(message);
  return {
    address: signer.address,
    message,
    signature,
    ...(signer.messageVerification ? { verification: signer.messageVerification } : {}),
  };
}

export interface VerifySignInOptions {
  maxAgeSeconds?: number;
  /** Reject a nonce seen before. The host owns the store. */
  nonceSeen?: (nonce: string) => Promise<boolean> | boolean;
}

/** Server side: structure, origin, age, address and signature, in that order. */
export async function verifySignIn(
  proof: ConnectionProof,
  expectedOrigin: string,
  expectedAddress: string,
  options: VerifySignInOptions = {},
): Promise<{ valid: boolean; reason?: string }> {
  const result = await validateProof(proof, expectedOrigin, expectedAddress, {
    maxAgeSeconds: options.maxAgeSeconds,
    prefixes: [SIGN_IN_PREFIX, PROOF_PREFIX],
    verifySignature: async (message, signature, address) => {
      try {
        return verifyDeclaredConnectionSignature(proof, message, signature, address);
      } catch {
        return false;
      }
    },
  });
  if (!result.valid) return result;
  if (options.nonceSeen) {
    const nonce = /^nonce:(.+)$/m.exec(proof.message)?.[1] ?? "";
    if (await options.nonceSeen(nonce)) return { valid: false, reason: "Nonce already used" };
  }
  return { valid: true };
}

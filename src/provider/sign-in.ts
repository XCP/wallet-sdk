import { WalletSdkError } from "@/errors";
import { validateProof, verifyDeclaredConnectionSignature } from "@/provider/proof";
import type { ConnectionProof } from "@/provider/types";

/**
 * Sign-in with a wallet: the same challenge format the extension signs at
 * connect (`xcp-wallet` / origin / nonce / issued), so one verifier serves both.
 */

export interface SignInChallenge {
  origin: string;
  nonce: string;
  issued: number;
}

export function createSignInMessage({ origin, nonce, issued }: SignInChallenge): string {
  return ["xcp-wallet", `origin:${origin}`, `nonce:${nonce}`, `issued:${issued}`].join("\n");
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

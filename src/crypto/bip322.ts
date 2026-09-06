/**
 * BIP-322 "simple" signature verification for the three script types the XCP
 * Wallet extension produces: p2pkh (legacy ECDSA), p2wpkh (ECDSA) and p2tr
 * key-path (schnorr).
 *
 * The scheme: build a virtual `to_spend` transaction whose single output is
 * the signer's scriptPubKey and whose input commits to the tagged hash of the
 * message; then a virtual `to_sign` transaction spending it. The signature is
 * the serialized witness stack of that spend, base64-encoded. Verification =
 * computing the spend's sighash and checking the witness signature against
 * the address's own key material — so a passing signature proves control of
 * the address over exactly this message.
 *
 * Runs on the Cloudflare Worker: pure @scure/@noble, no Buffer, no wasm.
 */

import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha256";
import { base64 } from "@scure/base";
import { Address, OutScript, p2pkh, p2sh, p2wpkh, Transaction } from "@scure/btc-signer";
import { scureNetwork } from "@/crypto/network";

const TAG = "BIP0322-signed-message";

function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  const buf = new Uint8Array(tagHash.length * 2 + data.length);
  buf.set(tagHash, 0);
  buf.set(tagHash, tagHash.length);
  buf.set(data, tagHash.length * 2);
  return sha256(buf);
}

/** The script types the XCP Wallet extension can produce a signature for and
 *  this module knows how to check. Anything else is "can't verify", which is
 *  a different answer from "the signature is wrong" — see canVerifyBip322. */
const VERIFIABLE = new Set(["pkh", "sh", "wpkh", "tr"]);

/**
 * Whether a BIP-322 signature from this address is checkable here at all.
 * Callers need this to tell an unverifiable address type apart from a failed
 * verification: the first is a gap in coverage, the second is a red flag.
 */
export function canVerifyBip322(address: string): boolean {
  try {
    const decoded = Address(scureNetwork()).decode(address);
    return !!decoded && VERIFIABLE.has(decoded.type);
  } catch {
    return false;
  }
}

function hash256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >> 8) & 0xff;
  b[2] = (n >> 16) & 0xff;
  b[3] = (n >> 24) & 0xff;
  return b;
}

function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff);
  throw new Error("CompactSize too large for BIP-322 scripts");
}

/**
 * The `to_spend` transaction, serialized. Legacy verification can't reuse the
 * btc-signer Transaction path the segwit branches take: it needs this exact
 * byte string to derive the prevout hash the legacy sighash commits to.
 */
function serializeToSpend(messageHash: Uint8Array, scriptPubKey: Uint8Array): Uint8Array {
  const scriptSig = new Uint8Array(2 + 32); // OP_0 PUSH32 <hash>
  scriptSig[0] = 0x00;
  scriptSig[1] = 0x20;
  scriptSig.set(messageHash, 2);
  return concatBytes([
    u32le(0), // nVersion
    compactSize(1), // input count
    new Uint8Array(32), // prevout hash: all zeros
    Uint8Array.of(0xff, 0xff, 0xff, 0xff), // prevout index
    compactSize(scriptSig.length),
    scriptSig,
    u32le(0), // nSequence
    compactSize(1), // output count
    new Uint8Array(8), // amount: 0
    compactSize(scriptPubKey.length),
    scriptPubKey,
    u32le(0), // nLockTime
  ]);
}

/**
 * Pre-segwit sighash for the BIP-322 `to_sign` spend: the classic preimage
 * with the input's scriptSig replaced by the scriptPubKey being spent, double
 * SHA-256'd. Every field but the prevout hash is fixed by BIP-322.
 */
function legacySighash(prevoutHash: Uint8Array, scriptPubKey: Uint8Array, hashType: number): Uint8Array {
  return hash256(
    concatBytes([
      u32le(0), // nVersion
      compactSize(1), // input count
      prevoutHash, // natural order, as written into to_sign
      u32le(0), // prevout index
      compactSize(scriptPubKey.length),
      scriptPubKey, // scriptSig := scriptPubKey for signing
      u32le(0), // nSequence
      compactSize(1), // output count
      new Uint8Array(8), // amount: 0
      compactSize(1),
      Uint8Array.of(0x6a), // OP_RETURN
      u32le(0), // nLockTime
      u32le(hashType),
    ]),
  );
}

/** Serialized witness stack: varint count, then varint-length-prefixed items. */
function decodeWitnessStack(bytes: Uint8Array): Uint8Array[] {
  let pos = 0;
  const readVarint = (): number => {
    const first = bytes[pos++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      const v = bytes[pos] | (bytes[pos + 1] << 8);
      pos += 2;
      return v;
    }
    throw new Error("witness item too large");
  };
  const count = readVarint();
  const stack: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const len = readVarint();
    if (pos + len > bytes.length) throw new Error("truncated witness stack");
    stack.push(bytes.subarray(pos, pos + len));
    pos += len;
  }
  if (pos !== bytes.length) throw new Error("trailing bytes in witness stack");
  return stack;
}

function buildToSignTx(message: string, scriptPubKey: Uint8Array): Transaction {
  // Version 0 is in btc-signer's default allowed set; its allowUnknownVersion
  // flag is NOT passed because the library's check inverts with it set.
  const txOpts = {
    version: 0,
    lockTime: 0,
    allowUnknownOutputs: true,
    allowUnknownInputs: true,
  };

  // to_spend: input commits to the message hash, output is the signer's script.
  const messageHash = taggedHash(TAG, new TextEncoder().encode(message));
  const scriptSig = new Uint8Array(2 + 32); // OP_0 PUSH32 <hash>
  scriptSig[0] = 0x00;
  scriptSig[1] = 0x20;
  scriptSig.set(messageHash, 2);

  const toSpend = new Transaction(txOpts);
  toSpend.addInput({
    txid: new Uint8Array(32),
    index: 0xffffffff,
    sequence: 0,
  });
  toSpend.addOutput({ script: scriptPubKey, amount: 0n });
  // Set after addOutput: a finalScriptSig marks the tx "signed" and blocks
  // further outputs; the force flag permits updating a signed input.
  toSpend.updateInput(0, { finalScriptSig: scriptSig }, true);

  // to_sign: spends to_spend's output 0 into an OP_RETURN.
  const toSign = new Transaction(txOpts);
  toSign.addInput({
    txid: toSpend.id,
    index: 0,
    sequence: 0,
    witnessUtxo: { script: scriptPubKey, amount: 0n },
  });
  toSign.addOutput({ script: Uint8Array.of(0x6a), amount: 0n });
  return toSign;
}

/**
 * The signer's public key, recovered from a BIP-322 signature.
 *
 * WHY THIS EXISTS. Counterparty encodes any message over 80 bytes as bare
 * multisig (composer.py::determine_encoding), and a multisig output embeds
 * the SOURCE's public key so the source can recover its own dust. Core looks
 * that key up by scanning the address's transactions — which only works once
 * the address has SPENT something, because that is the first time a key
 * appears on chain. A freshly funded address has never spent, so core raises
 * "Pubkey not found for …, please provide it with the `multisig_pubkey`
 * parameter" and every launch from a brand-new wallet fails.
 *
 * The connection proof already carries the key: a p2pkh/p2wpkh BIP-322
 * witness is [signature, pubkey]. Nothing here is trusted on the wallet's
 * say-so — the key is accepted only if it hashes to the address it claims,
 * which is the same check verifyBip322 makes before checking the signature.
 *
 * Taproot returns null deliberately. A p2tr address commits to the TWEAKED
 * output key, and the key the wallet can actually sign the multisig leg with
 * is the untweaked internal one; handing core the wrong one of those two
 * would publish a recovery key that recovers nothing. Those addresses fall
 * back to core's own lookup, which is correct once they have spent.
 */
export function pubkeyFromBip322(address: string, signatureBase64: string): string | null {
  let decoded: ReturnType<ReturnType<typeof Address>["decode"]>;
  try {
    decoded = Address(scureNetwork()).decode(address);
  } catch {
    return null;
  }
  if (!decoded) return null;
  if (decoded.type !== "pkh" && decoded.type !== "wpkh" && decoded.type !== "sh") {
    return null;
  }

  let stack: Uint8Array[];
  try {
    stack = decodeWitnessStack(base64.decode(signatureBase64));
  } catch {
    return null;
  }
  if (stack.length !== 2) return null;

  const pubkey = stack[1]!;
  // p2pkh tolerates the uncompressed keys old Counterwallet seeds produce;
  // the witness types never carry one.
  const compressed = pubkey.length === 33;
  if (!compressed && !(decoded.type === "pkh" && pubkey.length === 65)) return null;

  const pubkeyHash = ripemd160(sha256(pubkey));
  if (decoded.type === "sh") {
    // p2sh-p2wpkh: the address commits to the hash of the redeem script, not
    // to the key hash directly.
    const redeemScript = OutScript.encode({ type: "wpkh", hash: pubkeyHash });
    if (!bytesEqual(ripemd160(sha256(redeemScript)), decoded.hash)) return null;
  } else if (!bytesEqual(pubkeyHash, decoded.hash)) {
    return null;
  }

  return bytesToHex(pubkey);
}

const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Verify a BIP-322 simple signature. Returns false on any mismatch; throws
 * only for unsupported address types (so callers can distinguish "wrong
 * signature" from "can't verify this address kind").
 */
export function verifyBip322(address: string, message: string, signatureBase64: string): boolean {
  // Spelled out rather than checked against VERIFIABLE so the union narrows —
  // the taproot branch below needs `decoded.pubkey` to be known to exist.
  const decoded = Address(scureNetwork()).decode(address);
  if (
    !decoded ||
    (decoded.type !== "pkh" && decoded.type !== "sh" && decoded.type !== "wpkh" && decoded.type !== "tr")
  ) {
    throw new Error(`Unsupported address type for BIP-322: ${decoded?.type ?? "unknown"}`);
  }
  const scriptPubKey = OutScript.encode(decoded);

  let stack: Uint8Array[];
  try {
    stack = decodeWitnessStack(base64.decode(signatureBase64));
  } catch {
    return false;
  }

  try {
    // Legacy addresses (the common Counterparty case — plain `1…`, plus the
    // Counterwallet and FreeWallet variants) sign a pre-segwit sighash, not a
    // BIP-143 one, so this branch builds the preimage directly rather than
    // going through the btc-signer transaction the witness branches use.
    // Uncompressed pubkeys are accepted: old Counterwallet keys are.
    if (decoded.type === "pkh") {
      if (stack.length !== 2) return false;
      const [sigWithType, pubkey] = stack;
      if (pubkey.length !== 33 && pubkey.length !== 65) return false;
      if (sigWithType.length < 9) return false;
      if (!bytesEqual(ripemd160(sha256(pubkey)), decoded.hash)) return false;
      const hashType = sigWithType[sigWithType.length - 1];
      const der = sigWithType.subarray(0, -1);
      const messageHash = taggedHash(TAG, new TextEncoder().encode(message));
      const prevoutHash = hash256(serializeToSpend(messageHash, scriptPubKey));
      const digest = legacySighash(prevoutHash, scriptPubKey, hashType);
      const sig = secp256k1.Signature.fromDER(der);
      return secp256k1.verify(sig.toCompactRawBytes(), digest, pubkey, { lowS: false });
    }

    const toSign = buildToSignTx(message, scriptPubKey);

    // p2wpkh and p2sh-p2wpkh share one sighash (BIP-143 witness v0 over the
    // classic p2pkh scriptCode); they differ only in what the address commits
    // to — the pubkey hash directly, or the hash of the p2wpkh redeem script.
    if (decoded.type === "wpkh" || decoded.type === "sh") {
      if (stack.length !== 2) return false;
      const [sigWithType, pubkey] = stack;
      if (pubkey.length !== 33 || sigWithType.length < 9) return false;
      const pubkeyHash = ripemd160(sha256(pubkey));
      if (decoded.type === "wpkh") {
        if (!bytesEqual(pubkeyHash, decoded.hash)) return false;
      } else {
        const redeemScript = OutScript.encode({ type: "wpkh", hash: pubkeyHash });
        if (!bytesEqual(ripemd160(sha256(redeemScript)), decoded.hash)) return false;
      }
      const hashType = sigWithType[sigWithType.length - 1];
      const der = sigWithType.subarray(0, -1);
      const scriptCode = OutScript.encode({ type: "pkh", hash: pubkeyHash });
      const digest = toSign.preimageWitnessV0(0, scriptCode, hashType, 0n);
      const sig = secp256k1.Signature.fromDER(der);
      return secp256k1.verify(sig.toCompactRawBytes(), digest, pubkey, { lowS: false });
    }

    // p2tr key-path: single-element witness, schnorr against the output key.
    if (stack.length !== 1) return false;
    const raw = stack[0];
    let sig: Uint8Array;
    let hashType: number;
    if (raw.length === 64) {
      sig = raw;
      hashType = 0x00; // SIGHASH_DEFAULT
    } else if (raw.length === 65 && raw[64] !== 0x00) {
      sig = raw.subarray(0, 64);
      hashType = raw[64];
    } else {
      return false;
    }
    const digest = toSign.preimageWitnessV1(0, [scriptPubKey], hashType, [0n]);
    return schnorr.verify(sig, digest, decoded.pubkey);
  } catch {
    return false;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* -------------------------------------------------------------------- */
/* BIP-137 legacy recoverable signatures                                */
/* -------------------------------------------------------------------- */

/** Bitcoin Signed Message digest used by strict BIP-137 signatures. */
export function legacyMessageHash(message: string): Uint8Array {
  const magic = new TextEncoder().encode("Bitcoin Signed Message:\n");
  const payload = new TextEncoder().encode(message);
  return hash256(concatBytes([compactSize(magic.length), magic, compactSize(payload.length), payload]));
}

type Bip137Header = {
  type: "pkh" | "sh-wpkh" | "wpkh";
  recovery: number;
  compressed: boolean;
};

const parseBip137Header = (header: number): Bip137Header | null => {
  if (header >= 27 && header <= 30) return { type: "pkh", recovery: header - 27, compressed: false };
  if (header >= 31 && header <= 34) return { type: "pkh", recovery: header - 31, compressed: true };
  if (header >= 35 && header <= 38) return { type: "sh-wpkh", recovery: header - 35, compressed: true };
  if (header >= 39 && header <= 42) return { type: "wpkh", recovery: header - 39, compressed: true };
  return null;
};

export type MessageSignatureVerdict = { valid: true } | { valid: false; reason: string };

/**
 * Strict BIP-137 verification, for wallets such as Trezor that sign
 * messages the pre-BIP-322 way.
 *
 * The caller must explicitly select this verifier — a proof declares its
 * dialect (see ConnectionProof.verification), and this never serves as a
 * fallback for one declared BIP-322. The header must identify the exact
 * address family, and the recovered key must derive the exact address.
 */
export function verifyLegacyRecoverableMessage(
  message: string,
  signatureB64: string,
  address: string,
): MessageSignatureVerdict {
  let signature: Uint8Array;
  try {
    signature = base64.decode(signatureB64.trim());
  } catch {
    return { valid: false, reason: "signature is not base64" };
  }
  if (signature.length !== 65) {
    return { valid: false, reason: `recoverable signature must be 65 bytes, got ${signature.length}` };
  }

  const header = parseBip137Header(signature[0]);
  if (!header) return { valid: false, reason: "invalid BIP-137 header" };

  let decoded: ReturnType<ReturnType<typeof Address>["decode"]>;
  try {
    decoded = Address(scureNetwork()).decode(address);
  } catch {
    return { valid: false, reason: "not a valid address" };
  }
  const expectedType = header.type === "sh-wpkh" ? "sh" : header.type;
  if (decoded.type !== expectedType) {
    return { valid: false, reason: `BIP-137 header does not match ${decoded.type} address` };
  }

  const digest = legacyMessageHash(message);
  const compact = signature.subarray(1);
  let recovered: Uint8Array;
  try {
    recovered = secp256k1.Signature.fromCompact(compact)
      .addRecoveryBit(header.recovery)
      .recoverPublicKey(digest)
      .toBytes(true);
    if (!secp256k1.verify(compact, digest, recovered, { prehash: false, lowS: false })) {
      return { valid: false, reason: "invalid recoverable signature" };
    }
  } catch {
    return { valid: false, reason: "public key recovery failed" };
  }

  try {
    const publicKey = secp256k1.Point.fromBytes(recovered).toBytes(header.compressed);
    const script =
      header.type === "pkh"
        ? p2pkh(publicKey).script
        : header.type === "sh-wpkh"
          ? p2sh(p2wpkh(publicKey)).script
          : p2wpkh(publicKey).script;
    const derived = Address(scureNetwork()).encode(OutScript.decode(script));
    const canonical = Address(scureNetwork()).encode(decoded);
    return derived === canonical
      ? { valid: true }
      : { valid: false, reason: "recovered key does not match address" };
  } catch {
    return { valid: false, reason: "address derivation failed" };
  }
}

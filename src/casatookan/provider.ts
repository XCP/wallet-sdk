import { hex } from "@scure/base";
import { Address, p2pkh, p2tr, p2wpkh } from "@scure/btc-signer";
import { getNetwork } from "@/config";
import { broadcastSignedTransaction } from "@/counterparty/broadcast";
import { verifyBip86RecoverableMessage, verifyLegacyRecoverableMessage } from "@/crypto/bip322";
import { WalletSdkError } from "@/errors";
import type { ProviderPsbtSigningCapabilities } from "@/provider/capabilities";
import type { ConnectionProof, WalletAddress, XcpProvider } from "@/provider/types";
import {
  CASA_BATCH_LIMIT,
  CASA_SIGHASHES,
  type CasaSigningOptions,
  prepareCasaPsbt,
  verifyCasaPsbt,
} from "./psbt";

export interface CasaTookanProvider {
  requestAccounts(): Promise<unknown>;
  getAccounts(): Promise<unknown>;
  getPublicKey(): Promise<unknown>;
  getNetwork(): Promise<unknown>;
  signMessage(message: string, type: "ecdsa"): Promise<unknown>;
  signPsbt(psbtHex: string, options: CasaSigningOptions): Promise<unknown>;
  signPsbts?(psbtHexes: string[], options: CasaSigningOptions[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export const CASATOOKAN_MESSAGE_VERIFICATION: NonNullable<ConnectionProof["verification"]> = {
  method: "BIP-137",
  format: "legacy_recoverable",
};

export function getCasaTookanProvider(): CasaTookanProvider | null {
  if (typeof window === "undefined") return null;
  const injected = window as unknown as {
    casaTookan?: { isCasaTookan?: boolean };
    unisat?: Partial<CasaTookanProvider>;
  };
  const provider = injected.unisat;
  if (injected.casaTookan?.isCasaTookan !== true || !provider) return null;
  const methods: (keyof CasaTookanProvider)[] = [
    "requestAccounts",
    "getAccounts",
    "getPublicKey",
    "getNetwork",
    "signMessage",
    "signPsbt",
    "on",
    "removeListener",
  ];
  return methods.every((method) => typeof provider[method] === "function")
    ? (provider as CasaTookanProvider)
    : null;
}

export function casaTookanMessageVerification(address: string): NonNullable<ConnectionProof["verification"]> {
  return address.startsWith("bc1p")
    ? { method: "ECDSA-BIP86", format: "legacy_recoverable" }
    : CASATOOKAN_MESSAGE_VERIFICATION;
}

function signingCapabilities(batch: boolean): ProviderPsbtSigningCapabilities {
  const method = {
    supported: true,
    inputScope: "selected" as const,
    externalInputs: "any" as const,
    sighashTypes: [...CASA_SIGHASHES],
  };
  return {
    intentValidation: "none",
    psbt: { ...method },
    psbtBatch: {
      ...method,
      supported: batch,
      approvalMode: "single",
      maxRequests: batch ? CASA_BATCH_LIMIT : 0,
      maxPolicyOfferAlternatives: 0,
      marketplaceBundles: [],
    },
  };
}

function accountList(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((address) => typeof address === "string")) {
    throw new WalletSdkError("invalid_response", "Casa Tookan returned invalid accounts");
  }
  return value;
}

function supportsAddress(address: string): boolean {
  try {
    const type = Address().decode(address).type;
    return type === "pkh" || type === "wpkh" || type === "tr";
  } catch {
    return false;
  }
}

function fromCasaTookanError(error: unknown): WalletSdkError {
  if (error instanceof WalletSdkError) return error;
  const rpc = error as { code?: number | string; message?: string } | null;
  const message = typeof rpc?.message === "string" ? rpc.message : "Casa Tookan request failed";
  const options = { cause: error, walletCode: typeof rpc?.code === "number" ? rpc.code : undefined };
  if (rpc?.code === "E_BUSY" || /\bE_BUSY\b/.test(message))
    return new WalletSdkError(
      "invalid_argument",
      "Finish the pending Casa Tookan approval before signing again",
      options,
    );
  if (rpc?.code === 4001 || /reject|cancel|denied/i.test(message))
    return new WalletSdkError("user_rejected", message, options);
  if (rpc?.code === 4100) return new WalletSdkError("unauthorized", message, options);
  if (rpc?.code === 4900) return new WalletSdkError("disconnected", message, options);
  if (rpc?.code === 4200 || rpc?.code === -32601)
    return new WalletSdkError("unsupported_method", message, options);
  return new WalletSdkError("invalid_response", message, options);
}

export function createCasaTookanProvider(
  casa: CasaTookanProvider | null = getCasaTookanProvider(),
): XcpProvider {
  if (!casa) throw new WalletSdkError("wallet_missing", "Casa Tookan not detected");
  const wallet = casa;
  let disconnected = false;
  let revision = 0;
  let signing = false;
  const disconnectListeners = new Map<(...args: unknown[]) => void, (...args: unknown[]) => void>();

  function endSession(): void {
    revision++;
    for (const handler of disconnectListeners.keys()) handler({});
  }

  async function passiveAccount(): Promise<WalletAddress | null> {
    if (disconnected) return null;
    if (accountList(await wallet.getAccounts()).length === 0) {
      // Casa has no cold-worker state: an empty grant invalidates cached identity.
      endSession();
      return null;
    }
    try {
      return await activeAccount();
    } catch (error) {
      if (error instanceof WalletSdkError && (error.code === "capability" || error.code === "unauthorized"))
        endSession();
      throw error;
    }
  }

  async function requireMainnet(): Promise<void> {
    if (getNetwork() !== "mainnet" || (await wallet.getNetwork()) !== "livenet")
      throw new WalletSdkError("capability", "Casa Tookan supports Bitcoin mainnet only");
  }

  async function activeAccount(): Promise<WalletAddress> {
    if (disconnected) throw new WalletSdkError("disconnected", "Reconnect Casa Tookan before signing");
    await requireMainnet();
    const [address] = accountList(await wallet.getAccounts());
    if (!address) throw new WalletSdkError("unauthorized", "Connect Casa Tookan before signing");
    const publicKey = await wallet.getPublicKey();
    if (typeof publicKey !== "string" || !/^(02|03)[0-9a-f]{64}$/i.test(publicKey))
      throw new WalletSdkError("invalid_response", "Casa Tookan returned an invalid public key");
    const key = hex.decode(publicKey);
    const type =
      p2pkh(key).address === address
        ? "p2pkh"
        : p2wpkh(key).address === address
          ? "p2wpkh"
          : p2tr(key.slice(1)).address === address
            ? "p2tr"
            : null;
    if (!type)
      throw new WalletSdkError(
        "capability",
        "Select a Legacy, Native SegWit or BIP-86 Taproot address in Casa Tookan",
      );
    const [current] = accountList(await wallet.getAccounts());
    if (current !== address)
      throw new WalletSdkError("disconnected", "Casa Tookan account changed; reconnect and retry");
    return { address, publicKey, type };
  }

  async function withAccount<T>(action: (account: WalletAddress) => Promise<T>): Promise<T> {
    if (signing)
      throw new WalletSdkError(
        "invalid_argument",
        "Finish the pending Casa Tookan approval before signing again",
      );
    signing = true;
    const invalidate = () => {
      revision++;
    };
    wallet.on("accountsChanged", invalidate);
    wallet.on("networkChanged", invalidate);
    wallet.on("disconnect", invalidate);
    const start = revision;
    try {
      const account = await activeAccount();
      if (revision !== start) throw new WalletSdkError("disconnected", "Casa Tookan account changed");
      const result = await action(account);
      const current = await activeAccount();
      if (
        revision !== start ||
        current.address !== account.address ||
        current.publicKey !== account.publicKey
      )
        throw new WalletSdkError("disconnected", "Casa Tookan account changed; reconnect and retry");
      return result;
    } finally {
      signing = false;
      wallet.removeListener("accountsChanged", invalidate);
      wallet.removeListener("networkChanged", invalidate);
      wallet.removeListener("disconnect", invalidate);
    }
  }

  async function signPsbt(value: unknown): Promise<{ hex: string }> {
    return withAccount(async (account) => {
      const prepared = prepareCasaPsbt(value, account);
      const signed = await wallet.signPsbt(prepared.hex, prepared.options);
      return { hex: verifyCasaPsbt(prepared, signed) };
    });
  }

  async function signPsbts(value: unknown): Promise<{ hexes: string[] }> {
    if (!wallet.signPsbts)
      throw new WalletSdkError("unsupported_method", "This Casa Tookan version does not support batches");
    const requests = (value as { requests?: unknown } | null)?.requests;
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > CASA_BATCH_LIMIT)
      throw new WalletSdkError("invalid_argument", `Provide between 1 and ${CASA_BATCH_LIMIT} PSBTs`);
    return withAccount(async (account) => {
      const prepared = requests.map((request) => prepareCasaPsbt(request, account));
      const signed = await wallet.signPsbts!(
        prepared.map((p) => p.hex),
        prepared.map((p) => p.options),
      );
      if (!Array.isArray(signed) || signed.length !== prepared.length)
        throw new WalletSdkError("invalid_response", "Casa Tookan returned an incomplete PSBT batch");
      return { hexes: prepared.map((p, index) => verifyCasaPsbt(p, signed[index])) };
    });
  }

  return {
    async request({ method, params = [] }) {
      try {
        switch (method) {
          case "xcp_requestAccounts": {
            await requireMainnet();
            if (accountList(await wallet.getAccounts()).length === 0)
              accountList(await wallet.requestAccounts());
            disconnected = false;
            const active = await activeAccount();
            return { accounts: [active.address], proof: null };
          }
          case "xcp_accounts": {
            const active = await passiveAccount();
            return active ? [active.address] : [];
          }
          case "xcp_getAddresses": {
            const active = await passiveAccount();
            return active
              ? { active, signing: signingCapabilities(typeof wallet.signPsbts === "function") }
              : null;
          }
          case "xcp_getNetwork":
          case "xcp_chainId":
            await requireMainnet();
            return method === "xcp_getNetwork" ? "mainnet" : "0x0";
          case "xcp_disconnect":
            disconnected = true;
            revision++;
            return null;
          case "xcp_signMessage": {
            const [message, address] = params;
            if (typeof message !== "string")
              throw new WalletSdkError("invalid_argument", "A message is required");
            return await withAccount(async (account) => {
              if (address !== undefined && address !== account.address)
                throw new WalletSdkError("unauthorized", "Select the requested Casa Tookan account first");
              const signature = await wallet.signMessage(message, "ecdsa");
              const verify =
                account.type === "p2tr" ? verifyBip86RecoverableMessage : verifyLegacyRecoverableMessage;
              if (typeof signature !== "string" || !verify(message, signature, account.address).valid)
                throw new WalletSdkError(
                  "invalid_response",
                  "Casa Tookan signature does not match the message and account",
                );
              return signature;
            });
          }
          case "xcp_signPsbt":
            return await signPsbt(params[0]);
          case "xcp_signPsbts":
            return await signPsbts(params[0]);
          case "xcp_broadcastTransaction":
            await activeAccount();
            if (typeof params[0] !== "string")
              throw new WalletSdkError("invalid_argument", "A signed transaction is required");
            return { txid: await broadcastSignedTransaction(params[0]) };
          default:
            throw new WalletSdkError("unsupported_method", `Casa Tookan does not support ${method}`);
        }
      } catch (error) {
        throw fromCasaTookanError(error);
      }
    },
    on: (event, handler) => {
      if (event === "disconnect" && !disconnectListeners.has(handler)) {
        const onAccounts = (value: unknown) => {
          const accounts = accountList(value);
          // XCP uses [] for a locked wallet; Casa Tookan has lost the usable account.
          if (accounts.length === 0 || !supportsAddress(accounts[0]!)) handler({});
        };
        disconnectListeners.set(handler, onAccounts);
        wallet.on("accountsChanged", onAccounts);
      }
      wallet.on(event, handler);
    },
    removeListener: (event, handler) => {
      const onAccounts = event === "disconnect" ? disconnectListeners.get(handler) : undefined;
      if (onAccounts) {
        wallet.removeListener("accountsChanged", onAccounts);
        disconnectListeners.delete(handler);
      }
      wallet.removeListener(event, handler);
    },
  };
}

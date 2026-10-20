import { hex } from "@scure/base";
import { Address, p2pkh, p2wpkh, RawTx, type Transaction } from "@scure/btc-signer";
import { getNetwork } from "@/config";
import { broadcastSignedTransaction } from "@/counterparty/broadcast";
import { verifyLegacyRecoverableMessage } from "@/crypto/bip322";
import { WalletSdkError } from "@/errors";
import type { ProviderPsbtSigningCapabilities } from "@/provider/capabilities";
import type { ConnectionProof, WalletAddress, XcpProvider } from "@/provider/types";
import { assertSameTransaction, readPsbt, readRawTransaction } from "@/transaction/verify";

export interface CasaTookanProvider {
  requestAccounts(): Promise<unknown>;
  getAccounts(): Promise<unknown>;
  getPublicKey(): Promise<unknown>;
  getNetwork(): Promise<unknown>;
  signMessage(message: string, type: "ecdsa"): Promise<unknown>;
  signPsbt(
    psbtHex: string,
    options: {
      autoFinalize: false;
      toSignInputs: { index: number; address: string; sighashTypes: number[] }[];
    },
  ): Promise<unknown>;
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

function signingCapabilities(): ProviderPsbtSigningCapabilities {
  return {
    intentValidation: "none",
    psbt: { supported: true, inputScope: "all", sighashTypes: [1] },
    psbtBatch: {
      supported: false,
      inputScope: "all",
      sighashTypes: [],
      maxRequests: 0,
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
    return type === "pkh" || type === "wpkh";
  } catch {
    return false;
  }
}

function fromCasaTookanError(error: unknown): WalletSdkError {
  if (error instanceof WalletSdkError) return error;
  const rpc = error as { code?: number; message?: string } | null;
  const message = typeof rpc?.message === "string" ? rpc.message : "Casa Tookan request failed";
  const options = { cause: error, walletCode: rpc?.code };
  if (rpc?.code === 4001 || /reject|cancel|denied/i.test(message))
    return new WalletSdkError("user_rejected", message, options);
  if (rpc?.code === 4100) return new WalletSdkError("unauthorized", message, options);
  if (rpc?.code === 4900) return new WalletSdkError("disconnected", message, options);
  if (rpc?.code === 4200 || rpc?.code === -32601)
    return new WalletSdkError("unsupported_method", message, options);
  return new WalletSdkError("invalid_response", message, options);
}

function requireOwnedInputs(tx: Transaction, account: WalletAddress): void {
  if (!tx.inputsLength || !tx.outputsLength)
    throw new WalletSdkError("invalid_argument", "A transaction needs inputs and outputs");
  const key = hex.decode(account.publicKey);
  const expected = account.type === "p2pkh" ? p2pkh(key).script : p2wpkh(key).script;
  for (let index = 0; index < tx.inputsLength; index++) {
    const input = tx.getInput(index);
    let prevout = input.witnessUtxo;
    if (input.nonWitnessUtxo) {
      const parent = readRawTransaction(hex.encode(RawTx.encode(input.nonWitnessUtxo)));
      if (!input.txid || parent.id !== hex.encode(input.txid) || input.index === undefined)
        throw new WalletSdkError("transaction_mismatch", "PSBT parent does not match its input");
      const output = parent.getOutput(input.index);
      if (output.amount === undefined || !output.script)
        throw new WalletSdkError("invalid_argument", "PSBT parent output is missing");
      if (
        prevout &&
        (prevout.amount !== output.amount || hex.encode(prevout.script) !== hex.encode(output.script))
      )
        throw new WalletSdkError("transaction_mismatch", "PSBT prevouts disagree");
      prevout = { amount: output.amount, script: output.script };
    } else if (account.type === "p2pkh") {
      throw new WalletSdkError("invalid_argument", "Legacy signing requires the full parent transaction");
    }
    if (!prevout || hex.encode(prevout.script) !== hex.encode(expected))
      throw new WalletSdkError("capability", "Casa Tookan must own every input in this transaction");
    if ((input.sighashType ?? 1) !== 1)
      throw new WalletSdkError("capability", "Casa Tookan pilot supports SIGHASH_ALL only");
  }
}

/** Opt-in pilot: mainnet Legacy/Native SegWit, one fully owned transaction per approval. */
export function createCasaTookanProvider(
  casa: CasaTookanProvider | null = getCasaTookanProvider(),
): XcpProvider {
  if (!casa) throw new WalletSdkError("wallet_missing", "Casa Tookan not detected");
  const wallet = casa;
  let disconnected = false;
  let revision = 0;
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
      throw new WalletSdkError("capability", "Casa Tookan pilot supports Bitcoin mainnet only");
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
    const type = p2pkh(key).address === address ? "p2pkh" : p2wpkh(key).address === address ? "p2wpkh" : null;
    if (!type)
      throw new WalletSdkError("capability", "Select a Legacy or Native SegWit address in Casa Tookan");
    const [current] = accountList(await wallet.getAccounts());
    if (current !== address)
      throw new WalletSdkError("disconnected", "Casa Tookan account changed; reconnect and retry");
    return { address, publicKey, type };
  }

  async function withAccount<T>(action: (account: WalletAddress) => Promise<T>): Promise<T> {
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
      wallet.removeListener("accountsChanged", invalidate);
      wallet.removeListener("networkChanged", invalidate);
      wallet.removeListener("disconnect", invalidate);
    }
  }

  async function signPsbt(value: unknown): Promise<{ hex: string }> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new WalletSdkError("invalid_argument", "A PSBT request is required");
    const request = value as Record<string, unknown>;
    if (Object.keys(request).some((key) => !["hex", "signInputs", "sighashTypes"].includes(key)))
      throw new WalletSdkError("capability", "Casa Tookan pilot does not support intents or commit/reveal");
    if (typeof request.hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(request.hex))
      throw new WalletSdkError("invalid_argument", "A hex PSBT is required");
    const psbtHex = request.hex;
    const tx = readPsbt(psbtHex);
    const indices = Array.from({ length: tx.inputsLength }, (_, index) => index);
    if (
      request.sighashTypes !== undefined &&
      (!Array.isArray(request.sighashTypes) ||
        request.sighashTypes.length !== indices.length ||
        request.sighashTypes.some((type) => type !== 1))
    )
      throw new WalletSdkError("capability", "Use SIGHASH_ALL for every input");
    return withAccount(async (account) => {
      if (request.signInputs !== undefined) {
        const inputs = request.signInputs;
        if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
          throw new WalletSdkError("invalid_argument", "Invalid signing inputs");
        const entries = Object.entries(inputs);
        const selected = entries[0]?.[1] as unknown;
        if (
          entries.length !== 1 ||
          entries[0]?.[0] !== account.address ||
          !Array.isArray(selected) ||
          selected.length !== indices.length ||
          new Set(selected).size !== indices.length ||
          selected.some((index) => !Number.isInteger(index) || !indices.includes(index))
        )
          throw new WalletSdkError("capability", "Casa Tookan must sign every input with the active account");
      }
      requireOwnedInputs(tx, account);
      // Casa Tookan's bridge spells this autoFinalize, unlike Unisat's autoFinalized.
      const signed = await wallet.signPsbt(psbtHex, {
        autoFinalize: false,
        toSignInputs: indices.map((index) => ({ index, address: account.address, sighashTypes: [1] })),
      });
      if (typeof signed !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(signed))
        throw new WalletSdkError("invalid_response", "Casa Tookan returned an invalid PSBT");
      const result = readPsbt(signed);
      assertSameTransaction(tx, result);
      requireOwnedInputs(result, account);
      for (const index of indices) {
        const before = tx.getInput(index);
        const after = result.getInput(index);
        if (before.witnessUtxo && after.witnessUtxo?.amount !== before.witnessUtxo.amount)
          throw new WalletSdkError("transaction_mismatch", "Casa Tookan changed a prevout amount");
      }
      if (!result.isFinal) result.finalize();
      result.extract();
      return { hex: signed };
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
            return active ? { active, signing: signingCapabilities() } : null;
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
              if (
                typeof signature !== "string" ||
                !verifyLegacyRecoverableMessage(message, signature, account.address).valid
              )
                throw new WalletSdkError(
                  "invalid_response",
                  "Casa Tookan signature does not match the message and account",
                );
              return signature;
            });
          }
          case "xcp_signPsbt":
            return await signPsbt(params[0]);
          case "xcp_broadcastTransaction":
            await activeAccount();
            if (typeof params[0] !== "string")
              throw new WalletSdkError("invalid_argument", "A signed transaction is required");
            return { txid: await broadcastSignedTransaction(params[0]) };
          default:
            throw new WalletSdkError("unsupported_method", `Casa Tookan pilot does not support ${method}`);
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

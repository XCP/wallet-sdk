import { secp256k1 } from "@noble/curves/secp256k1";
import { base64, hex } from "@scure/base";
import { p2pkh, p2tr, p2wpkh, Transaction } from "@scure/btc-signer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CasaTookanProvider,
  createCasaTookanProvider,
  getCasaTookanProvider,
} from "@/casatookan/provider";
import { configureWalletSdk } from "@/config";
import { legacyMessageHash } from "@/crypto/bip322";
import { WalletSession } from "@/session";
import { readPsbt } from "@/transaction/verify";
import { CASATOOKAN_WALLET } from "@/wallets/casatookan";
import { discoverWallets, KNOWN_WALLETS } from "@/wallets/discovery";

const key = new Uint8Array(32).fill(9);
const pub = secp256k1.getPublicKey(key, true);
const other = p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(10), true));
const segwit = p2wpkh(pub);
const legacy = p2pkh(pub);

function fixture(type: "p2wpkh" | "p2pkh" = "p2wpkh") {
  const payment = type === "p2pkh" ? legacy : segwit;
  const parent = new Transaction({ allowUnknownInputs: true });
  parent.addOutputAddress(payment.address, 20_000n);
  parent.addInput({ txid: hex.decode("cc".repeat(32)), index: 0, finalScriptSig: hex.decode("51") });
  const tx = new Transaction();
  tx.addInput({
    txid: parent.id,
    index: 0,
    ...(type === "p2pkh"
      ? { nonWitnessUtxo: parent.toBytes(true, true) }
      : { witnessUtxo: { script: payment.script, amount: 20_000n } }),
  });
  tx.addOutputAddress(other.address, 19_000n);
  return tx;
}

function fakeCasa(address = segwit.address) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const casa = {
    requestAccounts: vi.fn(async () => [address]),
    getAccounts: vi.fn(async (): Promise<string[]> => [address]),
    getPublicKey: vi.fn(async () => hex.encode(pub)),
    getNetwork: vi.fn(async () => "livenet"),
    signMessage: vi.fn(async (message: string) => {
      const signature = secp256k1.sign(legacyMessageHash(message), key);
      return base64.encode(Uint8Array.from([31 + signature.recovery, ...signature.toCompactRawBytes()]));
    }),
    signPsbt: vi.fn(async (encoded: string) => {
      const tx = readPsbt(encoded);
      tx.sign(key);
      return hex.encode(tx.toPSBT());
    }),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener);
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    listeners,
  } satisfies CasaTookanProvider & { emit: unknown; listeners: unknown };
  return casa;
}

function sign(casa: CasaTookanProvider, tx = fixture(), extra: Record<string, unknown> = {}) {
  return createCasaTookanProvider(casa).request({
    method: "xcp_signPsbt",
    params: [{ hex: hex.encode(tx.toPSBT()), ...extra }],
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  configureWalletSdk({ network: "mainnet", storage: null });
});

describe("Casa Tookan pilot", () => {
  it("requires Casa Tookan's marker and a complete bridge, not just window.unisat", () => {
    const casa = fakeCasa();
    vi.stubGlobal("window", { unisat: casa });
    expect(getCasaTookanProvider()).toBeNull();
    vi.stubGlobal("window", { casaTookan: { isCasaTookan: true }, unisat: casa });
    expect(getCasaTookanProvider()).toBe(casa);
    vi.stubGlobal("window", { casaTookan: { isCasaTookan: true }, unisat: {} });
    expect(getCasaTookanProvider()).toBeNull();
  });

  it("is opt-in and discovers late injection", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", {});
    expect(KNOWN_WALLETS.some((wallet) => wallet.id === "casatookan")).toBe(false);
    const discovery = discoverWallets([CASATOOKAN_WALLET]);
    const changed = vi.fn();
    const unsubscribe = discovery.subscribe(changed);
    vi.stubGlobal("window", { casaTookan: { isCasaTookan: true }, unisat: fakeCasa() });
    vi.advanceTimersByTime(250);
    expect(changed).toHaveBeenCalledWith([expect.objectContaining({ id: "casatookan", installed: true })]);
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores passively, disconnects locally and requires explicit reconnect", async () => {
    const casa = fakeCasa();
    const provider = createCasaTookanProvider(casa);
    expect(await provider.request({ method: "xcp_accounts" })).toEqual([segwit.address]);
    expect(casa.requestAccounts).not.toHaveBeenCalled();
    const grant = await provider.request({ method: "xcp_getAddresses" });
    expect(grant).toMatchObject({
      active: { address: segwit.address, type: "p2wpkh" },
      signing: {
        intentValidation: "none",
        psbt: { inputScope: "all", sighashTypes: [1] },
        psbtBatch: { supported: false },
      },
    });
    expect(grant).not.toHaveProperty("legacy");
    await provider.request({ method: "xcp_disconnect" });
    expect(await provider.request({ method: "xcp_accounts" })).toEqual([]);
    await expect(provider.request({ method: "xcp_signMessage", params: ["hello"] })).rejects.toMatchObject({
      code: "disconnected",
    });
    await provider.request({ method: "xcp_requestAccounts" });
    expect(casa.requestAccounts).not.toHaveBeenCalled();
  });

  it("asks for a connection only when Casa Tookan has no existing grant", async () => {
    const casa = fakeCasa();
    casa.getAccounts.mockResolvedValueOnce([]);
    const provider = createCasaTookanProvider(casa);
    await expect(provider.request({ method: "xcp_requestAccounts" })).resolves.toMatchObject({
      accounts: [segwit.address],
    });
    expect(casa.requestAccounts).toHaveBeenCalledOnce();
  });

  it.each(["p2pkh", "p2wpkh"] as const)("signs and finalizes a complete %s transaction", async (type) => {
    const address = type === "p2pkh" ? legacy.address : segwit.address;
    const casa = fakeCasa(address);
    const tx = fixture(type);
    const signed = (await sign(casa, tx, { signInputs: { [address]: [0] }, sighashTypes: [1] })) as {
      hex: string;
    };
    expect(casa.signPsbt).toHaveBeenCalledWith(hex.encode(tx.toPSBT()), {
      autoFinalize: false,
      toSignInputs: [{ index: 0, address, sighashTypes: [1] }],
    });
    const result = readPsbt(signed.hex);
    expect(hex.encode(result.unsignedTx)).toBe(hex.encode(tx.unsignedTx));
    result.finalize();
    expect(result.extract().length).toBeGreaterThan(0);
    expect([...casa.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("accepts an already-finalized response", async () => {
    const casa = fakeCasa();
    casa.signPsbt.mockImplementation(async (encoded) => {
      const tx = readPsbt(encoded);
      tx.sign(key);
      tx.finalize();
      return hex.encode(tx.toPSBT());
    });
    await expect(sign(casa)).resolves.toHaveProperty("hex");
  });

  it.each(["p2pkh", "p2wpkh"] as const)(
    "verifies %s message proofs against the requested message and account",
    async (type) => {
      const casa = fakeCasa(type === "p2pkh" ? legacy.address : segwit.address);
      const provider = createCasaTookanProvider(casa);
      const signature = await provider.request({ method: "xcp_signMessage", params: ["exact message"] });
      casa.signMessage.mockResolvedValueOnce(signature as string);
      await expect(
        provider.request({ method: "xcp_signMessage", params: ["different"] }),
      ).rejects.toMatchObject({ code: "invalid_response" });
      await expect(
        provider.request({ method: "xcp_signMessage", params: ["hello", other.address] }),
      ).rejects.toMatchObject({ code: "unauthorized" });
    },
  );

  it("connects with an independently verified session proof", async () => {
    const casa = fakeCasa();
    vi.stubGlobal("window", { casaTookan: { isCasaTookan: true }, unisat: casa });
    const session = new WalletSession({
      wallets: discoverWallets([CASATOOKAN_WALLET]),
      proofOnConnect: true,
      origin: "https://xcpdex.com",
    });
    await session.connect("casatookan");
    expect(session.address).toBe(segwit.address);
    expect(session.connectionProof?.verification?.method).toBe("BIP-137");
    session.stop();
  });

  it.each(["xcp_signPsbts", "xcp_signTransaction", "xcp_switchAccount"])("refuses %s", async (method) => {
    await expect(createCasaTookanProvider(fakeCasa()).request({ method })).rejects.toMatchObject({
      code: "unsupported_method",
    });
  });

  it.each([
    { intent: {} },
    { inscription: {} },
    { reveal: {} },
    { sighashTypes: [0x83] },
    { sighashTypes: [] },
    { signInputs: { [segwit.address]: [] } },
    { signInputs: { [other.address]: [0] } },
    { signInputs: { [segwit.address]: [0, 0] } },
  ])("refuses unsupported request %j before prompting", async (extra) => {
    const casa = fakeCasa();
    await expect(sign(casa, fixture(), extra)).rejects.toMatchObject({ code: "capability" });
    expect(casa.signPsbt).not.toHaveBeenCalled();
  });

  it("refuses foreign inputs, missing prevouts and unsafe PSBT sighash flags", async () => {
    const casa = fakeCasa();
    for (const input of [
      { witnessUtxo: { script: other.script, amount: 20_000n } },
      { witnessUtxo: { script: segwit.script, amount: 20_000n }, sighashType: 0x83 },
      {},
    ]) {
      const tx = new Transaction();
      tx.addInput({ txid: "aa".repeat(32), index: 0, ...input });
      tx.addOutputAddress(other.address, 19_000n);
      await expect(sign(casa, tx)).rejects.toMatchObject({ code: "capability" });
    }
    expect(casa.signPsbt).not.toHaveBeenCalled();
  });

  it("refuses changed transactions and unsigned responses", async () => {
    const casa = fakeCasa();
    casa.signPsbt.mockImplementationOnce(async () => {
      const tx = fixture();
      tx.updateOutput(0, { amount: 18_000n });
      tx.sign(key);
      return hex.encode(tx.toPSBT());
    });
    await expect(sign(casa)).rejects.toMatchObject({ code: "transaction_mismatch" });
    casa.signPsbt.mockImplementationOnce(async (encoded) => encoded);
    await expect(sign(casa)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("refuses changed prevout amounts even when the unsigned transaction is unchanged", async () => {
    const casa = fakeCasa();
    casa.signPsbt.mockImplementationOnce(async (encoded) => {
      const tx = readPsbt(encoded);
      tx.updateInput(0, { witnessUtxo: { script: segwit.script, amount: 30_000n } });
      tx.sign(key);
      return hex.encode(tx.toPSBT());
    });
    await expect(sign(casa)).rejects.toMatchObject({ code: "transaction_mismatch" });
  });

  it.each(["psbt", "message"])("discards %s results after switching away and back", async (kind) => {
    const casa = fakeCasa();
    const method = kind === "psbt" ? "signPsbt" : "signMessage";
    const original = casa[method].getMockImplementation()!;
    casa[method].mockImplementationOnce(async (value: string) => {
      const result = await original(value);
      casa.emit("accountsChanged", [other.address]);
      casa.emit("accountsChanged", [segwit.address]);
      return result;
    });
    const request =
      kind === "psbt"
        ? sign(casa)
        : createCasaTookanProvider(casa).request({ method: "xcp_signMessage", params: ["hello"] });
    await expect(request).rejects.toMatchObject({ code: "disconnected" });
    expect([...casa.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it("discards signing results after silent revocation", async () => {
    const casa = fakeCasa();
    const original = casa.signPsbt.getMockImplementation()!;
    casa.signPsbt.mockImplementationOnce(async (encoded) => {
      const result = await original(encoded);
      casa.getAccounts.mockResolvedValue([]);
      return result;
    });
    await expect(sign(casa)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects mismatched keys, Taproot and non-mainnet before signing", async () => {
    for (const address of [other.address, p2tr(pub.slice(1)).address]) {
      const casa = fakeCasa(address);
      await expect(sign(casa)).rejects.toMatchObject({ code: "capability" });
      expect(casa.signPsbt).not.toHaveBeenCalled();
    }
    const casa = fakeCasa();
    casa.getNetwork.mockResolvedValue("testnet");
    await expect(sign(casa)).rejects.toMatchObject({ code: "capability" });
    casa.getNetwork.mockResolvedValue("livenet");
    configureWalletSdk({ network: "testnet" });
    await expect(sign(casa)).rejects.toMatchObject({ code: "capability" });
  });

  it("does not restore an unsupported account through the passive connect fallback", async () => {
    const provider = createCasaTookanProvider(fakeCasa(p2tr(pub.slice(1)).address));
    await expect(provider.request({ method: "xcp_accounts" })).rejects.toMatchObject({ code: "capability" });
  });

  it("ends the SDK session on revoked or unsupported accounts and removes the event bridge", () => {
    const casa = fakeCasa();
    const provider = createCasaTookanProvider(casa);
    const disconnected = vi.fn();
    provider.on("disconnect", disconnected);
    casa.emit("accountsChanged", [other.address]);
    expect(disconnected).not.toHaveBeenCalled();
    casa.emit("accountsChanged", []);
    casa.emit("accountsChanged", [p2tr(pub.slice(1)).address]);
    expect(disconnected).toHaveBeenCalledTimes(2);
    provider.removeListener("disconnect", disconnected);
    casa.emit("accountsChanged", []);
    expect(disconnected).toHaveBeenCalledTimes(2);
    expect(casa.listeners.get("accountsChanged")?.size).toBe(0);
  });

  it("preserves rejection errors and removes only its own listeners", async () => {
    const casa = fakeCasa();
    const provider = createCasaTookanProvider(casa);
    const listener = vi.fn();
    provider.on("accountsChanged", listener);
    casa.signPsbt.mockRejectedValueOnce({ code: 4001, message: "User rejected" });
    await expect(sign(casa)).rejects.toMatchObject({ code: "user_rejected" });
    casa.emit("accountsChanged", []);
    expect(listener).toHaveBeenCalledWith([]);
    provider.removeListener("accountsChanged", listener);
    expect(casa.listeners.get("accountsChanged")?.size).toBe(0);
  });
});

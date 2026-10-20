import { secp256k1 } from "@noble/curves/secp256k1";
import { base64, hex } from "@scure/base";
import { p2pkh, p2sh, p2tr, p2wpkh, Script, Transaction } from "@scure/btc-signer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CasaTookanProvider,
  createCasaTookanProvider,
  getCasaTookanProvider,
} from "@/casatookan/provider";
import { configureWalletSdk } from "@/config";
import { legacyMessageHash } from "@/crypto/bip322";
import { WALLET_CONNECTED_STORAGE_KEY, WalletSession } from "@/session";
import { readPsbt } from "@/transaction/verify";
import { CASATOOKAN_WALLET } from "@/wallets/casatookan";
import { discoverWallets, KNOWN_WALLETS } from "@/wallets/discovery";

const key = new Uint8Array(32).fill(9);
const pub = secp256k1.getPublicKey(key, true);
const other = p2wpkh(secp256k1.getPublicKey(new Uint8Array(32).fill(10), true));
const segwit = p2wpkh(pub);
const legacy = p2pkh(pub);
const taproot = p2tr(pub.slice(1));
const nested = p2sh(segwit);

function fixture(type: "p2wpkh" | "p2pkh" | "p2tr" = "p2wpkh") {
  const payment = type === "p2pkh" ? legacy : type === "p2tr" ? taproot : segwit;
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
    signPsbt: vi.fn(async (encoded: string, options?: Parameters<CasaTookanProvider["signPsbt"]>[1]) => {
      const tx = readPsbt(encoded);
      if (options) for (const input of options.toSignInputs) tx.signIdx(key, input.index, input.sighashTypes);
      else tx.sign(key);
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
  return Object.assign(casa, {
    signPsbts: vi.fn(async (hexes: string[], options: Parameters<CasaTookanProvider["signPsbt"]>[1][]) =>
      Promise.all(hexes.map((h, i) => casa.signPsbt(h, options[i]))),
    ),
  });
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
        psbt: { inputScope: "selected", externalInputs: "any", taprootTreeKeyPath: false },
        psbtBatch: { supported: true, maxRequests: 20, approvalMode: "single" },
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

  it.each([{ accounts: [] }, { accounts: [nested.address] }])(
    "clears restored identity when the passive grant is unusable: %j",
    async ({ accounts }) => {
      const stored = new Map([[WALLET_CONNECTED_STORAGE_KEY, segwit.address]]);
      configureWalletSdk({
        storage: {
          getItem: (key) => stored.get(key) ?? null,
          setItem: (key, value) => void stored.set(key, value),
          removeItem: (key) => void stored.delete(key),
        },
      });
      const casa = fakeCasa();
      casa.getAccounts.mockResolvedValue(accounts);
      const session = new WalletSession({ provider: createCasaTookanProvider(casa) });
      session.start();
      session.stop();
      session.start();
      try {
        await vi.waitFor(() => {
          expect(session.getState()).toMatchObject({ readyState: "disconnected", address: null });
        });
        expect(stored.has(WALLET_CONNECTED_STORAGE_KEY)).toBe(false);
        expect(casa.requestAccounts).not.toHaveBeenCalled();
      } finally {
        session.stop();
      }
    },
  );

  it("reattaches account and revocation listeners when a session restarts", async () => {
    const casa = fakeCasa();
    const session = new WalletSession({ provider: createCasaTookanProvider(casa) });
    session.start();
    await session.connect();
    session.stop();
    session.start();
    session.start();
    expect(casa.listeners.get("accountsChanged")?.size).toBe(2);
    casa.emit("accountsChanged", []);
    expect(session.getState()).toMatchObject({ readyState: "disconnected", address: null });
    session.stop();
    expect([...casa.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
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

  it("refuses an unexpectedly finalized response", async () => {
    const casa = fakeCasa();
    casa.signPsbt.mockImplementation(async (encoded) => {
      const tx = readPsbt(encoded);
      tx.sign(key);
      tx.finalize();
      return hex.encode(tx.toPSBT());
    });
    await expect(sign(casa)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each(["p2pkh", "p2wpkh", "p2tr"] as const)(
    "verifies %s message proofs against the requested message and account",
    async (type) => {
      const casa = fakeCasa(
        type === "p2pkh" ? legacy.address : type === "p2tr" ? taproot.address : segwit.address,
      );
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

  it.each([segwit.address, taproot.address])(
    "connects with an independently verified session proof: %s",
    async (address) => {
      const casa = fakeCasa(address);
      vi.stubGlobal("window", { casaTookan: { isCasaTookan: true }, unisat: casa });
      const session = new WalletSession({
        wallets: discoverWallets([CASATOOKAN_WALLET]),
        proofOnConnect: true,
        origin: "https://xcpdex.com",
      });
      await session.connect("casatookan");
      expect(session.address).toBe(address);
      expect(session.connectionProof?.verification?.method).toBe(
        address === taproot.address ? "ECDSA-BIP86" : "BIP-137",
      );
      session.stop();
    },
  );

  it.each(["xcp_signTransaction", "xcp_switchAccount"])("refuses %s", async (method) => {
    await expect(createCasaTookanProvider(fakeCasa()).request({ method })).rejects.toMatchObject({
      code: "unsupported_method",
    });
  });

  it.each([{ inscription: {} }, { reveal: {} }, { signInputs: { [other.address]: [0] } }])(
    "refuses unsupported request %j before prompting",
    async (extra) => {
      const casa = fakeCasa();
      await expect(sign(casa, fixture(), extra)).rejects.toMatchObject({ code: "capability" });
      expect(casa.signPsbt).not.toHaveBeenCalled();
    },
  );

  it("refuses foreign inputs, missing prevouts and unsafe PSBT sighash flags", async () => {
    const casa = fakeCasa();
    for (const input of [
      { witnessUtxo: { script: other.script, amount: 20_000n } },
      { witnessUtxo: { script: segwit.script, amount: 20_000n }, sighashType: 4 },
    ]) {
      const tx = new Transaction();
      tx.addInput({ txid: "aa".repeat(32), index: 0, ...input });
      tx.addOutputAddress(other.address, 19_000n);
      await expect(sign(casa, tx)).rejects.toMatchObject({ code: "capability" });
    }
    expect(casa.signPsbt).not.toHaveBeenCalled();
  });

  it("refuses tree-bearing Taproot recovery even when the internal key is the account key", async () => {
    const casa = fakeCasa(taproot.address);
    const tree = p2tr(pub.slice(1), { script: Script.encode([taproot.script.slice(2), "CHECKSIG"]) });
    const tx = new Transaction();
    tx.addInput({
      txid: "ab".repeat(32),
      index: 0,
      witnessUtxo: { script: tree.script, amount: 20_000n },
      tapInternalKey: pub.slice(1),
      tapMerkleRoot: tree.tapMerkleRoot,
    });
    tx.addOutputAddress(taproot.address, 19_000n);
    const control = tx.clone();
    control.sign(key);
    control.finalize();
    expect(control.extract().length).toBeGreaterThan(0);
    await expect(sign(casa, tx)).rejects.toMatchObject({ code: "capability" });
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

  it("rejects mismatched keys, nested SegWit and non-mainnet before signing", async () => {
    for (const address of [other.address, nested.address]) {
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
    const provider = createCasaTookanProvider(fakeCasa(nested.address));
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
    casa.emit("accountsChanged", [nested.address]);
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

  for (const type of ["p2pkh", "p2wpkh", "p2tr"] as const) {
    for (const version of [0, 2]) {
      it.each(type === "p2tr" ? [0, 1, 2, 3, 129, 130, 131] : [1, 2, 3, 129, 130, 131])(
        `verifies ${type} PSBT v${version} with sighash %d`,
        async (sighashType) => {
          const address =
            type === "p2pkh" ? legacy.address : type === "p2tr" ? taproot.address : segwit.address;
          const tx = fixture(type);
          tx.updateInput(0, {
            sighashType,
            ...(type === "p2tr" ? { tapInternalKey: pub.slice(1) } : {}),
          });
          const provider = createCasaTookanProvider(fakeCasa(address));
          const result = (await provider.request({
            method: "xcp_signPsbt",
            params: [{ hex: hex.encode(tx.toPSBT(version)), sighashTypes: [sighashType] }],
          })) as { hex: string };
          const signed = readPsbt(result.hex);
          signed.finalize();
          expect(signed.extract().length).toBeGreaterThan(0);
          expect(hex.encode(readPsbt(result.hex).toPSBT(version))).toBe(result.hex);
        },
      );
    }
  }

  it("signs a selected input, preserves a foreign signature, and finalizes the shared transaction", async () => {
    const tx = fixture();
    const foreignKey = new Uint8Array(32).fill(10);
    tx.addInput({ txid: "dd".repeat(32), index: 1, witnessUtxo: { script: other.script, amount: 5_000n } });
    tx.signIdx(foreignKey, 1);
    const foreignSignature = tx.getInput(1).partialSig;
    const casa = fakeCasa();
    const result = (await sign(casa, tx, {
      signInputs: { [segwit.address]: [0] },
      intent: { action: "trade" },
    })) as { hex: string };
    const signed = readPsbt(result.hex);
    expect(signed.getInput(1).partialSig).toEqual(foreignSignature);
    signed.finalize();
    expect(signed.extract().length).toBeGreaterThan(0);
    expect(casa.signPsbt.mock.calls[0]?.[1]?.toSignInputs).toEqual([
      { index: 0, address: segwit.address, sighashTypes: [1] },
    ]);
  });

  it("leaves unselected owned and unsigned foreign inputs unsigned", async () => {
    const tx = fixture();
    for (const [index, payment] of [segwit, other].entries())
      tx.addInput({ txid: "dd".repeat(32), index, witnessUtxo: { script: payment.script, amount: 5_000n } });
    const signed = (await sign(fakeCasa(), tx, { signInputs: { [segwit.address]: [0] } })) as { hex: string };
    expect(readPsbt(signed.hex).getInput(1).partialSig).toBeUndefined();
    expect(readPsbt(signed.hex).getInput(2).partialSig).toBeUndefined();
  });

  it("refuses another address family from the same key before invoking the wallet", async () => {
    const casa = fakeCasa(taproot.address);
    await expect(sign(casa, fixture(), { signInputs: { [taproot.address]: [0] } })).rejects.toMatchObject({
      code: "capability",
    });
    expect(casa.signPsbt).not.toHaveBeenCalled();
  });

  it.each([
    { sighashTypes: [131] },
    { sighashTypes: [] },
    { signInputs: { [segwit.address]: [] } },
    { signInputs: { [segwit.address]: [0, 0] } },
    { signInputs: { [segwit.address]: [-1] } },
  ])("validates input selection and exact sighash before approval: %j", async (extra) => {
    const casa = fakeCasa();
    await expect(sign(casa, fixture(), extra)).rejects.toMatchObject({ code: "invalid_argument" });
    expect(casa.signPsbt).not.toHaveBeenCalled();
  });

  it("rejects signatures produced for a different prevout amount even if metadata is restored", async () => {
    const casa = fakeCasa();
    casa.signPsbt.mockImplementationOnce(async (encoded) => {
      const tx = readPsbt(encoded);
      tx.updateInput(0, { witnessUtxo: { script: segwit.script, amount: 30_000n } });
      tx.sign(key);
      tx.updateInput(0, { witnessUtxo: { script: segwit.script, amount: 20_000n } }, true);
      return hex.encode(tx.toPSBT());
    });
    await expect(sign(casa)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("restores proprietary metadata stripped by the signing engine", async () => {
    const original = fixture();
    const tx = Transaction.fromPSBT(original.toPSBT(), { unknown: "ignore", proprietary: "ignore" });
    tx.updateInput(0, { unknown: [[{ type: 252, key: new Uint8Array([1, 65, 0]) }, new Uint8Array([42])]] });
    const result = (await sign(fakeCasa(), tx)) as { hex: string };
    const signed = Transaction.fromPSBT(hex.decode(result.hex), { unknown: "ignore", proprietary: "ignore" });
    expect(signed.getInput(0).proprietary).toEqual([[new Uint8Array([1, 65, 0]), new Uint8Array([42])]]);
  });

  it("signs 20 ordered requests through one batch call with per-item policies", async () => {
    const casa = fakeCasa();
    const provider = createCasaTookanProvider(casa);
    const requests = Array.from({ length: 20 }, (_, index) => {
      const tx = fixture();
      tx.updateOutput(0, { amount: BigInt(19_000 - index) });
      tx.updateInput(0, { sighashType: index % 2 ? 131 : 1 });
      return { hex: hex.encode(tx.toPSBT()), sighashTypes: [index % 2 ? 131 : 1] };
    });
    const result = (await provider.request({ method: "xcp_signPsbts", params: [{ requests }] })) as {
      hexes: string[];
    };
    expect(casa.signPsbts).toHaveBeenCalledOnce();
    expect(result.hexes).toHaveLength(20);
    result.hexes.forEach((encoded, index) => {
      const tx = readPsbt(encoded);
      expect(tx.getOutput(0).amount).toBe(BigInt(19_000 - index));
      tx.finalize();
      expect(tx.extract().length).toBeGreaterThan(0);
    });
  });

  it.each(["truncated", "reordered", "unsigned", "rejected", "revoked"])(
    "returns no partial batch for %s results",
    async (failure) => {
      const casa = fakeCasa();
      const original = casa.signPsbts.getMockImplementation()!;
      casa.signPsbts.mockImplementationOnce(async (hexes, options) => {
        const signed = await original(hexes, options);
        if (failure === "truncated") return signed.slice(0, 1);
        if (failure === "reordered") return signed.reverse();
        if (failure === "unsigned") return [signed[0]!, hexes[1]!];
        if (failure === "rejected") throw { code: 4001, message: "Cancelled" };
        casa.emit("accountsChanged", []);
        return signed;
      });
      const tx = fixture();
      const second = fixture();
      second.updateOutput(0, { amount: 18_999n });
      await expect(
        createCasaTookanProvider(casa).request({
          method: "xcp_signPsbts",
          params: [{ requests: [tx, second].map((t) => ({ hex: hex.encode(t.toPSBT()) })) }],
        }),
      ).rejects.toBeInstanceOf(Error);
    },
  );

  it("rejects excessive batches, oversized PSBTs and invalid later requests before prompting", async () => {
    const casa = fakeCasa();
    const provider = createCasaTookanProvider(casa);
    const request = { hex: hex.encode(fixture().toPSBT()) };
    for (const requests of [[], Array(21).fill(request), [request, { hex: "00" }]])
      await expect(
        provider.request({ method: "xcp_signPsbts", params: [{ requests }] }),
      ).rejects.toBeInstanceOf(Error);
    await expect(
      provider.request({ method: "xcp_signPsbt", params: [{ hex: "00".repeat(65_537) }] }),
    ).rejects.toMatchObject({ code: "capability" });
    expect(casa.signPsbts).not.toHaveBeenCalled();
    expect(casa.signPsbt).not.toHaveBeenCalled();
  });

  it("refuses overlapping approvals and allows the next request after completion", async () => {
    const casa = fakeCasa();
    const provider = createCasaTookanProvider(casa);
    const params = [{ hex: hex.encode(fixture().toPSBT()) }];
    const pending = provider.request({ method: "xcp_signPsbt", params });
    await expect(provider.request({ method: "xcp_signPsbt", params })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await pending;
    await expect(provider.request({ method: "xcp_signPsbt", params })).resolves.toHaveProperty("hex");
  });
});

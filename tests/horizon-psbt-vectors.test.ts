import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { hex } from "@scure/base";
import { p2pkh, p2wpkh, Transaction } from "@scure/btc-signer";
import { afterEach, expect, it } from "vitest";
import { configureWalletSdk } from "@/config";
import { createHorizonProvider } from "@/horizon/provider";
import { XcpWallet } from "@/provider/wallet";
import { VERIFY_TX_OPTIONS } from "@/transaction/verify";
import fixtures from "./fixtures/horizon-2.3.1.json";

afterEach(() => configureWalletSdk({ storage: null }));

// Built by the marketplace's real policy parent, accept and hard-cancel builders;
// signed by official Horizon 2.3.1 with the public abandon/about test wallet.
// Dummy prevouts, no funds, no broadcast. Includes unsigned market-owned inputs.
it.each(fixtures)("verifies captured $name signatures and adapter input selection", async (fixture) => {
  const tx = Transaction.fromPSBT(hex.decode(fixture.signedHex), VERIFY_TX_OPTIONS);
  const unsigned = Transaction.fromPSBT(hex.decode(fixture.hex), VERIFY_TX_OPTIONS);
  expect(hex.encode(tx.unsignedTx)).toBe(hex.encode(unsigned.unsignedTx));
  const scripts = Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).witnessUtxo!.script);
  const amounts = Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).witnessUtxo!.amount);
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    expect(input.finalScriptWitness?.length ?? 0).toBe(0);
    expect(input.finalScriptSig?.length ?? 0).toBe(0);
    if (!fixture.expected.includes(i)) {
      expect(input.partialSig?.length ?? 0).toBe(0);
      expect(input.tapKeySig).toBeUndefined();
      continue;
    }
    if (input.tapKeySig) {
      const sig = input.tapKeySig;
      const hashType = sig.length === 65 ? sig[64]! : 0;
      expect(fixture.sighashTypes).toContain(hashType);
      const digest = tx.preimageWitnessV1(i, scripts, hashType, amounts);
      expect(schnorr.verify(sig.subarray(0, 64), digest, scripts[i]!.subarray(2))).toBe(true);
    } else {
      expect(input.partialSig).toHaveLength(1);
      const [pub, sig] = input.partialSig![0]!;
      expect(p2wpkh(pub).script).toEqual(scripts[i]);
      const hashType = sig[sig.length - 1]!;
      expect(fixture.sighashTypes).toContain(hashType);
      const digest = tx.preimageWitnessV0(i, p2pkh(pub).script, hashType, amounts[i]!);
      expect(
        secp256k1.verify(secp256k1.Signature.fromDER(sig.subarray(0, -1)).toCompactRawBytes(), digest, pub, {
          prehash: false,
        }),
      ).toBe(true);
    }
  }

  const cache = new Map<string, string>();
  configureWalletSdk({
    storage: {
      getItem: (k) => cache.get(k) ?? null,
      setItem: (k, v) => void cache.set(k, v),
      removeItem: (k) => void cache.delete(k),
    },
  });
  const calls: unknown[] = [];
  const provider = createHorizonProvider({
    request: async (method, params) => {
      if (method === "getAddresses")
        return {
          result: {
            addresses: [
              {
                address: fixture.address,
                publicKey: "02" + "11".repeat(32),
                type: fixture.name.includes("-tr-") ? "p2tr" : "p2wpkh",
              },
            ],
          },
        };
      calls.push(params);
      return { result: { hex: fixture.signedHex } };
    },
  });
  const wallet = new XcpWallet(provider);
  await wallet.connect();
  const sighashTypes = Array.from({ length: tx.inputsLength }, () => fixture.sighashTypes[0]!);
  expect(await wallet.signPsbt(fixture.hex, { [fixture.address]: fixture.expected }, sighashTypes)).toBe(
    fixture.signedHex,
  );
  expect(calls).toEqual([
    { hex: fixture.hex, signInputs: fixture.signInputs, sighashTypes: fixture.sighashTypes },
  ]);
  const capabilities = (await wallet.getAddresses())!.signing!;
  expect(capabilities.intentValidation).toBe("none");
  expect(capabilities.psbtBatch.approvalMode).toBe("per-psbt");
  expect(capabilities.psbtBatch.marketplaceBundles).toEqual([]);
});

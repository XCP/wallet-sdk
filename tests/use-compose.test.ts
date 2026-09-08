// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmountValidationError } from "@/amounts";
import { WalletSdkError } from "@/errors";
import { useCompose } from "@/react/use-compose";

const mock = vi.hoisted(() => ({ address: "source", action: vi.fn() }));
vi.mock("@/react/use-wallet", () => ({
  useWallet: () => ({ address: mock.address, session: { asSigner: () => ({}) } }),
}));
vi.mock("@/transaction/compose", async (original) => ({
  ...(await original<typeof import("@/transaction/compose")>()),
  composeAndBroadcast: (...args: unknown[]) => mock.action(...args),
}));

let root: Root;
let current: ReturnType<typeof useCompose>;
function Harness() {
  current = useCompose();
  return null;
}
async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  mock.address = "source";
  mock.action.mockReset();
  vi.unstubAllGlobals();
});

describe("useCompose structured errors", () => {
  it("preserves amount codes through wrapping and clears them on reset and account change", async () => {
    mock.action.mockRejectedValue(
      new WalletSdkError("invalid_argument", "quantity: malformed", {
        cause: new AmountValidationError("amount_syntax"),
      }),
    );
    await mount();
    await act(async () => current.compose("send", { quantity: "1,234" }));
    expect(current).toMatchObject({
      status: "error",
      errorCode: "amount_syntax",
      errorDetails: { diagnostic: "quantity: malformed" },
    });
    await act(async () => current.reset());
    expect(current).toMatchObject({ status: "idle", errorCode: null, errorDetails: null });
    await act(async () => current.compose("send", { quantity: "1,234" }));
    mock.address = "other";
    await act(async () => root.render(createElement(Harness)));
    expect(current).toMatchObject({ status: "idle", errorCode: null, errorDetails: null });
  });

  it("keeps wallet diagnostics and mismatch codes, clearing metadata when another action succeeds", async () => {
    mock.action.mockRejectedValueOnce(
      new WalletSdkError("user_rejected", "Original wallet diagnostic", { walletCode: 4001 }),
    );
    await mount();
    await act(async () => current.compose("send", {}));
    expect(current).toMatchObject({
      errorCode: "user_rejected",
      errorDetails: { diagnostic: "Original wallet diagnostic", walletCode: 4001 },
    });
    mock.action.mockRejectedValueOnce(new WalletSdkError("transaction_mismatch", "Different amount"));
    await act(async () => current.compose("send", {}));
    expect(current.errorCode).toBe("transaction_mismatch");
    mock.action.mockResolvedValueOnce({ txid: "test", type: "send", signedHex: "" });
    await act(async () => current.compose("send", {}));
    expect(current).toMatchObject({ status: "confirmed", txid: "test", errorCode: null, errorDetails: null });
  });
});

import type http from "node:http";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  approve,
  createXcpWallet,
  HORIZON_EXTENSION,
  launchWithExtensions,
  serveTestPage,
  XCP_WALLET_EXTENSION,
  xcpWalletId,
} from "./harness";

declare global {
  interface Window {
    sdk: {
      session: {
        getState(): Record<string, unknown>;
        connect(id?: string): Promise<void>;
        disconnect(): Promise<void>;
        signMessage(message: string): Promise<string>;
      };
      discovery: { snapshot(): { id: string; installed: boolean }[] };
      verifyBip322(address: string, message: string, signature: string): boolean;
    };
  }
}

let context: BrowserContext;
let server: http.Server;
let url: string;
let page: Page;

test.beforeAll(async () => {
  const extensions = [XCP_WALLET_EXTENSION, ...(HORIZON_EXTENSION ? [HORIZON_EXTENSION] : [])];
  context = await launchWithExtensions("xcp-wallet", extensions);
  const id = await xcpWalletId(context);
  const popup = await createXcpWallet(context, id);
  await popup.close();
  ({ server, url } = await serveTestPage());
  page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.sdk !== undefined);
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
});

const state = () => page.evaluate(() => window.sdk.session.getState());

test("discovery sees the installed wallets and the session settles on connect or choose", async () => {
  // Horizon injects a beat later than XCP Wallet; wait for every wallet that is loaded.
  await page.waitForFunction(
    (expected) => window.sdk.discovery.snapshot().filter((c) => c.installed).length >= expected,
    HORIZON_EXTENSION ? 2 : 1,
  );
  const snapshot = await page.evaluate(() => window.sdk.discovery.snapshot());
  expect(snapshot.find((c) => c.id === "xcp")?.installed).toBe(true);
  expect(snapshot.find((c) => c.id === "horizon")?.installed).toBe(Boolean(HORIZON_EXTENSION));
  // The session learns of a late wallet on discovery's next poll tick, a beat after the snapshot.
  await page.waitForFunction(
    (expected) => window.sdk.session.getState().connectAction === expected,
    HORIZON_EXTENSION ? "choose" : "connect",
  );
  expect((await state()).readyState).toBe("disconnected");
});

test("connect approves in the extension, verifies the BIP-322 proof in the page, and stores the choice", async () => {
  const approved = approve(context, /requests\/connect\/approve/, "Connect");
  await page.evaluate(() => window.sdk.session.connect("xcp"));
  await approved;
  await page.waitForFunction(() => window.sdk.session.getState().readyState === "connected");
  const connected = await state();
  expect(connected.wallet).toBe("xcp");
  expect(connected.accounts).toHaveLength(1);
  expect(connected.proofStatus).toBe("verified");
  expect(await page.evaluate(() => localStorage.getItem("xcp:wallet-choice"))).toBe("xcp");
  expect(await page.evaluate(() => localStorage.getItem("xcp-wallet-connected"))).toBe(connected.address);
});

test("signMessage approves in the extension and the signature verifies against the connected address", async () => {
  const message = "wallet-sdk e2e: sign me";
  const approved = approve(context, /requests\/message\/approve/, "Sign message");
  const signature = page.evaluate((m) => window.sdk.session.signMessage(m), message);
  await approved;
  const signed = await signature;
  const valid = await page.evaluate(
    ({ m, s }) => {
      const address = window.sdk.session.getState().address as string;
      return {
        ok: window.sdk.verifyBip322(address, m, s),
        altered: window.sdk.verifyBip322(address, `${m}!`, s),
      };
    },
    { m: message, s: signed },
  );
  expect(valid).toEqual({ ok: true, altered: false });
});

test("a reload restores the session without a prompt, and disconnect clears it", async () => {
  await page.reload();
  await page.waitForFunction(() => window.sdk?.session.getState().readyState === "connected");
  expect((await state()).wallet).toBe("xcp");
  await page.evaluate(() => window.sdk.session.disconnect());
  await page.waitForFunction(() => window.sdk.session.getState().readyState === "disconnected");
  expect(await page.evaluate(() => localStorage.getItem("xcp-wallet-connected"))).toBeNull();
});

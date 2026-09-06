import type http from "node:http";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { HORIZON_EXTENSION, launchWithExtensions, serveTestPage, XCP_WALLET_EXTENSION } from "./harness";

/**
 * Horizon renders its UI on a canvas, so its prompts cannot be driven here.
 * What can be checked against the real build: its injected surface, its
 * registry entry, and that discovery and the chooser see it.
 */
test.skip(!HORIZON_EXTENSION, "HORIZON_EXTENSION not set");

let context: BrowserContext;
let server: http.Server;
let page: Page;

test.beforeAll(async () => {
  context = await launchWithExtensions("horizon", [XCP_WALLET_EXTENSION, HORIZON_EXTENSION!]);
  const served = await serveTestPage();
  server = served.server;
  page = await context.newPage();
  await page.goto(served.url);
  await page.waitForFunction(() => window.sdk !== undefined);
});

test.afterAll(async () => {
  await context?.close();
  server?.close();
});

test("Horizon injects the surface the adapter expects and registers itself", async () => {
  await page.waitForFunction(() => (window as unknown as { HorizonWalletProvider?: unknown }).HorizonWalletProvider);
  const surface = await page.evaluate(() => {
    const w = window as unknown as {
      HorizonWalletProvider: { request?: unknown };
      btc_providers?: { id: string; methods?: string[] }[];
    };
    return {
      request: typeof w.HorizonWalletProvider.request,
      registry: w.btc_providers?.find((p) => p.id === "HorizonWalletProvider")?.methods ?? null,
    };
  });
  expect(surface.request).toBe("function");
  expect(surface.registry).toEqual(expect.arrayContaining(["getAddresses", "signPsbt", "signMessage"]));
});

test("discovery lists Horizon as installed and the session asks which wallet", async () => {
  await page.waitForFunction(() =>
    window.sdk.discovery.snapshot().every((c: { installed: boolean }) => c.installed),
  );
  await page.waitForFunction(() => window.sdk.session.getState().connectAction === "choose");
  const snapshot = await page.evaluate(() => window.sdk.discovery.snapshot());
  expect(snapshot.map((c) => c.id)).toEqual(["xcp", "horizon"]);
});

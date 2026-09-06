import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, expect, type Page } from "@playwright/test";
import { build } from "esbuild";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export const XCP_WALLET_EXTENSION =
  process.env.XCP_WALLET_EXTENSION ?? path.resolve(HERE, "../../extension/.output/chrome-mv3");
export const HORIZON_EXTENSION = process.env.HORIZON_EXTENSION;
export const TEST_PASSWORD = "TestPassword123!";

const PAGE = `<!DOCTYPE html>
<html><head><title>wallet-sdk e2e</title></head>
<body><h1>wallet-sdk e2e</h1><script type="module" src="/page.js"></script></body></html>`;

/** The page's script: the SDK source bundled with its dependencies, since the dist keeps them external. */
async function bundlePage(): Promise<string> {
  const result = await build({
    entryPoints: [path.resolve(HERE, "page.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
    alias: { "@": path.resolve(HERE, "../src") },
  });
  return result.outputFiles[0]!.text;
}

export async function serveTestPage(): Promise<{ server: http.Server; url: string }> {
  const script = await bundlePage();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/page.js")) {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(script);
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
    });
    server.listen(0, "localhost", () => {
      const address = server.address();
      if (address && typeof address !== "string") resolve({ server, url: `http://localhost:${address.port}` });
    });
  });
}

export async function launchWithExtensions(testId: string, extensions: string[]): Promise<BrowserContext> {
  for (const dir of extensions) {
    if (!fs.existsSync(path.join(dir, "manifest.json"))) throw new Error(`No extension at ${dir}`);
  }
  const userDataDir = path.resolve(HERE, `../test-results/${testId}`);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      `--disable-extensions-except=${extensions.join(",")}`,
      `--load-extension=${extensions.join(",")}`,
    ],
  });
}

/** The XCP Wallet extension id, from its service worker. */
export async function xcpWalletId(context: BrowserContext): Promise<string> {
  for (let i = 0; i < 30; i++) {
    for (const worker of context.serviceWorkers()) {
      const url = worker.url();
      if (url.includes("chrome-extension://") && !HORIZON_EXTENSION?.includes(url.split("/")[2] ?? "")) {
        const match = url.match(/chrome-extension:\/\/([^/]+)/);
        if (match) return match[1]!;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("XCP Wallet service worker not found");
}

/** Onboards a fresh XCP Wallet in its popup: create, reveal, confirm, password. Same steps as the extension's own e2e. */
export async function createXcpWallet(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForLoadState("domcontentloaded");
  const create = page.getByRole("button", { name: /Create.*Wallet/i });
  await create.waitFor({ state: "visible", timeout: 15_000 });
  await create.click();
  await page.waitForURL(/keychain\/setup\/create-mnemonic/);
  await page.waitForLoadState("networkidle");
  const reveal = page.getByRole("button", { name: "Reveal recovery phrase" });
  await reveal.waitFor({ state: "visible" });
  await reveal.click();
  const saved = page.getByLabel(/I have saved my secret recovery phrase/);
  await expect(saved).toBeVisible();
  await saved.check();
  await page.locator('input[name="password"]').fill(TEST_PASSWORD);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/index/, { timeout: 15_000 });
  return page;
}

/** Waits for the extension's approval page and presses its primary button. */
export async function approve(context: BrowserContext, urlPart: RegExp, button: string): Promise<void> {
  const popup = await context.waitForEvent("page", { timeout: 30_000 });
  await expect(popup).toHaveURL(urlPart, { timeout: 15_000 });
  const action = popup.getByRole("button", { name: button, exact: true });
  await expect(action).toBeEnabled({ timeout: 15_000 });
  await action.click();
}

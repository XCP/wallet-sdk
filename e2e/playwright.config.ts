import { defineConfig } from "@playwright/test";

/**
 * Runs against the real extensions, so it is headed and never part of CI:
 * `npm run test:e2e` with XCP Wallet built at ../extension/.output/chrome-mv3
 * (override with XCP_WALLET_EXTENSION), and HORIZON_EXTENSION pointing at an
 * unpacked Horizon build to include its discovery checks.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  use: {
    headless: false,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [["list", { printSteps: true }]],
  use: {
    baseURL: process.env.DEPLOYFLOW_E2E_URL ?? "http://127.0.0.1:3000",
    viewport: { width: 1440, height: 1100 },
    launchOptions: { executablePath: process.env.DEPLOYFLOW_E2E_CHROMIUM },
  },
});

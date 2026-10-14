import { defineConfig } from "@playwright/test";

// Dashboard end-to-end tests against a local production build (Base Sepolia data).
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  use: { baseURL: "http://localhost:3000", trace: "retain-on-failure" },
  webServer: { command: "corepack pnpm --filter @guardian/web start", url: "http://localhost:3000", reuseExistingServer: true, timeout: 120_000 },
  outputDir: "test-results",
});

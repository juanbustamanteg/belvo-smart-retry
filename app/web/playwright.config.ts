import { defineConfig, devices } from "@playwright/test";
import { E2E } from "./e2e/fixtures";

// Real browser, real FastAPI + SQLite, original CSVs. No mocked responses.
// One worker: the server allows a single validation/analysis job at a time.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["./e2e/testing-csv-reporter.ts"]],
  outputDir: "../tests/artifacts/e2e-results",
  use: {
    baseURL: E2E.baseURL,
    ...devices["Desktop Chrome"],
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "./e2e/serve.sh",
    url: `${E2E.baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { E2E_OPERATOR_PASSWORD: E2E.passwords.operator, E2E_REVIEWER_PASSWORD: E2E.passwords.reviewer },
  },
});

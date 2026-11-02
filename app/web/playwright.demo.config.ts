import { defineConfig } from "@playwright/test";
import { E2E } from "./e2e/fixtures";

// Records the narrated walkthrough video. Not part of the test suite; writes no testing rows.
export default defineConfig({
  testDir: "./demo",
  workers: 1,
  timeout: 300_000,
  reporter: [["list"]],
  outputDir: "../tests/artifacts/demo-video",
  use: {
    baseURL: E2E.baseURL,
    viewport: { width: 1280, height: 800 },
    video: { mode: "on", size: { width: 1280, height: 800 } },
    launchOptions: { slowMo: 120 },
  },
  webServer: {
    command: "./e2e/serve.sh",
    url: `${E2E.baseURL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { E2E_OPERATOR_PASSWORD: E2E.passwords.operator, E2E_REVIEWER_PASSWORD: E2E.passwords.reviewer },
  },
});

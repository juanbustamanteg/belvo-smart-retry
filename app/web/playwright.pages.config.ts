import { defineConfig } from "@playwright/test";

// Tests the static GitHub Pages build (dist-demo) exactly as Pages serves it: no backend at all.
export default defineConfig({
  testDir: "./e2e-pages",
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [["list"]],
  outputDir: "../tests/artifacts/pages-results",
  // Set PAGES_URL to test the published site instead of a local preview of dist-demo.
  use: { baseURL: process.env.PAGES_URL ?? "http://127.0.0.1:4174/belvo-smart-retry/", viewport: { width: 1400, height: 900 }, acceptDownloads: true },
  webServer: process.env.PAGES_URL ? undefined : { command: "npx vite preview --mode demo --port 4174 --strictPort --host 127.0.0.1", url: "http://127.0.0.1:4174/belvo-smart-retry/", reuseExistingServer: false, timeout: 60_000 },
});

import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Writes one row per executed browser test in the master's Testing CSV schema (section 8).
// Status comes from Playwright's actual outcome; nothing is declared PASS without execution.
const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, "../..");
const OUT = path.join(APP, "tests", "artifacts", "Belvo_Smart_Retry_E2E_Testing.csv");
const COLUMNS = ["test_run_id", "test_id", "suite", "case_kind", "dataset_kind", "master_sha256", "rule_version",
  "application_version", "engine_version", "configuration_json", "expected_json", "actual_json", "status",
  "executed_at", "evidence_reference", "error_code"];

const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export default class TestingCsvReporter implements Reporter {
  private rows: Record<string, string>[] = [];
  private runId = randomUUID().replace(/-/g, "");
  private master = (() => {
    try { return createHash("sha256").update(readFileSync(path.join(APP, "..", "Belvo_Payments_Data_Analysis.md"))).digest("hex"); }
    catch { return "unavailable"; }
  })();

  onTestEnd(test: TestCase, result: TestResult) {
    const note = (type: string) => test.annotations.find(a => a.type === type)?.description ?? "{}";
    const status = result.status === "passed" ? "PASS" : result.status === "skipped" ? "SKIPPED" : "FAIL";
    const ids = (test.title.match(/\b(E\d{2}|C\d{2}|EC\d{2}|DMO\d{2}|DX\d{2})\b/g) ?? []).join(",");
    this.rows.push({
      test_run_id: this.runId, test_id: test.title, suite: path.basename(test.location.file),
      case_kind: "browser_e2e", dataset_kind: "belvo_sample", master_sha256: this.master, rule_version: "minimal-v1",
      application_version: "0.1.0", engine_version: test.annotations.find(a => a.type === "engine")?.description ?? "sqlite (see health)",
      configuration_json: note("configuration"), expected_json: note("expected"), actual_json: note("actual"), status,
      executed_at: new Date(result.startTime).toISOString(),
      evidence_reference: `playwright chromium ${path.basename(test.location.file)}:${test.location.line} criteria=${ids}`,
      error_code: status === "FAIL" ? (result.error?.message?.split("\n")[0].slice(0, 120) ?? "error") : "",
    });
  }

  onEnd(_: FullResult) {
    if (this.rows.length === 0) return; // e.g. --list: never overwrite real results with an empty file
    mkdirSync(path.dirname(OUT), { recursive: true });
    const lines = [COLUMNS.join(","), ...this.rows.map(r => COLUMNS.map(c => quote(r[c] ?? "")).join(","))];
    writeFileSync(OUT, lines.join("\r\n") + "\r\n", "utf-8");
  }
}

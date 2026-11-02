import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, login, newPage, pickCooldown, pickPolicy, openLoan, parseCsv, readyRun, record, runIdFrom, signOut, totals } from "./fixtures";

const GOLDEN = {
  3: { loans: 3062, RETRY: 404, WAIT: 1945, REVIEW_REMEDIATE: 713 },
  7: { loans: 3062, RETRY: 400, WAIT: 1949, REVIEW_REMEDIATE: 713 },
  14: { loans: 3062, RETRY: 396, WAIT: 1953, REVIEW_REMEDIATE: 713 },
};

test("E01 E12 E14 DMO01-DMO08 happy path: operator prepares, distinct reviewer approves, CSV handed off, state persists", async ({ page, browser, request }, info) => {
  const hosts = new Set<string>();
  const apiCalls: string[] = [];
  page.on("request", r => {
    const u = new URL(r.url());
    hosts.add(u.host);
    if (u.pathname.startsWith("/api/")) apiCalls.push(`${r.method()} ${u.pathname.replace(/[0-9a-f-]{36}/g, ":id")}`);
  });
  const health = await (await request.get("/api/v1/health")).json();
  info.annotations.push({ type: "engine", description: `sqlite ${health.sqlite}` });

  // DMO01-DMO02: workspace and preloaded history
  await login(page, "operator");
  await expect(page.getByText("History available")).toBeVisible();
  await expect(page.getByText(/253,006 requests/)).toBeVisible();

  // DMO02-DMO03: upload the portfolio only, check, generate
  await pickCooldown(page, 7);
  await pickPolicy(page, { fatigue: "Off", holdout: "None" });
  await page.getByRole("button", { name: "New analysis" }).click();
  await page.locator('input[type="file"]').setInputFiles(E2E.loansCsv);
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await expect(page.getByText("3,062 unique IDs")).toBeVisible();
  await expect(page.getByText(/3,033 · 29 without history/)).toBeVisible();
  await expect(page.getByText("MXN 10,952,619.00")).toBeVisible();
  await page.getByRole("button", { name: "Generate results" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  const runUrl = page.url();
  const runId = runIdFrom(runUrl);

  // DMO04: queues, totals and visible-row count kept apart
  const t = await totals(page);
  await expect(page.getByText("Showing 1–50 of 400")).toBeVisible();
  await page.getByRole("tab", { name: /^Waiting/ }).click();
  await expect(page.getByText(/of 1,949 · soonest check first/)).toBeVisible();
  const firstChecks = await page.locator("tbody tr td:nth-child(5)").allInnerTexts();
  expect([...firstChecks].sort()).toEqual(firstChecks);
  await page.getByRole("tab", { name: /^Needs attention/ }).click();
  await page.getByLabel("Filter by reason").selectOption("LATEST_CHARGEBACK");
  await expect(page.getByText("Showing 1–37 of 37")).toBeVisible();
  expect(await totals(page)).toEqual(t);
  await page.getByLabel("Filter by reason").selectOption("");

  // DMO05 / E12: source-backed evidence
  const amb = await openLoan(page, "Needs attention", "7764852545");
  await expect(amb.getByText(/5 · Mixed results or repeated amount/)).toBeVisible();
  const ambRows = await amb.locator("table").first().locator("tbody tr").count();
  const debt = await openLoan(page, "Needs attention", "7765852743");
  await expect(debt.getByText("MXN 1,520.00")).toBeVisible();
  const wait = await openLoan(page, "Waiting", "7764910231");
  await expect(wait.getByText("2025-11-11 (America/Mexico_City)", { exact: false })).toBeVisible();
  await expect(wait.getByText("2025-11-18").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary")).toHaveCount(0);

  // DMO06: submit, sign out, distinct reviewer
  await expect(page.getByText("Submitting sends all 3,062 loans")).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and release payments" })).toHaveCount(0);
  await signOut(page);
  await login(page, "reviewer");
  await page.goto(runUrl);
  await expect(page.getByText(/Approving accepts the analysis for all 3,062 loans .* and releases 1,200 payment requests/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit for review" })).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);

  // DMO07: approve and download
  await page.getByRole("button", { name: "Approve and release payments" }).click();
  await expect(page.getByRole("heading", { name: "Approved results" })).toBeVisible();
  await expect(page.getByText("Approval covers the analysis, not every loan.")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"),
    page.getByRole("button", { name: "Download approved CSV" }).click()]);
  const raw = readFileSync((await download.path())!, "utf-8");
  const rows = parseCsv(raw);
  const counts = { RETRY: 0, WAIT: 0, REVIEW_REMEDIATE: 0 } as Record<string, number>;
  rows.forEach(r => counts[r.decision]++);

  // DMO08: refresh and a fresh session keep the same approved revision
  await page.reload();
  await expect(page.locator(".chip", { hasText: "Approved" })).toBeVisible();
  const again = await newPage(browser, "operator");
  await again.goto(runUrl);
  await expect(again.getByRole("heading", { name: "Approved results" })).toBeVisible();
  const afterTotals = await totals(again);

  const unexpectedCalls = apiCalls.filter(c => !/^(GET|POST|PUT|PATCH) \/api\/v1\/(auth|workspace|runs)/.test(c));
  const actual = { totals: t, ambiguousRows: ambRows, csvRows: rows.length, csvCounts: counts, afterTotals,
    recommendedAmounts: [...new Set(rows.map(r => r.recommended_amount))], executable: [...new Set(rows.map(r => r.is_executable))],
    hosts: [...hosts], unexpectedCalls };
  record(info, { totals: GOLDEN[7], ambiguousRows: 6, csvRows: 3062, recommendedAmounts: [""], executable: ["false"],
    hosts: ["127.0.0.1:8799"], unexpectedCalls: [] }, actual, { cooldown_days: 7, run_id: runId });

  expect(t).toEqual(GOLDEN[7]);
  expect(ambRows).toBe(6);
  expect(raw.startsWith("﻿")).toBe(false);
  expect(raw.includes("\r\n")).toBe(true);
  expect(rows).toHaveLength(3062);
  expect(counts).toEqual({ RETRY: 400, WAIT: 1949, REVIEW_REMEDIATE: 713 });
  expect(new Set(rows.map(r => r.run_id))).toEqual(new Set([runId]));
  expect(actual.recommendedAmounts).toEqual([""]);
  expect(actual.executable).toEqual(["false"]);
  expect(new Set(rows.map(r => r.analysis_review_state))).toEqual(new Set(["Approved"]));
  expect(rows.filter(r => r.payment_request_status === "RELEASED").length).toBe(400);
  expect(rows.every(r => (r.decision === "RETRY") === (r.payment_request_status === "RELEASED"))).toBe(true);
  expect(rows.every(r => JSON.parse(r.payment_request_ids).length === (r.decision === "RETRY" ? 3 : 0))).toBe(true);
  expect(rows.find(r => r.loan_id === "7765852743")!.total_amount_outstanding).toBe("1520.00");
  expect(rows.find(r => r.loan_id === "7764910231")!.next_check_date).toBe("2025-11-18");
  expect(rows.every(r => ({ RETRY: "PREPARE_RETRY_HANDOFF", WAIT: "REASSESS_ON_OR_AFTER_DATE",
    REVIEW_REMEDIATE: "INVESTIGATE_BEFORE_RETRY" } as Record<string, string>)[r.decision] === r.next_action_code)).toBe(true);
  expect(afterTotals).toEqual(GOLDEN[7]);
  expect([...hosts]).toEqual(["127.0.0.1:8799"]);
  expect(unexpectedCalls).toEqual([]);
  await again.context().close();
});

for (const cooldown of [3, 14] as const) {
  test(`E02 C12 alternative ${cooldown}-day wait produces its own golden totals`, async ({ page }, info) => {
    await login(page, "operator");
    await readyRun(page, cooldown);
    const t = await totals(page);
    await expect(page.getByLabel("Full-run totals")).toContainText(`${cooldown} days`);
    record(info, GOLDEN[cooldown], t, { cooldown_days: cooldown });
    expect(t).toEqual(GOLDEN[cooldown]);
  });
}

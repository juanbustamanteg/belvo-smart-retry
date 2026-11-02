import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { E2E, apiCall, login, newPage, openLoan, pickCooldown, prepare, readyRun, record, runIdFrom } from "./fixtures";

test("E05 DX01 invalid portfolio blocks with a specific error, then a corrected file validates", async ({ page }, info) => {
  const bad = info.outputPath("missing-column.csv");
  writeFileSync(bad, "loan_id,payment_method_bank,loan_amount,overdue_at,overdue_days\n1,mx_test,100,1/1/2025,3\n");
  await login(page, "operator");
  await prepare(page, 7, bad);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("missing required columns");
  await expect(alert).toContainText("Missing columns: total_amount_outstanding");
  await expect(page.getByRole("button", { name: "Generate results" })).toHaveCount(0);
  const runId = runIdFrom(page.url());
  const results = (await page.request.get(`/api/v1/runs/${runId}/decisions`)).status();
  await page.locator('input[type="file"]').setInputFiles(E2E.loansCsv);
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  record(info, { blockedResults: 409, afterFix: "Portfolio checked" }, { blockedResults: results, afterFix: "Portfolio checked" });
  expect(results).toBe(409);
});

test("E06 DX02 unknown or account reasons and simultaneous ambiguity keep evidence and go to review", async ({ page }, info) => {
  await login(page, "operator");
  await readyRun(page, 7);
  const cancelled = await openLoan(page, "Needs attention", "7762309510");
  await expect(page.locator("tbody tr", { hasText: "7762309510" })).toContainText("code 03");
  await expect(cancelled.getByText("Cuenta cancelada").first()).toBeVisible();
  await expect(cancelled.getByText(/7 · Latest attempt not entirely insufficient funds/)).toBeVisible();
  const amb = await openLoan(page, "Needs attention", "7764852545");
  const members = amb.locator("table").first().locator("tbody tr");
  await expect(members).toHaveCount(6);
  const amounts = await members.locator("td:nth-child(3)").allInnerTexts();
  await expect(amb.getByRole("button", { name: /override|retry|charge/i })).toHaveCount(0);
  record(info, { members: 6, repeatedAmounts: true }, { members: amounts.length, amounts });
  expect(new Set(amounts).size).toBeLessThan(amounts.length);
});

test("E07 DX03 returned analysis keeps the comment and old revision; changes require a new revision", async ({ page, browser }, info) => {
  await login(page, "operator");
  const runUrl = await readyRun(page, 7);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();

  const reviewer = await newPage(browser, "reviewer");
  await reviewer.goto(runUrl);
  await reviewer.getByRole("button", { name: "Request changes" }).click();
  await expect(reviewer.getByRole("button", { name: "Send back with comment" })).toBeDisabled();
  const comment = "Use a 3-day wait <b>for this client</b>";
  await reviewer.getByLabel(/What should the operator change/).fill(comment);
  await reviewer.getByRole("button", { name: "Send back with comment" }).click();
  await expect(reviewer.locator(".chip", { hasText: "Changes requested" })).toBeVisible();
  await reviewer.context().close();

  await page.reload();
  await expect(page.getByText(comment)).toBeVisible(); // rendered as text, not HTML
  await expect(page.locator("q b")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Submit for review" })).toHaveCount(0);
  await page.getByRole("button", { name: "New revision" }).click();
  await pickCooldown(page, 3);
  await page.getByRole("button", { name: "Create revision" }).click();
  await expect(page).not.toHaveURL(runUrl);
  await expect(page.getByRole("heading", { name: /· r2$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check portfolio" })).toBeVisible();
  await page.goto(runUrl);
  await expect(page.locator(".chip", { hasText: "Changes requested" })).toBeVisible();
  const csv = (await page.request.get(`/api/v1/runs/${runIdFrom(runUrl)}/results.csv`)).status();
  record(info, { oldStatus: "Changes requested", newRevision: "r2 Draft", oldCsv: 409 }, { oldStatus: "Changes requested", newRevision: "r2 Draft", oldCsv: csv });
  expect(csv).toBe(409);
});

test("E08 repeated clicks and replayed requests produce one logical effect", async ({ page }, info) => {
  await login(page, "operator");
  const runUrl = await readyRun(page, 7);
  const runId = runIdFrom(runUrl);
  const before = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
  await page.getByRole("button", { name: "Submit for review" }).dblclick();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();
  const after = await (await page.request.get(`/api/v1/runs/${runId}`)).json();

  const key = crypto.randomUUID();
  const listBefore = (await (await page.request.get("/api/v1/runs?page_size=100")).json()).total;
  const a = await apiCall(page.request, "POST", "/api/v1/runs", { data: { cooldown_days: 14 }, key });
  const b = await apiCall(page.request, "POST", "/api/v1/runs", { data: { cooldown_days: 14 }, key });
  const listAfter = (await (await page.request.get("/api/v1/runs?page_size=100")).json()).total;
  const actual = { submitVersionStep: after.version - before.version, status: after.status,
    sameRun: (await a.json()).run_id === (await b.json()).run_id, newRuns: listAfter - listBefore };
  record(info, { submitVersionStep: 1, status: "Submitted", sameRun: true, newRuns: 1 }, actual);
  expect(actual).toEqual({ submitVersionStep: 1, status: "Submitted", sameRun: true, newRuns: 1 });
});

test("E09 refreshing during processing never shows partial results or a permanent Running state", async ({ page }, info) => {
  await login(page, "operator");
  await prepare(page, 7);
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  const runId = runIdFrom(page.url());
  await page.getByRole("button", { name: "Generate results" }).click();
  await page.reload();
  const states: string[] = [];
  for (let i = 0; i < 50; i++) {
    const run = await (await page.request.get(`/api/v1/runs/${runId}`)).json();
    states.push(run.status);
    if (run.status === "Running") expect((await page.request.get(`/api/v1/runs/${runId}/decisions`)).status()).toBe(409);
    if (!["Validated", "Running"].includes(run.status)) break;
    await page.waitForTimeout(200);
  }
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  record(info, { final: "Ready" }, { states: [...new Set(states)], final: states.at(-1) });
  expect(states.at(-1)).toBe("Ready");
});

test("E11 a reviewer cannot approve a revision the operator withdrew after the page loaded", async ({ page, browser }, info) => {
  await login(page, "operator");
  const runUrl = await readyRun(page, 7);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();

  const reviewer = await newPage(browser, "reviewer");
  await reviewer.goto(runUrl);
  await expect(reviewer.getByRole("button", { name: "Approve and release payments" })).toBeVisible();

  await page.getByRole("button", { name: "Withdraw" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();

  await reviewer.getByRole("button", { name: "Approve and release payments" }).click();
  await expect(reviewer.getByRole("alert")).toContainText("changed since you loaded it");
  await expect(reviewer.getByRole("button", { name: "Approve and release payments" })).toHaveCount(0);
  const status = (await (await page.request.get(`/api/v1/runs/${runIdFrom(runUrl)}`)).json()).status;
  record(info, { status: "Ready" }, { status });
  expect(status).toBe("Ready");
  await reviewer.context().close();
});

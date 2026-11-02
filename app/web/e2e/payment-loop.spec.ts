import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { E2E, login, newPage, openLoan, parseCsv, readyRun, record, signOut, totals } from "./fixtures";

const PY = path.join(E2E.appDir, ".venv", "bin", "python");
const SIM = path.join(E2E.appDir, "tools", "simulate_bank_responses.py");

test("D36 D34 closed loop: draft requests reviewed, approval releases them, synthetic responses, follow-up analysis", async ({ page, browser }, info) => {
  await login(page, "operator");
  const runUrl = await readyRun(page, 7);

  // Draft requests appear with the results; nothing can be downloaded yet.
  const panel = page.getByRole("region", { name: "Payment requests" });
  await expect(panel).toContainText("Draft · released on approval");
  await expect(panel).toContainText("1,200 for 400 retry candidates");
  await expect(page.getByRole("link", { name: "Download payment requests CSV" })).toHaveCount(0);
  const total = /Total\s*MXN ([\d,.]+)/.exec(await panel.innerText())![1];
  await expect(page.getByText(/plus the 1,200 draft payment requests below/)).toBeVisible();

  // Each retry candidate shows its three tranches.
  const loan = await openLoan(page, "Retry candidates", "7762351674");
  const tranches = await loan.getByRole("table", { name: /Payment requests for this loan/ }).locator("tbody tr td:nth-child(2)").allInnerTexts();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();

  // The reviewer sees the amounts and releases them by approving.
  const reviewer = await newPage(browser, "reviewer");
  await reviewer.goto(runUrl);
  await expect(reviewer.getByText(new RegExp(`releases 1,200 payment requests for MXN ${total.replace(/[.]/g, "\\.")}`))).toBeVisible();
  await reviewer.getByRole("button", { name: "Approve and release payments" }).click();
  const released = reviewer.getByRole("region", { name: "Payment requests" });
  await expect(released).toContainText("Released, not sent");
  await expect(released).toContainText("Released by");
  await expect(released).toContainText("reviewer");
  await reviewer.context().close();

  await page.reload();
  await expect(page.getByRole("region", { name: "Payment requests" })).toContainText("Released, not sent");
  const [download] = await Promise.all([page.waitForEvent("download"),
    page.getByRole("link", { name: "Download payment requests CSV" }).click()]);
  const requestsPath = info.outputPath("payment-requests.csv");
  await download.saveAs(requestsPath);
  const requests = parseCsv(readFileSync(requestsPath, "utf-8"));

  // Synthetic responses are produced outside the portal, then imported with an explicit origin.
  const responsesPath = info.outputPath("SYNTHETIC_responses.csv");
  execFileSync(PY, [SIM, requestsPath, "-o", responsesPath, "--seed", "7"]);
  await page.getByLabel("Response file").setInputFiles(responsesPath);
  await expect(page.getByRole("button", { name: "Import responses" })).toBeDisabled();
  await page.getByLabel("Where do these responses come from?").selectOption("synthetic_demo");
  await page.getByRole("button", { name: "Import responses" }).click();
  await expect(page.locator(".chip", { hasText: "Responses imported" })).toBeVisible();
  await expect(page.locator(".chip", { hasText: "Synthetic demo" })).toBeVisible();

  // Follow-up analysis on the new history.
  await page.getByRole("button", { name: "Start follow-up analysis" }).click();
  await expect(page.getByRole("heading", { name: /· r2$/ })).toBeVisible();
  await page.getByRole("button", { name: "Check portfolio" }).click();
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await expect(page.getByText("254,206 requests", { exact: false })).toBeVisible();
  await expect(page.getByText("2025-11-14T23:59:59-06:00", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Generate results" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Synthetic bank responses.");
  const follow = await totals(page);

  // The original approved revision is untouched.
  await page.goto(runUrl);
  await expect(page.locator(".chip", { hasText: "Approved" })).toBeVisible();
  const original = await totals(page);
  await expect(page.getByRole("note")).toHaveCount(0);
  await signOut(page);

  const statuses = [...new Set(requests.map(r => r.status))];
  const loanRows = requests.filter(r => r.loan_id === "7762351674").map(r => r.amount);
  record(info, { requests: 1200, statuses: ["pending"], tranches7762351674: ["146.00", "730.00", "2,044.00"], followLoans: 3062, originalRetry: 400 },
    { requests: requests.length, statuses, tranches: tranches, csvTranches: loanRows, total, follow, original },
    { cooldown_days: 7, split: [5, 25, 70], seed: 7 });
  expect(tranches).toEqual(["146.00", "730.00", "2,044.00"]);
  expect(loanRows).toEqual(["146.00", "730.00", "2044.00"]);
  expect(requests).toHaveLength(1200);
  expect(statuses).toEqual(["pending"]);
  expect(follow.loans).toBe(3062);
  expect(follow.RETRY + follow.WAIT + follow.REVIEW_REMEDIATE).toBe(3062);
  expect(original.RETRY).toBe(400);
});

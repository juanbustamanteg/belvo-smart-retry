import { expect, test } from "@playwright/test";
import { E2E, login, newPage, openLoan, readyRun } from "../e2e/fixtures";

const OUT = "/private/tmp/claude-501/-Users-bernabebustamante/79d442fb-6e15-42bf-a3fb-2d6ff38b9645/scratchpad/deck";

test("deck screenshots", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "operator");
  await page.screenshot({ path: `${OUT}/s_workspace.png` });
  await page.goto("/");
  await page.getByRole("button", { name: "New analysis" }).click();
  await page.locator('input[type="file"]').setInputFiles(E2E.loansCsv);
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await page.screenshot({ path: `${OUT}/s_prepare.png`, fullPage: true });
  const runUrl = await readyRun(page, 7, { fatigue: "20", holdout: "10%" });
  await page.getByRole("tab", { name: /^Retry candidates/ }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  await page.screenshot({ path: `${OUT}/s_results.png` });
  await openLoan(page, "Retry candidates", (await page.getByRole("table", { name: "Retry candidates" }).locator("td.loan").first().innerText()).trim());
  await page.screenshot({ path: `${OUT}/s_detail.png` });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Submit for review" }).click();
  const rv = await newPage(browser, "reviewer");
  await rv.setViewportSize({ width: 1440, height: 900 });
  await rv.goto(runUrl);
  await expect(rv.getByRole("button", { name: "Approve and release payments" })).toBeVisible();
  await rv.screenshot({ path: `${OUT}/s_review.png` });
  await rv.getByRole("button", { name: "Approve and release payments" }).click();
  await expect(rv.getByRole("heading", { name: "Approved results" })).toBeVisible();
  await rv.getByRole("region", { name: "Payment requests" }).scrollIntoViewIfNeeded();
  await rv.screenshot({ path: `${OUT}/s_released.png` });
  await rv.goto("/");
  await expect(rv.getByRole("heading", { name: "Analyses" })).toBeVisible();
  void E2E;
});

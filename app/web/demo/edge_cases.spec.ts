import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { E2E, login, newPage, openLoan, pickPolicy, signOut } from "../e2e/fixtures";

// Captioned edge-case demo. Everything happens in one recorded window; the only extra
// session (the operator withdrawing in case 4) is deliberately off camera.
async function caption(page: Page, text: string, ms = 2800) {
  await page.evaluate(t => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      Object.assign(el.style, { position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", zIndex: "99",
        maxWidth: "920px", padding: "12px 18px", background: "rgba(20,30,34,.92)", color: "#fff", font: "500 17px/1.4 system-ui",
        borderRadius: "6px", boxShadow: "0 4px 18px rgba(0,0,0,.25)", textAlign: "center" });
      document.body.appendChild(el);
    }
    el.textContent = t;
    el.style.display = "block";
  }, text);
  await page.waitForTimeout(ms);
  await page.evaluate(() => { const el = document.getElementById("demo-caption"); if (el) el.style.display = "none"; });
}

test("Smart Retry edge cases", async ({ page, browser }, info) => {
  // 1. Invalid file
  const bad = info.outputPath("portfolio-missing-column.csv");
  writeFileSync(bad, "loan_id,payment_method_bank,loan_amount,overdue_at,overdue_days\n7762351674,mx_azteca,1000,8/4/2023,830\n");
  await login(page, "operator");
  await caption(page, "Edge case 1: a portfolio file missing a required column.");
  await pickPolicy(page, { fatigue: "20", holdout: "10%" });
  await page.getByRole("button", { name: "New analysis" }).click();
  await page.locator('input[type="file"]').setInputFiles(bad);
  await expect(page.getByRole("alert")).toContainText("missing required columns");
  await caption(page, "The check stops with a specific error. No results, nothing to approve.", 3200);
  await page.locator('input[type="file"]').setInputFiles(E2E.loansCsv);
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await caption(page, "Upload the corrected file and the check passes.");
  await page.getByRole("button", { name: "Generate results" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();

  // 2. Needs attention evidence
  await caption(page, "Edge case 2: loans that must not be retried automatically.");
  const amb = await openLoan(page, "Needs attention", "7764852545");
  await amb.evaluate(el => el.scrollTo({ top: 500, behavior: "smooth" }));
  await caption(page, "Six simultaneous requests with repeated amounts: all six are shown, and no one can override the decision.", 3600);
  await page.keyboard.press("Escape");
  await openLoan(page, "Needs attention", "7762309510");
  await caption(page, "A cancelled account (code 03) goes to investigation instead of another debit.", 3200);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Clear" }).click();
  await page.getByLabel("Filter by reason").selectOption("LATEST_CHARGEBACK");
  await page.getByRole("table", { name: "Needs attention" }).scrollIntoViewIfNeeded();
  await caption(page, "37 loans whose last attempt was charged back. Retrying them caused another chargeback 23% of the time.", 3400);

  // 3. Reviewer returns with a comment
  await page.mouse.wheel(0, -3000);
  await caption(page, "The operator submits the analysis for review.", 1800);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();
  const runUrl = page.url().split("?")[0];
  await signOut(page);
  await login(page, "reviewer");
  await page.goto(runUrl);
  await caption(page, "Edge case 3: the reviewer disagrees and sends the analysis back.", 2600);
  await page.getByRole("button", { name: "Request changes" }).click();
  await page.getByLabel(/What should the operator change/).pressSequentially("Use a 14-day wait for this client.", { delay: 25 });
  await page.getByRole("button", { name: "Send back with comment" }).click();
  await expect(page.locator(".chip", { hasText: "Changes requested" })).toBeVisible();
  await caption(page, "Returned: nothing is released, and the draft payment requests are never sent.", 3000);
  await signOut(page);
  await login(page, "operator");
  await page.goto(runUrl);
  await expect(page.getByText("Changes requested by reviewer")).toBeVisible();
  await caption(page, "The operator sees the comment. Changes require a new revision; the old one stays as history.", 3400);
  await page.getByRole("button", { name: "New revision" }).click();
  await page.locator("fieldset.seg label", { hasText: "14 days" }).click();
  await page.getByRole("button", { name: "Create revision" }).click();
  await expect(page.getByRole("heading", { name: /· r2$/ })).toBeVisible();
  await page.getByRole("button", { name: "Check portfolio" }).click();
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await page.getByRole("button", { name: "Generate results" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();
  const r2 = page.url().split("?")[0];

  // 4. Stale approval
  await signOut(page);
  await login(page, "reviewer");
  await page.goto(r2);
  await expect(page.getByRole("button", { name: "Approve and release payments" })).toBeVisible();
  await caption(page, "Edge case 4: the reviewer opens revision 2. Meanwhile the operator withdraws it from another session.", 3200);
  const operator = await newPage(browser, "operator");
  await operator.goto(r2);
  await operator.getByRole("button", { name: "Withdraw" }).click();
  await expect(operator.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  await operator.context().close();
  await page.getByRole("button", { name: "Approve and release payments" }).click();
  await expect(page.getByRole("alert")).toContainText("changed since you loaded it");
  await caption(page, "The stale approval is refused. Money is never released on outdated results.", 3200);

  // 5. Session ends
  await page.context().clearCookies();
  await page.getByRole("link", { name: "Analyses" }).click();
  await expect(page.getByText("Your session ended. Sign in again to continue.")).toBeVisible();
  await caption(page, "Edge case 5: when a session expires, the app asks to sign in again and never replays an action.", 3400);
});

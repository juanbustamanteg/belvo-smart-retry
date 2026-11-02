import { expect, test, type Page } from "@playwright/test";
import { E2E } from "../e2e/fixtures";

const pause = (page: Page, ms = 2200) => page.waitForTimeout(ms);

async function caption(page: Page, text: string, ms = 2600) {
  await page.evaluate(t => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      el.setAttribute("aria-hidden", "true");
      Object.assign(el.style, { position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)", zIndex: "99",
        maxWidth: "900px", padding: "12px 18px", background: "rgba(20,30,34,.92)", color: "#fff", font: "500 17px/1.4 system-ui",
        borderRadius: "6px", boxShadow: "0 4px 18px rgba(0,0,0,.25)", textAlign: "center" });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await pause(page, ms);
}

async function signIn(page: Page, role: "operator" | "reviewer") {
  await page.goto("/login");
  await caption(page, `Sign in as the ${role === "operator" ? "Operator, who prepares the analysis" : "Reviewer, a different person who approves it"}.`, 1800);
  await page.getByLabel("Username").pressSequentially(role, { delay: 40 });
  await page.getByLabel("Password").fill(E2E.passwords[role]);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("Smart Retry walkthrough", async ({ page }) => {
  await signIn(page, "operator");
  await expect(page.getByRole("heading", { name: "Analyses" })).toBeVisible();
  await caption(page, "Payment history (253,006 requests) is already in the system. The operator only brings the loan portfolio.");
  await caption(page, "Retry policy: 7-day wait, a 30-day rest after 20 insufficient-funds failures in a row, and a 10% control group.", 3200);
  await page.getByRole("button", { name: "New analysis" }).click();
  await page.locator('input[type="file"]').setInputFiles(E2E.loansCsv);
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await caption(page, "The portfolio is checked against history: 3,062 loans, 29 without history, no unmatched records.", 3000);
  await page.getByRole("button", { name: "Generate results" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  await caption(page, "SQL classifies every loan: 398 retry candidates, 1,951 waiting, 713 that need attention.", 3200);
  await caption(page, "Retry candidates that have paid before come first. 10% are held out to measure what retrying adds.", 3200);

  await page.getByRole("button", { name: /^View details for / }).first().click();
  await caption(page, "Each loan explains what to do, why, and its three draft payment requests: 5%, 25% and 70% of the balance.", 3600);
  await page.getByRole("complementary").evaluate(el => el.scrollTo({ top: 400, behavior: "smooth" }));
  await caption(page, "The evidence shows the exact rule that matched and the date math. No black box.", 3000);
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: /^Waiting/ }).click();
  await caption(page, "Waiting loans show when to check again. Loans that failed 20+ times in a row rest 30 days instead of weekly retries.", 3600);
  await page.getByRole("tab", { name: /^Needs attention/ }).click();
  await page.getByLabel("Filter by reason").selectOption("LATEST_CHARGEBACK");
  await caption(page, "Needs attention: chargebacks, cancelled accounts or unclear attempts are never retried automatically.", 3200);
  await page.getByLabel("Filter by reason").selectOption("");

  await page.mouse.wheel(0, -2000);
  await caption(page, "Submitting sends all 3,062 decisions and the draft payment requests for review together.", 2600);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();
  const runUrl = page.url();
  await page.getByRole("button", { name: "Sign out" }).click();

  await signIn(page, "reviewer");
  await page.goto(runUrl);
  await caption(page, "The reviewer sees exactly how much will be requested before approving. Four eyes on money.", 3200);
  await page.getByRole("button", { name: "Approve and release payments" }).click();
  await expect(page.getByRole("heading", { name: "Approved results" })).toBeVisible();
  await caption(page, "Approval releases the payment requests in the bank's own format. Smart Retry never sends money itself.", 3200);
  await page.getByRole("region", { name: "Payment requests" }).scrollIntoViewIfNeeded();
  await caption(page, "Bank responses come back in the same format, become new history, and feed the next analysis.", 3200);
  await page.getByRole("region", { name: "Holdout experiment" }).scrollIntoViewIfNeeded();
  await caption(page, "The holdout compares retried and held-out loans once the next portfolio snapshot arrives.", 3200);
  await caption(page, "Smart Retry · unofficial product challenge prototype", 2500);
});

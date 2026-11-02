import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

async function signIn(page: Page, user: "operator" | "reviewer") {
  await page.getByLabel("Username").fill(user);
  await page.getByLabel("Password").fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
}
const totals = async (page: Page) => (await page.getByLabel("Full-run totals").innerText()).replace(/\s+/g, " ");

test("browser demo: full flow with the same golden results as the server", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("./");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText("The password for both is demo")).toBeVisible();
  await signIn(page, "operator");
  await expect(page.getByText(/253,006 requests/)).toBeVisible();

  // Reference counts: fatigue off, no holdout.
  await page.locator("fieldset.seg label", { hasText: /^Off$/ }).click();
  await page.locator("fieldset.seg label", { hasText: /^None$/ }).click();
  await page.getByRole("button", { name: "New analysis" }).click();
  await page.getByRole("button", { name: "Use the challenge portfolio" }).click();
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await expect(page.getByText("3,062 unique IDs")).toBeVisible();
  await page.getByRole("button", { name: "Generate results" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  expect(await totals(page)).toContain("3,062 loans classified 400 retry candidates 1,949 waiting 713 need attention");

  // Default policy, then the whole loop.
  await page.getByRole("link", { name: "Analyses" }).click();
  await page.getByRole("button", { name: "New analysis" }).click();
  await page.getByRole("button", { name: "Use the challenge portfolio" }).click();
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await page.getByRole("button", { name: "Generate results" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  expect(await totals(page)).toContain("398 retry candidates 1,951 waiting 713 need attention");
  await page.getByRole("tab", { name: /^Needs attention/ }).click();
  await page.getByLabel("Find loan ID").fill("7764852545");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: "View details for 7764852545" }).click();
  await expect(page.getByRole("complementary").locator("table").first().locator("tbody tr")).toHaveCount(6);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();
  const runUrl = page.url().split("?")[0];
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, "reviewer");
  await page.goto(runUrl);
  await page.getByRole("button", { name: "Approve and release payments" }).click();
  await expect(page.getByRole("region", { name: "Payment requests" })).toContainText("Released, not sent");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download approved CSV" }).click()]);
  const rows = readFileSync((await dl.path())!, "utf-8").trim().split("\r\n");
  await page.getByRole("button", { name: "Sign out" }).click();
  await signIn(page, "operator");
  await page.goto(runUrl);
  await page.getByRole("button", { name: "Demo only: import synthetic responses" }).click();
  await expect(page.locator(".chip", { hasText: "Responses imported" })).toBeVisible();
  await page.getByRole("button", { name: "Start follow-up analysis" }).click();
  await page.getByRole("button", { name: "Check portfolio" }).click();
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await page.getByRole("button", { name: "Generate results" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Synthetic bank responses.");

  expect(rows.length).toBe(3063);
  expect(errors).toEqual([]);
});

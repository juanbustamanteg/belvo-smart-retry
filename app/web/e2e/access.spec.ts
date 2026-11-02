import { expect, test } from "@playwright/test";
import { E2E, apiCall, login, readServerLog, readyRun, record, runIdFrom } from "./fixtures";

test("E03 anonymous visitors see no protected results and cannot mutate", async ({ page, request }, info) => {
  await page.goto("/runs/00000000-0000-0000-0000-000000000000");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const codes = {
    runs: (await request.get("/api/v1/runs")).status(),
    workspace: (await request.get("/api/v1/workspace")).status(),
    create: (await request.post("/api/v1/runs", { headers: { Origin: E2E.baseURL }, data: { cooldown_days: 7 } })).status(),
  };
  record(info, { runs: 401, workspace: 401, create: 401 }, codes);
  expect(codes).toEqual({ runs: 401, workspace: 401, create: 401 });
});

test("E04 forbidden role actions fail in the UI and on the server without changing state", async ({ page, browser }, info) => {
  await login(page, "operator");
  const runUrl = await readyRun(page, 7);
  const runId = runIdFrom(runUrl);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.locator(".chip", { hasText: "Awaiting reviewer" })).toBeVisible();
  const before = await (await page.request.get(`/api/v1/runs/${runId}`)).json();

  // Operator cannot approve own work, even by calling the API directly.
  const selfApprove = await apiCall(page.request, "POST", `/api/v1/runs/${runId}/review`, { data: { action: "approve" }, version: before.version });

  // Reviewer has no preparation controls and cannot create analyses.
  const reviewer = await (await browser.newContext({ baseURL: E2E.baseURL })).newPage();
  await login(reviewer, "reviewer");
  await expect(reviewer.getByRole("button", { name: "New analysis" })).toHaveCount(0);
  const reviewerCreate = await apiCall(reviewer.request, "POST", "/api/v1/runs", { data: { cooldown_days: 7 } });
  const reviewerWithdraw = await apiCall(reviewer.request, "POST", `/api/v1/runs/${runId}/withdraw`, { version: before.version });
  const after = await (await page.request.get(`/api/v1/runs/${runId}`)).json();

  const actual = { selfApprove: selfApprove.status(), reviewerCreate: reviewerCreate.status(), reviewerWithdraw: reviewerWithdraw.status(),
    status: after.status, versionUnchanged: after.version === before.version };
  record(info, { selfApprove: 403, reviewerCreate: 403, reviewerWithdraw: 403, status: "Submitted", versionUnchanged: true }, actual);
  expect(actual).toEqual({ selfApprove: 403, reviewerCreate: 403, reviewerWithdraw: 403, status: "Submitted", versionUnchanged: true });
  await reviewer.context().close();
});

test("E10 logout and a lost session end access; signing in again restores only permitted context", async ({ page, context }, info) => {
  await login(page, "operator");
  const runUrl = await readyRun(page, 7);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/login/);
  const afterLogout = (await page.request.get("/api/v1/runs")).status();

  // Signing in from the redirected page returns to the analysis that was open.
  await page.getByLabel("Username").fill("operator");
  await page.getByLabel("Password").fill(E2E.passwords.operator);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(runUrl);
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  await context.clearCookies(); // the server-side session can no longer be presented, as after expiry
  await page.getByRole("tab", { name: /^Waiting/ }).click();
  await expect(page.getByText("Your session ended. Sign in again to continue.")).toBeVisible();
  await page.getByLabel("Username").fill("operator");
  await page.getByLabel("Password").fill(E2E.passwords.operator);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(runUrl + "?queue=WAIT");
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  record(info, { afterLogout: 401, statusAfterReauth: "Ready for review" }, { afterLogout, statusAfterReauth: "Ready for review" });
  expect(afterLogout).toBe(401);
});

test("E13 main flow works from the keyboard and status is never color-only", async ({ page }, info) => {
  await page.goto("/login");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Username")).toBeFocused();
  await page.keyboard.type("operator");
  await page.keyboard.press("Tab");
  await page.keyboard.type(E2E.passwords.operator);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Analyses" })).toBeVisible();

  // Choose 3 days with arrow keys, create with Enter.
  await page.getByRole("radio", { name: "7 days" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("radio", { name: "3 days" })).toBeChecked();
  const outline = await page.getByRole("radio", { name: "3 days" }).evaluate(el => getComputedStyle(el.parentElement!).outlineStyle);
  await page.getByRole("button", { name: "New analysis" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/runs\//);
  await page.locator('input[type="file"]').setInputFiles(E2E.loansCsv); // native file chooser can't be driven by keys
  await page.getByRole("button", { name: "Generate results" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();

  // Switch queues and open/close a detail panel with the keyboard.
  await page.getByRole("tab", { name: /^Needs attention/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /^Needs attention/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: /^View details for / }).first().focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("complementary");
  await expect(panel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  const chip = (await page.locator(".chip").first().innerText()).trim();
  record(info, { focusOutline: "solid", chipHasText: true }, { focusOutline: outline, chip });
  expect(outline).toBe("solid");
  expect(chip.length).toBeGreaterThan(0);
});

test("E15 no credentials or tokens in browser storage, readable cookies or server logs", async ({ page, context }, info) => {
  await login(page, "reviewer");
  const session = await (await page.request.get("/api/v1/auth/session")).json();
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  const cookies = await context.cookies();
  const sessionCookie = cookies.find(c => c.name === "sr_session")!;
  const log = readServerLog();
  const leaks = [E2E.passwords.operator, E2E.passwords.reviewer, session.csrf_token, sessionCookie.value].filter(s => log.includes(s) || storage.includes(s));
  const actual = { storage: JSON.parse(storage), httpOnly: sessionCookie.httpOnly, sameSite: sessionCookie.sameSite, leaks: leaks.length };
  record(info, { storage: { local: {}, session: {}, cookie: "" }, httpOnly: true, sameSite: "Strict", leaks: 0 }, actual);
  expect(actual.storage).toEqual({ local: {}, session: {}, cookie: "" });
  expect(sessionCookie.httpOnly).toBe(true);
  expect(sessionCookie.sameSite).toBe("Strict");
  expect(leaks).toHaveLength(0);
});

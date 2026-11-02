import { expect, type APIRequestContext, type Browser, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Test-only credentials for the disposable E2E database (tests/artifacts/e2e-data). Not used anywhere else.
export const E2E = {
  baseURL: "http://127.0.0.1:8799",
  passwords: { operator: "e2e-operator-pass-1", reviewer: "e2e-reviewer-pass-1" },
  appDir: path.resolve(here, "../.."),
  loansCsv: path.resolve(here, "../../../PaymentsPM_Challenge_loan_info.csv"),
  serverLog: path.resolve(here, "../../tests/artifacts/e2e-data/server.log"),
};

export type Role = "operator" | "reviewer";

/** Attach expected/actual evidence for the testing CSV. */
export function record(info: TestInfo, expected: unknown, actual: unknown, configuration: unknown = {}) {
  info.annotations.push({ type: "expected", description: JSON.stringify(expected) });
  info.annotations.push({ type: "actual", description: JSON.stringify(actual) });
  info.annotations.push({ type: "configuration", description: JSON.stringify(configuration) });
}

export async function login(page: Page, role: Role) {
  await page.goto("/login");
  await page.getByLabel("Username").fill(role);
  await page.getByLabel("Password").fill(E2E.passwords[role]);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Analyses" })).toBeVisible();
}

export async function newPage(browser: Browser, role: Role) {
  const context = await browser.newContext({ baseURL: E2E.baseURL, acceptDownloads: true });
  const page = await context.newPage();
  await login(page, role);
  return page;
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
}

/** Click the visible label, as a person would; the native radio is visually hidden behind it. */
export async function pickCooldown(page: Page, cooldown: 3 | 7 | 14) {
  await page.locator("fieldset.seg label", { hasText: `${cooldown} days` }).click();
  await expect(page.getByRole("radio", { name: `${cooldown} days` })).toBeChecked();
}

/** Policy pickers on the workspace. Regression flows turn fatigue and holdout off to match minimal-v1 golden counts. */
export async function pickPolicy(page: Page, opts: { fatigue: "Off" | "10" | "20" | "30"; holdout: "None" | "10%" | "20%" }) {
  await page.getByRole("group", { name: /^Rest 30 days/ }).locator("label").filter({ hasText: new RegExp(`^${opts.fatigue}$`) }).click();
  await page.getByRole("group", { name: /^Hold out retry candidates/ }).locator("label").filter({ hasText: new RegExp(`^${opts.holdout}$`) }).click();
}

/** Operator: create an analysis through the UI, upload a portfolio and wait for the check. */
export async function prepare(page: Page, cooldown: 3 | 7 | 14, file: string = E2E.loansCsv,
  policy: Parameters<typeof pickPolicy>[1] = { fatigue: "Off", holdout: "None" }) {
  await page.goto("/");
  await pickCooldown(page, cooldown);
  await pickPolicy(page, policy);
  await page.getByRole("button", { name: "New analysis" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
  await page.locator('input[type="file"]').setInputFiles(file);
}

/** Operator: full preparation through Generate results. Returns the run URL. */
export async function readyRun(page: Page, cooldown: 3 | 7 | 14 = 7,
  policy: Parameters<typeof pickPolicy>[1] = { fatigue: "Off", holdout: "None" }) {
  await prepare(page, cooldown, E2E.loansCsv, policy);
  await expect(page.getByText("Portfolio checked")).toBeVisible();
  await page.getByRole("button", { name: "Generate results" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for review" })).toBeVisible();
  return page.url();
}

export async function totals(page: Page) {
  const metrics = page.getByLabel("Full-run totals");
  const text = await metrics.innerText();
  const n = (label: string) => Number(new RegExp(`([\\d,]+)\\s*${label}`).exec(text)![1].replace(/,/g, ""));
  return { loans: n("loans classified"), RETRY: n("retry candidates"), WAIT: n("waiting"), REVIEW_REMEDIATE: n("need attention") };
}

export async function openLoan(page: Page, queue: "Retry candidates" | "Waiting" | "Needs attention", loanId: string) {
  await page.getByRole("tab", { name: new RegExp(`^${queue}`) }).click();
  await page.getByLabel("Find loan ID").fill(loanId);
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByRole("button", { name: `View details for ${loanId}` }).click();
  const panel = page.getByRole("complementary", { name: `Loan ${loanId}` });
  await expect(panel.getByText("What to do")).toBeVisible();
  return panel;
}

/** Same-origin API call with the session cookie and CSRF token, as the portal would send it. */
export async function apiCall(request: APIRequestContext, method: "POST" | "GET", url: string,
  opts: { data?: unknown; version?: number; key?: string } = {}) {
  const session = await request.get("/api/v1/auth/session");
  const csrf = session.ok() ? (await session.json()).csrf_token : "";
  const headers: Record<string, string> = { Origin: E2E.baseURL, "X-CSRF-Token": csrf, "Idempotency-Key": opts.key ?? crypto.randomUUID() };
  if (opts.version !== undefined) headers["If-Match"] = `"${opts.version}"`;
  return method === "GET" ? request.get(url, { headers }) : request.post(url, { headers, data: opts.data });
}

export function runIdFrom(url: string) {
  return /\/runs\/([0-9a-f-]+)/.exec(url)![1];
}

/** Minimal RFC 4180 parser for the exported result CSV. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export const readServerLog = () => readFileSync(E2E.serverLog, "utf-8");

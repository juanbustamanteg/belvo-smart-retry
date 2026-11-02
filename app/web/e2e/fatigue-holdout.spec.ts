import { expect, test } from "@playwright/test";
import { login, newPage, openLoan, readyRun, record, runIdFrom, totals } from "./fixtures";

test("D38 D39 D40 default policy: fatigue rest, previous payers first, holdout group and experiment panel", async ({ page, browser }, info) => {
  await login(page, "operator");
  const runUrl = await readyRun(page, 7, { fatigue: "20", holdout: "10%" });
  const t = await totals(page);
  await expect(page.getByText(/rest 30 days after 20 failures in a row · 10% holdout/).first()).toBeVisible();

  // Retry queue: previous payers first, holdout loans tagged.
  const queue = page.getByRole("table", { name: "Retry candidates" });
  const firstLastPaid = await queue.locator("tbody tr").first().locator("td:nth-child(6)").innerText();
  await expect(page.getByText("Loans that have paid before come first.")).toBeVisible();
  const holdoutChips = await queue.locator(".chip", { hasText: "Holdout" }).count();

  // Waiting queue explains the rest period.
  const runId = runIdFrom(runUrl);
  const rest = await (await page.request.get(`/api/v1/runs/${runId}/decisions?decision=WAIT&reason=FATIGUE_REST&page_size=1`)).json();
  const restLoan = rest.items[0].loan_id as string;
  const restPanel = await openLoan(page, "Waiting", restLoan);
  await expect(page.getByRole("table", { name: "Waiting" })).toContainText(/times in a row\. Resting until/);
  await expect(restPanel).toContainText(/8 · Code 04 streak reached the fatigue limit/);
  await page.keyboard.press("Escape");
  const restVisible = rest.total as number;

  // Payment requests exclude the control group.
  const panel = page.getByRole("region", { name: "Payment requests" });
  await expect(panel).toContainText("kept as a control group get no requests");
  const panelText = await panel.innerText();
  const holdout = Number(/(\d+) retry candidates kept as a control group/.exec(panelText)![1]);
  const requests = Number(/([\d,]+) for ([\d,]+) retry candidates/.exec(panelText)![1].replace(/,/g, ""));

  await page.getByRole("button", { name: "Submit for review" }).click();
  const reviewer = await newPage(browser, "reviewer");
  await reviewer.goto(runUrl);
  await reviewer.getByRole("button", { name: "Approve and release payments" }).click();
  const exp = reviewer.getByRole("region", { name: "Holdout experiment" });
  await expect(exp).toContainText("Held out");
  await expect(exp).toContainText("upload the next portfolio snapshot");
  await reviewer.context().close();

  const actual = { totals: t, firstLastPaid, holdoutChipsOnFirstPage: holdoutChips, restLoans: restVisible, holdout, requests };
  record(info, { totals: { loans: 3062, RETRY: 398, WAIT: 1951, REVIEW_REMEDIATE: 713 }, firstLastPaidNotNever: true,
    requests: "3 x (398 - holdout)" }, actual, { cooldown_days: 7, fatigue_attempts: 20, holdout_pct: 10 });
  expect(t).toEqual({ loans: 3062, RETRY: 398, WAIT: 1951, REVIEW_REMEDIATE: 713 });
  expect(firstLastPaid).not.toBe("Never");
  expect(restVisible).toBe(1623);
  expect(holdout).toBeGreaterThan(0);
  expect(requests).toBe(3 * (398 - holdout));
});

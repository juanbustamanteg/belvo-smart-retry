// Plain-language copy. Formal rule codes stay in the master spec and the evidence panel.
import type { Decision, DecisionRow, RunStatus } from "./api";

export const QUEUE_LABEL: Record<Decision, string> = {
  RETRY: "Retry candidates",
  WAIT: "Waiting",
  REVIEW_REMEDIATE: "Needs attention",
};

export const DECISION_CHIP: Record<Decision, string> = {
  RETRY: "Retry candidate",
  WAIT: "Waiting",
  REVIEW_REMEDIATE: "Needs attention",
};

export const STATUS_LABEL: Record<RunStatus, string> = {
  Draft: "Draft",
  Validating: "Checking portfolio",
  Validated: "Ready to generate",
  Running: "Generating results",
  Failed: "Failed",
  Interrupted: "Interrupted",
  Ready: "Ready for review",
  Submitted: "Awaiting reviewer",
  Returned: "Changes requested",
  Superseded: "Replaced",
  Approved: "Approved",
};

export const REASON_LABEL: Record<string, string> = {
  SOFT_FAILURE_WINDOW_ELAPSED: "Insufficient funds, wait period passed",
  FATIGUE_REST: "Too many insufficient-funds failures in a row, resting",
  COOLDOWN: "Insufficient funds, still in wait period",
  ACCOUNT_AUTH_OR_UNKNOWN_REASON: "Account, authorization or unknown failure",
  LATEST_CHARGEBACK: "Charged back",
  AMBIGUOUS_LATEST_BATCH: "Simultaneous attempts disagree",
  LATEST_SUCCESS_RECONCILE: "Last attempt succeeded",
  NO_HISTORY: "No payment history",
  INVALID_TIMESTAMP: "Inconsistent attempt times",
  INVALID_BALANCE: "Missing or zero balance",
};

export function why(r: DecisionRow): string {
  switch (r.reason_code) {
    case "SOFT_FAILURE_WINDOW_ELAPSED":
      return `Insufficient funds. Wait period has passed (${r.days_since_anchor} days).`;
    case "COOLDOWN":
      return `Insufficient funds on ${r.cooldown_anchor_date}. Check again after the wait.`;
    case "FATIGUE_REST":
      return `Insufficient funds ${r.consecutive_soft_failures} times in a row. Resting until ${r.next_check_date} instead of retrying weekly.`;
    case "ACCOUNT_AUTH_OR_UNKNOWN_REASON": {
      const codes = r.last_batch_reasons.length ? `code ${r.last_batch_reasons.join(", ")}` : "no failure code";
      return `Last attempt failed with ${codes}. Investigate before any retry.`;
    }
    case "LATEST_CHARGEBACK":
      return "Last attempt was charged back. Investigate the reversal.";
    case "AMBIGUOUS_LATEST_BATCH":
      return `${r.last_batch_rows} simultaneous attempts with mixed results or repeated amounts. Check all of them.`;
    case "LATEST_SUCCESS_RECONCILE":
      return "Last attempt succeeded. Reconcile it with the current debt.";
    case "NO_HISTORY":
      return "No payment history for this loan. Check the link to history.";
    case "INVALID_TIMESTAMP":
      return "Last attempt has missing or inconsistent times. Verify the source.";
    case "INVALID_BALANCE":
      return "Outstanding balance is missing or zero. Verify the portfolio.";
    default:
      return r.reason_code;
  }
}

export const WHAT_TO_DO: Record<string, string> = {
  PREPARE_RETRY_HANDOFF:
    "It gets three draft payment requests that the reviewer releases on approval. Before any real debit, production still has to confirm authorization, account status, current debt and client policy.",
  REASSESS_ON_OR_AFTER_DATE:
    "Leave it for now. Reassess on or after the next check date with a new analysis. Nothing wakes up automatically.",
  INVESTIGATE_BEFORE_RETRY:
    "Don't retry yet. Investigate the reason below before considering another attempt.",
};

export const INVESTIGATE: Record<string, string> = {
  INVALID_BALANCE: "Verify the snapshot debt with the lender.",
  NO_HISTORY: "Check how this loan links to payment history.",
  INVALID_TIMESTAMP: "Verify the attempt times at the source.",
  LATEST_CHARGEBACK: "Review the reversal and the authorization context.",
  AMBIGUOUS_LATEST_BATCH: "Inspect every simultaneous attempt listed below.",
  LATEST_SUCCESS_RECONCILE: "Reconcile the successful payment with the current debt.",
  ACCOUNT_AUTH_OR_UNKNOWN_REASON: "Check the account, authorization and failure message below.",
};

export const RULES: Record<number, string> = {
  1: "1 · Balance missing or not positive",
  2: "2 · No payment history",
  3: "3 · Latest timing invalid",
  4: "4 · Chargeback in latest attempt",
  5: "5 · Mixed results or repeated amount in latest attempt",
  6: "6 · Success in latest attempt",
  7: "7 · Latest attempt not entirely insufficient funds (code 04)",
  8: "8 · Code 04 streak reached the fatigue limit, rest period not over",
  9: "9 · Code 04, wait period not over",
  10: "10 · Code 04, wait period over",
};

export const fmtInt = (n: number) => n.toLocaleString("en-US");
export const fmtMoney = (s: string | null) => {
  if (s === null) return "—";
  const [whole, cents] = s.replace("-", "").split(".");
  return (s.startsWith("-") ? "-" : "") + Number(whole).toLocaleString("en-US") + "." + cents;
};
export const fmtCents = (c: number) => fmtMoney(`${Math.trunc(c / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`);
export const fmtWhen = (iso: string | null) => (iso ? iso.replace("T", " ").replace(/\.\d+/, "").replace("Z", " UTC") : "—");
export const short = (sha: string) => sha.slice(0, 8) + "…";

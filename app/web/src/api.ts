// Thin client for /api/v1. The browser never decides anything; it renders persisted results.

export type Role = "operator" | "reviewer";
export type Decision = "RETRY" | "WAIT" | "REVIEW_REMEDIATE";
export type RunStatus =
  | "Draft" | "Validating" | "Validated" | "Running" | "Failed" | "Interrupted"
  | "Ready" | "Submitted" | "Returned" | "Superseded" | "Approved";

export interface Policy { cooldown_days: number; fatigue_attempts: number | null; holdout_pct: number }
export interface Experiment {
  holdout_pct: number; assignment: string; synthetic: boolean; small_sample: boolean;
  arms: Record<"treatment" | "control", { loans: number; outstanding: string }>;
  responses: null | { treatment_loans_paid: number; treatment_collected: string; treatment_loans_charged_back: number; origin: string };
  next_snapshot: null | { revision_no: number; run_id: string; incremental_recovered_per_loan: string | null;
    arms: Record<"treatment" | "control", { loans: number; loans_with_lower_balance: number; recovered: string; recovered_per_loan: string }> };
}
export interface Session { user: { username: string; role: Role }; workspace: string; expires_at: string; csrf_token: string }
export interface History {
  dataset_id: string; file_name: string; sha256: string; row_count: number; imported_at: string;
  event_range: [string | null, string | null]; workspace: string; available: boolean;
  origin: "original" | "bank" | "synthetic_demo"; responses_count: number; parent_dataset_id: string | null;
}
export interface PaymentSet {
  set_id: string; run_id: string; status: "Draft" | "Released" | "Responded"; split: number[]; split_version: string;
  requested_at: string; created_by: string; created_at: string; released_by: string | null; released_at: string | null; loans: number; requests: number; total_amount: string;
  total_by_tranche: Record<string, string>; holdout_loans: number;
  responses: null | { origin: "bank" | "synthetic_demo"; sha256: string; imported_at: string; imported_by: string;
    history_dataset_id: string; outcomes: { by_status: Record<string, number>; loans: number; loans_with_mixed_outcomes: number } };
  sent_by_mvp: false;
}
export interface Workspace {
  workspace: string; label: string; history: History | null; history_available: boolean;
  permitted_actions: string[]; allowed_cooldowns: number[]; evaluated_at: string; business_timezone: string;
}
export interface ApiErrorBody { code: string; message: string; details: Record<string, unknown>[]; request_id?: string }
export interface Coverage {
  loans: number; requests: number; loans_with_history: number; loans_without_history: number;
  orphan_request_rows: number; collection_batches: number; outstanding_cents: number; requested_cents: number;
}
export interface Run {
  run_id: string; revision_id: string; analysis_id: string; revision_no: number; parent_run_id: string | null;
  version: number; status: RunStatus;
  configuration: Policy & { evaluated_at: string; business_timezone: string; rule_version: string; rest_days: number | null };
  master_sha256: string; created_by: string; created_at: string;
  sources: { portfolio: { file_name: string; sha256: string; size_bytes: number; row_count: number | null } | null; history: History | null };
  validation: { coverage: Coverage; warnings: Record<string, unknown>[] } | null;
  error: ApiErrorBody | null;
  totals: { loans: number; RETRY: number; WAIT: number; REVIEW_REMEDIATE: number } | null;
  submitted_at: string | null;
  review: { reviewed_by: string; reviewed_at: string; comment: string | null } | null;
  job_active: boolean; permitted_actions: string[]; is_executable: false; payment_requests: PaymentSet | null;
}
export interface DecisionRow {
  loan_id: string; decision: Decision; reason_code: string; next_action_code: string; payment_method_bank: string;
  overdue_days: number | null; total_amount_outstanding: string | null; recommended_amount: null;
  last_batch_created_at: string | null; last_batch_rows: number; last_batch_statuses: string[]; last_batch_reasons: string[];
  cooldown_anchor_date: string | null; days_since_anchor: number | null; next_check_date: string | null; rule_priority: number;
  consecutive_soft_failures: number; last_success_at: string | null; experiment_arm: "treatment" | "control" | null;
}
export interface Page<T> { items: T[]; total: number; page: number; page_size: number }
export interface Summary {
  totals: NonNullable<Run["totals"]>; reasons: Record<string, number>; actions: Record<string, number>; coverage: Coverage;
}
export interface BatchMember {
  payment_request_id: string; created_at: string; completed_at: string | null; chargeback_at: string | null;
  status: string; amount: string; failed_reason: string | null; failed_message: string | null;
}
export interface LoanDetail extends DecisionRow {
  loan: { loan_amount: string | null; overdue_at: string | null; overdue_days: number | null; source_line: number };
  latest_batch: BatchMember[];
  history: { requests: number; batches: number; first_request_at: string | null;
    earlier_requests: { created_at: string; status: string; amount: string; failed_reason: string | null; failed_message: string | null }[] };
  clock: { evaluated_at: string; business_timezone: string; cooldown_days: number };
  production_checks: string;
  payment_requests: { payment_request_id: string; tranche_pct: number; amount: string; status: PaymentSet["status"] }[];
}

export class ApiError extends Error {
  constructor(public status: number, public body: ApiErrorBody) { super(body.message); }
}

export const DEMO = import.meta.env.VITE_DEMO === "1";

let csrf: string | null = null; // kept in memory only, never in browser storage
let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };
export const setCsrf = (token: string | null) => { csrf = token; };

const newKey = () => crypto.randomUUID();

async function request<T>(method: string, path: string, opts: { body?: unknown; form?: FormData; version?: number; idempotent?: boolean; login?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrf) headers["X-CSRF-Token"] = csrf;
  if (opts.version !== undefined) headers["If-Match"] = `"${opts.version}"`;
  if (opts.idempotent) headers["Idempotency-Key"] = newKey();
  if (opts.login) headers["X-Requested-With"] = "SmartRetry";
  if (DEMO) {
    const { handle } = await import("./demo/backend");
    const r = await handle(method, path, { body: opts.body, form: opts.form, headers });
    if (r.status === 204) return undefined as T;
    const data = r.text !== undefined ? r.text : r.data;
    if (r.status >= 400) {
      const body = (data as { error: ApiErrorBody }).error;
      if (r.status === 401 && !opts.login && onUnauthorized) onUnauthorized();
      throw new ApiError(r.status, body);
    }
    return data as T;
  }
  let res: Response;
  try {
    res = await fetch("/api/v1" + path, {
      method, headers, credentials: "same-origin",
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    throw new ApiError(0, { code: "NETWORK", message: "Can't reach the local server. Check that it is running.", details: [] });
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const body: ApiErrorBody = data?.error ?? { code: "UNKNOWN", message: `Request failed (${res.status}).`, details: [] };
    if (res.status === 401 && !opts.login && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body);
  }
  return data as T;
}

export const api = {
  login: (username: string, password: string) => request<Session>("POST", "/auth/login", { body: { username, password }, login: true }),
  session: () => request<Session>("GET", "/auth/session"),
  logout: () => request<void>("POST", "/auth/logout"),
  workspace: () => request<Workspace>("GET", "/workspace"),
  runs: () => request<Page<Run>>("GET", "/runs?page_size=50"),
  run: (id: string) => request<Run>("GET", `/runs/${id}`),
  createRun: (policy: Policy) => request<Run>("POST", "/runs", { body: policy, idempotent: true }),
  setPolicy: (run: Run, policy: Policy) => request<Run>("PATCH", `/runs/${run.run_id}`, { body: policy, version: run.version }),
  experiment: (id: string) => request<Experiment>("GET", `/runs/${id}/experiment`),
  upload: (run: Run, file: File) => {
    const form = new FormData();
    form.append("loans_file", file);
    return request<Run>("PUT", `/runs/${run.run_id}/sources`, { form, version: run.version, idempotent: true });
  },
  validate: (run: Run) => request<Run>("POST", `/runs/${run.run_id}/validate`, { version: run.version, idempotent: true }),
  execute: (run: Run) => request<Run>("POST", `/runs/${run.run_id}/execute`, { version: run.version, idempotent: true }),
  summary: (id: string) => request<Summary>("GET", `/runs/${id}/summary`),
  decisions: (id: string, q: { decision: Decision; reason?: string; loan_id?: string; page: number }) => {
    const p = new URLSearchParams({ decision: q.decision, page: String(q.page), page_size: "50" });
    if (q.reason) p.set("reason", q.reason);
    if (q.loan_id) p.set("loan_id", q.loan_id);
    return request<Page<DecisionRow>>("GET", `/runs/${id}/decisions?${p}`);
  },
  loan: (id: string, loanId: string) => request<LoanDetail>("GET", `/runs/${id}/loans/${encodeURIComponent(loanId)}`),
  submit: (run: Run) => request<Run>("POST", `/runs/${run.run_id}/submit`, { version: run.version, idempotent: true }),
  withdraw: (run: Run) => request<Run>("POST", `/runs/${run.run_id}/withdraw`, { version: run.version, idempotent: true }),
  review: (run: Run, action: "approve" | "return", comment?: string) =>
    request<Run>("POST", `/runs/${run.run_id}/review`, { body: action === "return" ? { action, comment } : { action }, version: run.version, idempotent: true }),
  revise: (run: Run, cooldown_days: number, use_latest_history = false) =>
    request<Run>("POST", `/runs/${run.run_id}/revisions`, { body: { cooldown_days, use_latest_history }, version: run.version, idempotent: true }),
  importResponses: (run: Run, file: File, origin: "bank" | "synthetic_demo") => {
    const form = new FormData();
    form.append("responses_file", file);
    form.append("origin", origin);
    return request<PaymentSet>("PUT", `/runs/${run.run_id}/payment-requests/responses`, { form, idempotent: true });
  },
  paymentsCsvUrl: (id: string) => `/runs/${id}/payment-requests.csv`,
  /** Fetch a CSV through the API (server or browser demo) and save it with the given name. */
  download: async (path: string, filename: string) => {
    let text: string;
    if (DEMO) text = await request<string>("GET", path);
    else {
      const res = await fetch("/api/v1" + path, { credentials: "same-origin" });
      if (!res.ok) throw new ApiError(res.status, (await res.json()).error);
      text = await res.text();
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  simulateResponses: (run: Run) => request<string>("POST", `/runs/${run.run_id}/payment-requests/simulate`, { body: { seed: 7 } }),
  csvUrl: (id: string) => `/runs/${id}/results.csv`,
};

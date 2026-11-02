// In-browser stand-in for the FastAPI server, used only by the GitHub Pages demo build.
// It answers the same /api/v1 routes with the same JSON shapes and status codes, running the
// real SQL files in SQLite (WebAssembly). Simplifications, stated in the UI: demo passwords,
// no CSRF or idempotency keys (one tab, one user at a time), and data lives only in this tab.
import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import m001 from "../../../sql/001_schema.sql?raw";
import m002 from "../../../sql/002_payment_requests.sql?raw";
import m003 from "../../../sql/003_release_flow.sql?raw";
import m004 from "../../../sql/004_fatigue_holdout.sql?raw";
import rulesSql from "../../../sql/rules_minimal_v2.sql?raw";
import paymentsSql from "../../../sql/payment_requests_v1.sql?raw";
import * as E from "./engine";

export const DEMO_PASSWORD = "demo";
const BASE = import.meta.env.BASE_URL;
export const DATA_URLS = {
  history: `${BASE}data/PaymentsPM_Challenge_payment_requests.csv`,
  portfolio: `${BASE}data/PaymentsPM_Challenge_loan_info.csv`,
};
const COMPLETED = ["Ready", "Submitted", "Returned", "Approved", "Superseded"];
const REVISABLE = ["Ready", "Returned", "Failed", "Interrupted", "Approved"];

type Res = { status: number; data?: unknown; text?: string };
class ApiErr extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown>[] = []) { super(message); }
}

let db: Database | null = null;
let ready: Promise<void> | null = null;
let user: { id: string; username: string; role: string } | null = null;
let jobActive: string | null = null;
export const progress = { step: "Starting…" };

export function boot(onStep?: (s: string) => void): Promise<void> {
  if (ready) return ready;
  const step = (s: string) => { progress.step = s; onStep?.(s); };
  ready = (async () => {
    step("Loading SQLite (WebAssembly)…");
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    db = new SQL.Database();
    db.run("PRAGMA foreign_keys = OFF");
    for (const m of [m001, m002, m003, m004]) db.exec(m);
    db.run("INSERT INTO users VALUES ('u-op','operator','operator','demo',?), ('u-rv','reviewer','reviewer','demo',?)", [E.nowText(), E.nowText()]);
    step("Downloading the challenge payment history (253,006 requests)…");
    const text = await (await fetch(DATA_URLS.history)).text();
    step("Importing payment history into SQLite…");
    await new Promise(r => setTimeout(r, 30));
    const id = E.uuid();
    db.run("BEGIN");
    db.run(`INSERT INTO source_files (id, kind, workspace, original_name, storage_path, sha256, size_bytes, status, imported_at)
            VALUES (?,?,?,?,?,?,?,?,?)`, [id, "requests_history", E.WORKSPACE, "PaymentsPM_Challenge_payment_requests.csv", "browser",
      await E.sha256Hex(text), text.length, "uploaded", E.nowText()]);
    const staged = E.stageHistory(db, id, text);
    db.run("UPDATE source_files SET status='staged', row_count=?, event_min_us=?, event_max_us=?, warnings_json=? WHERE id=?",
      [staged.row_count, staged.event_min_us, staged.event_max_us, JSON.stringify(staged.warnings), id]);
    db.run("COMMIT");
    step("Ready");
  })();
  return ready;
}

const D = () => db!;
const who = (id: string | null) => (id ? (E.scalar(D(), "SELECT username FROM users WHERE id=?", [id]) as string) : null);
const runRow = (id: string) => { const r = E.one<any>(D(), "SELECT * FROM runs WHERE id=?", [id]); if (!r) throw new ApiErr(404, "NOT_FOUND", "This analysis doesn't exist."); return r; };
const currentHistory = () => E.scalar(D(), "SELECT id FROM source_files WHERE kind='requests_history' AND status='staged' ORDER BY rowid DESC LIMIT 1") as string | null;
const event = (runId: string, actor: string | null, name: string, detail?: unknown) =>
  D().run("INSERT INTO run_events (run_id, at, actor_id, event, detail) VALUES (?,?,?,?,?)", [runId, E.nowText(), actor, name, detail ? JSON.stringify(detail) : null]);

function historyInfo(fileId: string | null) {
  if (!fileId) return null;
  const f = E.one<any>(D(), "SELECT * FROM source_files WHERE id=?", [fileId]);
  if (!f) return null;
  return { dataset_id: f.id, file_name: f.original_name, sha256: f.sha256, row_count: f.row_count, imported_at: f.imported_at,
    event_range: [E.isoUtc(f.event_min_us), E.isoUtc(f.event_max_us)], workspace: f.workspace, available: f.status === "staged",
    origin: f.origin, responses_count: f.responses_count, parent_dataset_id: f.parent_file_id };
}
const configJson = (r: any) => ({ cooldown_days: r.cooldown_days, evaluated_at: r.evaluated_at, business_timezone: r.business_timezone,
  rule_version: r.rule_version, fatigue_attempts: r.fatigue_attempts, rest_days: r.fatigue_attempts ? E.REST_DAYS : null, holdout_pct: r.holdout_pct });

function permitted(r: any) {
  const u = user!; const s = r.status; const creator = r.created_by === u.id; const acts: string[] = [];
  if (u.role === "operator" && creator) {
    if (s === "Draft") { acts.push("update_configuration", "upload_portfolio"); if (r.loans_file_id && r.history_file_id && !jobActive) acts.push("validate"); }
    if (s === "Validated") { acts.push("upload_portfolio"); if (!jobActive) acts.push("execute"); }
    if (s === "Ready") acts.push("submit");
    if (s === "Submitted") acts.push("withdraw");
  }
  if (u.role === "operator" && REVISABLE.includes(s)) acts.push("create_revision");
  if (u.role === "reviewer" && s === "Submitted" && !creator) acts.push("review");
  if (s === "Approved") acts.push("download_results");
  return acts;
}

function runJson(r: any) {
  const loans = r.loans_file_id ? E.one<any>(D(), "SELECT * FROM source_files WHERE id=?", [r.loans_file_id]) : null;
  const summary = r.summary_json && COMPLETED.includes(r.status) ? JSON.parse(r.summary_json) : null;
  const set = E.one<any>(D(), "SELECT * FROM payment_request_sets WHERE run_id=?", [r.id]);
  const actions = permitted(r);
  if (set && set.status === "Released" && user!.role === "operator") actions.push("import_responses");
  if (set && ["Released", "Responded"].includes(set.status)) actions.push("download_payment_requests");
  return {
    run_id: r.id, revision_id: r.id, analysis_id: r.analysis_id, revision_no: r.revision_no, parent_run_id: r.parent_run_id,
    version: r.version, status: r.status, configuration: configJson(r), master_sha256: r.master_sha256,
    created_by: who(r.created_by), created_at: r.created_at,
    sources: { portfolio: loans ? { file_name: loans.original_name, sha256: loans.sha256, size_bytes: loans.size_bytes, row_count: loans.row_count } : null,
      history: historyInfo(r.history_file_id) },
    validation: r.validation_json ? JSON.parse(r.validation_json) : null, error: r.error_json ? JSON.parse(r.error_json) : null,
    totals: summary ? summary.totals : null, submitted_at: r.submitted_at,
    review: r.reviewed_at ? { reviewed_by: who(r.reviewed_by), reviewed_at: r.reviewed_at, comment: r.review_comment } : null,
    job_active: jobActive === r.id, permitted_actions: actions,
    payment_requests: set ? E.paymentSummary(D(), set, who) : null, is_executable: false,
  };
}

function decisionJson(r: any) {
  return { loan_id: r.loan_id, decision: r.decision, reason_code: r.reason_code, next_action_code: r.next_action_code,
    payment_method_bank: r.payment_method_bank, overdue_days: r.overdue_days, total_amount_outstanding: E.money(r.total_amount_outstanding_cents),
    recommended_amount: null, last_batch_created_at: E.isoUtc(r.last_batch_created_us), last_batch_rows: r.last_batch_rows,
    last_batch_statuses: JSON.parse(r.last_batch_statuses), last_batch_reasons: JSON.parse(r.last_batch_reasons),
    cooldown_anchor_date: E.dayText(r.cooldown_anchor_day), days_since_anchor: r.days_since_anchor, next_check_date: E.dayText(r.next_check_day),
    rule_priority: r.rule_priority, consecutive_soft_failures: r.consecutive_soft_failures, last_success_at: E.isoUtc(r.last_success_us),
    experiment_arm: r.arm ?? null };
}

const needUser = () => { if (!user) throw new ApiErr(401, "AUTH_REQUIRED", "Sign in to continue."); return user; };
const needRole = (role: string) => { if (needUser().role !== role) throw new ApiErr(403, "FORBIDDEN", `Only the ${role} account can do this.`); };
const creatorOperator = (r: any) => { needRole("operator"); if (r.created_by !== user!.id) throw new ApiErr(403, "FORBIDDEN", "Only the operator who created this analysis can change it."); };
const ifMatch = (headers: Record<string, string>, r: any) => {
  const v = headers["If-Match"];
  if (v === undefined) throw new ApiErr(428, "PRECONDITION_REQUIRED", "This change needs the current version (If-Match).");
  if (v.replace(/"/g, "") !== String(r.version)) throw new ApiErr(412, "STALE_VERSION", "This analysis changed since you loaded it. Reload and try again.");
};
const needStatus = (r: any, ...allowed: string[]) => {
  if (!allowed.includes(r.status)) throw new ApiErr(409, "INVALID_STATE", `This action isn't available while the analysis is ${r.status}.`);
};
const completedRun = (id: string) => {
  const r = runRow(id);
  if (!COMPLETED.includes(r.status) || !r.summary_json) throw new ApiErr(409, "RESULTS_NOT_AVAILABLE", "Results are only available after a completed analysis.");
  return r;
};
const tx = <T>(fn: () => T): T => { D().run("BEGIN"); try { const v = fn(); D().run("COMMIT"); return v; } catch (e) { D().run("ROLLBACK"); throw e; } };
const txa = async <T>(fn: () => Promise<T>): Promise<T> => { D().run("BEGIN"); try { const v = await fn(); D().run("COMMIT"); return v; } catch (e) { D().run("ROLLBACK"); throw e; } };
const checkPolicy = (b: any) => {
  const allowed = new Set(["cooldown_days", "fatigue_attempts", "holdout_pct", "use_latest_history"]);
  if (Object.keys(b).some(k => !allowed.has(k)) || ![3, 7, 14].includes(b.cooldown_days) ||
    ("fatigue_attempts" in b && ![null, 10, 20, 30].includes(b.fatigue_attempts)) || ("holdout_pct" in b && ![0, 10, 20].includes(b.holdout_pct)))
    throw new ApiErr(422, "INVALID_REQUEST", "The request has invalid or unknown fields.");
};

// ------------------------------------------------------------------ jobs (async, so the UI can poll)
function startJob(r: any, to: string, fn: (id: string) => Promise<void>) {
  if (jobActive) throw new ApiErr(409, "ANALYSIS_BUSY", "Another check or analysis is running. Wait for it to finish.");
  jobActive = r.id;
  D().run("UPDATE runs SET status=?, version=version+1, error_json=NULL WHERE id=?", [to, r.id]);
  setTimeout(async () => { try { await fn(r.id); } finally { jobActive = null; } }, 60);
}

async function validateJob(id: string) {
  const r = runRow(id);
  const lf = E.one<any>(D(), "SELECT * FROM source_files WHERE id=?", [r.loans_file_id])!;
  try {
    tx(() => {
      if (lf.status !== "staged") {
        D().run("DELETE FROM source_loans WHERE file_id=?", [lf.id]);
        const staged = E.stagePortfolio(D(), lf.id, uploads.get(lf.id)!);
        D().run("UPDATE source_files SET status='staged', row_count=?, warnings_json=? WHERE id=?", [staged.row_count, JSON.stringify(staged.warnings), lf.id]);
      }
      const coverage = E.pairCoverage(D(), lf.id, r.history_file_id);
      if (coverage.orphan_request_rows) throw new E.IntakeError("ORPHAN_REQUESTS", "Payment history references loans that are not in this portfolio.",
        [{ orphan_request_rows: coverage.orphan_request_rows, orphan_loan_ids: coverage.orphan_loan_ids }]);
      const warnings = JSON.parse(E.scalar(D(), "SELECT warnings_json FROM source_files WHERE id=?", [lf.id]) as string);
      D().run("UPDATE runs SET status='Validated', version=version+1, validation_json=?, error_json=NULL WHERE id=?", [JSON.stringify({ coverage, warnings }), id]);
      event(id, null, "validated");
    });
  } catch (e) {
    const err = e instanceof E.IntakeError ? e : new E.IntakeError("VALIDATION_ERROR", "Validation stopped unexpectedly. Try again.");
    D().run("UPDATE source_files SET status='invalid' WHERE id=?", [lf.id]);
    D().run("UPDATE runs SET status='Draft', version=version+1, validation_json=NULL, error_json=? WHERE id=?",
      [JSON.stringify({ code: err.code, message: err.message, details: err.details }), id]);
  }
}

async function executeJob(id: string) {
  const r = runRow(id);
  try {
    await txa(async () => {
      const result = E.classify(D(), rulesSql, id, r.loans_file_id, r.history_file_id, r.cooldown_days,
        E.parseInstantUs(r.evaluated_at), E.localDay(E.parseInstantUs(r.evaluated_at)), r.fatigue_attempts);
      await E.draft(D(), paymentsSql, r);
      const summary = { ...result, coverage: JSON.parse(r.validation_json).coverage };
      D().run("UPDATE runs SET status='Ready', version=version+1, summary_json=?, error_json=NULL WHERE id=?", [JSON.stringify(summary), id]);
      event(id, null, "ready", result.totals);
    });
  } catch (e) {
    const code = e instanceof E.ReconciliationError ? "RECONCILIATION_FAILED" : "QUERY_FAILED";
    D().run("UPDATE runs SET status='Failed', version=version+1, error_json=? WHERE id=?",
      [JSON.stringify({ code, message: "The analysis failed and nothing was saved. Run again.", details: [] }), id]);
    console.error(e);
  }
}

const uploads = new Map<string, string>();

function csvRes(text: string): Res { return { status: 200, text }; }

// ------------------------------------------------------------------ router
export async function handle(method: string, path: string, opts: { body?: any; form?: FormData; headers: Record<string, string> }): Promise<Res> {
  await boot();
  try {
    return await route(method, path, opts);
  } catch (e) {
    if (e instanceof ApiErr) return { status: e.status, data: { error: { code: e.code, message: e.message, details: e.details, request_id: "demo" } } };
    if (e instanceof E.IntakeError) return { status: e.status, data: { error: { code: e.code, message: e.message, details: e.details, request_id: "demo" } } };
    console.error(e);
    return { status: 500, data: { error: { code: "SERVER_ERROR", message: "Something went wrong in the browser demo.", details: [], request_id: "demo" } } };
  }
}

async function route(method: string, fullPath: string, { body, form, headers }: { body?: any; form?: FormData; headers: Record<string, string> }): Promise<Res> {
  const [path, qs] = fullPath.split("?");
  const q = new URLSearchParams(qs ?? "");
  const seg = path.split("/").filter(Boolean);
  const ok = (data: unknown, status = 200): Res => ({ status, data });

  if (path === "/health") return ok({ status: "ok", mode: "browser-demo", rule_version: E.RULE_VERSION });
  if (path === "/auth/login" && method === "POST") {
    const u = E.one<any>(D(), "SELECT * FROM users WHERE username=?", [String(body?.username ?? "")]);
    if (!u || body?.password !== DEMO_PASSWORD) throw new ApiErr(401, "LOGIN_FAILED", "Username or password is incorrect. In this demo the password is \"demo\".");
    user = { id: u.id, username: u.username, role: u.role };
    return ok(sessionBody());
  }
  if (path === "/auth/session") { needUser(); return ok(sessionBody()); }
  if (path === "/auth/logout") { user = null; return { status: 204 }; }
  needUser();

  if (path === "/workspace") {
    const h = historyInfo(currentHistory());
    return ok({ workspace: E.WORKSPACE, label: "Demo merchant (hypothetical)", history: h, history_available: !!h?.available,
      permitted_actions: user!.role === "operator" ? ["create_run"] : [], allowed_cooldowns: [3, 7, 14],
      evaluated_at: E.evaluatedAtForHistory(D(), currentHistory()), business_timezone: E.BUSINESS_TZ });
  }
  if (path === "/runs" && method === "GET") {
    const items = E.all<any>(D(), "SELECT * FROM runs ORDER BY created_at DESC, revision_no DESC LIMIT 50").map(runJson);
    return ok({ items, total: items.length, page: 1, page_size: 50 });
  }
  if (path === "/runs" && method === "POST") {
    needRole("operator"); checkPolicy(body);
    const id = E.uuid(), now = E.nowText(), hist = currentHistory();
    tx(() => {
      D().run("INSERT INTO analyses VALUES (?,?,?,?)", [id, E.WORKSPACE, user!.id, now]);
      D().run(`INSERT INTO runs (id, analysis_id, revision_no, status, cooldown_days, evaluated_at, business_timezone, rule_version, master_sha256,
               created_by, created_at, history_file_id, fatigue_attempts, holdout_pct) VALUES (?,?,1,'Draft',?,?,?,?,?,?,?,?,?,?)`,
        [id, id, body.cooldown_days, E.evaluatedAtForHistory(D(), hist), E.BUSINESS_TZ, E.RULE_VERSION, "browser-demo", user!.id, now, hist,
          body.fatigue_attempts ?? null, body.holdout_pct ?? 0]);
    });
    return ok(runJson(runRow(id)), 201);
  }

  const id = seg[1];
  if (seg[0] !== "runs" || !id) throw new ApiErr(404, "NOT_FOUND", "Unknown API path.");
  const action = seg.slice(2).join("/");

  if (!action && method === "GET") return ok(runJson(runRow(id)));
  if (!action && method === "PATCH") {
    const r = runRow(id); creatorOperator(r); ifMatch(headers, r); needStatus(r, "Draft"); checkPolicy(body);
    D().run("UPDATE runs SET cooldown_days=?, fatigue_attempts=?, holdout_pct=?, version=version+1 WHERE id=?",
      [body.cooldown_days, "fatigue_attempts" in body ? body.fatigue_attempts : r.fatigue_attempts, "holdout_pct" in body ? body.holdout_pct : r.holdout_pct, id]);
    return ok(runJson(runRow(id)));
  }
  if (action === "sources" && method === "PUT") {
    const r = runRow(id); creatorOperator(r); ifMatch(headers, r); needStatus(r, "Draft", "Validated");
    if (form?.has("requests_file")) throw new ApiErr(422, "REQUESTS_UPLOAD_REJECTED", "Payment history comes from the system. Upload only the loan portfolio.");
    const file = form?.get("loans_file");
    if (!(file instanceof Blob)) throw new ApiErr(422, "INVALID_REQUEST", "Send exactly one file in the loans_file field.");
    if (file.size > 50 * 1024 * 1024) throw new ApiErr(413, "INPUT_TOO_LARGE", "The portfolio file is larger than 50 MiB.");
    const text = await file.text(); const fid = E.uuid();
    uploads.set(fid, text);
    D().run(`INSERT INTO source_files (id, kind, workspace, original_name, storage_path, sha256, size_bytes, status, imported_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [fid, "loans_portfolio", E.WORKSPACE, (file as File).name || "portfolio.csv", "browser", await E.sha256Hex(text), file.size, "uploaded", E.nowText()]);
    D().run("UPDATE runs SET loans_file_id=?, status='Draft', validation_json=NULL, error_json=NULL, version=version+1 WHERE id=?", [fid, id]);
    return ok(runJson(runRow(id)));
  }
  if (action === "validate" || action === "execute") {
    const r = runRow(id); creatorOperator(r); ifMatch(headers, r);
    if (action === "validate") {
      needStatus(r, "Draft");
      if (!r.loans_file_id) throw new ApiErr(409, "PORTFOLIO_MISSING", "Upload the loan portfolio before checking it.");
      startJob(r, "Validating", validateJob);
    } else { needStatus(r, "Validated"); startJob(r, "Running", executeJob); }
    return ok(runJson(runRow(id)), 202);
  }
  if (action === "summary") {
    const r = completedRun(id); const s = JSON.parse(r.summary_json);
    return ok({ run_id: id, revision_id: id, version: r.version, status: r.status, configuration: configJson(r), totals: s.totals,
      reasons: s.reasons, actions: s.actions, coverage: s.coverage, is_executable: false });
  }
  if (action === "decisions") {
    completedRun(id);
    const decision = q.get("decision"), reason = q.get("reason"), loan = q.get("loan_id");
    const page = Math.max(1, Number(q.get("page") ?? 1)), size = Math.max(1, Math.min(Number(q.get("page_size") ?? 50), 100));
    const where = ["run_id=?"]; const params: unknown[] = [id];
    if (decision) { where.push("decision=?"); params.push(decision); }
    if (reason) { where.push("reason_code=?"); params.push(reason); }
    if (loan) { where.push("loan_id LIKE ?"); params.push(loan.replace(/[%_]/g, "") + "%"); }
    const order = decision === "WAIT" ? "next_check_day ASC, loan_id ASC"
      : decision === "RETRY" ? "last_success_us IS NULL, last_success_us DESC, consecutive_soft_failures ASC, loan_id ASC" : "loan_id ASC";
    const clause = where.join(" AND ");
    const total = Number(E.scalar(D(), `SELECT COUNT(*) FROM loan_decisions WHERE ${clause}`, params));
    const rows = E.all<any>(D(), `SELECT d.*, a.arm FROM (SELECT * FROM loan_decisions WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?) d
        LEFT JOIN experiment_assignments a ON a.run_id=d.run_id AND a.loan_id=d.loan_id ORDER BY ${order}`, [...params, size, (page - 1) * size]);
    return ok({ items: rows.map(decisionJson), total, page, page_size: size });
  }
  if (seg[2] === "loans" && seg[3]) {
    const r = completedRun(id); const loanId = decodeURIComponent(seg[3]);
    const d = E.one<any>(D(), `SELECT d.*, a.arm FROM loan_decisions d LEFT JOIN experiment_assignments a ON a.run_id=d.run_id AND a.loan_id=d.loan_id
        WHERE d.run_id=? AND d.loan_id=?`, [id, loanId]);
    if (!d) throw new ApiErr(404, "NOT_FOUND", "This loan isn't in the analysis.");
    const loan = E.one<any>(D(), "SELECT * FROM source_loans WHERE file_id=? AND loan_id=?", [r.loans_file_id, loanId])!;
    const ids: string[] = JSON.parse(d.source_payment_request_ids);
    const members = ids.length ? E.all<any>(D(), `SELECT * FROM source_requests WHERE file_id=? AND payment_request_id IN (${ids.map(() => "?").join(",")})
        ORDER BY payment_request_id`, [r.history_file_id, ...ids]).map(m => ({ payment_request_id: m.payment_request_id, created_at: m.created_at_raw,
      completed_at: m.completed_at_raw || null, chargeback_at: m.chargeback_at_raw || null, status: m.status, amount: E.money(m.amount_cents),
      failed_reason: m.failed_code, failed_message: m.failed_message || null })) : [];
    const h = E.one<any>(D(), "SELECT COUNT(*) n, COUNT(DISTINCT created_us) b, MIN(created_us) f FROM source_requests WHERE file_id=? AND loan_id=?", [r.history_file_id, loanId])!;
    const recent = E.all<any>(D(), `SELECT * FROM source_requests WHERE file_id=? AND loan_id=? AND created_us < COALESCE(?, 0)
        ORDER BY created_us DESC, payment_request_id LIMIT 10`, [r.history_file_id, loanId, d.last_batch_created_us])
      .map(x => ({ created_at: x.created_at_raw, status: x.status, amount: E.money(x.amount_cents), failed_reason: x.failed_code, failed_message: x.failed_message || null }));
    const reqs = E.all<any>(D(), `SELECT o.*, s.status FROM outbound_requests o JOIN payment_request_sets s ON s.id=o.set_id
        WHERE s.run_id=? AND o.loan_id=? ORDER BY o.tranche_pct`, [id, loanId])
      .map(p => ({ payment_request_id: p.payment_request_id, tranche_pct: p.tranche_pct, amount: E.money(p.amount_cents), status: p.status }));
    return ok({ ...decisionJson(d), loan: { loan_amount: E.money(loan.loan_amount_cents), overdue_at: loan.overdue_at, overdue_days: loan.overdue_days, source_line: loan.line_no },
      latest_batch: members, history: { requests: h.n, batches: h.b, first_request_at: E.isoUtc(h.f), earlier_requests: recent },
      clock: { evaluated_at: r.evaluated_at, business_timezone: r.business_timezone, cooldown_days: r.cooldown_days },
      payment_requests: reqs, production_checks: E.PRODUCTION_CHECKS, is_executable: false });
  }
  if (action === "submit" || action === "withdraw") {
    const r = runRow(id); creatorOperator(r); ifMatch(headers, r);
    if (action === "submit") { needStatus(r, "Ready"); D().run("UPDATE runs SET status='Submitted', version=version+1, submitted_at=? WHERE id=?", [E.nowText(), id]); }
    else { needStatus(r, "Submitted"); D().run("UPDATE runs SET status='Ready', version=version+1, submitted_at=NULL WHERE id=?", [id]); }
    return ok(runJson(runRow(id)));
  }
  if (action === "review") {
    needRole("reviewer"); const r = runRow(id);
    if (r.created_by === user!.id) throw new ApiErr(403, "SELF_APPROVAL", "The person who prepared an analysis can't review it.");
    const comment = String(body?.comment ?? "").trim();
    if (body?.action === "return" && !comment) throw new ApiErr(422, "COMMENT_REQUIRED", "Tell the operator what to change before sending it back.");
    ifMatch(headers, r); needStatus(r, "Submitted");
    tx(() => {
      D().run("UPDATE runs SET status=?, version=version+1, reviewed_by=?, reviewed_at=?, review_comment=? WHERE id=?",
        [body.action === "approve" ? "Approved" : "Returned", user!.id, E.nowText(), comment || null, id]);
      if (body.action === "approve") D().run("UPDATE payment_request_sets SET status='Released', released_by=?, released_at=? WHERE run_id=? AND status='Draft'", [user!.id, E.nowText(), id]);
    });
    return ok(runJson(runRow(id)));
  }
  if (action === "revisions") {
    needRole("operator"); checkPolicy(body); const p = runRow(id); ifMatch(headers, p);
    if (p.status === "Submitted") throw new ApiErr(409, "WITHDRAW_FIRST", "Withdraw the submitted analysis before creating a new revision.");
    needStatus(p, ...REVISABLE);
    const nid = E.uuid(); const hist = body.use_latest_history ? currentHistory() : p.history_file_id;
    const rev = Number(E.scalar(D(), "SELECT MAX(revision_no) FROM runs WHERE analysis_id=?", [p.analysis_id])) + 1;
    tx(() => {
      if (p.status === "Ready") D().run("UPDATE runs SET status='Superseded', version=version+1 WHERE id=?", [id]);
      D().run(`INSERT INTO runs (id, analysis_id, parent_run_id, revision_no, status, cooldown_days, evaluated_at, business_timezone, rule_version, master_sha256,
               created_by, created_at, loans_file_id, history_file_id, fatigue_attempts, holdout_pct) VALUES (?,?,?,?,'Draft',?,?,?,?,?,?,?,?,?,?,?)`,
        [nid, p.analysis_id, id, rev, body.cooldown_days, E.evaluatedAtForHistory(D(), hist), E.BUSINESS_TZ, E.RULE_VERSION, "browser-demo", user!.id, E.nowText(),
          p.loans_file_id, hist, "fatigue_attempts" in body ? body.fatigue_attempts : p.fatigue_attempts, "holdout_pct" in body ? body.holdout_pct : p.holdout_pct]);
    });
    return ok(runJson(runRow(nid)), 201);
  }
  if (action === "results.csv") {
    const r = runRow(id);
    if (r.status !== "Approved") throw new ApiErr(409, "NOT_APPROVED", "Only approved results can be downloaded.");
    return csvRes(resultsCsv(r));
  }
  if (action === "experiment") {
    const res = E.experiment(D(), completedRun(id));
    if (!res) throw new ApiErr(404, "NOT_FOUND", "This analysis has no holdout group.");
    return ok(res);
  }
  if (action.startsWith("payment-requests")) {
    runRow(id);
    const set = E.one<any>(D(), "SELECT * FROM payment_request_sets WHERE run_id=?", [id]);
    if (!set) throw new ApiErr(404, "NOT_FOUND", "No payment requests have been prepared for this analysis.");
    if (action === "payment-requests") return ok(E.paymentSummary(D(), set, who));
    if (action === "payment-requests.csv") {
      if (set.status === "Draft") throw new ApiErr(409, "NOT_RELEASED", "Payment requests can be downloaded once the reviewer approves and releases them.");
      return csvRes(E.exportPaymentsCsv(D(), set));
    }
    if (action === "payment-requests/simulate" && method === "POST") {
      needRole("operator");
      return csvRes(E.simulateResponses(D(), set, E.scalar(D(), "SELECT history_file_id FROM runs WHERE id=?", [id]) as string, Number(body?.seed ?? 7)));
    }
    if (action === "payment-requests/responses" && method === "PUT") {
      needRole("operator");
      if (set.status === "Draft") throw new ApiErr(409, "NOT_RELEASED", "Responses can only be imported for released payment requests.");
      if (set.status !== "Released") throw new ApiErr(409, "ALREADY_RESPONDED", "Responses for these payment requests were already imported.");
      const file = form?.get("responses_file"); const origin = String(form?.get("origin") ?? "");
      if (!(file instanceof Blob) || !["bank", "synthetic_demo"].includes(origin)) throw new ApiErr(422, "INVALID_REQUEST", "Send one responses_file and its origin.");
      const text = await file.text();
      await txa(() => E.importResponses(D(), set, text, origin, user!.id));
      return ok(E.paymentSummary(D(), E.one<any>(D(), "SELECT * FROM payment_request_sets WHERE id=?", [set.id])!, who));
    }
  }
  throw new ApiErr(404, "NOT_FOUND", "Unknown API path.");
}

function sessionBody() {
  return { user: { username: user!.username, role: user!.role }, workspace: E.WORKSPACE, expires_at: null, csrf_token: "demo" };
}

const CSV_COLUMNS = ["run_id", "revision_id", "master_sha256", "rule_version", "dataset_kind", "loan_id", "decision", "reason_code", "next_action_code",
  "payment_request_status", "payment_request_ids", "experiment_arm", "consecutive_soft_failures", "last_success_at", "last_batch_created_at", "last_batch_rows",
  "last_batch_statuses", "last_batch_reasons", "source_payment_request_ids", "cooldown_anchor_date", "days_since_anchor", "next_check_date",
  "total_amount_outstanding", "recommended_amount", "evaluated_at", "business_timezone", "cooldown_days", "fatigue_attempts", "rest_days", "holdout_pct",
  "loans_source_sha256", "requests_source_sha256", "production_checks", "is_executable", "analysis_review_state", "analysis_approved_by", "analysis_approved_at"];

function resultsCsv(run: any) {
  const loansSha = E.scalar(D(), "SELECT sha256 FROM source_files WHERE id=?", [run.loans_file_id]);
  const hist = E.one<any>(D(), "SELECT sha256, origin FROM source_files WHERE id=?", [run.history_file_id])!;
  const kind = hist.origin === "synthetic_demo" ? "synthetic_demo" : hist.origin === "bank" ? "belvo_sample_with_bank_responses" : "belvo_sample";
  const set = E.one<any>(D(), "SELECT id, status FROM payment_request_sets WHERE run_id=?", [run.id]);
  const ids = new Map<string, string[]>();
  if (set) for (const o of E.all<any>(D(), "SELECT loan_id, payment_request_id FROM outbound_requests WHERE set_id=? ORDER BY loan_id, tranche_pct", [set.id])) {
    if (!ids.has(o.loan_id)) ids.set(o.loan_id, []); ids.get(o.loan_id)!.push(o.payment_request_id);
  }
  const arms = new Map(E.all<any>(D(), "SELECT loan_id, arm FROM experiment_assignments WHERE run_id=?", [run.id]).map(a => [a.loan_id, a.arm]));
  const retryStatus = set ? String(set.status).toUpperCase() : "NOT_GENERATED";
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of E.all<any>(D(), "SELECT * FROM loan_decisions WHERE run_id=? ORDER BY loan_id", [run.id])) {
    lines.push([run.id, run.id, run.master_sha256, run.rule_version, kind, r.loan_id, r.decision, r.reason_code, r.next_action_code,
      r.decision === "RETRY" ? (arms.get(r.loan_id) === "control" ? "HOLDOUT" : retryStatus) : "NONE", JSON.stringify(ids.get(r.loan_id) ?? []),
      arms.get(r.loan_id) ?? "", r.consecutive_soft_failures, E.isoUtc(r.last_success_us) ?? "", E.isoUtc(r.last_batch_created_us) ?? "", r.last_batch_rows,
      r.last_batch_statuses, r.last_batch_reasons, r.source_payment_request_ids, E.dayText(r.cooldown_anchor_day) ?? "", r.days_since_anchor ?? "",
      E.dayText(r.next_check_day) ?? "", E.money(r.total_amount_outstanding_cents) ?? "", "", run.evaluated_at, run.business_timezone, run.cooldown_days,
      run.fatigue_attempts ?? "", run.fatigue_attempts ? E.REST_DAYS : "", run.holdout_pct, loansSha, hist.sha256, E.PRODUCTION_CHECKS, "false", "Approved",
      who(run.reviewed_by), run.reviewed_at].map(E.csvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

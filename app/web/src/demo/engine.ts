// Browser port of the server's intake, classification and payment-request logic.
// The decision rules are NOT reimplemented here: the same SQL files the FastAPI server
// uses (app/sql/*.sql) run inside SQLite compiled to WebAssembly (sql.js).
// This module mirrors app/server/ingest.py, engine.py and payments.py.
import type { Database } from "sql.js";

export const EVALUATED_AT_TEXT = "2025-11-11T23:59:59-06:00";
export const BUSINESS_TZ = "America/Mexico_City";
export const RULE_VERSION = "minimal-v2";
export const REST_DAYS = 30;
export const WORKSPACE = "demo-merchant";
export const PRODUCTION_CHECKS = "UNVERIFIED_LIVE_AUTH_METHOD_DEBT_EXPOSURE_POLICY";
// Mexico City has had a fixed UTC-6 offset since daylight saving ended in October 2022,
// which covers every timestamp in the challenge data and the exercise clock.
const MX_OFFSET_US = -6 * 3600 * 1_000_000;
const DAY_US = 86_400 * 1_000_000;

export const LOANS_COLUMNS = ["loan_id", "payment_method_bank", "loan_amount", "total_amount_outstanding", "overdue_at", "overdue_days"];
export const REQUEST_COLUMNS = ["payment_request_id", "created_at", "completed_at", "chargeback_at", "status", "amount", "failed_reason", "failed_message", "loan_id"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_DETAILS = 20;

export class IntakeError extends Error {
  code: string; details: Record<string, unknown>[]; status: number;
  constructor(code: string, message: string, details: Record<string, unknown>[] = [], status = 422) {
    super(message); this.code = code; this.details = details; this.status = status;
  }
}
export class ReconciliationError extends Error {}

class Problems {
  items: Record<string, unknown>[] = []; count = 0; label: string;
  constructor(label: string) { this.label = label; }
  add(line: number, column: string, problem: string) {
    this.count++;
    if (this.items.length < MAX_DETAILS) this.items.push({ file: this.label, line, column, problem });
  }
  raiseIfAny(code: string, message: string) {
    if (!this.count) return;
    const more = this.count > this.items.length ? [{ file: this.label, more: this.count - this.items.length }] : [];
    throw new IntakeError(code, `${message} (${this.count} problem${this.count !== 1 ? "s" : ""}).`, [...this.items, ...more]);
  }
}

// ------------------------------------------------------------------ values
export function parseMoneyCents(text: string): number {
  const t = text.trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new Error("not a decimal number");
  let frac = m[3] ?? "";
  if (frac.length > 2) {
    if (/[1-9]/.test(frac.slice(2))) throw new Error("more than two decimal places");
    frac = frac.slice(0, 2);
  }
  const cents = Number(m[2]) * 100 + Number((frac + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new Error("out of range");
  return m[1] ? -cents : cents;
}

export function parseInstantUs(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})$/.exec(text.trim());
  if (!m) throw new Error("unparseable timestamp");
  const [, y, mo, d, h, mi, s, frac = "", tz] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (Number.isNaN(ms) || new Date(ms).getUTCDate() !== +d) throw new Error("unparseable timestamp");
  let us = ms * 1000 + Number((frac + "000000").slice(0, 6));
  if (tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    us -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000_000;
  }
  return us;
}

export const localDay = (us: number) => Math.floor((us + MX_OFFSET_US) / DAY_US);
export const dayText = (day: number | null) => day === null || day === undefined ? null : new Date(day * 86_400_000).toISOString().slice(0, 10);
export function isoUtc(us: number | null): string | null {
  if (us === null || us === undefined) return null;
  const ms = Math.floor(us / 1000);
  const base = new Date(ms).toISOString().slice(0, 19);
  return `${base}.${String(((us % 1_000_000) + 1_000_000) % 1_000_000).padStart(6, "0")}Z`;
}
export const isoMs = (us: number) => new Date(Math.floor(us / 1000)).toISOString().replace(/\.(\d{3})Z$/, ".$1Z");
export const nowText = () => new Date().toISOString().slice(0, 19) + "Z";
export const money = (cents: number | null) => {
  if (cents === null || cents === undefined) return null;
  const sign = cents < 0 ? "-" : ""; const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
};
export const normalizeCode = (raw: string) => {
  const t = raw.trim();
  if (!t) return null;
  return /^\d+$/.test(t) ? String(Number(t)).padStart(2, "0") : t;
};
export const CUTOFF_US = parseInstantUs(EVALUATED_AT_TEXT);
export const EVAL_DAY = localDay(CUTOFF_US);

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export const uuid = () => crypto.randomUUID();

// ------------------------------------------------------------------ CSV
export function parseCsv(text: string): { rows: string[][]; lines: number[] } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = []; const lines: number[] = [];
  let row: string[] = []; let field = ""; let quoted = false; let line = 1; let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else { if (c === "\n") line++; field += c; }
      continue;
    }
    if (c === '"') { quoted = true; started = true; }
    else if (c === ",") { row.push(field); field = ""; started = true; }
    else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (started || field) { row.push(field); rows.push(row); lines.push(line); }
      row = []; field = ""; started = false; line++;
    } else { field += c; started = true; }
  }
  if (quoted) throw new IntakeError("INPUT_MALFORMED", "The file has an unterminated quoted field.");
  if (started || field) { row.push(field); rows.push(row); lines.push(line); }
  return { rows, lines };
}

function openRows(text: string, required: string[], label: string, maxRows: number) {
  const { rows, lines } = parseCsv(text);
  if (!rows.length) throw new IntakeError("INPUT_EMPTY", `The ${label} is empty.`, [{ file: label }]);
  const header = rows[0].map(h => h.trim());
  const missing = required.filter(c => !header.includes(c));
  if (missing.length) throw new IntakeError("INPUT_SCHEMA_INVALID", `The ${label} is missing required columns.`, [{ file: label, missing_columns: missing }]);
  if (new Set(header).size !== header.length) throw new IntakeError("INPUT_SCHEMA_INVALID", `The ${label} has repeated column names.`, [{ file: label }]);
  const extra = header.filter(c => !required.includes(c));
  const index = Object.fromEntries(required.map(c => [c, header.indexOf(c)]));
  const out: [number, Record<string, string>][] = [];
  const malformed = new Problems(label);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length !== header.length) { malformed.add(lines[i], "*", `expected ${header.length} fields, found ${r.length}`); continue; }
    out.push([lines[i], Object.fromEntries(required.map(c => [c, r[index[c]]]))]);
    if (out.length > maxRows) throw new IntakeError("INPUT_TOO_LARGE", `The ${label} has more than ${maxRows.toLocaleString("en-US")} rows.`, [{ file: label, max_rows: maxRows }], 413);
  }
  malformed.raiseIfAny("INPUT_MALFORMED", `The ${label} has rows with the wrong number of fields`);
  return { rows: out, warnings: extra.length ? [{ file: label, unused_columns: extra }] : [] };
}

function bulkInsert(db: Database, sql: string, rows: unknown[][]) {
  const stmt = db.prepare(sql);
  try { for (const r of rows) stmt.run(r as never); } finally { stmt.free(); }
}

export function stageHistory(db: Database, fileId: string, text: string) {
  const label = "payment history file";
  const { rows, warnings } = openRows(text, REQUEST_COLUMNS, label, 1_000_000);
  const problems = new Problems(label);
  const seen = new Set<string>(); const staged: unknown[][] = []; let soft = 0;
  for (const [line, r] of rows) {
    const rid = r.payment_request_id, loan = r.loan_id;
    if (!ID_RE.test(rid)) problems.add(line, "payment_request_id", "invalid identifier");
    else if (seen.has(rid)) problems.add(line, "payment_request_id", `duplicate id ${rid}`);
    seen.add(rid);
    if (!ID_RE.test(loan)) problems.add(line, "loan_id", "invalid identifier");
    let created: number, amount: number;
    try { created = parseInstantUs(r.created_at); } catch { problems.add(line, "created_at", "unparseable timestamp"); continue; }
    try { amount = parseMoneyCents(r.amount); } catch (e) { problems.add(line, "amount", (e as Error).message); continue; }
    let completed: number | null = null, chargeback: number | null = null, cBad = 0, cbBad = 0;
    if (r.completed_at.trim()) { try { completed = parseInstantUs(r.completed_at); } catch { cBad = 1; soft++; } }
    if (r.chargeback_at.trim()) { try { chargeback = parseInstantUs(r.chargeback_at); } catch { cbBad = 1; soft++; } }
    staged.push([fileId, line, rid, loan, created, completed, cBad, chargeback, cbBad, localDay(created),
      completed === null ? null : localDay(completed), r.status, amount, normalizeCode(r.failed_reason), r.failed_reason,
      r.failed_message, r.created_at, r.completed_at, r.chargeback_at]);
  }
  problems.raiseIfAny("INPUT_ROWS_INVALID", "The payment history file has invalid rows");
  if (soft) warnings.push({ file: label, unparseable_optional_timestamps: soft } as never);
  bulkInsert(db, "INSERT INTO source_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", staged);
  const created = staged.map(s => s[4] as number);
  return { row_count: staged.length, event_min_us: created.length ? created.reduce((a, b) => Math.min(a, b)) : null,
    event_max_us: created.length ? created.reduce((a, b) => Math.max(a, b)) : null, warnings };
}

export function stagePortfolio(db: Database, fileId: string, text: string) {
  const label = "loan portfolio file";
  const { rows, warnings } = openRows(text, LOANS_COLUMNS, label, 100_000);
  const problems = new Problems(label);
  const seen = new Set<string>(); const staged: unknown[][] = [];
  for (const [line, r] of rows) {
    const loan = r.loan_id;
    if (!ID_RE.test(loan)) problems.add(line, "loan_id", "invalid identifier");
    else if (seen.has(loan)) problems.add(line, "loan_id", `duplicate id ${loan}`);
    seen.add(loan);
    const values: Record<string, number | null> = {};
    for (const col of ["loan_amount", "total_amount_outstanding"]) {
      const t = r[col].trim();
      if (!t) { values[col] = null; continue; }
      try { values[col] = parseMoneyCents(t); } catch (e) { problems.add(line, col, (e as Error).message); }
    }
    let overdueAt: string | null = null;
    if (r.overdue_at.trim()) {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(r.overdue_at.trim());
      const d = m ? new Date(Date.UTC(+m[3], +m[1] - 1, +m[2])) : null;
      if (!m || !d || d.getUTCMonth() !== +m[1] - 1) problems.add(line, "overdue_at", "expected M/D/YYYY");
      else overdueAt = d.toISOString().slice(0, 10);
    }
    let overdueDays: number | null = null;
    if (r.overdue_days.trim()) {
      if (/^-?\d+$/.test(r.overdue_days.trim())) overdueDays = Number(r.overdue_days.trim());
      else problems.add(line, "overdue_days", "not a whole number");
    }
    staged.push([fileId, line, loan, r.payment_method_bank, values.loan_amount ?? null, values.total_amount_outstanding ?? null,
      overdueAt, overdueDays, JSON.stringify(r)]);
  }
  problems.raiseIfAny("INPUT_ROWS_INVALID", "The loan portfolio file has invalid rows");
  bulkInsert(db, "INSERT INTO source_loans VALUES (?,?,?,?,?,?,?,?,?)", staged);
  return { row_count: staged.length, warnings };
}

// ------------------------------------------------------------------ queries
export function one<T = Record<string, unknown>>(db: Database, sql: string, params: unknown[] | Record<string, unknown> = []): T | null {
  const stmt = db.prepare(sql);
  try { stmt.bind(params as never); return stmt.step() ? (stmt.getAsObject() as T) : null; } finally { stmt.free(); }
}
export function all<T = Record<string, unknown>>(db: Database, sql: string, params: unknown[] | Record<string, unknown> = []): T[] {
  const stmt = db.prepare(sql); const out: T[] = [];
  try { stmt.bind(params as never); while (stmt.step()) out.push(stmt.getAsObject() as T); } finally { stmt.free(); }
  return out;
}
export const scalar = (db: Database, sql: string, params: unknown[] = []) => {
  const r = db.exec(sql, params as never);
  return r.length ? r[0].values[0][0] : null;
};

export function pairCoverage(db: Database, loansFile: string, historyFile: string) {
  const n = (sql: string, p: unknown[]) => Number(scalar(db, sql, p));
  const loans = n("SELECT COUNT(*) FROM source_loans WHERE file_id=?", [loansFile]);
  const requests = n("SELECT COUNT(*) FROM source_requests WHERE file_id=?", [historyFile]);
  const withHistory = n(`SELECT COUNT(*) FROM source_loans l WHERE l.file_id=? AND EXISTS
      (SELECT 1 FROM source_requests r WHERE r.file_id=? AND r.loan_id=l.loan_id)`, [loansFile, historyFile]);
  const orphans = one<{ a: number; b: number }>(db, `SELECT COUNT(*) a, COUNT(DISTINCT r.loan_id) b FROM source_requests r WHERE r.file_id=? AND NOT EXISTS
      (SELECT 1 FROM source_loans l WHERE l.file_id=? AND l.loan_id=r.loan_id)`, [historyFile, loansFile])!;
  return {
    loans, requests, loans_with_history: withHistory, loans_without_history: loans - withHistory,
    orphan_request_rows: orphans.a, orphan_loan_ids: orphans.b,
    collection_batches: n("SELECT COUNT(*) FROM (SELECT DISTINCT loan_id, created_us FROM source_requests WHERE file_id=?)", [historyFile]),
    outstanding_cents: n("SELECT COALESCE(SUM(total_amount_outstanding_cents),0) FROM source_loans WHERE file_id=?", [loansFile]),
    requested_cents: n("SELECT COALESCE(SUM(amount_cents),0) FROM source_requests WHERE file_id=?", [historyFile]),
  };
}

const DECISIONS = ["RETRY", "WAIT", "REVIEW_REMEDIATE"] as const;
const ACTIONS: Record<string, string> = { RETRY: "PREPARE_RETRY_HANDOFF", WAIT: "REASSESS_ON_OR_AFTER_DATE", REVIEW_REMEDIATE: "INVESTIGATE_BEFORE_RETRY" };

export function classify(db: Database, rulesSql: string, runId: string, loansFile: string, historyFile: string, cooldown: number,
  cutoffUs: number, evalDay: number, fatigue: number | null) {
  db.run(rulesSql, { ":run_id": runId, ":loans_file_id": loansFile, ":history_file_id": historyFile, ":cutoff_us": cutoffUs,
    ":eval_day": evalDay, ":cooldown": cooldown, ":fatigue": fatigue, ":rest": REST_DAYS } as never);
  const portfolio = Number(scalar(db, "SELECT COUNT(*) FROM source_loans WHERE file_id=?", [loansFile]));
  const rows = one<{ a: number; b: number }>(db, "SELECT COUNT(*) a, COUNT(DISTINCT loan_id) b FROM loan_decisions WHERE run_id=?", [runId])!;
  if (rows.a !== portfolio || rows.b !== portfolio) throw new ReconciliationError(`${rows.a} decisions for ${portfolio} portfolio loans`);
  const totals: Record<string, number> = { RETRY: 0, WAIT: 0, REVIEW_REMEDIATE: 0 };
  for (const r of all<{ decision: string; n: number }>(db, "SELECT decision, COUNT(*) n FROM loan_decisions WHERE run_id=? GROUP BY decision", [runId])) totals[r.decision] = r.n;
  const bad = Number(scalar(db, "SELECT COUNT(*) FROM loan_decisions WHERE run_id=? AND next_action_code IS NULL", [runId]));
  if (bad) throw new ReconciliationError("rows with an invalid next action");
  for (const d of DECISIONS) {
    const n = Number(scalar(db, "SELECT COUNT(*) FROM loan_decisions WHERE run_id=? AND decision=? AND next_action_code=?", [runId, d, ACTIONS[d]]));
    if (n !== totals[d]) throw new ReconciliationError("action counts do not match decision counts");
  }
  const reasons = Object.fromEntries(all<{ reason_code: string; n: number }>(db,
    "SELECT reason_code, COUNT(*) n FROM loan_decisions WHERE run_id=? GROUP BY reason_code ORDER BY reason_code", [runId]).map(r => [r.reason_code, r.n]));
  const actions = Object.fromEntries(all<{ a: string; n: number }>(db,
    "SELECT next_action_code a, COUNT(*) n FROM loan_decisions WHERE run_id=? GROUP BY next_action_code", [runId]).map(r => [r.a, r.n]));
  return { totals: { loans: portfolio, ...totals }, reasons, actions };
}

// ------------------------------------------------------------------ payment requests (D34-D39)
export function requestedAtFor(evaluatedAtText: string): number {
  const day = localDay(parseInstantUs(evaluatedAtText)) + 1;
  return day * DAY_US - MX_OFFSET_US + 9 * 3600 * 1_000_000;
}
export function evaluatedAtForHistory(db: Database, historyFile: string | null): string {
  if (!historyFile) return EVALUATED_AT_TEXT;
  const v = scalar(db, "SELECT response_event_max_us FROM source_files WHERE id=?", [historyFile]);
  if (v === null || v === undefined) return EVALUATED_AT_TEXT;
  return `${dayText(localDay(Number(v)))}T23:59:59-06:00`;
}
export async function armFor(runId: string, loanId: string, pct: number) {
  const hex = await sha256Hex(`${runId}:${loanId}`);
  return Number(BigInt("0x" + hex) % 100n) < pct ? "control" : "treatment";
}

export async function draft(db: Database, paymentsSql: string, run: Record<string, any>) {
  const setId = uuid();
  const pct = run.holdout_pct || 0;
  if (pct > 0) {
    const loans = all<{ loan_id: string }>(db, "SELECT loan_id FROM loan_decisions WHERE run_id=? AND decision='RETRY'", [run.id]);
    const rows: unknown[][] = [];
    for (const l of loans) rows.push([run.id, l.loan_id, await armFor(run.id, l.loan_id, pct)]);
    bulkInsert(db, "INSERT INTO experiment_assignments VALUES (?,?,?)", rows);
  }
  db.run(`INSERT INTO payment_request_sets (id, run_id, created_by, created_at, requested_at_us, loan_count, request_count, total_cents, status)
          VALUES (?,?,?,?,?,0,0,0,'Draft')`, [setId, run.id, run.created_by, nowText(), requestedAtFor(run.evaluated_at)]);
  db.run(paymentsSql, { ":set_id": setId, ":run_id": run.id } as never);
  const retry = one<{ n: number; s: number }>(db, `SELECT COUNT(*) n, COALESCE(SUM(total_amount_outstanding_cents),0) s FROM loan_decisions d
     WHERE run_id=? AND decision='RETRY' AND NOT EXISTS (SELECT 1 FROM experiment_assignments a
     WHERE a.run_id=d.run_id AND a.loan_id=d.loan_id AND a.arm='control')`, [run.id])!;
  const made = one<{ n: number; s: number; mn: number; l: number }>(db, `SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) s, COALESCE(MIN(amount_cents),0) mn,
     COUNT(DISTINCT loan_id) l FROM outbound_requests WHERE set_id=?`, [setId])!;
  if (made.n !== 3 * retry.n || made.s !== retry.s || made.l !== retry.n) throw new ReconciliationError("request count or total does not match the RETRY candidates");
  if (retry.n && made.mn <= 0) throw new ReconciliationError("a tranche would be zero or negative");
  db.run("UPDATE payment_request_sets SET loan_count=?, request_count=?, total_cents=? WHERE id=?", [retry.n, made.n, made.s, setId]);
}

export function exportPaymentsCsv(db: Database, set: Record<string, any>) {
  const created = isoMs(set.requested_at_us);
  const lines = [REQUEST_COLUMNS.join(",")];
  for (const r of all<any>(db, "SELECT * FROM outbound_requests WHERE set_id=? ORDER BY loan_id, tranche_pct", [set.id]))
    lines.push([r.payment_request_id, created, "", "", "pending", money(r.amount_cents), "", "", r.loan_id].join(","));
  return lines.join("\r\n") + "\r\n";
}

export function paymentSummary(db: Database, set: Record<string, any>, who: (id: string | null) => string | null) {
  const byTranche = Object.fromEntries(all<any>(db,
    "SELECT tranche_pct p, SUM(amount_cents) s FROM outbound_requests WHERE set_id=? GROUP BY tranche_pct ORDER BY tranche_pct", [set.id]).map(r => [`${r.p}%`, money(r.s)]));
  return {
    set_id: set.id, run_id: set.run_id, status: set.status, split: [5, 25, 70], split_version: "split-5-25-70-v1",
    requested_at: isoMs(set.requested_at_us), created_by: who(set.created_by), created_at: set.created_at,
    released_by: who(set.released_by), released_at: set.released_at,
    loans: set.loan_count, requests: set.request_count, total_amount: money(set.total_cents), total_by_tranche: byTranche,
    holdout_loans: Number(scalar(db, "SELECT COUNT(*) FROM experiment_assignments WHERE run_id=? AND arm='control'", [set.run_id])),
    responses: set.status !== "Responded" ? null : {
      origin: set.responses_origin, sha256: set.responses_sha256, imported_at: set.responses_imported_at,
      imported_by: who(set.responses_imported_by), history_dataset_id: set.history_file_id, outcomes: JSON.parse(set.outcome_json),
    },
    sent_by_mvp: false,
  };
}

const RESPONSE_STATUSES = ["successful", "failed", "chargeback"];

export async function importResponses(db: Database, set: Record<string, any>, text: string, origin: string, userId: string) {
  const label = "response file";
  const { rows } = openRows(text, REQUEST_COLUMNS, label, 1_000_000);
  const expected = new Map(all<any>(db, "SELECT * FROM outbound_requests WHERE set_id=?", [set.id]).map(r => [r.payment_request_id, r]));
  const problems = new Problems(label);
  const seen = new Set<string>(); const outcomes: Record<string, number> = {}; const loanStatus = new Map<string, Set<string>>();
  let eventMax = 0;
  for (const [line, r] of rows) {
    const exp = expected.get(r.payment_request_id);
    if (!exp) { problems.add(line, "payment_request_id", `${r.payment_request_id} is not in this request set`); continue; }
    if (seen.has(r.payment_request_id)) { problems.add(line, "payment_request_id", `${r.payment_request_id} answered more than once`); continue; }
    seen.add(r.payment_request_id);
    if (r.loan_id !== exp.loan_id) problems.add(line, "loan_id", `expected ${exp.loan_id}`);
    try { if (parseMoneyCents(r.amount) !== exp.amount_cents) problems.add(line, "amount", `expected ${money(exp.amount_cents)}`); }
    catch (e) { problems.add(line, "amount", (e as Error).message); }
    let created = set.requested_at_us;
    try { created = parseInstantUs(r.created_at); if (created !== set.requested_at_us) problems.add(line, "created_at", "does not match the request"); }
    catch { problems.add(line, "created_at", "unparseable timestamp"); }
    if (!RESPONSE_STATUSES.includes(r.status)) { problems.add(line, "status", "must be successful, failed or chargeback"); continue; }
    let completed: number;
    try { completed = parseInstantUs(r.completed_at); } catch { problems.add(line, "completed_at", "required response timestamp is missing or unparseable"); continue; }
    if (completed < created) problems.add(line, "completed_at", "is before the request was created");
    const events = [completed];
    if (r.status === "failed" && !r.failed_reason.trim()) problems.add(line, "failed_reason", "failed responses need a reason");
    if (r.status === "chargeback") {
      try { const cb = parseInstantUs(r.chargeback_at); if (cb < completed) problems.add(line, "chargeback_at", "is before completion"); events.push(cb); }
      catch { problems.add(line, "chargeback_at", "chargeback responses need chargeback_at"); }
    } else if (r.chargeback_at.trim()) problems.add(line, "chargeback_at", "only chargeback responses may have it");
    eventMax = Math.max(eventMax, ...events);
    outcomes[r.status] = (outcomes[r.status] ?? 0) + 1;
    if (!loanStatus.has(exp.loan_id)) loanStatus.set(exp.loan_id, new Set());
    loanStatus.get(exp.loan_id)!.add(r.status);
  }
  const missing = expected.size - seen.size;
  if (missing > 0) problems.add(0, "payment_request_id", `${missing} request(s) have no response; send a complete file`);
  problems.raiseIfAny("RESPONSES_INVALID", "The response file doesn't match the payment requests");

  const parentId = scalar(db, "SELECT history_file_id FROM runs WHERE id=?", [set.run_id]) as string;
  const parent = one<any>(db, "SELECT * FROM source_files WHERE id=?", [parentId])!;
  const fileId = uuid();
  const newOrigin = origin === "synthetic_demo" || parent.origin === "synthetic_demo" ? "synthetic_demo" : "bank";
  // Copy the parent's staged rows, then stage the responses on top: the same rows the server's combined file holds.
  db.run(`INSERT INTO source_files (id, kind, workspace, original_name, storage_path, sha256, size_bytes, status, imported_at, origin,
          parent_file_id, responses_count, response_event_max_us) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [fileId, "requests_history", WORKSPACE, `${parent.original_name} + responses ${set.id.slice(0, 8)}`, "browser", await sha256Hex(parent.sha256 + text),
      parent.size_bytes + text.length, "uploaded", nowText(), newOrigin, parentId, (parent.responses_count || 0) + rows.length, Math.max(eventMax, parent.response_event_max_us || 0)]);
  db.run(`INSERT INTO source_requests SELECT ?, line_no, payment_request_id, loan_id, created_us, completed_us, completed_unparseable, chargeback_us,
          chargeback_unparseable, created_local_day, completed_local_day, status, amount_cents, failed_code, failed_reason_raw, failed_message,
          created_at_raw, completed_at_raw, chargeback_at_raw FROM source_requests WHERE file_id=?`, [fileId, parentId]);
  const header = REQUEST_COLUMNS.join(",");
  const staged = stageHistory(db, fileId, header + "\n" + rows.map(([, r]) => REQUEST_COLUMNS.map(c => csvField(r[c])).join(",")).join("\n"));
  const total = Number(scalar(db, "SELECT COUNT(*) FROM source_requests WHERE file_id=?", [fileId]));
  const range = one<any>(db, "SELECT MIN(created_us) mn, MAX(created_us) mx FROM source_requests WHERE file_id=?", [fileId])!;
  db.run("UPDATE source_files SET status='staged', row_count=?, event_min_us=?, event_max_us=?, warnings_json=? WHERE id=?",
    [total, range.mn, range.mx, JSON.stringify(staged.warnings), fileId]);
  const mixed = [...loanStatus.values()].filter(s => s.size > 1).length;
  db.run(`UPDATE payment_request_sets SET status='Responded', responses_sha256=?, responses_origin=?, responses_imported_at=?, responses_imported_by=?,
          history_file_id=?, outcome_json=? WHERE id=?`,
    [await sha256Hex(text), origin, nowText(), userId, fileId, JSON.stringify({ by_status: outcomes, loans: loanStatus.size, loans_with_mixed_outcomes: mixed }), set.id]);
  return fileId;
}

export const csvField = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function experiment(db: Database, run: Record<string, any>) {
  if (!run.holdout_pct) return null;
  const arms: Record<string, { loans: number; outstanding: string }> = { treatment: { loans: 0, outstanding: "0.00" }, control: { loans: 0, outstanding: "0.00" } };
  for (const r of all<any>(db, `SELECT a.arm, COUNT(*) n, SUM(d.total_amount_outstanding_cents) bal FROM experiment_assignments a
      JOIN loan_decisions d ON d.run_id=a.run_id AND d.loan_id=a.loan_id WHERE a.run_id=? GROUP BY a.arm`, [run.id]))
    arms[r.arm] = { loans: r.n, outstanding: money(r.bal || 0)! };
  const set = one<any>(db, "SELECT * FROM payment_request_sets WHERE run_id=?", [run.id]);
  let responses = null;
  if (set && set.status === "Responded") {
    const r = one<any>(db, `SELECT COUNT(DISTINCT CASE WHEN q.status='successful' THEN q.loan_id END) paid,
        COALESCE(SUM(CASE WHEN q.status='successful' THEN q.amount_cents END),0) collected,
        COUNT(DISTINCT CASE WHEN q.status='chargeback' THEN q.loan_id END) cb
        FROM outbound_requests o JOIN source_requests q ON q.file_id=? AND q.payment_request_id=o.payment_request_id WHERE o.set_id=?`,
      [set.history_file_id, set.id])!;
    responses = { treatment_loans_paid: r.paid, treatment_collected: money(r.collected), treatment_loans_charged_back: r.cb, origin: set.responses_origin };
  }
  const later = one<any>(db, `SELECT r.id, r.loans_file_id, r.revision_no FROM runs r JOIN source_files f ON f.id=r.loans_file_id
      WHERE r.analysis_id=? AND r.revision_no>? AND r.loans_file_id<>? AND f.status='staged' ORDER BY r.revision_no DESC LIMIT 1`,
    [run.analysis_id, run.revision_no, run.loans_file_id]);
  let snapshot = null;
  if (later) {
    const per: Record<string, any> = {};
    for (const r of all<any>(db, `SELECT a.arm, COUNT(*) n,
        SUM(CASE WHEN nl.total_amount_outstanding_cents < ol.total_amount_outstanding_cents THEN 1 ELSE 0 END) reduced,
        SUM(MAX(ol.total_amount_outstanding_cents - COALESCE(nl.total_amount_outstanding_cents, ol.total_amount_outstanding_cents), 0)) recovered
        FROM experiment_assignments a JOIN source_loans ol ON ol.file_id=? AND ol.loan_id=a.loan_id
        LEFT JOIN source_loans nl ON nl.file_id=? AND nl.loan_id=a.loan_id WHERE a.run_id=? GROUP BY a.arm`, [run.loans_file_id, later.loans_file_id, run.id]))
      per[r.arm] = { loans: r.n, loans_with_lower_balance: r.reduced, recovered: money(r.recovered || 0), recovered_per_loan: money(Math.floor((r.recovered || 0) / Math.max(r.n, 1))) };
    const t = per.treatment, c = per.control;
    const lift = t && c ? money(Math.floor((r100(t.recovered_per_loan) - r100(c.recovered_per_loan)))) : null;
    snapshot = { revision_no: later.revision_no, run_id: later.id, arms: per, incremental_recovered_per_loan: lift };
  }
  return { holdout_pct: run.holdout_pct, assignment: "sha256(run_id:loan_id) mod 100 < holdout_pct", arms, responses, next_snapshot: snapshot,
    synthetic: !!(set && set.responses_origin === "synthetic_demo"), small_sample: arms.control.loans < 100 };
}
const r100 = (s: string) => parseMoneyCents(s);

/** Synthetic responses, same method as app/tools/simulate_bank_responses.py: one outcome per loan from historical three-member batches. */
export function simulateResponses(db: Database, set: Record<string, any>, historyFile: string, seed = 7) {
  const mix = all<any>(db, `SELECT status, failed_reason_raw AS code, COUNT(*) n FROM (
      SELECT loan_id, created_us, MIN(status) status, MIN(failed_reason_raw) failed_reason_raw, COUNT(*) c,
             COUNT(DISTINCT status || '|' || failed_reason_raw) k FROM source_requests WHERE file_id=? GROUP BY loan_id, created_us)
      WHERE c=3 AND k=1 GROUP BY status, code ORDER BY status, code`, [historyFile]);
  const messages = Object.fromEntries(all<any>(db, `SELECT failed_reason_raw code, failed_message m, COUNT(*) n FROM source_requests
      WHERE file_id=? AND status='failed' AND failed_message<>'' GROUP BY code, m ORDER BY code, n DESC`, [historyFile])
    .reduce((acc: [string, string][], r: any) => (acc.some(([c]) => c === r.code) ? acc : [...acc, [r.code, r.m]]), []));
  const total = mix.reduce((a, r) => a + r.n, 0);
  let state = seed >>> 0;
  const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  const rows = all<any>(db, "SELECT * FROM outbound_requests WHERE set_id=? ORDER BY loan_id, tranche_pct", [set.id]);
  const created = isoMs(set.requested_at_us);
  const byLoan = new Map<string, any[]>();
  for (const r of rows) { if (!byLoan.has(r.loan_id)) byLoan.set(r.loan_id, []); byLoan.get(r.loan_id)!.push(r); }
  const lines = [REQUEST_COLUMNS.join(",")];
  for (const [loan, reqs] of [...byLoan.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let x = rand() * total, pick = mix[0];
    for (const m of mix) { if ((x -= m.n) < 0) { pick = m; break; } }
    const completedUs = set.requested_at_us + 2 * DAY_US + Math.floor(rand() * 120) * 60_000_000;
    for (const r of reqs) {
      const cb = pick.status === "chargeback" ? isoMs(completedUs + 3 * DAY_US) : "";
      lines.push([r.payment_request_id, created, isoMs(completedUs), cb, pick.status, money(r.amount_cents),
        pick.status === "failed" ? pick.code : "", pick.status === "failed" ? csvField(messages[pick.code] ?? "") : "", loan].join(","));
    }
  }
  return lines.join("\r\n") + "\r\n";
}

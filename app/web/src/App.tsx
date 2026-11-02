import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { BrowserRouter, HashRouter, Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, DEMO, setCsrf, setUnauthorizedHandler, type Decision, type DecisionRow, type Experiment, type LoanDetail, type Page, type Policy, type Run,
  type Session, type Summary, type Workspace } from "./api";
import { DECISION_CHIP, INVESTIGATE, QUEUE_LABEL, REASON_LABEL, RULES, STATUS_LABEL, WHAT_TO_DO, fmtCents, fmtInt, fmtMoney,
  fmtWhen, short, why } from "./copy";

// ------------------------------------------------------------------ session
interface Auth { session: Session | null; setSession: (s: Session | null) => void; notice: string; setNotice: (n: string) => void }
const AuthCtx = createContext<Auth>(null!);
const useAuth = () => useContext(AuthCtx);

export default function App() {
  const [session, setSessionState] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const setSession = useCallback((s: Session | null) => { setCsrf(s?.csrf_token ?? null); setSessionState(s); }, []);
  const [bootStep, setBootStep] = useState(DEMO ? "Starting the browser demo…" : "Loading…");
  useEffect(() => {
    setUnauthorizedHandler(() => { setSession(null); setNotice("Your session ended. Sign in again to continue."); });
    const start = DEMO ? import("./demo/backend").then(m => m.boot(setBootStep)) : Promise.resolve();
    start.then(() => api.session()).then(setSession).catch(() => setSession(null)).finally(() => setLoading(false));
  }, [setSession]);
  if (loading) return (
    <div className="boot" role="status">
      <h1>Smart Retry</h1>
      <p>{bootStep}</p>
      {DEMO && <p className="muted">This demo runs entirely in your browser: the same SQL rules as the app, in SQLite compiled to WebAssembly. Loading the 253,006-request payment history takes a few seconds.</p>}
    </div>
  );
  const Router = DEMO ? HashRouter : BrowserRouter;
  return (
    <AuthCtx.Provider value={{ session, setSession, notice, setNotice }}>
      <Router>
        <div className="unofficial">Product challenge · Unofficial prototype · Not a Belvo product{DEMO && " · Browser demo: runs only in this tab; refreshing resets it"}</div>
        <Routes>
          <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
          <Route path="/" element={<Protected><WorkspacePage /></Protected>} />
          <Route path="/runs/:id" element={<Protected><RunPage /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </AuthCtx.Provider>
  );
}

function Protected({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const loc = useLocation();
  if (!session) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <Shell>{children}</Shell>;
}

function Shell({ children }: { children: ReactNode }) {
  const { session, setSession } = useAuth();
  const nav = useNavigate();
  const signOut = async () => { try { await api.logout(); } catch { /* already gone */ } setSession(null); nav("/login"); };
  return (
    <>
      <header className="top">
        <Link to="/" className="brand">Smart Retry</Link>
        <span className="who">
          <span className="role-chip">{session!.user.role === "operator" ? "Operator" : "Reviewer"}</span>
          <span className="muted">Demo merchant</span>
          <button className="ghost" onClick={signOut}>Sign out</button>
        </span>
      </header>
      <main className="page">{children}</main>
    </>
  );
}

function ErrorBox({ error }: { error: ApiError | { message: string; details?: Record<string, unknown>[] } | null }) {
  if (!error) return null;
  const body = error instanceof ApiError ? error.body : error;
  return (
    <div className="state error" role="alert">
      <strong>{body.message}</strong>
      {body.details && body.details.length > 0 && (
        <ul className="details">{body.details.slice(0, 8).map((d, i) => <li key={i}>{describe(d)}</li>)}</ul>
      )}
    </div>
  );
}

function describe(d: Record<string, unknown>): string {
  if (d.missing_columns) return `Missing columns: ${(d.missing_columns as string[]).join(", ")}`;
  if (d.line) return `Line ${d.line}${d.column ? `, ${d.column}` : ""}: ${d.problem}`;
  if (d.more) return `…and ${d.more} more`;
  if (d.orphan_request_rows) return `${fmtInt(d.orphan_request_rows as number)} history rows for ${fmtInt(d.orphan_loan_ids as number)} loans not in this portfolio`;
  return Object.entries(d).map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
}

// ------------------------------------------------------------------ S1 sign in
function Login() {
  const { setSession, notice, setNotice } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const s = await api.login(username.trim(), password);
      setSession(s); setNotice("");
      nav((loc.state as { from?: string } | null)?.from ?? "/", { replace: true });
    } catch (err) { setError(err as ApiError); setPassword(""); }
    finally { setBusy(false); }
  };
  return (
    <main className="login">
      <h1>Smart Retry</h1>
      <p className="muted">Sign in to prepare or review a collection analysis.</p>
      {notice && <div className="state" role="status">{notice}</div>}
      {DEMO && <div className="state" role="note"><strong>Demo accounts</strong><span>Sign in as <b>operator</b> to prepare an analysis, then as <b>reviewer</b> to approve it. The password for both is <b>demo</b>.</span></div>}
      <form onSubmit={submit}>
        <label htmlFor="username">Username</label>
        <input id="username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        <ErrorBox error={error} />
        <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}

// ------------------------------------------------------------------ S2 workspace
function WorkspacePage() {
  const { session } = useAuth();
  const nav = useNavigate();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [runs, setRuns] = useState<Page<Run> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [policy, setPolicy] = useState<Policy>(DEFAULT_POLICY);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    Promise.all([api.workspace(), api.runs()]).then(([w, r]) => { setWs(w); setRuns(r); }).catch(setError);
  }, []);
  const create = async () => {
    setBusy(true);
    try { const run = await api.createRun(policy); nav(`/runs/${run.run_id}`); }
    catch (e) { setError(e as ApiError); setBusy(false); }
  };
  const isOperator = session?.user.role === "operator";
  return (
    <>
      <div className="row"><h1>Analyses</h1></div>
      <ErrorBox error={error} />
      {ws && <HistoryBanner ws={ws} />}
      {isOperator && ws && (
        <section className="panel">
          <h2>New analysis</h2>
          <p className="muted">Set the retry policy, then upload the loan portfolio on the next screen.</p>
          <PolicyPickers value={policy} onChange={setPolicy} disabled={busy} />
          <div><button className="primary" onClick={create} disabled={busy || !ws.history_available}>New analysis</button></div>
          {!ws.history_available && <p className="muted">History is unavailable, so new analyses are blocked until local setup is fixed.</p>}
        </section>
      )}
      {runs && (
        runs.items.length === 0 ? (
          <p className="muted empty">No analyses yet.{isOperator ? " Start one above." : " The operator hasn't submitted anything."}</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Analyses and revisions</caption>
              <thead><tr><th>Analysis</th><th>Revision</th><th>Wait period</th><th>Status</th><th>Created</th><th><span className="sr-only">Open</span></th></tr></thead>
              <tbody>
                {runs.items.map(r => (
                  <tr key={r.run_id}>
                    <td>{r.sources.portfolio?.file_name ?? <span className="muted">No portfolio yet</span>}</td>
                    <td className="num">r{r.revision_no}</td>
                    <td className="num">{r.configuration.cooldown_days} days</td>
                    <td><StatusChip status={r.status} /></td>
                    <td className="num">{fmtWhen(r.created_at)}</td>
                    <td><Link to={`/runs/${r.run_id}`}>Open<span className="sr-only"> revision {r.revision_no}</span></Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </>
  );
}

function HistoryBanner({ ws }: { ws: Workspace }) {
  const h = ws.history;
  if (!h || !h.available) {
    return (
      <div className="state error" role="alert">
        <strong>Payment history unavailable.</strong> Run local setup to import it. History can't be uploaded from the portal.
      </div>
    );
  }
  return (
    <div className="history">
      <span className="chip">History available</span>
      <span>Payment history · {fmtInt(h.row_count)} requests{h.responses_count ? ` · includes ${fmtInt(h.responses_count)} imported responses` : ""}</span>
      {h.origin === "synthetic_demo" && <span className="chip dash">Synthetic demo</span>}
      <details>
        <summary>Source details</summary>
        <dl className="kv">
          <dt>File</dt><dd>{h.file_name}</dd>
          <dt>SHA-256</dt><dd className="mono">{h.sha256}</dd>
          <dt>Imported</dt><dd>{fmtWhen(h.imported_at)}</dd>
          <dt>Events</dt><dd>{fmtWhen(h.event_range[0])} to {fmtWhen(h.event_range[1])}</dd>
          <dt>Note</dt><dd>Historical extract imported at setup, not a live ledger.</dd>
        </dl>
      </details>
    </div>
  );
}

const DEFAULT_POLICY: Policy = { cooldown_days: 7, fatigue_attempts: 20, holdout_pct: 10 };

function Segmented<T extends string | number | null>({ legend, name, options, value, onChange, disabled }:
  { legend: string; name: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <fieldset className="seg" disabled={disabled}>
      <legend>{legend}</legend>
      {options.map(o => (
        <label key={String(o.value)} className={value === o.value ? "on" : ""}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

function CooldownPicker({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return <Segmented legend="Wait after an insufficient-funds failure" name="cooldown" value={value} onChange={onChange} disabled={disabled}
    options={[3, 7, 14].map(n => ({ value: n, label: `${n} days` }))} />;
}

function PolicyPickers({ value, onChange, disabled }: { value: Policy; onChange: (p: Policy) => void; disabled?: boolean }) {
  return (
    <div className="policy">
      <CooldownPicker value={value.cooldown_days} onChange={n => onChange({ ...value, cooldown_days: n })} disabled={disabled} />
      <Segmented legend="Rest 30 days after this many insufficient-funds failures in a row" name="fatigue" disabled={disabled}
        value={value.fatigue_attempts} onChange={n => onChange({ ...value, fatigue_attempts: n })}
        options={[{ value: null, label: "Off" }, { value: 10, label: "10" }, { value: 20, label: "20" }, { value: 30, label: "30" }]} />
      <Segmented legend="Hold out retry candidates as a control group" name="holdout" disabled={disabled}
        value={value.holdout_pct} onChange={n => onChange({ ...value, holdout_pct: n })}
        options={[0, 10, 20].map(n => ({ value: n, label: n === 0 ? "None" : `${n}%` }))} />
    </div>
  );
}

const policyText = (c: Run["configuration"]) =>
  `${c.cooldown_days}-day wait · ${c.fatigue_attempts ? `rest ${c.rest_days} days after ${c.fatigue_attempts} failures in a row` : "no fatigue rest"} · ${c.holdout_pct ? `${c.holdout_pct}% holdout` : "no holdout"}`;

function StatusChip({ status }: { status: Run["status"] }) {
  const tone = status === "Approved" ? "solid" : ["Returned", "Failed", "Interrupted"].includes(status) ? "dash" : "";
  return <span className={`chip ${tone}`}>{STATUS_LABEL[status]}</span>;
}

// ------------------------------------------------------------------ run page
function RunPage() {
  const { id } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = useCallback(() => api.run(id!).then(r => { setRun(r); return r; }).catch(e => { setError(e); return null; }), [id]);
  useEffect(() => { setRun(null); setError(null); load(); }, [load]);
  useEffect(() => {
    if (!run || !["Validating", "Running"].includes(run.status)) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [run, load]);
  if (error && !run) return <ErrorBox error={error} />;
  if (!run) return <p className="muted">Loading analysis…</p>;
  const preparing = ["Draft", "Validating", "Validated", "Running", "Failed", "Interrupted"].includes(run.status);
  return preparing ? <Prepare run={run} setRun={setRun} /> : <Results run={run} setRun={setRun} />;
}

function RunHeader({ run, children }: { run: Run; children?: ReactNode }) {
  return (
    <div className="row head">
      <div>
        <p className="crumb"><Link to="/">Analyses</Link> / revision {run.revision_no}</p>
        <h1>{run.sources.portfolio?.file_name ?? "New analysis"} · r{run.revision_no}</h1>
      </div>
      <StatusChip status={run.status} />
      <div className="actions">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ S3/S4 prepare and run states
function Prepare({ run, setRun }: { run: Run; setRun: (r: Run) => void }) {
  const { session } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const can = (a: string) => run.permitted_actions.includes(a);
  const act = async (fn: () => Promise<Run>) => {
    setBusy(true); setError(null);
    try { setRun(await fn()); } catch (e) { setError(e as ApiError); } finally { setBusy(false); }
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const uploaded = await api.upload(run, file);
      setRun(uploaded);
      setRun(await api.validate(uploaded));
    } catch (e) { setError(e as ApiError); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const revise = async () => {
    setBusy(true);
    try { const r = await api.revise(run, run.configuration.cooldown_days); nav(`/runs/${r.run_id}`); }
    catch (e) { setError(e as ApiError); setBusy(false); }
  };
  const cov = run.validation?.coverage;
  const working = run.status === "Validating" || run.status === "Running";
  const isMine = can("upload_portfolio") || can("execute") || can("validate") || run.status === "Draft";
  return (
    <>
      <RunHeader run={run} />
      <ErrorBox error={error} />
      {run.status === "Failed" || run.status === "Interrupted" ? (
        <div className="state error" role="alert">
          <strong>{run.status === "Interrupted" ? "Processing was interrupted." : "The analysis failed."}</strong>
          <span>{run.error?.message} Nothing can be submitted from this attempt.</span>
          {can("create_revision") && <div><button className="primary" onClick={revise} disabled={busy}>Run again as a new revision</button></div>}
        </div>
      ) : null}
      {session?.user.role !== "operator" && !["Failed", "Interrupted"].includes(run.status) && (
        <div className="state" role="status">The operator is still preparing this analysis.</div>
      )}
      {session?.user.role === "operator" && isMine && !["Failed", "Interrupted"].includes(run.status) && (
        <section className="prepare">
          <div className="field-block">
            <PolicyPickers value={{ cooldown_days: run.configuration.cooldown_days, fatigue_attempts: run.configuration.fatigue_attempts,
              holdout_pct: run.configuration.holdout_pct }} disabled={!can("update_configuration") || busy}
              onChange={p => act(() => api.setPolicy(run, p))} />
            {!can("update_configuration") && <p className="hint">Set before checking. To change it now, replace the portfolio file.</p>}
          </div>

          <div className="drop">
            {run.sources.portfolio ? (
              <>
                <strong>{run.sources.portfolio.file_name}</strong>
                <span className="muted">{run.sources.portfolio.row_count !== null ? `${fmtInt(run.sources.portfolio.row_count)} rows · ` : ""}{(run.sources.portfolio.size_bytes / 1024).toFixed(1)} KB</span>
              </>
            ) : (
              <><strong>Upload the loan portfolio</strong><span className="muted">CSV with loan_id, payment_method_bank, loan_amount, total_amount_outstanding, overdue_at, overdue_days</span></>
            )}
            {DEMO && !run.sources.portfolio && (
              <button className="primary" disabled={busy || working || !can("upload_portfolio")} onClick={async () => {
                const { DATA_URLS } = await import("./demo/backend");
                const text = await (await fetch(DATA_URLS.portfolio)).text();
                onFile(new File([text], "PaymentsPM_Challenge_loan_info.csv", { type: "text/csv" }));
              }}>Use the challenge portfolio</button>
            )}
            <label className="button-like">
              {run.sources.portfolio ? "Replace file" : "Choose CSV file"}
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" disabled={busy || working || !can("upload_portfolio")}
                onChange={e => onFile(e.target.files?.[0])} />
            </label>
          </div>

          {run.status === "Validating" && <div className="state" role="status"><strong>Checking portfolio…</strong> Matching it against payment history.</div>}
          {run.status === "Draft" && run.error && (
            <div className="state error" role="alert">
              <strong>{run.error.message}</strong>
              <ul className="details">{run.error.details.slice(0, 8).map((d, i) => <li key={i}>{describe(d)}</li>)}</ul>
              <span className="muted">Fix the file and upload it again.</span>
            </div>
          )}
          {run.status === "Draft" && !run.error && run.sources.portfolio && can("validate") && (
            <button onClick={() => act(() => api.validate(run))} disabled={busy}>Check portfolio</button>
          )}

          {cov && (run.status === "Validated" || run.status === "Running") && (
            <div className="panel">
              <div className="row"><span className="chip solid">Valid</span><strong>Portfolio checked</strong></div>
              <dl className="kv">
                <dt>Loans</dt><dd>{fmtInt(cov.loans)} unique IDs</dd>
                <dt>Outstanding</dt><dd>MXN {fmtCents(cov.outstanding_cents)}</dd>
                <dt>With history</dt><dd>{fmtInt(cov.loans_with_history)} · {fmtInt(cov.loans_without_history)} without history (they go to Needs attention)</dd>
                <dt>History</dt><dd>{fmtInt(cov.requests)} requests in {fmtInt(cov.collection_batches)} attempts · no unmatched loans</dd>
                <dt>Evaluated at</dt><dd>{run.configuration.evaluated_at} ({run.configuration.business_timezone}), fixed</dd>
                <dt>Policy</dt><dd>{policyText(run.configuration)}</dd>
              </dl>
              {run.validation!.warnings.length > 0 && <p className="hint">Warnings: {run.validation!.warnings.map(describe).join("; ")}</p>}
              <details>
                <summary>File identity</summary>
                <dl className="kv">
                  <dt>Portfolio SHA-256</dt><dd className="mono">{run.sources.portfolio?.sha256}</dd>
                  <dt>History SHA-256</dt><dd className="mono">{run.sources.history?.sha256}</dd>
                  <dt>Rule version</dt><dd>{run.configuration.rule_version}</dd>
                </dl>
              </details>
            </div>
          )}
          {run.status === "Running" && <div className="state" role="status"><strong>Generating results…</strong> Classifying {cov ? fmtInt(cov.loans) : ""} loans with a {run.configuration.cooldown_days}-day wait. Results appear only when every loan is classified.</div>}
          <div className="row">
            <Link to="/" className="button-like ghost">Back</Link>
            {run.status === "Validated" && (
              <button className="primary push" onClick={() => act(() => api.execute(run))} disabled={busy || !can("execute")}>Generate results</button>
            )}
          </div>
          {run.status === "Validated" && !can("execute") && <p className="hint">Another check or analysis is running. Wait for it to finish.</p>}
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ S5 results + S7 review + S8 output
const QUEUES: Decision[] = ["RETRY", "WAIT", "REVIEW_REMEDIATE"];

function Results({ run, setRun }: { run: Run; setRun: (r: Run) => void }) {
  const { session } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const queue = (QUEUES.includes(params.get("queue") as Decision) ? params.get("queue") : "RETRY") as Decision;
  const reason = params.get("reason") ?? "";
  const loanFilter = params.get("q") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? 1));
  const openLoan = params.get("loan");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<Page<DecisionRow> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseCooldown, setReviseCooldown] = useState(run.configuration.cooldown_days);
  const [search, setSearch] = useState(loanFilter);

  useEffect(() => { api.summary(run.run_id).then(setSummary).catch(setError); }, [run.run_id]);
  useEffect(() => {
    setRows(null);
    api.decisions(run.run_id, { decision: queue, reason: queue === "REVIEW_REMEDIATE" ? reason || undefined : undefined, loan_id: loanFilter || undefined, page })
      .then(setRows).catch(setError);
  }, [run.run_id, queue, reason, loanFilter, page]);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v === null || v === "" ? next.delete(k) : next.set(k, v)));
    setParams(next);
  };
  const can = (a: string) => run.permitted_actions.includes(a);
  const act = async (fn: () => Promise<Run>) => {
    setBusy(true); setError(null);
    try { setRun(await fn()); setReturnOpen(false); setComment(""); }
    catch (e) { setError(e as ApiError); if ((e as ApiError).status === 412) setRun(await api.run(run.run_id)); }
    finally { setBusy(false); }
  };
  const revise = async () => {
    setBusy(true);
    try { const r = await api.revise(run, reviseCooldown); nav(`/runs/${r.run_id}`); }
    catch (e) { setError(e as ApiError); setBusy(false); }
  };
  const t = run.totals!;
  const pages = rows ? Math.max(1, Math.ceil(rows.total / rows.page_size)) : 1;
  const reviewReasons = summary ? Object.keys(summary.reasons).filter(r => !["COOLDOWN", "SOFT_FAILURE_WINDOW_ELAPSED"].includes(r)) : [];

  return (
    <div className={openLoan ? "with-panel" : ""}>
      <div className="results-main">
        <RunHeader run={run}>
          {can("submit") && <button className="primary" onClick={() => act(() => api.submit(run))} disabled={busy}>Submit for review</button>}
          {can("review") && <button className="primary" onClick={() => act(() => api.review(run, "approve"))} disabled={busy}>Approve and release payments</button>}
          {can("download_results") && <button className="primary" onClick={() => api.download(api.csvUrl(run.run_id), "Belvo_Smart_Retry_Results.csv").catch(setError)}>Download approved CSV</button>}
          {can("withdraw") && <button onClick={() => act(() => api.withdraw(run))} disabled={busy}>Withdraw</button>}
          {can("create_revision") && <button className="ghost" onClick={() => setReviseOpen(o => !o)} aria-expanded={reviseOpen}>New revision</button>}
        </RunHeader>
        <ErrorBox error={error} />

        <SyntheticNote run={run} />
        <ScopeNote run={run} role={session!.user.role} />

        {reviseOpen && (
          <div className="panel">
            <p>A new revision copies this portfolio and history. You'll check and generate it again{run.status === "Ready" ? "; this revision will be marked Replaced" : ""}.</p>
            <div className="row">
              <CooldownPicker value={reviseCooldown} onChange={setReviseCooldown} disabled={busy} />
              <button className="primary" onClick={revise} disabled={busy}>Create revision</button>
            </div>
          </div>
        )}

        {run.status === "Approved" && <ApprovedSummary run={run} summary={summary} />}
        {run.payment_requests && <PaymentRequests run={run} setRun={setRun} />}
        {run.configuration.holdout_pct > 0 && run.payment_requests && <ExperimentPanel run={run} />}
        {run.status === "Approved" && !run.payment_requests && (
          <div className="state" role="status">This analysis was approved before payment release existed, so it has no payment requests. Create a new revision to get them.</div>
        )}

        {can("review") && (
          <div className="panel">
            <button className="ghost disclosure" aria-expanded={returnOpen} onClick={() => setReturnOpen(o => !o)}>Request changes</button>
            {returnOpen && (
              <form onSubmit={e => { e.preventDefault(); act(() => api.review(run, "return", comment)); }}>
                <label htmlFor="comment">What should the operator change? Required.</label>
                <textarea id="comment" value={comment} onChange={e => setComment(e.target.value)} maxLength={2000} />
                <button disabled={busy || !comment.trim()}>Send back with comment</button>
              </form>
            )}
          </div>
        )}

        <div className="metrics" aria-label="Full-run totals">
          <span><b>{fmtInt(t.loans)}</b>loans classified</span>
          <span><b>{fmtInt(t.RETRY)}</b>retry candidates</span>
          <span><b>{fmtInt(t.WAIT)}</b>waiting</span>
          <span><b>{fmtInt(t.REVIEW_REMEDIATE)}</b>need attention</span>
          <span><b>{run.configuration.cooldown_days} days</b>wait period</span>
        </div>
        <p className="hint">Policy: {policyText(run.configuration)}. {queue === "RETRY" ? "Loans that have paid before come first." : ""}</p>

        <div role="tablist" aria-label="Decision queues" className="tabs">
          {QUEUES.map(q => (
            <button key={q} role="tab" aria-selected={queue === q} className={queue === q ? "on" : ""}
              onClick={() => update({ queue: q, page: null, reason: null, loan: null })}>
              {QUEUE_LABEL[q]} <em>{fmtInt(t[q])}</em>
            </button>
          ))}
        </div>

        <div className="row filters">
          <form role="search" onSubmit={e => { e.preventDefault(); update({ q: search.trim(), page: null }); }}>
            <label htmlFor="loan-search" className="sr-only">Find loan ID</label>
            <input id="loan-search" placeholder="Find loan ID" value={search} onChange={e => setSearch(e.target.value)} />
            <button>Find</button>
            {loanFilter && <button type="button" className="ghost" onClick={() => { setSearch(""); update({ q: null, page: null }); }}>Clear</button>}
          </form>
          {queue === "REVIEW_REMEDIATE" && (
            <>
              <label htmlFor="reason" className="sr-only">Filter by reason</label>
              <select id="reason" value={reason} onChange={e => update({ reason: e.target.value, page: null })}>
                <option value="">All reasons</option>
                {reviewReasons.map(r => <option key={r} value={r}>{REASON_LABEL[r] ?? r} ({fmtInt(summary!.reasons[r])})</option>)}
              </select>
            </>
          )}
          <span className="pager push" aria-live="polite">
            {rows ? (rows.total === 0 ? "No loans match" : `Showing ${fmtInt((rows.page - 1) * rows.page_size + 1)}–${fmtInt(Math.min(rows.total, rows.page * rows.page_size))} of ${fmtInt(rows.total)}`) : "Loading…"}
            {queue === "WAIT" && " · soonest check first"}
          </span>
        </div>

        <div className="table-wrap">
          <table className="queue">
            <caption className="sr-only">{QUEUE_LABEL[queue]}</caption>
            <thead><tr><th>Loan</th><th className="col-bank">Bank</th><th className="num">Outstanding (MXN)</th><th>Why</th><th>Next check</th>
              {queue !== "REVIEW_REMEDIATE" && <><th>Last paid</th><th className="num">Failed in a row</th></>}
              <th><span className="sr-only">Details</span></th></tr></thead>
            <tbody>
              {rows?.items.map(r => (
                <tr key={r.loan_id} className={openLoan === r.loan_id ? "selected" : ""}>
                  <td className="mono loan">{r.loan_id}</td>
                  <td className="col-bank">{r.payment_method_bank}</td>
                  <td className="num">{fmtMoney(r.total_amount_outstanding)}</td>
                  <td>{why(r)}{r.experiment_arm === "control" && <> <span className="chip dash">Holdout</span></>}</td>
                  <td className="num">{r.next_check_date ?? "—"}</td>
                  {queue !== "REVIEW_REMEDIATE" && <><td className="num">{r.last_success_at ? r.last_success_at.slice(0, 10) : "Never"}</td>
                    <td className="num">{r.consecutive_soft_failures}</td></>}
                  <td><button className="link" onClick={() => update({ loan: r.loan_id })}>View details<span className="sr-only"> for {r.loan_id}</span></button></td>
                </tr>
              ))}
              {rows && rows.items.length === 0 && <tr><td colSpan={8} className="muted">{rows.total === 0 && !loanFilter && !reason ? "This queue is empty for this analysis. That's a valid result." : "No loans match this filter."}</td></tr>}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <nav className="row pagination" aria-label="Pages">
            <button disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>Previous</button>
            <span>Page {page} of {pages}</span>
            <button disabled={page >= pages} onClick={() => update({ page: String(page + 1) })}>Next</button>
          </nav>
        )}
      </div>
      {openLoan && <LoanPanel runId={run.run_id} loanId={openLoan} onClose={() => update({ loan: null })} />}
    </div>
  );
}

function SyntheticNote({ run }: { run: Run }) {
  const h = run.sources.history;
  if (!h || h.origin === "original") return null;
  return h.origin === "synthetic_demo"
    ? <div className="state dash" role="note"><strong>Synthetic bank responses.</strong> This analysis uses {fmtInt(h.responses_count)} generated responses for demonstration. Results are illustrative, not evidence of recovery.</div>
    : <div className="state" role="note">This analysis includes {fmtInt(h.responses_count)} imported bank responses.</div>;
}

function ScopeNote({ run, role }: { run: Run; role: string }) {
  if (run.status === "Ready")
    return <p className="scope">Submitting sends all {fmtInt(run.totals!.loans)} loans in this revision, not only the queue you're viewing{run.payment_requests ? `, plus the ${fmtInt(run.payment_requests.requests)} draft payment requests below` : ""}. Approval releases those requests; Smart Retry doesn't send them.</p>;
  if (run.status === "Submitted")
    return <p className="scope">{role === "reviewer"
      ? `Submitted by ${run.created_by} on ${fmtWhen(run.submitted_at)}. Approving accepts the analysis for all ${fmtInt(run.totals!.loans)} loans in revision ${run.revision_no} and releases ${run.payment_requests ? `${fmtInt(run.payment_requests.requests)} payment requests for MXN ${fmtMoney(run.payment_requests.total_amount)}` : "its payment requests"}. Smart Retry doesn't send them.`
      : `Waiting for the reviewer since ${fmtWhen(run.submitted_at)}. Withdraw it if you need to change something.`}</p>;
  if (run.status === "Returned")
    return <div className="state dash" role="status"><strong>Changes requested by {run.review?.reviewed_by}</strong><q>{run.review?.comment}</q><span className="muted">Create a new revision to address it. This revision stays as history.</span></div>;
  if (run.status === "Superseded")
    return <div className="state" role="status">This revision was replaced by a newer one. It stays as read-only history.</div>;
  return null;
}

function ApprovedSummary({ run, summary }: { run: Run; summary: Summary | null }) {
  return (
    <section className="panel" aria-label="Approved output">
      <h2>Approved results</h2>
      <dl className="kv">
        <dt>Approved by</dt><dd>{run.review?.reviewed_by} · {fmtWhen(run.review?.reviewed_at ?? null)}</dd>
        <dt>Revision</dt><dd className="mono">{run.revision_id} (r{run.revision_no})</dd>
        <dt>Configuration</dt><dd>{run.configuration.cooldown_days}-day wait · evaluated {run.configuration.evaluated_at} · {run.configuration.rule_version}</dd>
        <dt>Sources</dt><dd className="mono">portfolio {short(run.sources.portfolio!.sha256)} · history {short(run.sources.history!.sha256)}</dd>
        <dt>Rows</dt><dd>{fmtInt(run.totals!.loans)} · {fmtInt(run.totals!.RETRY)} retry · {fmtInt(run.totals!.WAIT)} waiting · {fmtInt(run.totals!.REVIEW_REMEDIATE)} need attention</dd>
        {summary && <><dt>Spec</dt><dd className="mono">master {short(run.master_sha256)}</dd></>}
      </dl>
      <div className="state"><strong>Approval covers the analysis, not every loan.</strong> {run.payment_requests
          ? <>Only {fmtInt(run.payment_requests.loans)} retry candidates have released payment requests (payment_request_status RELEASED in the CSV){run.payment_requests.holdout_loans > 0 ? <>; {fmtInt(run.payment_requests.holdout_loans)} more are held out as a control group (HOLDOUT)</> : null}. </>
          : <>This analysis has no payment requests. </>}
        The other {fmtInt(run.totals!.WAIT + run.totals!.REVIEW_REMEDIATE)} loans are NONE: they wait or need attention. The results CSV has no amounts and isn't a payment instruction; live checks on authorization, account, debt and client policy are still pending.</div>
    </section>
  );
}

// ------------------------------------------------------------------ S9 payment requests and responses (D34)
function PaymentRequests({ run, setRun }: { run: Run; setRun: (r: Run) => void }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [origin, setOrigin] = useState<"bank" | "synthetic_demo" | "">("");
  const fileRef = useRef<HTMLInputElement>(null);
  const p = run.payment_requests!;
  const can = (a: string) => run.permitted_actions.includes(a);
  const importFile = async (e: FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file || !origin) return;
    setBusy(true); setError(null);
    try { await api.importResponses(run, file, origin); setRun(await api.run(run.run_id)); }
    catch (err) { setError(err as ApiError); } finally { setBusy(false); }
  };
  const followUp = async () => {
    setBusy(true); setError(null);
    try { const r = await api.revise(run, run.configuration.cooldown_days, true); nav(`/runs/${r.run_id}`); }
    catch (e) { setError(e as ApiError); setBusy(false); }
  };
  const label = p.status === "Draft" ? (run.status === "Returned" || run.status === "Superseded" ? "Draft, never released" : "Draft · released on approval")
    : p.status === "Released" ? "Released, not sent" : "Responses imported";
  return (
    <section className="panel" aria-labelledby="payments-title">
      <div className="row"><h2 id="payments-title">Payment requests</h2>
        <span className={`chip ${p.status === "Draft" ? "dash" : "solid"}`}>{label}</span></div>
      <ErrorBox error={error} />
      {p.requests === 0 ? <p className="muted">No retry candidates, so there are no payment requests.</p> : (
        <dl className="kv">
          <dt>Requests</dt><dd>{fmtInt(p.requests)} for {fmtInt(p.loans)} retry candidates · 5%, 25% and 70% of each balance</dd>
          {p.holdout_loans > 0 && <><dt>Holdout</dt><dd>{fmtInt(p.holdout_loans)} retry candidates kept as a control group get no requests</dd></>}
          <dt>Total</dt><dd>MXN {fmtMoney(p.total_amount)} <span className="muted">(5%: {fmtMoney(p.total_by_tranche["5%"] ?? "0.00")} · 25%: {fmtMoney(p.total_by_tranche["25%"] ?? "0.00")} · 70%: {fmtMoney(p.total_by_tranche["70%"] ?? "0.00")})</span></dd>
          <dt>Request time</dt><dd>{fmtWhen(p.requested_at)}</dd>
          {p.released_by && <><dt>Released by</dt><dd>{p.released_by} · {fmtWhen(p.released_at)}</dd></>}
        </dl>
      )}
      {p.status === "Draft" && p.requests > 0 && (
        <p className="hint">The split copies the most common historical practice; it isn't a validated policy. Open any retry candidate to see its three requests. Authorization, account, current debt and client policy are still unchecked.</p>
      )}
      {can("download_payment_requests") && p.requests > 0 && (
        <div className="row"><button className="primary" onClick={() => api.download(api.paymentsCsvUrl(run.run_id), `Belvo_Smart_Retry_Payment_Requests_${run.run_id.slice(0, 8)}.csv`).catch(setError)}>Download payment requests CSV</button>
          <span className="hint">Same nine columns as the payment history. Status is pending; the bank fills the rest.</span></div>
      )}
      {p.status === "Released" && can("import_responses") && p.requests > 0 && (
        <form className="state" onSubmit={importFile} aria-label="Import bank responses">
          <strong>Import responses</strong>
          <span className="muted">Upload one file that answers every request, in the same nine columns.</span>
          <label htmlFor="responses-file">Response file</label>
          <input id="responses-file" ref={fileRef} type="file" accept=".csv,text/csv" required />
          <label htmlFor="responses-origin">Where do these responses come from?</label>
          <select id="responses-origin" value={origin} onChange={e => setOrigin(e.target.value as typeof origin)} required>
            <option value="">Choose…</option>
            <option value="bank">Bank responses</option>
            <option value="synthetic_demo">Synthetic demo data</option>
          </select>
          <div className="row"><button className="primary" disabled={busy || !origin}>Import responses</button>
            {DEMO && <button type="button" disabled={busy} onClick={async () => {
              setBusy(true); setError(null);
              try {
                const csv = await api.simulateResponses(run);
                await api.importResponses(run, new File([csv], "SYNTHETIC_responses.csv", { type: "text/csv" }), "synthetic_demo");
                setRun(await api.run(run.run_id));
              } catch (err) { setError(err as ApiError); } finally { setBusy(false); }
            }}>Demo only: import synthetic responses</button>}
          </div>
          {DEMO && <span className="hint">In the app, synthetic responses come from a script outside the portal. This demo button uses the same method (one historical outcome per loan) and labels everything that follows as synthetic.</span>}
        </form>
      )}
      {p.responses && (
        <>
          <dl className="kv">
            <dt>Origin</dt><dd><span className={`chip ${p.responses.origin === "synthetic_demo" ? "dash" : ""}`}>{p.responses.origin === "synthetic_demo" ? "Synthetic demo" : "Bank"}</span></dd>
            <dt>Outcomes</dt><dd>{Object.entries(p.responses.outcomes.by_status).map(([k, v]) => `${fmtInt(v)} ${k}`).join(" · ")} <span className="muted">({fmtInt(p.responses.outcomes.loans)} loans)</span></dd>
            <dt>Imported</dt><dd>{p.responses.imported_by} · {fmtWhen(p.responses.imported_at)}</dd>
          </dl>
          <p className="muted">The responses are now part of the payment history. A follow-up analysis uses that history and is evaluated at the end of the latest response day. Successful payments don't reduce the portfolio balance; those loans will ask for reconciliation.</p>
          {can("create_revision") && <div><button className="primary" onClick={followUp} disabled={busy}>Start follow-up analysis</button></div>}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ S10 holdout experiment (D39)
function ExperimentPanel({ run }: { run: Run }) {
  const [e, setE] = useState<Experiment | null>(null);
  useEffect(() => { api.experiment(run.run_id).then(setE).catch(() => setE(null)); }, [run.run_id, run.version]);
  if (!e) return null;
  const s = e.next_snapshot;
  return (
    <section className="panel" aria-labelledby="experiment-title">
      <div className="row"><h2 id="experiment-title">Holdout experiment</h2>{e.synthetic && <span className="chip dash">Synthetic demo</span>}</div>
      <p className="muted">{e.holdout_pct}% of retry candidates were picked at random (reproducibly) and get no payment requests. Comparing them with the rest shows what retrying adds over not retrying.</p>
      <div className="table-wrap">
        <table className="compact">
          <caption className="sr-only">Treatment and control</caption>
          <thead><tr><th>Group</th><th className="num">Loans</th><th className="num">Outstanding (MXN)</th>
            {e.responses && <th className="num">Paid / collected</th>}
            {s && <><th className="num">Lower balance</th><th className="num">Recovered</th><th className="num">Per loan</th></>}</tr></thead>
          <tbody>
            {(["treatment", "control"] as const).map(arm => (
              <tr key={arm}>
                <td>{arm === "treatment" ? "Retried" : "Held out"}</td>
                <td className="num">{fmtInt(e.arms[arm].loans)}</td>
                <td className="num">{fmtMoney(e.arms[arm].outstanding)}</td>
                {e.responses && <td className="num">{arm === "treatment" ? `${fmtInt(e.responses.treatment_loans_paid)} / ${fmtMoney(e.responses.treatment_collected)}` : "No attempts"}</td>}
                {s && <><td className="num">{fmtInt(s.arms[arm]?.loans_with_lower_balance ?? 0)}</td><td className="num">{fmtMoney(s.arms[arm]?.recovered ?? "0.00")}</td>
                  <td className="num">{fmtMoney(s.arms[arm]?.recovered_per_loan ?? "0.00")}</td></>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s ? (
        <p><strong>Incremental recovery: MXN {fmtMoney(s.incremental_recovered_per_loan)} per retried loan</strong> <span className="muted">(snapshot from revision {s.revision_no}).</span>{" "}
          {e.small_sample && <span className="muted">The control group has fewer than 100 loans, so treat this as directional, not significant.</span>}</p>
      ) : (
        <p className="hint">To measure, upload the next portfolio snapshot in a follow-up revision. Without it, held-out loans have no observable outcome.</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ S6 loan detail panel
function LoanPanel({ runId, loanId, onClose }: { runId: string; loanId: string; onClose: () => void }) {
  const [d, setD] = useState<LoanDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { setD(null); setError(null); api.loan(runId, loanId).then(setD).catch(setError); }, [runId, loanId]);
  useEffect(() => { ref.current?.focus(); }, [loanId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <aside className="side-panel" aria-label={`Loan ${loanId}`} tabIndex={-1} ref={ref}>
      <div className="row"><h2>Loan {loanId}</h2>{d && <span className={`chip ${d.decision === "RETRY" ? "solid" : d.decision === "WAIT" ? "dash" : ""}`}>{DECISION_CHIP[d.decision]}</span>}
        <button className="ghost push" onClick={onClose}>Close</button></div>
      <ErrorBox error={error} />
      {!d && !error && <p className="muted">Loading…</p>}
      {d && (
        <>
          <div className="todo">
            <strong>What to do</strong>
            <p>{WHAT_TO_DO[d.next_action_code]}</p>
            {d.decision === "REVIEW_REMEDIATE" && <p>{INVESTIGATE[d.reason_code]}</p>}
            {d.decision === "WAIT" && <p>Next check: <b>{d.next_check_date}</b> (a reassessment date, not a debit date).</p>}
          </div>
          <dl className="kv">
            <dt>Outstanding</dt><dd>MXN {fmtMoney(d.total_amount_outstanding)} <span className="muted">(portfolio snapshot, not reduced by past payments)</span></dd>
            <dt>Bank</dt><dd>{d.payment_method_bank}</dd>
            <dt>Last paid</dt><dd>{d.last_success_at ? fmtWhen(d.last_success_at) : "Never in the available history"}</dd>
            <dt>Failed in a row</dt><dd>{d.consecutive_soft_failures} insufficient-funds attempt{d.consecutive_soft_failures === 1 ? "" : "s"}</dd>
            {d.experiment_arm === "control" && <><dt>Experiment</dt><dd>Held out as control: no payment requests for this loan.</dd></>}
            <dt>Overdue</dt><dd>{d.loan.overdue_days ?? "—"} days{d.loan.overdue_at ? ` (since ${d.loan.overdue_at})` : ""}</dd>
            <dt>Recommended amount</dt><dd>None in the analysis. {d.decision === "RETRY" ? "The payment requests below use the fixed 5/25/70 split." : "Only retry candidates get payment requests."}</dd>
          </dl>
          {d.payment_requests.length > 0 && (
            <div className="table-wrap">
              <table className="compact">
                <caption>Payment requests for this loan ({d.payment_requests[0].status === "Draft" ? "draft, released on approval" : d.payment_requests[0].status.toLowerCase()})</caption>
                <thead><tr><th>Tranche</th><th className="num">Amount (MXN)</th><th>Request</th></tr></thead>
                <tbody>{d.payment_requests.map(r => (
                  <tr key={r.payment_request_id}><td>{r.tranche_pct}%</td><td className="num">{fmtMoney(r.amount)}</td><td className="mono">{short(r.payment_request_id)}</td></tr>))}</tbody>
              </table>
            </div>
          )}
          <details open>
            <summary>Payment evidence</summary>
            <dl className="kv">
              <dt>Latest attempt</dt><dd>{d.last_batch_created_at ? `${fmtWhen(d.last_batch_created_at)} · ${d.last_batch_rows} request${d.last_batch_rows === 1 ? "" : "s"}` : "No requests in history"}</dd>
              <dt>Rule matched</dt><dd>{RULES[d.rule_priority]} <span className="mono muted">{d.reason_code}</span></dd>
              {d.cooldown_anchor_date && <><dt>Clock</dt><dd>Latest attempt finished {d.cooldown_anchor_date} ({d.clock.business_timezone}) → {d.days_since_anchor} days to {d.clock.evaluated_at.slice(0, 10)}, wait is {d.clock.cooldown_days}</dd></>}
              {d.next_check_date && <><dt>Next check</dt><dd>{d.next_check_date}</dd></>}
              <dt>Action code</dt><dd className="mono">{d.next_action_code}</dd>
            </dl>
            {d.latest_batch.length > 0 && (
              <div className="table-wrap">
                <table className="compact">
                  <caption>All requests in the latest attempt</caption>
                  <thead><tr><th>Request</th><th>Status</th><th className="num">Amount</th><th>Code</th><th>Message</th><th>Completed</th></tr></thead>
                  <tbody>{d.latest_batch.map(m => (
                    <tr key={m.payment_request_id}>
                      <td className="mono">{short(m.payment_request_id)}</td><td>{m.status}</td><td className="num">{fmtMoney(m.amount)}</td>
                      <td>{m.failed_reason ?? "—"}</td><td>{m.failed_message ? <q lang="es">{m.failed_message}</q> : "—"}</td>
                      <td className="num">{fmtWhen(m.completed_at)}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
          </details>
          <details>
            <summary>Earlier attempts ({fmtInt(d.history.requests)} requests in {fmtInt(d.history.batches)} attempts)</summary>
            {d.history.earlier_requests.length === 0 ? <p className="muted">None before the latest attempt.</p> : (
              <div className="table-wrap">
                <table className="compact">
                  <caption>10 most recent earlier requests</caption>
                  <thead><tr><th>Created</th><th>Status</th><th className="num">Amount</th><th>Code</th><th>Message</th></tr></thead>
                  <tbody>{d.history.earlier_requests.map((m, i) => (
                    <tr key={i}><td className="num">{fmtWhen(m.created_at)}</td><td>{m.status}</td><td className="num">{fmtMoney(m.amount)}</td>
                      <td>{m.failed_reason ?? "—"}</td><td>{m.failed_message ? <q lang="es">{m.failed_message}</q> : "—"}</td></tr>))}</tbody>
                </table>
              </div>
            )}
          </details>
        </>
      )}
    </aside>
  );
}

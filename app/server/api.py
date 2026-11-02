"""HTTP API under /api/v1 (master section 13) and the one-origin portal."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import sqlite3
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import db, engine, ingest, payments, security
from .config import (REST_DAYS, ALLOWED_COOLDOWNS, APP_VERSION, BUSINESS_TZ_NAME, EVALUATED_AT_TEXT, MAX_SOURCE_BYTES,
                     PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, PRODUCTION_CHECKS, RULE_VERSION, WEB_DIST, WORKSPACE,
                     WORKSPACE_LABEL, Settings, day_text, iso_utc, master_sha256, now_text)

log = logging.getLogger("smart_retry.api")
COMPLETED = ("Ready", "Submitted", "Returned", "Approved", "Superseded")
REVISABLE = ("Ready", "Returned", "Failed", "Interrupted", "Approved")


# ---------------------------------------------------------------- errors
class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: list | None = None, headers: dict | None = None):
        self.status, self.code, self.message, self.details, self.headers = status, code, message, details or [], headers


def error_body(request: Request, code: str, message: str, details: list) -> dict:
    return {"error": {"code": code, "message": message, "details": details,
                      "request_id": getattr(request.state, "request_id", None)}}


# ---------------------------------------------------------------- models
class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginBody(Strict):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class CooldownBody(Strict):
    cooldown_days: Literal[3, 7, 14]
    fatigue_attempts: Literal[10, 20, 30] | None = None
    holdout_pct: Literal[0, 10, 20] = 0


class RevisionBody(CooldownBody):
    use_latest_history: bool = False


class ReviewBody(Strict):
    action: Literal["approve", "return"]
    comment: str | None = Field(default=None, max_length=2000)


# ---------------------------------------------------------------- helpers
def money(cents: int | None) -> str | None:
    if cents is None:
        return None
    sign = "-" if cents < 0 else ""
    cents = abs(cents)
    return f"{sign}{cents // 100}.{cents % 100:02d}"


def username_of(conn, user_id):
    if not user_id:
        return None
    row = conn.execute("SELECT username FROM users WHERE id=?", (user_id,)).fetchone()
    return row[0] if row else None


def history_info(conn, file_id):
    if not file_id:
        return None
    f = conn.execute("SELECT * FROM source_files WHERE id=?", (file_id,)).fetchone()
    if not f:
        return None
    return {"dataset_id": f["id"], "file_name": f["original_name"], "sha256": f["sha256"], "row_count": f["row_count"],
            "imported_at": f["imported_at"], "event_range": [iso_utc(f["event_min_us"]), iso_utc(f["event_max_us"])],
            "workspace": f["workspace"], "available": f["status"] == "staged",
            "origin": f["origin"], "responses_count": f["responses_count"], "parent_dataset_id": f["parent_file_id"]}


def current_history(conn):
    row = conn.execute("""SELECT id FROM source_files WHERE kind='requests_history' AND workspace=? AND status='staged'
                          ORDER BY rowid DESC LIMIT 1""", (WORKSPACE,)).fetchone()
    return row[0] if row else None


def permitted(run, user: security.User, job_active: bool) -> list[str]:
    s, creator = run["status"], run["created_by"] == user.id
    acts = []
    if user.role == "operator" and creator:
        if s == "Draft":
            acts += ["update_configuration", "upload_portfolio"]
            if run["loans_file_id"] and run["history_file_id"] and not job_active:
                acts.append("validate")
        if s == "Validated":
            acts.append("upload_portfolio")
            if not job_active:
                acts.append("execute")
        if s == "Ready":
            acts.append("submit")
        if s == "Submitted":
            acts.append("withdraw")
    if user.role == "operator" and s in REVISABLE:
        acts.append("create_revision")
    if user.role == "reviewer" and s == "Submitted" and not creator:
        acts.append("review")
    if s == "Approved":
        acts.append("download_results")
    return acts


def run_json(conn, run, user: security.User, jobs: engine.JobRunner) -> dict:
    loans = conn.execute("SELECT * FROM source_files WHERE id=?", (run["loans_file_id"],)).fetchone() if run["loans_file_id"] else None
    summary = json.loads(run["summary_json"]) if run["summary_json"] and run["status"] in COMPLETED else None
    pset = conn.execute("SELECT * FROM payment_request_sets WHERE run_id=?", (run["id"],)).fetchone()
    actions = permitted(run, user, jobs.active is not None)
    if pset is not None and pset["status"] == "Released" and user.role == "operator":
        actions.append("import_responses")
    if pset is not None and pset["status"] in ("Released", "Responded"):
        actions.append("download_payment_requests")
    return {
        "run_id": run["id"], "revision_id": run["id"], "analysis_id": run["analysis_id"],
        "revision_no": run["revision_no"], "parent_run_id": run["parent_run_id"], "version": run["version"],
        "status": run["status"],
        "configuration": config_json(run),
        "master_sha256": run["master_sha256"],
        "created_by": username_of(conn, run["created_by"]), "created_at": run["created_at"],
        "sources": {
            "portfolio": None if not loans else {"file_name": loans["original_name"], "sha256": loans["sha256"],
                                                 "size_bytes": loans["size_bytes"], "row_count": loans["row_count"]},
            "history": history_info(conn, run["history_file_id"]),
        },
        "validation": json.loads(run["validation_json"]) if run["validation_json"] else None,
        "error": json.loads(run["error_json"]) if run["error_json"] else None,
        "totals": summary["totals"] if summary else None,
        "submitted_at": run["submitted_at"],
        "review": {"reviewed_by": username_of(conn, run["reviewed_by"]), "reviewed_at": run["reviewed_at"],
                   "comment": run["review_comment"]} if run["reviewed_at"] else None,
        "job_active": jobs.active == run["id"],
        "permitted_actions": actions,
        "payment_requests": payments.summary(conn, pset) if pset else None,
        "is_executable": False,
    }


def config_json(run) -> dict:
    return {"cooldown_days": run["cooldown_days"], "evaluated_at": run["evaluated_at"],
            "business_timezone": run["business_timezone"], "rule_version": run["rule_version"],
            "fatigue_attempts": run["fatigue_attempts"], "rest_days": REST_DAYS if run["fatigue_attempts"] else None,
            "holdout_pct": run["holdout_pct"]}


def decision_json(r) -> dict:
    return {"loan_id": r["loan_id"], "decision": r["decision"], "reason_code": r["reason_code"],
            "next_action_code": r["next_action_code"], "payment_method_bank": r["payment_method_bank"],
            "overdue_days": r["overdue_days"], "total_amount_outstanding": money(r["total_amount_outstanding_cents"]),
            "recommended_amount": None, "last_batch_created_at": iso_utc(r["last_batch_created_us"]),
            "last_batch_rows": r["last_batch_rows"], "last_batch_statuses": json.loads(r["last_batch_statuses"]),
            "last_batch_reasons": json.loads(r["last_batch_reasons"]),
            "cooldown_anchor_date": day_text(r["cooldown_anchor_day"]), "days_since_anchor": r["days_since_anchor"],
            "next_check_date": day_text(r["next_check_day"]), "rule_priority": r["rule_priority"],
            "consecutive_soft_failures": r["consecutive_soft_failures"], "last_success_at": iso_utc(r["last_success_us"]),
            "experiment_arm": r["arm"] if "arm" in r.keys() else None}


# ---------------------------------------------------------------- app factory
def create_app(settings: Settings | None = None, extra_hosts: tuple[str, ...] = ()) -> FastAPI:
    settings = settings or Settings()
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    boot = db.connect(settings.db_path)
    db.migrate(boot)
    engine.recover_unfinished(boot)
    boot.close()
    jobs = engine.JobRunner(settings)

    app = FastAPI(title="Smart Retry (unofficial product challenge)", version=APP_VERSION,
                  docs_url=None, redoc_url=None, openapi_url="/api/v1/openapi.json")
    app.state.settings, app.state.jobs = settings, jobs
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.trusted_hosts) + list(extra_hosts))

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        request.state.request_id = uuid.uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(ApiError)
    async def api_error(request: Request, exc: ApiError):
        return JSONResponse(error_body(request, exc.code, exc.message, exc.details), exc.status, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        details = [{"field": ".".join(str(p) for p in e["loc"][1:]), "problem": e["msg"]} for e in exc.errors()]
        return JSONResponse(error_body(request, "INVALID_REQUEST", "The request has invalid or unknown fields.", details), 422)

    @app.exception_handler(sqlite3.OperationalError)
    async def storage_busy(request: Request, exc: sqlite3.OperationalError):
        if "locked" in str(exc) or "busy" in str(exc):
            return JSONResponse(error_body(request, "STORAGE_BUSY", "Storage is busy. Try again in a moment.", []), 503)
        log.exception("storage error")
        return JSONResponse(error_body(request, "SERVER_ERROR", "Something went wrong on the server.", []), 500)

    # -- dependencies -------------------------------------------------------
    def get_conn():
        conn = db.connect(settings.db_path)
        try:
            yield conn
        finally:
            conn.close()

    def get_user(request: Request, conn=Depends(get_conn)) -> security.User:
        user = security.load_session(conn, request.cookies.get(security.COOKIE))
        if not user:
            raise ApiError(401, "AUTH_REQUIRED", "Sign in to continue.")
        return user

    def check_origin(request: Request):
        origin = request.headers.get("origin")
        if origin not in settings.trusted_origins:
            raise ApiError(403, "ORIGIN_REJECTED", "This request did not come from the Smart Retry portal.")

    def mutating_user(request: Request, user=Depends(get_user)) -> security.User:
        check_origin(request)
        token = request.headers.get("x-csrf-token")
        if not token or token != user.csrf:
            raise ApiError(403, "CSRF_REJECTED", "Your session token is missing or out of date. Reload the page.")
        return user

    def require_role(user: security.User, role: str):
        if user.role != role:
            raise ApiError(403, "FORBIDDEN", f"Only the {role} account can do this.")

    def load_run(conn, run_id: str):
        run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not run:
            raise ApiError(404, "NOT_FOUND", "This analysis doesn't exist.")
        return run

    def check_if_match(request: Request, run):
        value = request.headers.get("if-match")
        if value is None:
            raise ApiError(428, "PRECONDITION_REQUIRED", "This change needs the current version (If-Match).")
        if value.strip().strip('"').removeprefix('W/').strip('"') != str(run["version"]):
            raise ApiError(412, "STALE_VERSION", "This analysis changed since you loaded it. Reload and try again.")

    def idem_key(request: Request) -> str:
        key = request.headers.get("idempotency-key")
        if not key or len(key) > 128:
            raise ApiError(422, "IDEMPOTENCY_KEY_REQUIRED", "This action needs an Idempotency-Key header.")
        return key

    def idem_replay(conn, user, action, key, payload_hash):
        row = conn.execute("SELECT * FROM idempotency_keys WHERE user_id=? AND action=? AND key=?",
                           (user.id, action, key)).fetchone()
        if not row:
            return None
        if row["payload_hash"] != payload_hash:
            raise ApiError(409, "IDEMPOTENCY_CONFLICT", "This request key was already used for a different request.")
        return row

    def idem_store(conn, user, action, key, payload_hash, status, body):
        conn.execute("INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?,?)",
                     (user.id, action, key, payload_hash, status, json.dumps(body), now_text()))

    def phash(*parts) -> str:
        return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()

    def respond_run(conn, run_id, user, status=200, replay_row=None):
        run = load_run(conn, run_id)
        body = run_json(conn, run, user, jobs)
        return JSONResponse(body, status if not replay_row else replay_row["status_code"],
                            headers={"ETag": f'"{run["version"]}"'})

    api = APIRouter(prefix="/api/v1")

    # -- health & auth ------------------------------------------------------
    @api.get("/health")
    def health(conn=Depends(get_conn)):
        return {"status": "ok", "app_version": APP_VERSION, "rule_version": RULE_VERSION,
                "sqlite": sqlite3.sqlite_version, "schema": [r[0] for r in conn.execute("SELECT version FROM schema_migrations")]}

    @api.post("/auth/login")
    def login(body: LoginBody, request: Request, conn=Depends(get_conn)):
        check_origin(request)
        if request.headers.get(security.LOGIN_HEADER) != security.LOGIN_HEADER_VALUE:
            raise ApiError(403, "LOGIN_HEADER_REQUIRED", "Sign in from the Smart Retry portal.")
        outcome, row = security.check_login(conn, body.username, body.password)
        if outcome == "locked":
            raise ApiError(429, "LOGIN_THROTTLED", "Too many failed attempts. Wait 15 minutes and try again.")
        if outcome != "ok":
            raise ApiError(401, "LOGIN_FAILED", "Username or password is incorrect.")
        token, csrf = security.create_session(conn, row["id"])
        user = security.load_session(conn, token, touch=False)
        response = JSONResponse(session_body(user))
        response.set_cookie(security.COOKIE, token, httponly=True, samesite="strict", path="/",
                            secure=settings.secure_cookie)
        return response

    def session_body(user: security.User) -> dict:
        return {"user": {"username": user.username, "role": user.role}, "workspace": WORKSPACE,
                "expires_at": iso_utc(user.expires_us), "csrf_token": user.csrf}

    @api.get("/auth/session")
    def session(user=Depends(get_user)):
        return session_body(user)

    @api.post("/auth/logout", status_code=204)
    def logout(user=Depends(mutating_user), conn=Depends(get_conn)):
        security.revoke(conn, user.token_hash)
        response = Response(status_code=204)
        response.delete_cookie(security.COOKIE, path="/")
        return response

    # -- workspace & runs ---------------------------------------------------
    @api.get("/workspace")
    def workspace(user=Depends(get_user), conn=Depends(get_conn)):
        hist = history_info(conn, current_history(conn))
        return {"workspace": WORKSPACE, "label": WORKSPACE_LABEL, "history": hist,
                "history_available": bool(hist and hist["available"]),
                "permitted_actions": ["create_run"] if user.role == "operator" and hist else [],
                "allowed_cooldowns": list(ALLOWED_COOLDOWNS), "evaluated_at": payments.evaluated_at_for_history(conn, current_history(conn)),
                "business_timezone": BUSINESS_TZ_NAME}

    @api.get("/runs")
    def list_runs(page: int = 1, page_size: int = 20, user=Depends(get_user), conn=Depends(get_conn)):
        page_size = max(1, min(page_size, PAGE_SIZE_MAX))
        page = max(1, page)
        total = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        rows = conn.execute("SELECT * FROM runs ORDER BY created_at DESC, revision_no DESC LIMIT ? OFFSET ?",
                            (page_size, (page - 1) * page_size)).fetchall()
        return {"items": [run_json(conn, r, user, jobs) for r in rows], "total": total, "page": page, "page_size": page_size}

    @api.post("/runs", status_code=201)
    def create_run(body: CooldownBody, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        require_role(user, "operator")
        key, ph = idem_key(request), phash(body.model_dump())
        if (row := idem_replay(conn, user, "create_run", key, ph)):
            return respond_run(conn, json.loads(row["response_json"])["run_id"], user, replay_row=row)
        run_id, now, hist = str(uuid.uuid4()), now_text(), current_history(conn)
        with db.transaction(conn):
            conn.execute("INSERT INTO analyses VALUES (?,?,?,?)", (run_id, WORKSPACE, user.id, now))
            conn.execute("""INSERT INTO runs (id, analysis_id, revision_no, status, cooldown_days, evaluated_at, business_timezone,
                            rule_version, master_sha256, created_by, created_at, history_file_id, fatigue_attempts, holdout_pct)
                            VALUES (?,?,1,'Draft',?,?,?,?,?,?,?,?,?,?)""",
                         (run_id, run_id, body.cooldown_days, payments.evaluated_at_for_history(conn, hist), BUSINESS_TZ_NAME,
                          RULE_VERSION, master_sha256(), user.id, now, hist, body.fatigue_attempts, body.holdout_pct))
            engine.add_event(conn, run_id, user.id, "created", body.model_dump())
            idem_store(conn, user, "create_run", key, ph, 201, {"run_id": run_id})
        return respond_run(conn, run_id, user, 201)

    @api.get("/runs/{run_id}")
    def get_run(run_id: str, user=Depends(get_user), conn=Depends(get_conn)):
        return respond_run(conn, run_id, user)

    def creator_operator(run, user):
        require_role(user, "operator")
        if run["created_by"] != user.id:
            raise ApiError(403, "FORBIDDEN", "Only the operator who created this analysis can change it.")

    def require_status(run, *allowed):
        if run["status"] not in allowed:
            raise ApiError(409, "INVALID_STATE", f"This action isn't available while the analysis is {run['status']}.",
                           [{"status": run["status"], "allowed": list(allowed)}])

    @api.patch("/runs/{run_id}")
    def update_run(run_id: str, body: CooldownBody, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        run = load_run(conn, run_id)
        creator_operator(run, user)
        check_if_match(request, run)
        require_status(run, "Draft")
        with db.transaction(conn):
            fields = body.model_fields_set
            conn.execute("""UPDATE runs SET cooldown_days=?, fatigue_attempts=?, holdout_pct=?, version=version+1
                            WHERE id=? AND version=?""",
                         (body.cooldown_days,
                          body.fatigue_attempts if "fatigue_attempts" in fields else run["fatigue_attempts"],
                          body.holdout_pct if "holdout_pct" in fields else run["holdout_pct"], run_id, run["version"]))
            engine.add_event(conn, run_id, user.id, "configured", body.model_dump())
        return respond_run(conn, run_id, user)

    @api.put("/runs/{run_id}/sources")
    async def upload_sources(run_id: str, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        run = load_run(conn, run_id)
        creator_operator(run, user)
        key = idem_key(request)
        if not request.headers.get("content-type", "").startswith("multipart/form-data"):
            raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload the portfolio as multipart/form-data.")
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_SOURCE_BYTES + 1_000_000:
            raise ApiError(413, "INPUT_TOO_LARGE", "The portfolio file is larger than 50 MiB.")
        form = await request.form(max_files=2, max_fields=5)
        fields = set(form.keys())
        if "requests_file" in fields:
            raise ApiError(422, "REQUESTS_UPLOAD_REJECTED",
                           "Payment history comes from the system. Upload only the loan portfolio.")
        if fields != {"loans_file"} or not hasattr(form["loans_file"], "read"):
            raise ApiError(422, "INVALID_REQUEST", "Send exactly one file in the loans_file field.")
        upload = form["loans_file"]
        file_id = str(uuid.uuid4())
        dest = settings.upload_dir / f"portfolio-{file_id}.csv"
        digest, size = hashlib.sha256(), 0
        with dest.open("wb") as out:
            while chunk := await upload.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_SOURCE_BYTES:
                    out.close()
                    dest.unlink(missing_ok=True)
                    raise ApiError(413, "INPUT_TOO_LARGE", "The portfolio file is larger than 50 MiB.")
                digest.update(chunk)
                out.write(chunk)
        sha = digest.hexdigest()
        ph = phash(run_id, sha)
        if (row := idem_replay(conn, user, "upload_portfolio", key, ph)):
            dest.unlink(missing_ok=True)
            return respond_run(conn, run_id, user, replay_row=row)
        check_if_match(request, run)
        require_status(run, "Draft", "Validated")
        name = (upload.filename or "portfolio.csv").replace("/", "_").replace("\\", "_")[:200]
        with db.transaction(conn):
            conn.execute("""INSERT INTO source_files (id, kind, workspace, original_name, storage_path, sha256, size_bytes,
                            status, imported_at) VALUES (?,?,?,?,?,?,?,?,?)""",
                         (file_id, "loans_portfolio", WORKSPACE, name, str(dest), sha, size, "uploaded", now_text()))
            conn.execute("""UPDATE runs SET loans_file_id=?, status='Draft', validation_json=NULL, error_json=NULL,
                            version=version+1 WHERE id=?""", (file_id, run_id))
            engine.add_event(conn, run_id, user.id, "portfolio_uploaded", {"sha256": sha, "size_bytes": size})
            idem_store(conn, user, "upload_portfolio", key, ph, 200, {"run_id": run_id})
        return respond_run(conn, run_id, user)

    def start_job(request, run_id, user, conn, action, from_status, to_status, fn):
        run = load_run(conn, run_id)
        creator_operator(run, user)
        key, ph = idem_key(request), phash(run_id, action)
        if (row := idem_replay(conn, user, action, key, ph)):
            return respond_run(conn, run_id, user, replay_row=row)
        check_if_match(request, run)
        require_status(run, from_status)
        if action == "validate":
            if not run["loans_file_id"]:
                raise ApiError(409, "PORTFOLIO_MISSING", "Upload the loan portfolio before checking it.")
            hist = history_info(conn, run["history_file_id"])
            if not hist or not hist["available"]:
                raise ApiError(409, "HISTORY_UNAVAILABLE",
                               "System payment history is unavailable. Fix it in local setup, then start a new analysis.")
        if not jobs.try_start(run_id):
            raise ApiError(409, "ANALYSIS_BUSY", "Another check or analysis is running. Wait for it to finish.")
        try:
            with db.transaction(conn):
                updated = conn.execute(f"UPDATE runs SET status=?, version=version+1, error_json=NULL WHERE id=? AND version=?",
                                       (to_status, run_id, run["version"])).rowcount
                if not updated:
                    raise ApiError(412, "STALE_VERSION", "This analysis changed since you loaded it. Reload and try again.")
                engine.add_event(conn, run_id, user.id, action + "_started")
                idem_store(conn, user, action, key, ph, 202, {"run_id": run_id})
        except BaseException:
            jobs.finish()
            raise
        jobs.submit(fn, run_id)
        return respond_run(conn, run_id, user, 202)

    @api.post("/runs/{run_id}/validate", status_code=202)
    def validate(run_id: str, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        return start_job(request, run_id, user, conn, "validate", "Draft", "Validating", jobs.validate)

    @api.post("/runs/{run_id}/execute", status_code=202)
    def execute(run_id: str, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        return start_job(request, run_id, user, conn, "execute", "Validated", "Running", jobs.execute)

    def completed_run(conn, run_id):
        run = load_run(conn, run_id)
        if run["status"] not in COMPLETED or not run["summary_json"]:
            raise ApiError(409, "RESULTS_NOT_AVAILABLE", "Results are only available after a completed analysis.")
        return run

    @api.get("/runs/{run_id}/summary")
    def summary(run_id: str, user=Depends(get_user), conn=Depends(get_conn)):
        run = completed_run(conn, run_id)
        s = json.loads(run["summary_json"])
        return {"run_id": run_id, "revision_id": run_id, "version": run["version"], "status": run["status"],
                "configuration": config_json(run),
                "totals": s["totals"], "reasons": s["reasons"], "actions": s["actions"], "coverage": s["coverage"],
                "is_executable": False}

    @api.get("/runs/{run_id}/decisions")
    def decisions(run_id: str, decision: Literal["RETRY", "WAIT", "REVIEW_REMEDIATE"] | None = None,
                  reason: str | None = None, loan_id: str | None = None, page: int = 1,
                  page_size: int = PAGE_SIZE_DEFAULT, user=Depends(get_user), conn=Depends(get_conn)):
        completed_run(conn, run_id)
        page_size = max(1, min(page_size, PAGE_SIZE_MAX))
        page = max(1, page)
        where, params = ["run_id=?"], [run_id]
        if decision:
            where.append("decision=?"); params.append(decision)
        if reason:
            where.append("reason_code=?"); params.append(reason)
        if loan_id:
            where.append("loan_id LIKE ? ESCAPE '\\'")
            params.append(loan_id.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        # WAIT: soonest check first. RETRY: loans that have collected before first (most recent first),
        # then the shortest insufficient-funds streak. Ordering never changes the decision.
        order = {"WAIT": "next_check_day ASC, loan_id ASC",
                 "RETRY": "last_success_us IS NULL, last_success_us DESC, consecutive_soft_failures ASC, loan_id ASC"
                 }.get(decision or "", "loan_id ASC")
        clause = " AND ".join(where)
        total = conn.execute(f"SELECT COUNT(*) FROM loan_decisions WHERE {clause}", params).fetchone()[0]
        rows = conn.execute(f"""SELECT d.*, a.arm FROM (SELECT * FROM loan_decisions WHERE {clause} ORDER BY {order} LIMIT ? OFFSET ?) d
                                LEFT JOIN experiment_assignments a ON a.run_id = d.run_id AND a.loan_id = d.loan_id
                                ORDER BY {order}""",
                            params + [page_size, (page - 1) * page_size]).fetchall()
        return {"items": [decision_json(r) for r in rows], "total": total, "page": page, "page_size": page_size}

    @api.get("/runs/{run_id}/loans/{loan_id}")
    def loan_detail(run_id: str, loan_id: str, user=Depends(get_user), conn=Depends(get_conn)):
        run = completed_run(conn, run_id)
        r = conn.execute("""SELECT d.*, a.arm FROM loan_decisions d LEFT JOIN experiment_assignments a
                            ON a.run_id = d.run_id AND a.loan_id = d.loan_id WHERE d.run_id=? AND d.loan_id=?""",
                         (run_id, loan_id)).fetchone()
        if not r:
            raise ApiError(404, "NOT_FOUND", "This loan isn't in the analysis.")
        loan = conn.execute("SELECT * FROM source_loans WHERE file_id=? AND loan_id=?", (run["loans_file_id"], loan_id)).fetchone()
        ids = json.loads(r["source_payment_request_ids"])
        members = []
        if ids:
            marks = ",".join("?" * len(ids))
            for m in conn.execute(f"""SELECT * FROM source_requests WHERE file_id=? AND payment_request_id IN ({marks})
                                      ORDER BY payment_request_id""", [run["history_file_id"], *ids]):
                members.append({"payment_request_id": m["payment_request_id"], "created_at": m["created_at_raw"],
                                "completed_at": m["completed_at_raw"] or None, "chargeback_at": m["chargeback_at_raw"] or None,
                                "status": m["status"], "amount": money(m["amount_cents"]),
                                "failed_reason": m["failed_code"], "failed_message": m["failed_message"] or None})
        earlier = conn.execute("""SELECT COUNT(*), COUNT(DISTINCT created_us), MIN(created_us) FROM source_requests
                                  WHERE file_id=? AND loan_id=?""", (run["history_file_id"], loan_id)).fetchone()
        recent = [dict(created_at=x["created_at_raw"], status=x["status"], amount=money(x["amount_cents"]),
                       failed_reason=x["failed_code"], failed_message=x["failed_message"] or None)
                  for x in conn.execute("""SELECT * FROM source_requests WHERE file_id=? AND loan_id=? AND created_us < COALESCE(?, 0)
                                           ORDER BY created_us DESC, payment_request_id LIMIT 10""",
                                        (run["history_file_id"], loan_id, r["last_batch_created_us"]))]
        return {**decision_json(r),
                "loan": {"loan_amount": money(loan["loan_amount_cents"]), "overdue_at": loan["overdue_at"],
                         "overdue_days": loan["overdue_days"], "source_line": loan["line_no"]},
                "latest_batch": members,
                "history": {"requests": earlier[0], "batches": earlier[1], "first_request_at": iso_utc(earlier[2]),
                            "earlier_requests": recent},
                "clock": {"evaluated_at": run["evaluated_at"], "business_timezone": run["business_timezone"],
                          "cooldown_days": run["cooldown_days"]},
                "payment_requests": [{"payment_request_id": p["payment_request_id"], "tranche_pct": p["tranche_pct"],
                                      "amount": money(p["amount_cents"]), "status": p["status"]}
                                     for p in conn.execute("""SELECT o.*, s.status FROM outbound_requests o
                                        JOIN payment_request_sets s ON s.id=o.set_id WHERE s.run_id=? AND o.loan_id=?
                                        ORDER BY o.tranche_pct""", (run_id, loan_id))],
                "production_checks": PRODUCTION_CHECKS, "is_executable": False}

    def transition(request, run_id, user, conn, action, from_status, to_status, extra_sql="", extra_params=(), payload=None,
                   after=None):
        run = load_run(conn, run_id)
        key, ph = idem_key(request), phash(run_id, action, payload)
        if (row := idem_replay(conn, user, action, key, ph)):
            return respond_run(conn, run_id, user, replay_row=row)
        check_if_match(request, run)
        require_status(run, from_status)
        with db.transaction(conn):
            updated = conn.execute(f"UPDATE runs SET status=?, version=version+1{extra_sql} WHERE id=? AND version=? AND status=?",
                                   (to_status, *extra_params, run_id, run["version"], from_status)).rowcount
            if not updated:
                raise ApiError(412, "STALE_VERSION", "This analysis changed since you loaded it. Reload and try again.")
            engine.add_event(conn, run_id, user.id, action, payload)
            if after:
                after()
            idem_store(conn, user, action, key, ph, 200, {"run_id": run_id})
        return respond_run(conn, run_id, user)

    @api.post("/runs/{run_id}/submit")
    def submit(run_id: str, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        creator_operator(load_run(conn, run_id), user)
        return transition(request, run_id, user, conn, "submit", "Ready", "Submitted", ", submitted_at=?", (now_text(),))

    @api.post("/runs/{run_id}/withdraw")
    def withdraw(run_id: str, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        creator_operator(load_run(conn, run_id), user)
        return transition(request, run_id, user, conn, "withdraw", "Submitted", "Ready", ", submitted_at=NULL")

    @api.post("/runs/{run_id}/review")
    def review(run_id: str, body: ReviewBody, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        require_role(user, "reviewer")
        run = load_run(conn, run_id)
        if run["created_by"] == user.id:
            raise ApiError(403, "SELF_APPROVAL", "The person who prepared an analysis can't review it.")
        comment = (body.comment or "").strip()
        if body.action == "return" and not comment:
            raise ApiError(422, "COMMENT_REQUIRED", "Tell the operator what to change before sending it back.")
        to_status = "Approved" if body.action == "approve" else "Returned"
        if body.action == "approve" and not conn.execute(
                "SELECT 1 FROM payment_request_sets WHERE run_id=? AND status='Draft'", (run_id,)).fetchone() \
                and run["status"] == "Submitted":
            raise ApiError(409, "NO_DRAFT_PAYMENTS",
                           "This analysis was generated before payment release existed. Ask the operator for a new revision.")

        def release():
            try:
                payments.release(conn, run_id, user.id)
            except payments.ReconciliationError:
                raise ApiError(409, "NO_DRAFT_PAYMENTS", "There are no draft payment requests to release.")
        return transition(request, run_id, user, conn, "review_" + body.action, "Submitted", to_status,
                          ", reviewed_by=?, reviewed_at=?, review_comment=?", (user.id, now_text(), comment or None),
                          payload=body.model_dump(), after=release if body.action == "approve" else None)

    @api.post("/runs/{run_id}/revisions", status_code=201)
    def create_revision(run_id: str, body: RevisionBody, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        require_role(user, "operator")
        parent = load_run(conn, run_id)
        key, ph = idem_key(request), phash(run_id, body.model_dump())
        if (row := idem_replay(conn, user, "create_revision", key, ph)):
            return respond_run(conn, json.loads(row["response_json"])["run_id"], user, replay_row=row)
        check_if_match(request, parent)
        if parent["status"] == "Submitted":
            raise ApiError(409, "WITHDRAW_FIRST", "Withdraw the submitted analysis before creating a new revision.")
        require_status(parent, *REVISABLE)
        new_id = str(uuid.uuid4())
        history = current_history(conn) if body.use_latest_history else parent["history_file_id"]
        if not history:
            raise ApiError(409, "HISTORY_UNAVAILABLE", "System payment history is unavailable. Fix it in local setup.")
        rev = conn.execute("SELECT MAX(revision_no) FROM runs WHERE analysis_id=?", (parent["analysis_id"],)).fetchone()[0] + 1
        with db.transaction(conn):
            if parent["status"] == "Ready":
                n = conn.execute("UPDATE runs SET status='Superseded', version=version+1 WHERE id=? AND version=?",
                                 (run_id, parent["version"])).rowcount
                if not n:
                    raise ApiError(412, "STALE_VERSION", "This analysis changed since you loaded it. Reload and try again.")
                engine.add_event(conn, run_id, user.id, "superseded", {"by": new_id})
            fields = body.model_fields_set
            conn.execute("""INSERT INTO runs (id, analysis_id, parent_run_id, revision_no, status, cooldown_days, evaluated_at,
                            business_timezone, rule_version, master_sha256, created_by, created_at, loans_file_id, history_file_id,
                            fatigue_attempts, holdout_pct)
                            VALUES (?,?,?,?,'Draft',?,?,?,?,?,?,?,?,?,?,?)""",
                         (new_id, parent["analysis_id"], run_id, rev, body.cooldown_days,
                          payments.evaluated_at_for_history(conn, history), BUSINESS_TZ_NAME,
                          RULE_VERSION, master_sha256(), user.id, now_text(), parent["loans_file_id"], history,
                          body.fatigue_attempts if "fatigue_attempts" in fields else parent["fatigue_attempts"],
                          body.holdout_pct if "holdout_pct" in fields else parent["holdout_pct"]))
            engine.add_event(conn, new_id, user.id, "revision_created", {"parent": run_id, **body.model_dump()})
            idem_store(conn, user, "create_revision", key, ph, 201, {"run_id": new_id})
        return respond_run(conn, new_id, user, 201)

    @api.get("/runs/{run_id}/results.csv")
    def results_csv(run_id: str, user=Depends(get_user), conn=Depends(get_conn)):
        run = load_run(conn, run_id)
        if run["status"] != "Approved":
            raise ApiError(409, "NOT_APPROVED", "Only approved results can be downloaded.")
        return PlainTextResponse(build_csv(conn, run), media_type="text/csv; charset=utf-8",
                                 headers={"Content-Disposition": 'attachment; filename="Belvo_Smart_Retry_Results.csv"'})

    # -- payment requests and responses (D34) ---------------------------------
    def payment_set(conn, run_id):
        row = conn.execute("SELECT * FROM payment_request_sets WHERE run_id=?", (run_id,)).fetchone()
        if not row:
            raise ApiError(404, "NOT_FOUND", "No payment requests have been prepared for this analysis.")
        return row

    @api.get("/runs/{run_id}/payment-requests")
    def get_payment_requests(run_id: str, user=Depends(get_user), conn=Depends(get_conn)):
        load_run(conn, run_id)
        return payments.summary(conn, payment_set(conn, run_id))

    @api.get("/runs/{run_id}/experiment")
    def get_experiment(run_id: str, user=Depends(get_user), conn=Depends(get_conn)):
        run = completed_run(conn, run_id)
        result = payments.experiment(conn, run)
        if result is None:
            raise ApiError(404, "NOT_FOUND", "This analysis has no holdout group.")
        return result

    @api.get("/runs/{run_id}/payment-requests.csv")
    def payment_requests_csv(run_id: str, user=Depends(get_user), conn=Depends(get_conn)):
        load_run(conn, run_id)
        row = payment_set(conn, run_id)
        if row["status"] == "Draft":
            raise ApiError(409, "NOT_RELEASED", "Payment requests can be downloaded once the reviewer approves and releases them.")
        return PlainTextResponse(payments.export_csv(conn, row), media_type="text/csv; charset=utf-8",
                                 headers={"Content-Disposition":
                                          f'attachment; filename="Belvo_Smart_Retry_Payment_Requests_{run_id[:8]}.csv"'})

    @api.put("/runs/{run_id}/payment-requests/responses")
    async def import_responses(run_id: str, request: Request, user=Depends(mutating_user), conn=Depends(get_conn)):
        require_role(user, "operator")
        load_run(conn, run_id)
        row = payment_set(conn, run_id)
        key = idem_key(request)
        if not request.headers.get("content-type", "").startswith("multipart/form-data"):
            raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload the responses as multipart/form-data.")
        form = await request.form(max_files=1, max_fields=3)
        if set(form.keys()) != {"responses_file", "origin"} or not hasattr(form["responses_file"], "read"):
            raise ApiError(422, "INVALID_REQUEST", "Send one responses_file and its origin.")
        origin = str(form["origin"])
        if origin not in ("bank", "synthetic_demo"):
            raise ApiError(422, "INVALID_REQUEST", "Origin must be bank or synthetic_demo.")
        data = await form["responses_file"].read(MAX_SOURCE_BYTES + 1)
        if len(data) > MAX_SOURCE_BYTES:
            raise ApiError(413, "INPUT_TOO_LARGE", "The response file is larger than 50 MiB.")
        ph = phash(run_id, origin, hashlib.sha256(data).hexdigest())
        if (replay := idem_replay(conn, user, "import_responses", key, ph)):
            return JSONResponse(payments.summary(conn, payment_set(conn, run_id)), replay["status_code"])
        if row["status"] == "Draft":
            raise ApiError(409, "NOT_RELEASED", "Responses can only be imported for released payment requests.")
        if row["status"] != "Released":
            raise ApiError(409, "ALREADY_RESPONDED", "Responses for these payment requests were already imported.")
        path = settings.upload_dir / f"responses-{uuid.uuid4()}.csv"
        path.write_bytes(data)
        if not jobs.try_start(run_id):
            raise ApiError(409, "ANALYSIS_BUSY", "Another job is running. Wait for it to finish.")
        try:
            with db.transaction(conn):
                payments.import_responses(conn, row, path, origin, user.id, settings.upload_dir)
                idem_store(conn, user, "import_responses", key, ph, 200, {"run_id": run_id})
        except ingest.IntakeError as err:
            raise ApiError(err.status, err.code, err.message, err.details)
        finally:
            jobs.finish()
        return JSONResponse(payments.summary(conn, payment_set(conn, run_id)))

    app.include_router(api)

    # -- portal -------------------------------------------------------------
    @app.get("/{path:path}", include_in_schema=False)
    def portal(path: str):
        if path.startswith("api/"):
            raise ApiError(404, "NOT_FOUND", "Unknown API path.")
        target = (WEB_DIST / path).resolve()
        if path and target.is_file() and WEB_DIST.resolve() in target.parents:
            return FileResponse(target)
        index = WEB_DIST / "index.html"
        if index.is_file():
            return FileResponse(index)
        return PlainTextResponse("Portal not built. Run: cd app/web && npm install && npm run build", 503)

    return app


CSV_COLUMNS = ["run_id", "revision_id", "master_sha256", "rule_version", "dataset_kind", "loan_id", "decision",
               "reason_code", "next_action_code", "payment_request_status", "payment_request_ids", "experiment_arm",
               "consecutive_soft_failures", "last_success_at", "last_batch_created_at", "last_batch_rows", "last_batch_statuses",
               "last_batch_reasons", "source_payment_request_ids", "cooldown_anchor_date", "days_since_anchor",
               "next_check_date", "total_amount_outstanding", "recommended_amount", "evaluated_at", "business_timezone",
               "cooldown_days", "fatigue_attempts", "rest_days", "holdout_pct", "loans_source_sha256", "requests_source_sha256", "production_checks", "is_executable",
               "analysis_review_state", "analysis_approved_by", "analysis_approved_at"]
ORIGINAL_LOANS_SHA = "667ce705f2e9c89c3ac2f5965ff3492601684c979cf3d55f7ceed1218cb7fc86"
ORIGINAL_REQUESTS_SHA = "27b608789d22c87703dd8bb4d70bd0283e468d91dde47adafe5dc2b4738f4b82"


def build_csv(conn, run) -> str:
    loans_sha = conn.execute("SELECT sha256 FROM source_files WHERE id=?", (run["loans_file_id"],)).fetchone()[0]
    req_sha = conn.execute("SELECT sha256 FROM source_files WHERE id=?", (run["history_file_id"],)).fetchone()[0]
    hist = conn.execute("SELECT origin, parent_file_id FROM source_files WHERE id=?", (run["history_file_id"],)).fetchone()
    if hist["origin"] == "synthetic_demo":
        kind = "synthetic_demo"
    elif hist["origin"] == "bank":
        kind = "belvo_sample_with_bank_responses"
    else:
        kind = "belvo_sample" if (loans_sha, req_sha) == (ORIGINAL_LOANS_SHA, ORIGINAL_REQUESTS_SHA) else "test_fixture"
    approver = username_of(conn, run["reviewed_by"])
    # Per-loan payment status: only RETRY loans have requests; everything else is NONE.
    pset = conn.execute("SELECT id, status FROM payment_request_sets WHERE run_id=?", (run["id"],)).fetchone()
    request_ids: dict[str, list[str]] = {}
    if pset:
        for o in conn.execute("SELECT loan_id, payment_request_id FROM outbound_requests WHERE set_id=? ORDER BY loan_id, tranche_pct",
                              (pset["id"],)):
            request_ids.setdefault(o["loan_id"], []).append(o["payment_request_id"])
    retry_status = pset["status"].upper() if pset else "NOT_GENERATED"
    arms = {r[0]: r[1] for r in conn.execute("SELECT loan_id, arm FROM experiment_assignments WHERE run_id=?", (run["id"],))}
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(CSV_COLUMNS)
    for r in conn.execute("SELECT * FROM loan_decisions WHERE run_id=? ORDER BY loan_id", (run["id"],)):
        w.writerow([run["id"], run["id"], run["master_sha256"], run["rule_version"], kind, r["loan_id"], r["decision"],
                    r["reason_code"], r["next_action_code"],
                    ("HOLDOUT" if arms.get(r["loan_id"]) == "control" else retry_status) if r["decision"] == "RETRY" else "NONE",
                    json.dumps(request_ids.get(r["loan_id"], []), separators=(",", ":")),
                    arms.get(r["loan_id"], ""), r["consecutive_soft_failures"], iso_utc(r["last_success_us"]) or "",
                    iso_utc(r["last_batch_created_us"]) or "", r["last_batch_rows"],
                    r["last_batch_statuses"], r["last_batch_reasons"], r["source_payment_request_ids"],
                    day_text(r["cooldown_anchor_day"]) or "",
                    "" if r["days_since_anchor"] is None else r["days_since_anchor"],
                    day_text(r["next_check_day"]) or "", money(r["total_amount_outstanding_cents"]) or "", "",
                    run["evaluated_at"], run["business_timezone"], run["cooldown_days"],
                    "" if run["fatigue_attempts"] is None else run["fatigue_attempts"],
                    REST_DAYS if run["fatigue_attempts"] else "", run["holdout_pct"], loans_sha, req_sha,
                    PRODUCTION_CHECKS, "false", "Approved", approver, run["reviewed_at"]])
    return buf.getvalue()

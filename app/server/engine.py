"""Validation and execution jobs. SQL decides; this module coordinates transactions."""
from __future__ import annotations

import json
import logging
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import db, ingest
import datetime as dt

from .config import CUTOFF_US, EVAL_DAY, REST_DAYS, Settings, local_day, now_text, to_us

log = logging.getLogger("smart_retry.engine")
DECISIONS = ("RETRY", "WAIT", "REVIEW_REMEDIATE")
ACTIONS = {"RETRY": "PREPARE_RETRY_HANDOFF", "WAIT": "REASSESS_ON_OR_AFTER_DATE",
           "REVIEW_REMEDIATE": "INVESTIGATE_BEFORE_RETRY"}


class ReconciliationError(Exception):
    pass


def add_event(conn: sqlite3.Connection, run_id: str, actor: str | None, event: str, detail: dict | None = None) -> None:
    conn.execute("INSERT INTO run_events (run_id, at, actor_id, event, detail) VALUES (?,?,?,?,?)",
                 (run_id, now_text(), actor, event, json.dumps(detail) if detail else None))


def classify(conn: sqlite3.Connection, run_id: str, loans_file_id: str, history_file_id: str, cooldown: int,
             cutoff_us: int = CUTOFF_US, eval_day: int = EVAL_DAY, fatigue: int | None = None) -> dict:
    """Run the authoritative SQL and reconcile. Caller owns the transaction."""
    conn.execute(db.rules_sql(), {"run_id": run_id, "loans_file_id": loans_file_id,
                                  "history_file_id": history_file_id, "cutoff_us": cutoff_us,
                                  "eval_day": eval_day, "cooldown": cooldown, "fatigue": fatigue,
                                  "rest": REST_DAYS})
    portfolio = conn.execute("SELECT COUNT(*) FROM source_loans WHERE file_id=?", (loans_file_id,)).fetchone()[0]
    rows = conn.execute("SELECT COUNT(*), COUNT(DISTINCT loan_id) FROM loan_decisions WHERE run_id=?", (run_id,)).fetchone()
    if rows[0] != portfolio or rows[1] != portfolio:
        raise ReconciliationError(f"{rows[0]} decisions for {portfolio} portfolio loans")
    bad_action = conn.execute(
        """SELECT COUNT(*) FROM loan_decisions WHERE run_id=? AND (next_action_code IS NULL OR
           (decision='RETRY' AND next_action_code<>'PREPARE_RETRY_HANDOFF') OR
           (decision='WAIT' AND next_action_code<>'REASSESS_ON_OR_AFTER_DATE') OR
           (decision='REVIEW_REMEDIATE' AND next_action_code<>'INVESTIGATE_BEFORE_RETRY'))""", (run_id,)).fetchone()[0]
    if bad_action:
        raise ReconciliationError(f"{bad_action} rows with an invalid next action")
    totals = {d: 0 for d in DECISIONS}
    for r in conn.execute("SELECT decision, COUNT(*) FROM loan_decisions WHERE run_id=? GROUP BY decision", (run_id,)):
        totals[r[0]] = r[1]
    if sum(totals.values()) != portfolio:
        raise ReconciliationError("queue totals do not add up to the portfolio")
    reasons = {r[0]: r[1] for r in conn.execute(
        "SELECT reason_code, COUNT(*) FROM loan_decisions WHERE run_id=? GROUP BY reason_code ORDER BY reason_code", (run_id,))}
    actions = {r[0]: r[1] for r in conn.execute(
        "SELECT next_action_code, COUNT(*) FROM loan_decisions WHERE run_id=? GROUP BY next_action_code", (run_id,))}
    if any(actions.get(ACTIONS[d], 0) != totals[d] for d in DECISIONS):
        raise ReconciliationError("action counts do not match decision counts")
    return {"totals": {"loans": portfolio, **totals}, "reasons": reasons, "actions": actions}


class JobRunner:
    """One bounded worker. A second job while one is active is rejected (409 ANALYSIS_BUSY)."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="smart-retry-job")
        self.lock = threading.Lock()
        self.active: str | None = None

    def try_start(self, run_id: str) -> bool:
        with self.lock:
            if self.active is not None:
                return False
            self.active = run_id
            return True

    def finish(self) -> None:
        with self.lock:
            self.active = None

    def submit(self, fn, run_id: str):
        def wrapper():
            try:
                fn(run_id)
            except Exception:  # noqa: BLE001 - recorded as Failed state, never leaked
                log.exception("job failed for run %s", run_id)
            finally:
                self.finish()
        return self.pool.submit(wrapper)

    def _conn(self) -> sqlite3.Connection:
        return db.connect(self.settings.db_path)

    # -- validation ---------------------------------------------------------
    def validate(self, run_id: str) -> None:
        conn = self._conn()
        try:
            run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            loans_file = conn.execute("SELECT * FROM source_files WHERE id=?", (run["loans_file_id"],)).fetchone()
            try:
                with db.transaction(conn):
                    if loans_file["status"] != "staged":
                        conn.execute("DELETE FROM source_loans WHERE file_id=?", (loans_file["id"],))
                        staged = ingest.stage_portfolio(conn, loans_file["id"], Path(loans_file["storage_path"]))
                        conn.execute("UPDATE source_files SET status='staged', row_count=?, warnings_json=? WHERE id=?",
                                     (staged["row_count"], json.dumps(staged["warnings"]), loans_file["id"]))
                    coverage = ingest.pair_coverage(conn, loans_file["id"], run["history_file_id"])
                    if coverage["orphan_request_rows"]:
                        raise ingest.IntakeError(
                            "ORPHAN_REQUESTS",
                            "Payment history references loans that are not in this portfolio.",
                            [{"orphan_request_rows": coverage["orphan_request_rows"],
                              "orphan_loan_ids": coverage["orphan_loan_ids"]}])
                    warnings = json.loads(conn.execute("SELECT warnings_json FROM source_files WHERE id=?",
                                                       (loans_file["id"],)).fetchone()[0])
                    conn.execute("UPDATE runs SET status='Validated', version=version+1, validation_json=?, error_json=NULL WHERE id=?",
                                 (json.dumps({"coverage": coverage, "warnings": warnings}), run_id))
                    add_event(conn, run_id, None, "validated", {"loans": coverage["loans"]})
            except ingest.IntakeError as err:
                with db.transaction(conn):
                    conn.execute("UPDATE source_files SET status='invalid' WHERE id=?", (loans_file["id"],))
                    conn.execute("UPDATE runs SET status='Draft', version=version+1, validation_json=NULL, error_json=? WHERE id=?",
                                 (json.dumps({"code": err.code, "message": err.message, "details": err.details}), run_id))
                    add_event(conn, run_id, None, "validation_failed", {"code": err.code})
        except Exception:
            with db.transaction(conn):
                conn.execute("UPDATE runs SET status='Draft', version=version+1, error_json=? WHERE id=? AND status='Validating'",
                             (json.dumps({"code": "VALIDATION_ERROR", "message": "Validation stopped unexpectedly. Try again.",
                                          "details": []}), run_id))
            raise
        finally:
            conn.close()

    # -- execution ----------------------------------------------------------
    def execute(self, run_id: str) -> None:
        conn = self._conn()
        try:
            run = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            try:
                with db.transaction(conn):
                    evaluated = dt.datetime.fromisoformat(run["evaluated_at"])
                    result = classify(conn, run_id, run["loans_file_id"], run["history_file_id"], run["cooldown_days"],
                                      to_us(evaluated), local_day(evaluated), run["fatigue_attempts"])
                    from . import payments  # local import: payments depends on this module
                    payments.draft(conn, run)
                    validation = json.loads(run["validation_json"])
                    summary = {**result, "coverage": validation["coverage"]}
                    conn.execute("UPDATE runs SET status='Ready', version=version+1, summary_json=?, error_json=NULL WHERE id=?",
                                 (json.dumps(summary), run_id))
                    add_event(conn, run_id, None, "ready", result["totals"])
            except Exception as exc:  # rollback already happened; publish nothing
                code = "RECONCILIATION_FAILED" if isinstance(exc, ReconciliationError) or \
                    type(exc).__name__ == "ReconciliationError" else "QUERY_FAILED"
                message = ("Results don't reconcile, so nothing was saved. Run again." if code == "RECONCILIATION_FAILED"
                           else "The analysis failed and nothing was saved. Run again.")
                with db.transaction(conn):
                    conn.execute("UPDATE runs SET status='Failed', version=version+1, error_json=? WHERE id=?",
                                 (json.dumps({"code": code, "message": message, "details": []}), run_id))
                    add_event(conn, run_id, None, "failed", {"code": code})
                raise
        finally:
            conn.close()


def recover_unfinished(conn: sqlite3.Connection) -> int:
    """On startup: Running -> Interrupted, Validating -> Draft. No automatic rerun."""
    with db.transaction(conn):
        running = [r[0] for r in conn.execute("SELECT id FROM runs WHERE status='Running'")]
        for rid in running:
            conn.execute("DELETE FROM loan_decisions WHERE run_id=?", (rid,))
            conn.execute("UPDATE runs SET status='Interrupted', version=version+1, error_json=? WHERE id=?",
                         (json.dumps({"code": "INTERRUPTED", "message": "Processing was interrupted. No results were saved.",
                                      "details": []}), rid))
            add_event(conn, rid, None, "interrupted")
        validating = [r[0] for r in conn.execute("SELECT id FROM runs WHERE status='Validating'")]
        for rid in validating:
            conn.execute("UPDATE runs SET status='Draft', version=version+1, error_json=? WHERE id=?",
                         (json.dumps({"code": "VALIDATION_INTERRUPTED", "message": "Validation was interrupted. Validate again.",
                                      "details": []}), rid))
            add_event(conn, rid, None, "validation_interrupted")
    return len(running) + len(validating)

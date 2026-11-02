"""Payment request sets and response import (master section 8, D34).

The MVP prepares and receives files. It never sends a payment.
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import io
import json
import sqlite3
import uuid
from decimal import Decimal
from pathlib import Path

from . import db, engine, ingest
from .config import (BUSINESS_TZ, EVALUATED_AT_TEXT, MAX_REQUEST_ROWS, REQUEST_COLUMNS, WORKSPACE,
                     now_text, to_us)

SPLIT = (5, 25, 70)
SPLIT_VERSION = "split-5-25-70-v1"
RESPONSE_STATUSES = ("successful", "failed", "chargeback")


class ReconciliationError(Exception):
    pass


def requested_at_for(evaluated_at_text: str) -> dt.datetime:
    """Exercise request instant: 09:00 local on the day after the run's evaluated_at."""
    evaluated = dt.datetime.fromisoformat(evaluated_at_text).astimezone(BUSINESS_TZ)
    day = evaluated.date() + dt.timedelta(days=1)
    return dt.datetime.combine(day, dt.time(9, 0), tzinfo=BUSINESS_TZ).astimezone(dt.timezone.utc)


def evaluated_at_for_history(conn: sqlite3.Connection, history_file_id: str | None) -> str:
    """Original history keeps the fixed cutoff; response-derived history moves to the end of the latest response day."""
    if not history_file_id:
        return EVALUATED_AT_TEXT
    row = conn.execute("SELECT response_event_max_us FROM source_files WHERE id=?", (history_file_id,)).fetchone()
    if not row or row[0] is None:
        return EVALUATED_AT_TEXT
    day = dt.datetime.fromtimestamp(row[0] / 1_000_000, dt.timezone.utc).astimezone(BUSINESS_TZ).date()
    return dt.datetime.combine(day, dt.time(23, 59, 59), tzinfo=BUSINESS_TZ).isoformat()


def iso_ms(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def draft(conn: sqlite3.Connection, run) -> str:
    """Draft the run's single request set with its Ready results. Caller owns the transaction."""
    set_id = str(uuid.uuid4())
    requested = requested_at_for(run["evaluated_at"])
    assign_holdout(conn, run)
    conn.execute("""INSERT INTO payment_request_sets (id, run_id, created_by, created_at, requested_at_us, loan_count,
                    request_count, total_cents, status) VALUES (?,?,?,?,?,0,0,0,'Draft')""",
                 (set_id, run["id"], run["created_by"], now_text(), to_us(requested)))
    conn.execute(db.payment_requests_sql(), {"set_id": set_id, "run_id": run["id"]})
    retry = conn.execute("""SELECT COUNT(*), COALESCE(SUM(total_amount_outstanding_cents),0) FROM loan_decisions d
                            WHERE run_id=? AND decision='RETRY' AND NOT EXISTS (SELECT 1 FROM experiment_assignments a
                            WHERE a.run_id=d.run_id AND a.loan_id=d.loan_id AND a.arm='control')""", (run["id"],)).fetchone()
    made = conn.execute("""SELECT COUNT(*), COALESCE(SUM(amount_cents),0), COALESCE(MIN(amount_cents),0),
                           COUNT(DISTINCT loan_id) FROM outbound_requests WHERE set_id=?""", (set_id,)).fetchone()
    if made[0] != 3 * retry[0] or made[1] != retry[1] or made[3] != retry[0]:
        raise ReconciliationError("request count or total does not match the RETRY candidates")
    if retry[0] and made[2] <= 0:
        raise ReconciliationError("a tranche would be zero or negative")
    not_distinct = conn.execute("""SELECT COUNT(*) FROM (SELECT loan_id FROM outbound_requests WHERE set_id=?
                                   GROUP BY loan_id HAVING COUNT(DISTINCT amount_cents) < 3)""", (set_id,)).fetchone()[0]
    if not_distinct:
        raise ReconciliationError("tranches of a loan must have distinct amounts")
    # Equality on (file_id, payment_request_id) uses the primary-key index for every history dataset.
    collision = conn.execute("""SELECT COUNT(*) FROM outbound_requests o
                                JOIN source_files f ON f.kind = 'requests_history'
                                JOIN source_requests r ON r.file_id = f.id AND r.payment_request_id = o.payment_request_id
                                WHERE o.set_id=?""", (set_id,)).fetchone()[0]
    if collision:
        raise ReconciliationError("generated request id collides with history")
    conn.execute("UPDATE payment_request_sets SET loan_count=?, request_count=?, total_cents=? WHERE id=?",
                 (retry[0], made[0], made[1], set_id))
    engine.add_event(conn, run["id"], None, "payment_requests_drafted",
                     {"set_id": set_id, "requests": made[0], "split": SPLIT_VERSION})
    return set_id


def arm_for(run_id: str, loan_id: str, pct: int) -> str:
    """Deterministic, reproducible assignment: the same run and loan always land in the same arm."""
    bucket = int(hashlib.sha256(f"{run_id}:{loan_id}".encode()).hexdigest(), 16) % 100
    return "control" if bucket < pct else "treatment"


def assign_holdout(conn: sqlite3.Connection, run) -> None:
    pct = run["holdout_pct"] or 0
    if pct <= 0:
        return
    loans = [r[0] for r in conn.execute("SELECT loan_id FROM loan_decisions WHERE run_id=? AND decision='RETRY'", (run["id"],))]
    conn.executemany("INSERT INTO experiment_assignments VALUES (?,?,?)",
                     [(run["id"], loan, arm_for(run["id"], loan, pct)) for loan in loans])


def experiment(conn: sqlite3.Connection, run) -> dict | None:
    """Treatment vs control for a run with a holdout. Incremental recovery needs a later portfolio snapshot."""
    if not run["holdout_pct"]:
        return None
    arms = {r["arm"]: {"loans": r["n"], "outstanding": money(r["bal"] or 0)} for r in conn.execute(
        """SELECT a.arm, COUNT(*) n, SUM(d.total_amount_outstanding_cents) bal FROM experiment_assignments a
           JOIN loan_decisions d ON d.run_id=a.run_id AND d.loan_id=a.loan_id WHERE a.run_id=? GROUP BY a.arm""", (run["id"],))}
    for arm in ("treatment", "control"):
        arms.setdefault(arm, {"loans": 0, "outstanding": "0.00"})
    pset = conn.execute("SELECT * FROM payment_request_sets WHERE run_id=?", (run["id"],)).fetchone()
    responses = None
    if pset and pset["status"] == "Responded":
        hist = pset["history_file_id"]
        r = conn.execute(f"""SELECT COUNT(DISTINCT CASE WHEN q.status='successful' THEN q.loan_id END) paid_loans,
                                    COALESCE(SUM(CASE WHEN q.status='successful' THEN q.amount_cents END),0) collected,
                                    COUNT(DISTINCT CASE WHEN q.status='chargeback' THEN q.loan_id END) cb_loans
                             FROM outbound_requests o JOIN source_requests q
                               ON q.file_id=? AND q.payment_request_id=o.payment_request_id
                             WHERE o.set_id=?""", (hist, pset["id"])).fetchone()
        responses = {"treatment_loans_paid": r["paid_loans"], "treatment_collected": money(r["collected"]),
                     "treatment_loans_charged_back": r["cb_loans"], "origin": pset["responses_origin"]}
    # The next snapshot: the latest later revision of this analysis with a different, staged portfolio.
    later = conn.execute("""SELECT r.id, r.loans_file_id, r.revision_no FROM runs r JOIN source_files f ON f.id=r.loans_file_id
                            WHERE r.analysis_id=? AND r.revision_no>? AND r.loans_file_id<>? AND f.status='staged'
                            ORDER BY r.revision_no DESC LIMIT 1""",
                         (run["analysis_id"], run["revision_no"], run["loans_file_id"])).fetchone()
    snapshot = None
    if later:
        rows = conn.execute("""SELECT a.arm, COUNT(*) n,
                                      SUM(CASE WHEN nl.total_amount_outstanding_cents < ol.total_amount_outstanding_cents THEN 1 ELSE 0 END) reduced,
                                      SUM(MAX(ol.total_amount_outstanding_cents - COALESCE(nl.total_amount_outstanding_cents, ol.total_amount_outstanding_cents), 0)) recovered
                               FROM experiment_assignments a
                               JOIN source_loans ol ON ol.file_id=? AND ol.loan_id=a.loan_id
                               LEFT JOIN source_loans nl ON nl.file_id=? AND nl.loan_id=a.loan_id
                               WHERE a.run_id=? GROUP BY a.arm""", (run["loans_file_id"], later["loans_file_id"], run["id"]))
        per = {}
        for r in rows:
            per[r["arm"]] = {"loans": r["n"], "loans_with_lower_balance": r["reduced"], "recovered": money(r["recovered"] or 0),
                             "recovered_per_loan": money((r["recovered"] or 0) // max(r["n"], 1))}
        t, c = per.get("treatment"), per.get("control")
        lift = None
        if t and c:
            lift = str((Decimal(t["recovered_per_loan"]) - Decimal(c["recovered_per_loan"])).quantize(Decimal("0.01")))
        snapshot = {"revision_no": later["revision_no"], "run_id": later["id"], "arms": per,
                    "incremental_recovered_per_loan": lift}
    return {"holdout_pct": run["holdout_pct"], "assignment": "sha256(run_id:loan_id) mod 100 < holdout_pct",
            "arms": arms, "responses": responses, "next_snapshot": snapshot,
            "synthetic": bool(pset and pset["responses_origin"] == "synthetic_demo"),
            "small_sample": arms["control"]["loans"] < 100}


def release(conn: sqlite3.Connection, run_id: str, reviewer_id: str) -> None:
    """Approval of the exact revision releases its draft set. Caller owns the transaction."""
    n = conn.execute("""UPDATE payment_request_sets SET status='Released', released_by=?, released_at=?
                        WHERE run_id=? AND status='Draft'""", (reviewer_id, now_text(), run_id)).rowcount
    if n != 1:
        raise ReconciliationError("no draft payment requests to release")
    engine.add_event(conn, run_id, reviewer_id, "payment_requests_released")


def money(cents: int) -> str:
    return f"{cents // 100}.{cents % 100:02d}"


def export_csv(conn: sqlite3.Connection, set_row) -> str:
    created = iso_ms(dt.datetime.fromtimestamp(set_row["requested_at_us"] / 1_000_000, dt.timezone.utc))
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(REQUEST_COLUMNS)
    for r in conn.execute("""SELECT * FROM outbound_requests WHERE set_id=? ORDER BY loan_id, tranche_pct""", (set_row["id"],)):
        w.writerow([r["payment_request_id"], created, "", "", "pending", money(r["amount_cents"]), "", "", r["loan_id"]])
    return buf.getvalue()


def summary(conn: sqlite3.Connection, set_row) -> dict:
    created = dt.datetime.fromtimestamp(set_row["requested_at_us"] / 1_000_000, dt.timezone.utc)
    by_tranche = {f"{r[0]}%": money(r[1]) for r in conn.execute(
        "SELECT tranche_pct, SUM(amount_cents) FROM outbound_requests WHERE set_id=? GROUP BY tranche_pct ORDER BY tranche_pct",
        (set_row["id"],))}
    who = lambda uid: conn.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()[0] if uid else None
    return {"set_id": set_row["id"], "run_id": set_row["run_id"], "status": set_row["status"],
            "split": list(SPLIT), "split_version": SPLIT_VERSION, "requested_at": iso_ms(created),
            "created_by": who(set_row["created_by"]), "created_at": set_row["created_at"],
            "released_by": who(set_row["released_by"]), "released_at": set_row["released_at"],
            "loans": set_row["loan_count"], "requests": set_row["request_count"], "total_amount": money(set_row["total_cents"]),
            "total_by_tranche": by_tranche,
            "holdout_loans": conn.execute("SELECT COUNT(*) FROM experiment_assignments WHERE run_id=? AND arm='control'",
                                          (set_row["run_id"],)).fetchone()[0],
            "responses": None if set_row["status"] != "Responded" else {
                "origin": set_row["responses_origin"], "sha256": set_row["responses_sha256"],
                "imported_at": set_row["responses_imported_at"], "imported_by": who(set_row["responses_imported_by"]),
                "history_dataset_id": set_row["history_file_id"], "outcomes": json.loads(set_row["outcome_json"])},
            "sent_by_mvp": False}


def import_responses(conn: sqlite3.Connection, set_row, upload_path: Path, origin: str, user_id: str,
                     upload_dir: Path) -> str:
    """Validate a complete response file and publish a new history dataset. Raises ingest.IntakeError."""
    label = "response file"
    rows, warnings = ingest._open_rows(upload_path, REQUEST_COLUMNS, label, MAX_REQUEST_ROWS)
    expected = {r["payment_request_id"]: r for r in conn.execute(
        "SELECT * FROM outbound_requests WHERE set_id=?", (set_row["id"],))}
    requested_us = set_row["requested_at_us"]
    problems = ingest.Problems(label)
    seen: set[str] = set()
    outcomes: dict[str, int] = {}
    loan_status: dict[str, set] = {}
    event_max = None
    for line, r in rows:
        rid = r["payment_request_id"]
        exp = expected.get(rid)
        if exp is None:
            problems.add(line, "payment_request_id", f"{rid} is not in this request set")
            continue
        if rid in seen:
            problems.add(line, "payment_request_id", f"{rid} answered more than once")
            continue
        seen.add(rid)
        if r["loan_id"] != exp["loan_id"]:
            problems.add(line, "loan_id", f"expected {exp['loan_id']}")
        try:
            if ingest.parse_money_cents(r["amount"]) != exp["amount_cents"]:
                problems.add(line, "amount", f"expected {money(exp['amount_cents'])}")
        except ValueError as exc:
            problems.add(line, "amount", str(exc))
        try:
            created = to_us(ingest.parse_instant(r["created_at"]))
            if created != requested_us:
                problems.add(line, "created_at", "does not match the request")
        except ValueError:
            problems.add(line, "created_at", "unparseable timestamp")
            created = requested_us
        status = r["status"]
        if status not in RESPONSE_STATUSES:
            problems.add(line, "status", "must be successful, failed or chargeback")
            continue
        try:
            completed = to_us(ingest.parse_instant(r["completed_at"]))
        except ValueError:
            problems.add(line, "completed_at", "required response timestamp is missing or unparseable")
            continue
        if completed < created:
            problems.add(line, "completed_at", "is before the request was created")
        events = [completed]
        if status == "failed" and not r["failed_reason"].strip():
            problems.add(line, "failed_reason", "failed responses need a reason")
        if status == "chargeback":
            try:
                cb = to_us(ingest.parse_instant(r["chargeback_at"]))
                if cb < completed:
                    problems.add(line, "chargeback_at", "is before completion")
                events.append(cb)
            except ValueError:
                problems.add(line, "chargeback_at", "chargeback responses need chargeback_at")
        elif r["chargeback_at"].strip():
            problems.add(line, "chargeback_at", "only chargeback responses may have it")
        event_max = max([event_max or 0, *events])
        outcomes[status] = outcomes.get(status, 0) + 1
        loan_status.setdefault(exp["loan_id"], set()).add(status)
    missing = len(expected) - len(seen)
    if missing > 0:
        problems.add(0, "payment_request_id", f"{missing} request(s) have no response; send a complete file")
    problems.raise_if_any("RESPONSES_INVALID", "The response file doesn't match the payment requests")

    parent_id = conn.execute("SELECT history_file_id FROM runs WHERE id=?", (set_row["run_id"],)).fetchone()[0]
    parent = conn.execute("SELECT * FROM source_files WHERE id=?", (parent_id,)).fetchone()
    file_id = str(uuid.uuid4())
    dest = upload_dir / f"history-{file_id}.csv"
    base = Path(parent["storage_path"]).read_bytes()
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\r\n")
    for _, r in rows:
        w.writerow([r[c] for c in REQUEST_COLUMNS])
    combined = base + (b"" if base.endswith(b"\n") else b"\r\n") + out.getvalue().encode("utf-8")
    dest.write_bytes(combined)
    digest = hashlib.sha256(combined).hexdigest()
    new_origin = "synthetic_demo" if origin == "synthetic_demo" or parent["origin"] == "synthetic_demo" else "bank"
    conn.execute("""INSERT INTO source_files (id, kind, workspace, original_name, storage_path, sha256, size_bytes, status,
                    imported_at, origin, parent_file_id, responses_count, response_event_max_us)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                 (file_id, "requests_history", WORKSPACE, f"{parent['original_name']} + responses {set_row['id'][:8]}",
                  str(dest), digest, len(combined), "uploaded", now_text(), new_origin, parent_id,
                  (parent["responses_count"] or 0) + len(rows), max(event_max, parent["response_event_max_us"] or 0)))
    staged = ingest.stage_history(conn, file_id, dest)
    conn.execute("UPDATE source_files SET status='staged', row_count=?, event_min_us=?, event_max_us=?, warnings_json=? WHERE id=?",
                 (staged["row_count"], staged["event_min_us"], staged["event_max_us"], json.dumps(staged["warnings"]), file_id))
    mixed = sum(1 for s in loan_status.values() if len(s) > 1)
    conn.execute("""UPDATE payment_request_sets SET status='Responded', responses_sha256=?, responses_origin=?,
                    responses_imported_at=?, responses_imported_by=?, history_file_id=?, outcome_json=? WHERE id=?""",
                 (hashlib.sha256(upload_path.read_bytes()).hexdigest(), origin, now_text(), user_id, file_id,
                  json.dumps({"by_status": outcomes, "loans": len(loan_status), "loans_with_mixed_outcomes": mixed}),
                  set_row["id"]))
    engine.add_event(conn, set_row["run_id"], user_id, "responses_imported",
                     {"set_id": set_row["id"], "origin": origin, "history": file_id, **outcomes})
    return file_id


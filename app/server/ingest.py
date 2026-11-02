"""CSV intake: strict parsing, exact money and time staging (master sections 4 and 13).

Python parses and normalizes values only. It never groups batches or classifies loans;
that belongs to app/sql/rules_minimal_v1.sql.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import re
import sqlite3
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .config import (LOANS_COLUMNS, MAX_PORTFOLIO_ROWS, MAX_REQUEST_ROWS, REQUEST_COLUMNS,
                     local_day, to_us)

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
INT64_MAX = 2**63 - 1
MAX_DETAILS = 20


class IntakeError(Exception):
    """A blocking input problem. `code` is a stable API error code."""

    def __init__(self, code: str, message: str, details: list | None = None, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.details, self.status = code, message, details or [], status


class Problems:
    def __init__(self, file_label: str):
        self.file_label = file_label
        self.items: list[dict] = []
        self.count = 0

    def add(self, line: int, column: str, problem: str) -> None:
        self.count += 1
        if len(self.items) < MAX_DETAILS:
            self.items.append({"file": self.file_label, "line": line, "column": column, "problem": problem})

    def raise_if_any(self, code: str, message: str) -> None:
        if self.count:
            raise IntakeError(code, f"{message} ({self.count} problem{'s' if self.count != 1 else ''}).",
                              self.items + ([{"file": self.file_label, "more": self.count - len(self.items)}]
                                            if self.count > len(self.items) else []))


def parse_money_cents(text: str) -> int:
    try:
        value = Decimal(text.strip())
    except (InvalidOperation, AttributeError):
        raise ValueError("not a decimal number")
    if not value.is_finite():
        raise ValueError("not a finite number")
    cents = value * 100
    if cents != cents.to_integral_value():
        raise ValueError("more than two decimal places")
    cents_int = int(cents)
    if abs(cents_int) > INT64_MAX:
        raise ValueError("out of range")
    return cents_int


def parse_instant(text: str) -> dt.datetime:
    text = text.strip()
    if "T" not in text:
        raise ValueError("not an ISO-8601 timestamp")
    value = dt.datetime.fromisoformat(text)
    if value.tzinfo is None:
        raise ValueError("timestamp has no timezone")
    return value.astimezone(dt.timezone.utc)


def normalize_code(raw: str) -> str | None:
    text = raw.strip()
    if not text:
        return None
    if text.isdigit():
        return f"{int(text):02d}"
    return text


def _open_rows(path: Path, required: list[str], file_label: str, max_rows: int):
    data = path.read_bytes()
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise IntakeError("INPUT_ENCODING_INVALID", f"The {file_label} is not valid UTF-8 text.",
                          [{"file": file_label, "byte_offset": exc.start}])
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    try:
        header = next(reader)
    except StopIteration:
        raise IntakeError("INPUT_EMPTY", f"The {file_label} is empty.", [{"file": file_label}])
    except csv.Error as exc:
        raise IntakeError("INPUT_MALFORMED", f"The {file_label} header can't be read.", [{"file": file_label, "problem": str(exc)}])
    header = [h.strip() for h in header]
    missing = [c for c in required if c not in header]
    if missing:
        raise IntakeError("INPUT_SCHEMA_INVALID", f"The {file_label} is missing required columns.",
                          [{"file": file_label, "missing_columns": missing}])
    if len(set(header)) != len(header):
        raise IntakeError("INPUT_SCHEMA_INVALID", f"The {file_label} has repeated column names.", [{"file": file_label}])
    extra = [c for c in header if c not in required]
    index = {c: header.index(c) for c in required}
    rows = []
    malformed = Problems(file_label)
    try:
        for row in reader:
            line = reader.line_num
            if not row:
                continue
            if len(row) != len(header):
                malformed.add(line, "*", f"expected {len(header)} fields, found {len(row)}")
                continue
            rows.append((line, {c: row[i] for c, i in index.items()}))
            if len(rows) > max_rows:
                raise IntakeError("INPUT_TOO_LARGE", f"The {file_label} has more than {max_rows:,} rows.",
                                  [{"file": file_label, "max_rows": max_rows}], status=413)
    except csv.Error as exc:
        raise IntakeError("INPUT_MALFORMED", f"The {file_label} has a malformed CSV row.",
                          [{"file": file_label, "line": reader.line_num, "problem": str(exc)}])
    malformed.raise_if_any("INPUT_MALFORMED", f"The {file_label} has rows with the wrong number of fields")
    warnings = [{"file": file_label, "unused_columns": extra}] if extra else []
    return rows, warnings


def stage_history(conn: sqlite3.Connection, file_id: str, path: Path) -> dict:
    """Parse the payment-request CSV and stage it. Raises IntakeError on any blocking problem."""
    label = "payment history file"
    rows, warnings = _open_rows(path, REQUEST_COLUMNS, label, MAX_REQUEST_ROWS)
    problems = Problems(label)
    seen: set[str] = set()
    staged = []
    soft_warnings = 0
    for line, r in rows:
        rid, loan = r["payment_request_id"], r["loan_id"]
        if not ID_RE.match(rid):
            problems.add(line, "payment_request_id", "invalid identifier")
        elif rid in seen:
            problems.add(line, "payment_request_id", f"duplicate id {rid}")
        seen.add(rid)
        if not ID_RE.match(loan):
            problems.add(line, "loan_id", "invalid identifier")
        try:
            created = parse_instant(r["created_at"])
        except ValueError:
            problems.add(line, "created_at", "unparseable timestamp")
            continue
        try:
            amount = parse_money_cents(r["amount"])
        except ValueError as exc:
            problems.add(line, "amount", str(exc))
            continue
        completed = chargeback = None
        completed_bad = chargeback_bad = 0
        if r["completed_at"].strip():
            try:
                completed = parse_instant(r["completed_at"])
            except ValueError:
                completed_bad = 1
                soft_warnings += 1
        if r["chargeback_at"].strip():
            try:
                chargeback = parse_instant(r["chargeback_at"])
            except ValueError:
                chargeback_bad = 1
                soft_warnings += 1
        staged.append((file_id, line, rid, loan, to_us(created),
                       to_us(completed) if completed else None, completed_bad,
                       to_us(chargeback) if chargeback else None, chargeback_bad,
                       local_day(created), local_day(completed) if completed else None,
                       r["status"], amount, normalize_code(r["failed_reason"]), r["failed_reason"],
                       r["failed_message"], r["created_at"], r["completed_at"], r["chargeback_at"]))
    problems.raise_if_any("INPUT_ROWS_INVALID", "The payment history file has invalid rows")
    if soft_warnings:
        warnings.append({"file": label, "unparseable_optional_timestamps": soft_warnings})
    conn.executemany(
        "INSERT INTO source_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", staged)
    created_values = [s[4] for s in staged]
    return {"row_count": len(staged), "event_min_us": min(created_values, default=None),
            "event_max_us": max(created_values, default=None), "warnings": warnings}


def stage_portfolio(conn: sqlite3.Connection, file_id: str, path: Path) -> dict:
    label = "loan portfolio file"
    rows, warnings = _open_rows(path, LOANS_COLUMNS, label, MAX_PORTFOLIO_ROWS)
    problems = Problems(label)
    seen: set[str] = set()
    staged = []
    for line, r in rows:
        loan = r["loan_id"]
        if not ID_RE.match(loan):
            problems.add(line, "loan_id", "invalid identifier")
        elif loan in seen:
            problems.add(line, "loan_id", f"duplicate id {loan}")
        seen.add(loan)
        values = {}
        for column in ("loan_amount", "total_amount_outstanding"):
            text = r[column].strip()
            if not text:
                values[column] = None
                continue
            try:
                values[column] = parse_money_cents(text)
            except ValueError as exc:
                problems.add(line, column, str(exc))
        overdue_at = None
        if r["overdue_at"].strip():
            try:
                overdue_at = dt.datetime.strptime(r["overdue_at"].strip(), "%m/%d/%Y").date().isoformat()
            except ValueError:
                problems.add(line, "overdue_at", "expected M/D/YYYY")
        overdue_days = None
        if r["overdue_days"].strip():
            try:
                overdue_days = int(r["overdue_days"].strip())
            except ValueError:
                problems.add(line, "overdue_days", "not a whole number")
        staged.append((file_id, line, loan, r["payment_method_bank"], values.get("loan_amount"),
                       values.get("total_amount_outstanding"), overdue_at, overdue_days,
                       json.dumps(r, ensure_ascii=False)))
    problems.raise_if_any("INPUT_ROWS_INVALID", "The loan portfolio file has invalid rows")
    conn.executemany("INSERT INTO source_loans VALUES (?,?,?,?,?,?,?,?,?)", staged)
    return {"row_count": len(staged), "warnings": warnings}


def pair_coverage(conn: sqlite3.Connection, loans_file_id: str, history_file_id: str) -> dict:
    """Join controls for a portfolio against pinned history. Orphans block validation."""
    q = lambda sql: conn.execute(sql, (loans_file_id, history_file_id)).fetchone()[0]
    loans = conn.execute("SELECT COUNT(*) FROM source_loans WHERE file_id=?", (loans_file_id,)).fetchone()[0]
    requests = conn.execute("SELECT COUNT(*) FROM source_requests WHERE file_id=?", (history_file_id,)).fetchone()[0]
    with_history = q("""SELECT COUNT(*) FROM source_loans l WHERE l.file_id=? AND EXISTS
                        (SELECT 1 FROM source_requests r WHERE r.file_id=? AND r.loan_id=l.loan_id)""")
    orphan_rows = conn.execute(
        """SELECT COUNT(*), COUNT(DISTINCT r.loan_id) FROM source_requests r WHERE r.file_id=? AND NOT EXISTS
           (SELECT 1 FROM source_loans l WHERE l.file_id=? AND l.loan_id=r.loan_id)""",
        (history_file_id, loans_file_id)).fetchone()
    outstanding = conn.execute("SELECT COALESCE(SUM(total_amount_outstanding_cents),0) FROM source_loans WHERE file_id=?",
                               (loans_file_id,)).fetchone()[0]
    batches = conn.execute("SELECT COUNT(*) FROM (SELECT DISTINCT loan_id, created_us FROM source_requests WHERE file_id=?)",
                           (history_file_id,)).fetchone()[0]
    requested = conn.execute("SELECT COALESCE(SUM(amount_cents),0) FROM source_requests WHERE file_id=?",
                             (history_file_id,)).fetchone()[0]
    return {"loans": loans, "requests": requests, "loans_with_history": with_history,
            "loans_without_history": loans - with_history, "orphan_request_rows": orphan_rows[0],
            "orphan_loan_ids": orphan_rows[1], "collection_batches": batches,
            "outstanding_cents": outstanding, "requested_cents": requested}

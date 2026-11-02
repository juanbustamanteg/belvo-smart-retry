"""Synthetic fixtures for rule branches absent from, or rare in, the original sample.

These exercise the authoritative SQL directly. They never replace the original-data regression.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from server import db, engine, ingest

LOAN_HEADER = "loan_id,payment_method_bank,loan_amount,total_amount_outstanding,overdue_at,overdue_days\n"
REQ_HEADER = "payment_request_id,created_at,completed_at,chargeback_at,status,amount,failed_reason,failed_message,loan_id\n"
SOFT = ("failed", "4", "Cuenta con insuficiencia de fondos")


def req(loan, created, completed, status="failed", amount="100", reason="4", message="Cuenta con insuficiencia de fondos",
        chargeback=""):
    return f"{uuid.uuid4()},{created},{completed},{chargeback},{status},{amount},{reason},{message},{loan}\n"


def classify(tmp_path: Path, loans: dict[str, str], requests: list[str], cooldown=7):
    conn = db.connect(tmp_path / "f.sqlite3")
    db.migrate(conn)
    lp, rp = tmp_path / "loans.csv", tmp_path / "req.csv"
    lp.write_text(LOAN_HEADER + "".join(f"{k},mx_test,100,{v},1/1/2025,10\n" for k, v in loans.items()))
    rp.write_text(REQ_HEADER + "".join(requests))
    uid = str(uuid.uuid4())
    with db.transaction(conn):
        conn.execute("INSERT INTO users VALUES (?,?,?,?,?)", (uid, "u", "operator", "x", "t"))
        for fid, kind, p in (("L", "loans_portfolio", lp), ("H", "requests_history", rp)):
            conn.execute("""INSERT INTO source_files (id, kind, workspace, original_name, storage_path, sha256, size_bytes, status,
                            imported_at) VALUES (?,?,?,?,?,?,?,?,?)""", (fid, kind, "w", p.name, str(p), "x", 1, "staged", "t"))
        ingest.stage_portfolio(conn, "L", lp)
        ingest.stage_history(conn, "H", rp)
        conn.execute("INSERT INTO analyses VALUES ('A','w',?,'t')", (uid,))
        conn.execute("""INSERT INTO runs (id, analysis_id, revision_no, status, cooldown_days, evaluated_at, business_timezone,
                        rule_version, master_sha256, created_by, created_at) VALUES ('R','A',1,'Running',?,?,?,?,?,?,?)""",
                     (cooldown, "e", "tz", "minimal-v1", "m", uid, "t"))
        engine.classify(conn, "R", "L", "H", cooldown)
    out = {r["loan_id"]: dict(r) for r in conn.execute("SELECT * FROM loan_decisions WHERE run_id='R'")}
    conn.close()
    return out


def pick(result, loan):
    r = result[loan]
    return r["decision"], r["reason_code"]


pytestmark = [pytest.mark.kind("synthetic_fixture")]


@pytest.mark.criteria("C07", "EC07")
def test_seven_day_boundary_and_local_midnight(tmp_path, evidence):
    res = classify(tmp_path, {"a": "100", "b": "100", "c": "100", "d": "100"}, [
        req("a", "2025-11-03T15:00:00Z", "2025-11-04T15:00:00Z"),   # anchor 11-04 -> 7 days
        req("b", "2025-11-04T15:00:00Z", "2025-11-05T15:00:00Z"),   # anchor 11-05 -> 6 days
        req("c", "2025-11-03T15:00:00Z", "2025-11-05T05:30:00Z"),   # 23:30 local on 11-04 -> 7 days
        req("d", "2025-11-01T15:00:00Z", "2025-11-06T15:00:00Z"),   # completion later than creation -> 5 days
    ])
    actual = {k: (pick(res, k), res[k]["days_since_anchor"]) for k in "abcd"}
    evidence.update(expected={"a": "RETRY 7", "b": "WAIT 6", "c": "RETRY 7", "d": "WAIT 5"}, actual=actual,
                    configuration={"cooldown_days": 7})
    assert pick(res, "a") == ("RETRY", "SOFT_FAILURE_WINDOW_ELAPSED") and res["a"]["days_since_anchor"] == 7
    assert pick(res, "b") == ("WAIT", "COOLDOWN") and res["b"]["days_since_anchor"] == 6
    assert pick(res, "c") == ("RETRY", "SOFT_FAILURE_WINDOW_ELAPSED")
    assert pick(res, "d") == ("WAIT", "COOLDOWN") and res["d"]["days_since_anchor"] == 5
    assert res["b"]["next_check_day"] - res["b"]["cooldown_anchor_day"] == 7


@pytest.mark.criteria("C06", "E06", "EC04")
def test_ordered_review_reasons_precede_cooldown(tmp_path, evidence):
    old = ("2025-09-01T15:00:00Z", "2025-09-02T15:00:00Z")
    res = classify(tmp_path, {k: "100" for k in ["cb", "succ", "mixed", "dup", "code03", "nullr", "unk", "badst"]}, [
        req("cb", *old, status="chargeback", reason="", message="", chargeback="2025-09-10T15:00:00Z"),
        req("cb", *old, amount="50"),
        req("succ", *old, status="successful", reason="", message=""),
        req("mixed", *old), req("mixed", *old, amount="200", reason="3", message="Cuenta cancelada"),
        req("dup", *old), req("dup", *old),
        req("code03", *old, reason="3", message="Cuenta cancelada"),
        req("nullr", *old, reason="", message=""),
        req("unk", *old, reason="unmapped_code"),
        req("badst", *old, status="pending"),
    ])
    expected = {"cb": "LATEST_CHARGEBACK", "succ": "LATEST_SUCCESS_RECONCILE", "mixed": "AMBIGUOUS_LATEST_BATCH",
                "dup": "AMBIGUOUS_LATEST_BATCH", "code03": "ACCOUNT_AUTH_OR_UNKNOWN_REASON",
                "nullr": "ACCOUNT_AUTH_OR_UNKNOWN_REASON", "unk": "ACCOUNT_AUTH_OR_UNKNOWN_REASON",
                "badst": "ACCOUNT_AUTH_OR_UNKNOWN_REASON"}
    actual = {k: pick(res, k)[1] for k in expected}
    evidence.update(expected=expected, actual=actual)
    assert actual == expected
    assert all(res[k]["decision"] == "REVIEW_REMEDIATE" and res[k]["next_check_day"] is None for k in expected)
    assert res["dup"]["last_batch_rows"] == 2 and res["mixed"]["last_batch_rows"] == 2


@pytest.mark.criteria("C03", "EC03")
def test_balance_and_no_history_come_first(tmp_path, evidence):
    old = ("2025-09-01T15:00:00Z", "2025-09-02T15:00:00Z")
    res = classify(tmp_path, {"zero": "0", "neg": "-5", "empty": "", "nohist": "100"},
                   [req("zero", *old), req("neg", *old), req("empty", *old)])
    actual = {k: pick(res, k)[1] for k in res}
    evidence.update(expected={"zero": "INVALID_BALANCE", "neg": "INVALID_BALANCE", "empty": "INVALID_BALANCE",
                              "nohist": "NO_HISTORY"}, actual=actual)
    assert actual == {"zero": "INVALID_BALANCE", "neg": "INVALID_BALANCE", "empty": "INVALID_BALANCE", "nohist": "NO_HISTORY"}
    assert res["nohist"]["last_batch_rows"] == 0 and res["nohist"]["source_payment_request_ids"] == "[]"


@pytest.mark.criteria("C07", "EC06")
def test_invalid_latest_timing_overrides_cooldown(tmp_path, evidence):
    res = classify(tmp_path, {k: "100" for k in ["nocomp", "before", "future", "cbbefore", "badcomp"]}, [
        req("nocomp", "2025-09-01T15:00:00Z", ""),
        req("before", "2025-09-02T15:00:00Z", "2025-09-01T15:00:00Z"),
        req("future", "2025-11-10T15:00:00Z", "2025-11-12T07:00:00Z"),
        req("cbbefore", "2025-09-01T15:00:00Z", "2025-09-02T15:00:00Z", chargeback="2025-09-01T16:00:00Z"),
        req("badcomp", "2025-09-01T15:00:00Z", "not-a-date"),
    ])
    actual = {k: pick(res, k)[1] for k in res}
    evidence.update(expected={k: "INVALID_TIMESTAMP" for k in res}, actual=actual)
    assert set(actual.values()) == {"INVALID_TIMESTAMP"}
    assert all(res[k]["cooldown_anchor_day"] is None for k in res)


@pytest.mark.criteria("C04", "C05", "EC05")
def test_equal_instants_with_different_offsets_form_one_batch(tmp_path, evidence):
    res = classify(tmp_path, {"x": "100"}, [
        req("x", "2025-09-01T15:00:00Z", "2025-09-02T15:00:00Z", amount="100"),
        req("x", "2025-09-01T09:00:00-06:00", "2025-09-02T15:00:00Z", amount="250"),
        req("x", "2025-08-01T15:00:00Z", "2025-08-02T15:00:00Z", amount="999", reason="3", message="Cuenta cancelada"),
    ])
    evidence.update(expected={"rows": 2, "decision": "RETRY"}, actual={"rows": res["x"]["last_batch_rows"], "decision": pick(res, "x")})
    assert res["x"]["last_batch_rows"] == 2
    assert pick(res, "x") == ("RETRY", "SOFT_FAILURE_WINDOW_ELAPSED")


@pytest.mark.criteria("C11", "EC01", "EC09")
@pytest.mark.parametrize("content,code", [
    ("loan_id,payment_method_bank\n1,mx\n", "INPUT_SCHEMA_INVALID"),
    (LOAN_HEADER + "1,mx,100,100,1/1/2025,1\n1,mx,100,100,1/1/2025,1\n", "INPUT_ROWS_INVALID"),
    (LOAN_HEADER + "1,mx,100,10.123,1/1/2025,1\n", "INPUT_ROWS_INVALID"),
    (LOAN_HEADER + "1,mx,100,abc,1/1/2025,1\n", "INPUT_ROWS_INVALID"),
    (LOAN_HEADER + "1 2,mx,100,100,1/1/2025,1\n", "INPUT_ROWS_INVALID"),
    (LOAN_HEADER + "1,mx,100,100,1/1/2025\n", "INPUT_MALFORMED"),
    (LOAN_HEADER + "1,mx,100,1e30,1/1/2025,1\n", "INPUT_ROWS_INVALID"),
])
def test_portfolio_intake_rejects_bad_input(tmp_path, content, code, evidence):
    conn = db.connect(tmp_path / "i.sqlite3")
    db.migrate(conn)
    p = tmp_path / "l.csv"
    p.write_text(content)
    with db.transaction(conn):
        conn.execute("""INSERT INTO source_files (id, kind, workspace, original_name, storage_path, sha256, size_bytes, status,
                        imported_at) VALUES ('L','loans_portfolio','w','l','x','x',1,'uploaded','t')""")
    with pytest.raises(ingest.IntakeError) as err:
        with db.transaction(conn):
            ingest.stage_portfolio(conn, "L", p)
    evidence.update(expected={"code": code}, actual={"code": err.value.code})
    assert err.value.code == code
    assert conn.execute("SELECT COUNT(*) FROM source_loans").fetchone()[0] == 0


@pytest.mark.kind("unit")
@pytest.mark.criteria("EC09")
def test_exact_money_parsing(evidence):
    assert ingest.parse_money_cents("242.5") == 24250
    assert ingest.parse_money_cents("1520") == 152000
    assert ingest.parse_money_cents("0.10") == 10
    for bad in ("1.001", "nan", "inf", "", "1,000"):
        with pytest.raises(ValueError):
            ingest.parse_money_cents(bad)
    assert ingest.normalize_code("4") == "04" and ingest.normalize_code("") is None
    assert ingest.normalize_code("unmapped_code") == "unmapped_code"
    evidence.update(expected={"242.5": 24250}, actual={"242.5": ingest.parse_money_cents("242.5")})

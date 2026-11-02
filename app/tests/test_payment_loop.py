"""Payment request file, response import and follow-up analysis (master section 8, D34)."""
from __future__ import annotations

import csv
import io
import subprocess
import sys
from decimal import Decimal

import pytest

from conftest import APP, REQUESTS_CSV

pytestmark = [pytest.mark.kind("api")]
COLUMNS = ["payment_request_id", "created_at", "completed_at", "chargeback_at", "status", "amount",
           "failed_reason", "failed_message", "loan_id"]


def approved(portal, cooldown=7):
    op, rv = portal["operator"], portal["reviewer"]
    run = op.post(op.ready_run(cooldown), "submit").json()
    return rv.post(run, "review", {"action": "approve"}).json()


def rows_of(text):
    return list(csv.DictReader(io.StringIO(text)))


def simulate(tmp_path, requests_text, seed=7):
    src, out = tmp_path / "requests.csv", tmp_path / "SYNTHETIC_responses.csv"
    src.write_text(requests_text, newline="")
    subprocess.run([sys.executable, str(APP / "tools" / "simulate_bank_responses.py"), str(src), "-o", str(out),
                    "--seed", str(seed), "--history", str(REQUESTS_CSV)], check=True, capture_output=True)
    return out.read_bytes()


def import_responses(op, run, content: bytes, origin="synthetic_demo"):
    return op.client.put(f"/api/v1/runs/{run['run_id']}/payment-requests/responses",
                         files={"responses_file": ("responses.csv", content, "text/csv")}, data={"origin": origin},
                         headers=op.h())


@pytest.mark.criteria("C10", "E04", "D36")
def test_requests_are_drafted_with_results_and_released_only_by_approval(portal, tmp_path, evidence):
    op, rv = portal["operator"], portal["reviewer"]
    ready = op.ready_run(7)
    rid = ready["run_id"]
    draft = op.get(f"/runs/{rid}/payment-requests").json()
    csv_draft = op.get(f"/runs/{rid}/payment-requests.csv").status_code
    import_draft = import_responses(op, ready, b"x").json()["error"]["code"]
    no_prepare_endpoint = op.client.post(f"/api/v1/runs/{rid}/payment-requests", json={"confirm": True}, headers=op.h()).status_code
    submitted = op.post(ready, "submit").json()
    reviewer_view = rv.get(f"/runs/{rid}").json()["payment_requests"]
    approved_run = rv.post(submitted, "review", {"action": "approve"}).json()
    released = approved_run["payment_requests"]
    csv_released = op.get(f"/runs/{rid}/payment-requests.csv").status_code

    returned = op.post(op.ready_run(7), "submit").json()
    returned = rv.post(returned, "review", {"action": "return", "comment": "Not yet"}).json()
    actual = {"draft_status": draft["status"], "draft_requests": draft["requests"], "csv_draft": csv_draft,
              "import_draft": import_draft, "no_prepare_endpoint": no_prepare_endpoint,
              "reviewer_sees_total": reviewer_view["total_amount"] == draft["total_amount"],
              "released_status": released["status"], "released_by": released["released_by"], "csv_released": csv_released,
              "returned_status": returned["payment_requests"]["status"]}
    expected = {"draft_status": "Draft", "draft_requests": 1200, "csv_draft": 409, "import_draft": "NOT_RELEASED",
                "no_prepare_endpoint": 405, "reviewer_sees_total": True, "released_status": "Released",
                "released_by": "reviewer", "csv_released": 200, "returned_status": "Draft"}
    evidence.update(expected=expected, actual=actual)
    assert actual == expected
    assert "download_payment_requests" in approved_run["permitted_actions"]
    assert released["sent_by_mvp"] is False


@pytest.mark.criteria("D34", "EC09")
def test_split_file_format_and_reconciliation(portal, evidence):
    op = portal["operator"]
    run = approved(portal)
    summary = op.get(f"/runs/{run['run_id']}/payment-requests").json()
    r = op.get(f"/runs/{run['run_id']}/payment-requests.csv")
    raw = r.text
    rows = rows_of(raw)
    retry = {}
    page = 1
    while True:
        body = op.get(f"/runs/{run['run_id']}/decisions?decision=RETRY&page_size=100&page={page}").json()
        retry.update({d["loan_id"]: Decimal(d["total_amount_outstanding"]) for d in body["items"]})
        if len(retry) >= body["total"]:
            break
        page += 1
    by_loan = {}
    for x in rows:
        by_loan.setdefault(x["loan_id"], []).append(Decimal(x["amount"]))
    bad_sum = [k for k, v in by_loan.items() if sum(v) != retry[k]]
    bad_split = [k for k, v in by_loan.items() if sorted(v)[0] != (retry[k] * Decimal("0.05")).quantize(Decimal("0.01"), rounding="ROUND_FLOOR")
                 or sorted(v)[1] != (retry[k] * Decimal("0.25")).quantize(Decimal("0.01"), rounding="ROUND_FLOOR")]
    evidence.update(expected={"requests": 1200, "loans": 400, "bad_sum": 0, "bad_split": 0},
                    actual={"requests": len(rows), "loans": len(by_loan), "bad_sum": len(bad_sum), "bad_split": len(bad_split),
                            "total": summary["total_amount"]})
    assert raw.splitlines()[0] == ",".join(COLUMNS) and "\r\n" in raw
    assert len(rows) == 1200 and set(by_loan) == set(retry) and all(len(v) == 3 for v in by_loan.values())
    assert not bad_sum and not bad_split
    assert all(len(set(v)) == 3 and min(v) > 0 for v in by_loan.values())
    assert {x["status"] for x in rows} == {"pending"}
    assert {x["completed_at"] + x["chargeback_at"] + x["failed_reason"] + x["failed_message"] for x in rows} == {""}
    assert {x["created_at"] for x in rows} == {"2025-11-12T15:00:00.000Z"}
    assert Decimal(summary["total_amount"]) == sum(retry.values())
    assert len({x["payment_request_id"] for x in rows}) == 1200


@pytest.mark.criteria("D34", "C11")
def test_response_import_rejects_incomplete_or_mismatched_files(portal, tmp_path, evidence):
    op = portal["operator"]
    run = approved(portal)
    requests_text = op.get(f"/runs/{run['run_id']}/payment-requests.csv").text
    good = simulate(tmp_path, requests_text)
    lines = good.decode().split("\r\n")
    header, body = lines[0], [l for l in lines[1:] if l]
    partial = ("\r\n".join([header] + body[:-1]) + "\r\n").encode()
    first = rows_of(good.decode())[0]
    tampered = good.decode().replace(f"{first['payment_request_id']},{first['created_at']},{first['completed_at']},,{first['status']},{first['amount']}",
                                     f"{first['payment_request_id']},{first['created_at']},{first['completed_at']},,{first['status']},1.00", 1).encode()
    pending = good.decode().replace(",failed,", ",pending,", 1).encode()
    unknown = good.decode().replace(first["payment_request_id"], "00000000-0000-0000-0000-000000000000", 1).encode()
    codes = {name: import_responses(op, run, c).json()["error"]["code"]
             for name, c in [("partial", partial), ("tampered", tampered), ("pending", pending), ("unknown", unknown)]}
    still = op.get(f"/runs/{run['run_id']}/payment-requests").json()["status"]
    history_rows = op.get("/workspace").json()["history"]["row_count"]
    evidence.update(expected={k: "RESPONSES_INVALID" for k in codes} | {"status": "Released", "history_rows": 253006},
                    actual=codes | {"status": still, "history_rows": history_rows})
    assert set(codes.values()) == {"RESPONSES_INVALID"}
    assert still == "Released" and history_rows == 253006


@pytest.mark.criteria("D34", "E07", "C09")
def test_closed_loop_follow_up_analysis(portal, tmp_path, evidence):
    op, rv = portal["operator"], portal["reviewer"]
    run = approved(portal)
    requests_text = op.get(f"/runs/{run['run_id']}/payment-requests.csv").text
    responses = simulate(tmp_path, requests_text, seed=7)
    resp_rows = rows_of(responses.decode())
    r = import_responses(op, run, responses)
    assert r.status_code == 200, r.text
    summary = r.json()
    again = import_responses(op, run, responses, origin="bank").json()["error"]["code"]
    ws = op.get("/workspace").json()

    run = op.run(run["run_id"])
    follow = op.client.post(f"/api/v1/runs/{run['run_id']}/revisions",
                            json={"cooldown_days": 7, "use_latest_history": True}, headers=op.h(run["version"])).json()
    follow = op.post(follow, "validate").json()
    follow = op.wait(follow["run_id"])
    follow = op.post(follow, "execute").json()
    follow = op.wait(follow["run_id"])
    assert follow["status"] == "Ready", follow

    by_loan = {}
    for x in resp_rows:
        by_loan[x["loan_id"]] = (x["status"], x["failed_reason"])
    checks = {}
    for loan, (status, code) in list(by_loan.items()):
        d = op.get(f"/runs/{follow['run_id']}/loans/{loan}").json()
        checks.setdefault((status, code), set()).add(d["reason_code"])
    expected_map = {"successful": {"LATEST_SUCCESS_RECONCILE"}, "chargeback": {"LATEST_CHARGEBACK"}}
    original = op.run(run["run_id"])
    evidence.update(expected={"history_rows": 254206, "evaluated_day": "2025-11-14", "origin": "synthetic_demo"},
                    actual={"history_rows": ws["history"]["row_count"], "evaluated_at": follow["configuration"]["evaluated_at"],
                            "origin": ws["history"]["origin"], "outcomes": summary["responses"]["outcomes"],
                            "follow_totals": follow["totals"], "reasons_by_outcome": {f"{k[0]}:{k[1]}": sorted(v) for k, v in checks.items()}})
    assert again == "ALREADY_RESPONDED"
    assert ws["history"]["row_count"] == 253006 + 1200 and ws["history"]["origin"] == "synthetic_demo"
    assert follow["configuration"]["evaluated_at"] == "2025-11-14T23:59:59-06:00"
    assert follow["sources"]["history"]["dataset_id"] == summary["responses"]["history_dataset_id"]
    assert original["sources"]["history"]["origin"] == "original"  # approved run keeps its pinned history
    for (status, code), reasons in checks.items():
        if status in expected_map:
            assert reasons == expected_map[status]
        elif code.strip().lstrip("0") == "4":
            assert reasons == {"COOLDOWN"}  # failed on 2025-11-14, evaluated the same day
        else:
            assert reasons == {"ACCOUNT_AUTH_OR_UNKNOWN_REASON"}
    assert summary["responses"]["outcomes"]["loans_with_mixed_outcomes"] == 0

    follow = op.post(follow, "submit").json()
    follow = rv.post(follow, "review", {"action": "approve"}).json()
    export = rows_of(op.get(f"/runs/{follow['run_id']}/results.csv").text)
    assert {x["dataset_kind"] for x in export} == {"synthetic_demo"}
    assert {x["payment_request_status"] for x in export if x["decision"] == "RETRY"} <= {"RELEASED"}
    # The first run's results now show RESPONDED and cross-reference the request file exactly.
    first = rows_of(op.get(f"/runs/{run['run_id']}/results.csv").text)
    req_ids = {x["loan_id"]: [y["payment_request_id"] for y in rows_of(requests_text) if y["loan_id"] == x["loan_id"]]
               for x in first if x["decision"] == "RETRY"}
    assert {x["payment_request_status"] for x in first if x["decision"] == "RETRY"} == {"RESPONDED"}
    assert all(__import__("json").loads(x["payment_request_ids"]) == req_ids[x["loan_id"]] for x in first if x["decision"] == "RETRY")
    assert {x["evaluated_at"] for x in export} == {"2025-11-14T23:59:59-06:00"}


@pytest.mark.criteria("D34", "C06")
def test_success_and_chargeback_responses_route_to_review(portal, tmp_path, evidence):
    op = portal["operator"]
    run = approved(portal)
    rows = rows_of(simulate(tmp_path, op.get(f"/runs/{run['run_id']}/payment-requests.csv").text).decode())
    loans = sorted({x["loan_id"] for x in rows})
    paid, reversed_, other = loans[0], loans[1], loans[2]
    for x in rows:
        if x["loan_id"] == paid:
            x.update(status="successful", failed_reason="", failed_message="")
        if x["loan_id"] == reversed_:
            x.update(status="chargeback", failed_reason="", failed_message="", chargeback_at="2025-11-17T16:00:00.000Z")
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator="\r\n")
    w.writeheader()
    w.writerows(rows)
    r = import_responses(op, run, buf.getvalue().encode(), origin="bank")
    assert r.status_code == 200, r.text
    run = op.run(run["run_id"])
    follow = op.client.post(f"/api/v1/runs/{run['run_id']}/revisions", json={"cooldown_days": 7, "use_latest_history": True},
                            headers=op.h(run["version"])).json()
    follow = op.wait(op.post(follow, "validate").json()["run_id"])
    follow = op.wait(op.post(follow, "execute").json()["run_id"])
    got = {k: op.get(f"/runs/{follow['run_id']}/loans/{k}").json() for k in (paid, reversed_, other)}
    actual = {"paid": got[paid]["reason_code"], "reversed": got[reversed_]["reason_code"],
              "paid_debt_unchanged": got[paid]["total_amount_outstanding"], "evaluated_at": follow["configuration"]["evaluated_at"],
              "origin": follow["sources"]["history"]["origin"]}
    evidence.update(expected={"paid": "LATEST_SUCCESS_RECONCILE", "reversed": "LATEST_CHARGEBACK",
                              "evaluated_at": "2025-11-17T23:59:59-06:00", "origin": "bank"}, actual=actual)
    assert actual["paid"] == "LATEST_SUCCESS_RECONCILE" and actual["reversed"] == "LATEST_CHARGEBACK"
    assert actual["evaluated_at"] == "2025-11-17T23:59:59-06:00"  # chargeback is the latest response event
    assert actual["origin"] == "bank"
    before = op.get(f"/runs/{run['run_id']}/loans/{paid}").json()["total_amount_outstanding"]
    assert actual["paid_debt_unchanged"] == before  # snapshot is never reduced by a successful response


@pytest.mark.kind("unit")
@pytest.mark.criteria("D36")
def test_migration_003_releases_legacy_prepared_sets(tmp_path, evidence):
    from server import db
    conn = db.connect(tmp_path / "legacy.sqlite3")
    full = db.MIGRATIONS
    try:
        db.MIGRATIONS = full[:2]
        db.migrate(conn)
    finally:
        db.MIGRATIONS = full
    conn.executescript("""
      INSERT INTO users VALUES ('op','operator','operator','x','t'), ('rv','reviewer','reviewer','x','t');
      INSERT INTO analyses VALUES ('A','w','op','t');
      INSERT INTO runs (id, analysis_id, revision_no, status, cooldown_days, evaluated_at, business_timezone, rule_version,
                        master_sha256, created_by, created_at, reviewed_by, reviewed_at)
        VALUES ('R','A',1,'Approved',7,'e','tz','minimal-v1','m','op','t','rv','t2');
      INSERT INTO payment_request_sets (id, run_id, created_by, created_at, requested_at_us, loan_count, request_count,
                                        total_cents, status) VALUES ('S','R','op','t3',1,1,3,300,'Prepared');
      INSERT INTO outbound_requests VALUES ('S','p1','L',5,15), ('S','p2','L',25,75), ('S','p3','L',70,210);
    """)
    db.migrate(conn)
    row = dict(conn.execute("SELECT status, released_by, released_at FROM payment_request_sets").fetchone())
    children = conn.execute("SELECT COUNT(*) FROM outbound_requests WHERE set_id='S'").fetchone()[0]
    fk = conn.execute("PRAGMA foreign_key_check").fetchall()
    evidence.update(expected={"status": "Released", "released_by": "rv", "children": 3, "fk": 0},
                    actual={**row, "children": children, "fk": len(fk)})
    assert row["status"] == "Released" and row["released_by"] == "rv" and children == 3 and not fk

"""Fatigue rest rule (D38), retry ordering (D40) and holdout experiment (D39)."""
from __future__ import annotations

import collections
import csv
import datetime as dt
import io
import subprocess
import sys
from decimal import Decimal

import pytest

from conftest import APP, LOANS_CSV, REQUESTS_CSV, Portal
from test_rules_fixtures import classify as classify_fixture, req

pytestmark = [pytest.mark.kind("original_regression")]

# Fatigue 20 with a 30-day rest (golden values for the original pair, minimal-v2).
FATIGUE_GOLDEN = {7: {"RETRY": 398, "WAIT": 1951, "REVIEW_REMEDIATE": 713, "FATIGUE_REST": 1623},
                  3: {"RETRY": 402, "WAIT": 1947, "REVIEW_REMEDIATE": 713, "FATIGUE_REST": 1623},
                  14: {"RETRY": 395, "WAIT": 1954, "REVIEW_REMEDIATE": 713, "FATIGUE_REST": 1623}}


def ready(op, cooldown=7, fatigue=None, holdout=0, content=None):
    r = op.client.post("/api/v1/runs", json={"cooldown_days": cooldown, "fatigue_attempts": fatigue, "holdout_pct": holdout},
                       headers=op.h())
    assert r.status_code == 201, r.text
    run = op.upload(r.json(), content or LOANS_CSV.read_bytes()).json()
    run = op.wait(op.post(run, "validate").json()["run_id"])
    return op.wait(op.post(run, "execute").json()["run_id"])


def all_rows(op, run_id, decision=None):
    out, page = [], 1
    while True:
        q = f"/runs/{run_id}/decisions?page={page}&page_size=100" + (f"&decision={decision}" if decision else "")
        body = op.get(q).json()
        out += body["items"]
        if len(out) >= body["total"]:
            return out
        page += 1


def python_streaks():
    """Independent oracle: consecutive all-code-04 batches counted back from the latest batch."""
    batches = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in csv.DictReader(REQUESTS_CSV.open()):
        batches[r["loan_id"]][dt.datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))].append(r)
    out = {}
    for loan, bs in batches.items():
        n = 0
        for k in sorted(bs, reverse=True):
            if all(x["status"] == "failed" and x["failed_reason"].strip().lstrip("0") == "4" for x in bs[k]):
                n += 1
            else:
                break
        out[loan] = n
    return out


@pytest.mark.criteria("C05", "C08", "D38")
def test_fatigue_rest_golden_and_streak_oracle(portal, evidence):
    op = portal["operator"]
    off = ready(op, 7, None)
    on = ready(op, 7, 20)
    rows_off = {r["loan_id"]: r for r in all_rows(op, off["run_id"])}
    rows_on = {r["loan_id"]: r for r in all_rows(op, on["run_id"])}
    reasons = op.get(f"/runs/{on['run_id']}/summary").json()["reasons"]
    oracle = python_streaks()
    mismatches = [k for k, r in rows_on.items() if r["consecutive_soft_failures"] != oracle.get(k, 0)]
    actual = {"off": {d: off["totals"][d] for d in ("RETRY", "WAIT", "REVIEW_REMEDIATE")},
              "on": {**{d: on["totals"][d] for d in ("RETRY", "WAIT", "REVIEW_REMEDIATE")}, "FATIGUE_REST": reasons.get("FATIGUE_REST", 0)},
              "streak_mismatches": len(mismatches)}
    evidence.update(expected={"off": {"RETRY": 400, "WAIT": 1949, "REVIEW_REMEDIATE": 713}, "on": FATIGUE_GOLDEN[7],
                              "streak_mismatches": 0}, actual=actual, configuration={"cooldown_days": 7, "fatigue_attempts": 20})
    assert actual["off"] == {"RETRY": 400, "WAIT": 1949, "REVIEW_REMEDIATE": 713}
    assert actual["on"] == FATIGUE_GOLDEN[7]
    assert not mismatches
    # Review population never changes; fatigue only lengthens waits.
    assert {k for k, r in rows_off.items() if r["decision"] == "REVIEW_REMEDIATE"} == \
           {k for k, r in rows_on.items() if r["decision"] == "REVIEW_REMEDIATE"}
    assert {k for k, r in rows_on.items() if r["decision"] == "RETRY"} <= {k for k, r in rows_off.items() if r["decision"] == "RETRY"}
    rest = [r for r in rows_on.values() if r["reason_code"] == "FATIGUE_REST"]
    assert all(r["consecutive_soft_failures"] >= 20 and r["days_since_anchor"] < 30 for r in rest)
    assert all(dt.date.fromisoformat(r["next_check_date"]) - dt.date.fromisoformat(r["cooldown_anchor_date"]) == dt.timedelta(days=30)
               for r in rest)


@pytest.mark.kind("synthetic_fixture")
@pytest.mark.criteria("C07", "D38")
def test_fatigue_boundaries(tmp_path, evidence):
    def streak(loan, n, last_completed):
        out = []
        for i in range(n):
            day = dt.date(2025, 6, 1) + dt.timedelta(days=i)
            out.append(req(loan, f"{day}T15:00:00Z", f"{day}T16:00:00Z"))
        out.append(req(loan, last_completed.replace("16:00", "15:00"), last_completed))
        return out
    reqs = (streak("at19", 18, "2025-10-30T16:00:00Z")      # 19 in a row, 12 days ago -> normal cooldown -> RETRY
            + streak("at20", 19, "2025-10-30T16:00:00Z")    # 20 in a row, 12 days ago -> rest -> WAIT
            + streak("rested", 19, "2025-10-12T16:00:00Z")  # 20 in a row, exactly 30 days ago -> RETRY
            + [req("broken", "2025-05-01T15:00:00Z", "2025-05-01T16:00:00Z", status="successful", reason="", message="")]
            + streak("broken", 4, "2025-10-30T16:00:00Z"))  # success resets the streak
    res = classify_fixture(tmp_path, {k: "100" for k in ("at19", "at20", "rested", "broken")}, reqs)
    # classify_fixture runs with fatigue off; rerun the SQL with fatigue on through the engine.
    from server import db, engine
    conn = db.connect(tmp_path / "f.sqlite3")
    with db.transaction(conn):
        conn.execute("DELETE FROM loan_decisions WHERE run_id='R'")
        engine.classify(conn, "R", "L", "H", 7, fatigue=20)
    on = {r["loan_id"]: (r["decision"], r["reason_code"], r["consecutive_soft_failures"]) for r in
          conn.execute("SELECT * FROM loan_decisions WHERE run_id='R'")}
    expected = {"at19": ("RETRY", "SOFT_FAILURE_WINDOW_ELAPSED", 19), "at20": ("WAIT", "FATIGUE_REST", 20),
                "rested": ("RETRY", "SOFT_FAILURE_WINDOW_ELAPSED", 20), "broken": ("RETRY", "SOFT_FAILURE_WINDOW_ELAPSED", 5)}
    evidence.update(expected={k: list(v) for k, v in expected.items()}, actual={k: list(v) for k, v in on.items()})
    assert on == expected
    assert res["at20"]["decision"] == "RETRY"  # without the rule it would be retried


@pytest.mark.criteria("DMO04", "D40")
def test_retry_queue_puts_previous_payers_first(portal, evidence):
    op = portal["operator"]
    run = ready(op, 7, 20)
    rows = all_rows(op, run["run_id"], "RETRY")
    flags = [r["last_success_at"] is not None for r in rows]
    first_never = flags.index(False)
    payers = rows[:first_never]
    evidence.update(expected={"payers_first": True}, actual={"payers": first_never, "total": len(rows)})
    assert all(flags[:first_never]) and not any(flags[first_never:])
    assert [r["last_success_at"] for r in payers] == sorted((r["last_success_at"] for r in payers), reverse=True)
    never = [r["consecutive_soft_failures"] for r in rows[first_never:]]
    assert never == sorted(never)


@pytest.mark.kind("api")
@pytest.mark.criteria("D39", "C10")
def test_holdout_assignment_requests_csv_and_measurement(portal, tmp_path, evidence):
    op, rv = portal["operator"], portal["reviewer"]
    run = ready(op, 7, 20, holdout=10)
    rid = run["run_id"]
    pset = op.get(f"/runs/{rid}/payment-requests").json()
    rows = all_rows(op, rid, "RETRY")
    control = {r["loan_id"] for r in rows if r["experiment_arm"] == "control"}
    treatment = {r["loan_id"] for r in rows if r["experiment_arm"] == "treatment"}
    run = rv.post(op.post(run, "submit").json(), "review", {"action": "approve"}).json()
    req_text = op.get(f"/runs/{rid}/payment-requests.csv").text
    req_loans = {x["loan_id"] for x in csv.DictReader(io.StringIO(req_text))}
    export = list(csv.DictReader(io.StringIO(op.get(f"/runs/{rid}/results.csv").text)))
    statuses = collections.Counter((x["decision"], x["payment_request_status"]) for x in export)

    # Responses with two forced successes, plus the synthetic next snapshot that reflects them.
    src, out, nxt = tmp_path / "req.csv", tmp_path / "resp.csv", tmp_path / "next.csv"
    src.write_text(req_text, newline="")
    subprocess.run([sys.executable, str(APP / "tools" / "simulate_bank_responses.py"), str(src), "-o", str(out),
                    "--history", str(REQUESTS_CSV)], check=True, capture_output=True)
    resp = list(csv.DictReader(out.open()))
    paid = sorted(treatment)[:2]
    for x in resp:
        if x["loan_id"] in paid:
            x.update(status="successful", failed_reason="", failed_message="")
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(resp[0].keys()), lineterminator="\r\n")
    w.writeheader()
    w.writerows(resp)
    r = op.client.put(f"/api/v1/runs/{rid}/payment-requests/responses", files={"responses_file": ("r.csv", buf.getvalue(), "text/csv")},
                      data={"origin": "synthetic_demo"}, headers=op.h())
    assert r.status_code == 200, r.text
    exp_before = op.get(f"/runs/{rid}/experiment").json()

    loans = list(csv.DictReader(LOANS_CSV.open()))
    collected = collections.Counter()
    for x in resp:
        if x["status"] == "successful":
            collected[x["loan_id"]] += Decimal(x["amount"])
    for l in loans:
        if collected[l["loan_id"]]:
            l["total_amount_outstanding"] = f"{Decimal(l['total_amount_outstanding']) - collected[l['loan_id']]:f}"
    nb = io.StringIO()
    w = csv.DictWriter(nb, fieldnames=list(loans[0].keys()), lineterminator="\r\n")
    w.writeheader()
    w.writerows(loans)
    run = op.run(rid)
    follow = op.client.post(f"/api/v1/runs/{rid}/revisions", json={"cooldown_days": 7, "use_latest_history": True},
                            headers=op.h(run["version"])).json()
    follow = op.upload(follow, nb.getvalue().encode(), name="next_snapshot.csv").json()
    follow = op.wait(op.post(follow, "validate").json()["run_id"])
    assert follow["status"] == "Validated", follow
    assert follow["configuration"]["fatigue_attempts"] == 20 and follow["configuration"]["holdout_pct"] == 10  # inherited
    exp = op.get(f"/runs/{rid}/experiment").json()
    t, c = exp["next_snapshot"]["arms"]["treatment"], exp["next_snapshot"]["arms"]["control"]

    actual = {"control": len(control), "treatment": len(treatment), "requests": pset["requests"], "holdout_loans": pset["holdout_loans"],
              "control_in_requests": len(control & req_loans), "statuses": {f"{k[0]}:{k[1]}": v for k, v in statuses.items()},
              "paid": exp_before["responses"]["treatment_loans_paid"], "collected": exp_before["responses"]["treatment_collected"],
              "treatment_recovered": t["recovered"], "control_recovered": c["recovered"],
              "lift_per_loan": exp["next_snapshot"]["incremental_recovered_per_loan"], "synthetic": exp["synthetic"]}
    expected_collected = str(sum(collected.values()).quantize(Decimal("0.01")))
    evidence.update(expected={"control_in_requests": 0, "paid": 2, "collected": expected_collected, "control_recovered": "0.00"},
                    actual=actual, configuration={"cooldown_days": 7, "fatigue_attempts": 20, "holdout_pct": 10})
    assert control and treatment and not (control & treatment) and len(control | treatment) == run["totals"]["RETRY"]
    assert pset["requests"] == 3 * len(treatment) and pset["holdout_loans"] == len(control)
    assert req_loans == treatment
    assert statuses[("RETRY", "HOLDOUT")] == len(control) and statuses[("RETRY", "RELEASED")] == len(treatment)
    assert {x["experiment_arm"] for x in export if x["decision"] != "RETRY"} == {""}
    assert exp_before["next_snapshot"] is None
    assert exp_before["responses"]["treatment_loans_paid"] == 2 and exp_before["responses"]["treatment_collected"] == expected_collected
    assert t["recovered"] == expected_collected and c["recovered"] == "0.00" and t["loans_with_lower_balance"] == 2
    assert Decimal(exp["next_snapshot"]["incremental_recovered_per_loan"]) > 0
    assert exp["synthetic"] is True and exp["small_sample"] is True
    # Assignment is deterministic.
    from server import payments
    assert all(payments.arm_for(rid, k, 10) == "control" for k in control)

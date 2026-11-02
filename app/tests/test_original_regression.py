"""Original-data golden regression through the real API, SQL and persistence (master section 9)."""
from __future__ import annotations

import csv
import io
import json

import pytest

from conftest import LOANS_CSV, REQUESTS_CSV, sha, shuffled_csv

GOLDEN = {3: {"RETRY": 404, "WAIT": 1945, "REVIEW_REMEDIATE": 713},
          7: {"RETRY": 400, "WAIT": 1949, "REVIEW_REMEDIATE": 713},
          14: {"RETRY": 396, "WAIT": 1953, "REVIEW_REMEDIATE": 713}}
REASONS_7 = {"ACCOUNT_AUTH_OR_UNKNOWN_REASON": 605, "LATEST_CHARGEBACK": 37, "NO_HISTORY": 29,
             "LATEST_SUCCESS_RECONCILE": 27, "AMBIGUOUS_LATEST_BATCH": 15, "COOLDOWN": 1949,
             "SOFT_FAILURE_WINDOW_ELAPSED": 400}

pytestmark = [pytest.mark.kind("original_regression")]


def all_decisions(op, run_id, decision=None):
    out, page = [], 1
    while True:
        q = f"/runs/{run_id}/decisions?page={page}&page_size=100" + (f"&decision={decision}" if decision else "")
        body = op.get(q).json()
        out += body["items"]
        if len(out) >= body["total"]:
            return out
        page += 1


@pytest.mark.criteria("C01", "C02", "C03", "C08", "E01", "DMO02")
def test_original_source_controls(portal, evidence):
    before = (sha(LOANS_CSV.read_bytes()), sha(REQUESTS_CSV.read_bytes()))
    op = portal["operator"]
    ws = op.get("/workspace").json()
    run = op.ready_run(7)
    cov = run["validation"]["coverage"]
    expected = {"loans": 3062, "requests": 253006, "loans_with_history": 3033, "loans_without_history": 29,
                "orphan_request_rows": 0, "collection_batches": 193629, "outstanding_cents": 1095261900,
                "requested_cents": 14093081615}
    evidence.update(expected=expected, actual={k: cov[k] for k in expected}, configuration={"cooldown_days": 7})
    assert {k: cov[k] for k in expected} == expected
    assert ws["history"]["sha256"] == "27b608789d22c87703dd8bb4d70bd0283e468d91dde47adafe5dc2b4738f4b82"
    assert run["sources"]["portfolio"]["sha256"] == "667ce705f2e9c89c3ac2f5965ff3492601684c979cf3d55f7ceed1218cb7fc86"
    assert (sha(LOANS_CSV.read_bytes()), sha(REQUESTS_CSV.read_bytes())) == before


@pytest.mark.criteria("C08", "C12", "E02", "EC08")
def test_golden_counts_for_each_cooldown(portal, evidence):
    op = portal["operator"]
    sets, actual = {}, {}
    for k in (3, 7, 14):
        run = op.ready_run(k)
        assert run["status"] == "Ready", run
        actual[k] = {d: run["totals"][d] for d in GOLDEN[k]}
        rows = all_decisions(op, run["run_id"])
        assert len(rows) == 3062 and len({r["loan_id"] for r in rows}) == 3062
        sets[k] = {d: {r["loan_id"] for r in rows if r["decision"] == d} for d in GOLDEN[k]}
        if k == 7:
            assert op.get(f"/runs/{run['run_id']}/summary").json()["reasons"] == REASONS_7
    evidence.update(expected=GOLDEN, actual=actual)
    assert actual == GOLDEN
    assert sets[14]["RETRY"] <= sets[7]["RETRY"] <= sets[3]["RETRY"]
    assert sets[3]["REVIEW_REMEDIATE"] == sets[7]["REVIEW_REMEDIATE"] == sets[14]["REVIEW_REMEDIATE"]


@pytest.mark.criteria("C05", "EC05")
def test_portfolio_row_order_does_not_change_decisions(portal, evidence):
    op = portal["operator"]
    a = op.ready_run(7)
    b = op.ready_run(7, shuffled_csv(LOANS_CSV, seed=11))
    ra = {r["loan_id"]: (r["decision"], r["reason_code"]) for r in all_decisions(op, a["run_id"])}
    rb = {r["loan_id"]: (r["decision"], r["reason_code"]) for r in all_decisions(op, b["run_id"])}
    evidence.update(expected={"identical": True}, actual={"identical": ra == rb, "loans": len(ra)})
    assert ra == rb


@pytest.mark.criteria("C09", "E06", "E12", "DMO05", "DX02")
def test_source_case_controls(portal, evidence):
    op = portal["operator"]
    run = op.ready_run(7)
    rid = run["run_id"]
    amb = op.get(f"/runs/{rid}/loans/7764852545").json()
    debt = op.get(f"/runs/{rid}/loans/7765852743").json()
    wait = op.get(f"/runs/{rid}/loans/7764910231").json()
    actual = {"7764852545": [amb["reason_code"], len(amb["latest_batch"])],
              "7765852743": debt["total_amount_outstanding"],
              "7764910231": [wait["cooldown_anchor_date"], wait["next_check_date"]]}
    expected = {"7764852545": ["AMBIGUOUS_LATEST_BATCH", 6], "7765852743": "1520.00",
                "7764910231": ["2025-11-11", "2025-11-18"]}
    evidence.update(expected=expected, actual=actual, configuration={"cooldown_days": 7})
    assert actual == expected
    assert amb["recommended_amount"] is None and amb["is_executable"] is False
    assert amb["next_action_code"] == "INVESTIGATE_BEFORE_RETRY"


@pytest.mark.criteria("C09", "C10", "E01", "E14", "EC14", "DMO07")
def test_approved_export_matches_persisted_results(portal, evidence):
    op, rv = portal["operator"], portal["reviewer"]
    run = op.ready_run(7)
    rid = run["run_id"]
    assert op.get(f"/runs/{rid}/results.csv").status_code == 409
    run = op.post(run, "submit").json()
    assert rv.get(f"/runs/{rid}/results.csv").status_code == 409
    run = rv.post(run, "review", {"action": "approve"}).json()
    assert run["status"] == "Approved"
    r = op.get(f"/runs/{rid}/results.csv")
    assert r.status_code == 200
    raw = r.content
    assert not raw.startswith(b"\xef\xbb\xbf") and b"\r\n" in raw
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8"))))
    persisted = {d["loan_id"]: d for d in all_decisions(op, rid)}
    assert len(rows) == 3062 and [x["loan_id"] for x in rows] == sorted(persisted)
    mismatches = [x["loan_id"] for x in rows if (x["decision"], x["reason_code"], x["next_action_code"], x["next_check_date"] or None)
                  != (persisted[x["loan_id"]]["decision"], persisted[x["loan_id"]]["reason_code"],
                      persisted[x["loan_id"]]["next_action_code"], persisted[x["loan_id"]]["next_check_date"])]
    counts = {d: sum(x["decision"] == d for x in rows) for d in GOLDEN[7]}
    evidence.update(expected={"rows": 3062, **GOLDEN[7], "mismatches": 0},
                    actual={"rows": len(rows), **counts, "mismatches": len(mismatches)})
    assert not mismatches and counts == GOLDEN[7]
    assert {x["recommended_amount"] for x in rows} == {""}
    assert {x["is_executable"] for x in rows} == {"false"}
    assert {x["analysis_review_state"] for x in rows} == {"Approved"} and {x["analysis_approved_by"] for x in rows} == {"reviewer"}
    assert "review_state" not in rows[0] and "approved_by" not in rows[0]
    status = {(x["decision"], x["payment_request_status"]) for x in rows}
    assert status == {("RETRY", "RELEASED"), ("WAIT", "NONE"), ("REVIEW_REMEDIATE", "NONE")}
    assert all(len(json.loads(x["payment_request_ids"])) == (3 if x["decision"] == "RETRY" else 0) for x in rows)
    assert {x["dataset_kind"] for x in rows} == {"belvo_sample"}
    debt = next(x for x in rows if x["loan_id"] == "7765852743")
    assert debt["total_amount_outstanding"] == "1520.00"
    assert all(not x["loan_id"][0] in "=+-@" for x in rows)

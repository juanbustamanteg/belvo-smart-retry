"""API permissions, state machine, idempotency, recovery and session rules (E03-E11, EC10-EC13)."""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from conftest import LOANS_CSV, ORIGIN, Portal
from server import api, config

pytestmark = [pytest.mark.kind("api")]
SMALL_BAD = b"loan_id,payment_method_bank\n1,mx\n"


@pytest.mark.criteria("E03", "EC13")
def test_anonymous_access_is_rejected(portal, evidence):
    anon = TestClient(portal["app"], base_url="http://testserver")
    codes = {p: anon.get("/api/v1" + p).status_code for p in ("/workspace", "/runs", "/runs/x/decisions", "/auth/session")}
    codes["POST /runs"] = anon.post("/api/v1/runs", json={"cooldown_days": 7}, headers={"Origin": ORIGIN}).status_code
    codes["health"] = anon.get("/api/v1/health").status_code
    evidence.update(expected={"protected": 401, "health": 200}, actual=codes)
    assert all(v == 401 for k, v in codes.items() if k != "health") and codes["health"] == 200


@pytest.mark.criteria("E04", "EC13")
def test_role_rules_are_enforced_server_side(portal, evidence):
    op, rv = portal["operator"], portal["reviewer"]
    r1 = rv.client.post("/api/v1/runs", json={"cooldown_days": 7}, headers=rv.h())
    run = op.ready_run(7)
    r2 = op.post(run, "submit")
    run = r2.json()
    r3 = op.post(run, "review", {"action": "approve"})
    r4 = rv.post(run, "withdraw")
    after = op.run(run["run_id"])
    evidence.update(expected=[403, 200, 403, 403, "Submitted"], actual=[r1.status_code, r2.status_code, r3.status_code,
                                                                         r4.status_code, after["status"]])
    assert (r1.status_code, r2.status_code, r3.status_code, r4.status_code) == (403, 200, 403, 403)
    assert after["status"] == "Submitted" and after["version"] == run["version"]


@pytest.mark.criteria("EC13", "E15")
def test_csrf_origin_and_login_header(portal, evidence):
    op = portal["operator"]
    no_csrf = op.client.post("/api/v1/runs", json={"cooldown_days": 7}, headers={"Idempotency-Key": "k1"})
    bad_origin = op.client.post("/api/v1/runs", json={"cooldown_days": 7},
                                headers={**op.h(), "Origin": "http://evil.example"})
    anon = TestClient(portal["app"], base_url="http://testserver")
    no_header = anon.post("/api/v1/auth/login", json={"username": "operator", "password": "x"}, headers={"Origin": ORIGIN})
    extra_field = op.client.post("/api/v1/runs", json={"cooldown_days": 7, "amount": 5}, headers=op.h())
    bad_cooldown = op.client.post("/api/v1/runs", json={"cooldown_days": 5}, headers=op.h())
    actual = [no_csrf.status_code, bad_origin.status_code, no_header.status_code, extra_field.status_code, bad_cooldown.status_code]
    evidence.update(expected=[403, 403, 403, 422, 422], actual=actual)
    assert actual == [403, 403, 403, 422, 422]
    assert "error" in no_csrf.json() and no_csrf.json()["error"]["request_id"]


@pytest.mark.criteria("EC13")
def test_login_throttle(portal, evidence):
    anon = TestClient(portal["app"], base_url="http://testserver")
    h = {"Origin": ORIGIN, "X-Requested-With": "SmartRetry"}
    codes = [anon.post("/api/v1/auth/login", json={"username": "reviewer", "password": "wrong"}, headers=h).status_code
             for _ in range(6)]
    ok_after = anon.post("/api/v1/auth/login", json={"username": "reviewer", "password": "reviewer-test-pw"}, headers=h).status_code
    evidence.update(expected=[401] * 5 + [429, 429], actual=codes + [ok_after])
    assert codes == [401] * 5 + [429] and ok_after == 429


@pytest.mark.criteria("E10", "EC13")
def test_logout_and_expiry_invalidate_session(portal, evidence):
    op = portal["operator"]
    assert op.get("/auth/session").status_code == 200
    r = op.client.post("/api/v1/auth/logout", headers=op.h(key=False))
    assert r.status_code == 204
    after_logout = op.get("/auth/session").status_code
    rv = portal["reviewer"]
    conn = sqlite3.connect(portal["settings"].db_path)
    conn.execute("UPDATE sessions SET last_seen_us = last_seen_us - ? WHERE revoked=0", (31 * 60 * 1_000_000,))
    conn.commit()
    conn.close()
    after_idle = rv.get("/auth/session").status_code
    evidence.update(expected=[401, 401], actual=[after_logout, after_idle])
    assert after_logout == 401 and after_idle == 401


@pytest.mark.criteria("E07", "E11", "EC10", "EC11")
def test_if_match_preconditions(portal, evidence):
    op = portal["operator"]
    run = op.create(7)
    missing = op.client.patch(f"/api/v1/runs/{run['run_id']}", json={"cooldown_days": 3},
                              headers={"X-CSRF-Token": op.csrf})
    ok = op.client.patch(f"/api/v1/runs/{run['run_id']}", json={"cooldown_days": 3}, headers=op.h(run["version"], key=False))
    stale = op.client.patch(f"/api/v1/runs/{run['run_id']}", json={"cooldown_days": 14}, headers=op.h(run["version"], key=False))
    actual = [missing.status_code, ok.status_code, stale.status_code, op.run(run["run_id"])["configuration"]["cooldown_days"]]
    evidence.update(expected=[428, 200, 412, 3], actual=actual)
    assert actual == [428, 200, 412, 3]


@pytest.mark.criteria("E08", "EC11")
def test_idempotent_create_and_conflict(portal, evidence):
    op = portal["operator"]
    h = op.h(key="same-key")
    a = op.client.post("/api/v1/runs", json={"cooldown_days": 7}, headers=h)
    b = op.client.post("/api/v1/runs", json={"cooldown_days": 7}, headers=h)
    c = op.client.post("/api/v1/runs", json={"cooldown_days": 3}, headers=h)
    total = op.get("/runs").json()["total"]
    evidence.update(expected={"same_run": True, "conflict": 409, "runs": 1},
                    actual={"same_run": a.json()["run_id"] == b.json()["run_id"], "conflict": c.status_code, "runs": total})
    assert a.status_code == b.status_code == 201 and a.json()["run_id"] == b.json()["run_id"]
    assert c.status_code == 409 and c.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT" and total == 1


@pytest.mark.criteria("E05", "C11", "EC01", "EC02", "DX01")
def test_invalid_portfolio_blocks_and_recovers(portal, evidence):
    op = portal["operator"]
    run = op.create(7)
    rejected = op.client.put(f"/api/v1/runs/{run['run_id']}/sources",
                             files={"requests_file": ("r.csv", b"x", "text/csv")}, headers=op.h(run["version"]))
    run = op.upload(run, SMALL_BAD).json()
    op.post(run, "validate")
    bad = op.wait(run["run_id"])
    results_blocked = op.get(f"/runs/{run['run_id']}/decisions").status_code
    exec_blocked = op.post(bad, "execute").status_code
    run = op.upload(bad, LOANS_CSV.read_bytes()).json()
    op.post(run, "validate")
    good = op.wait(run["run_id"])
    actual = {"requests_file": rejected.json()["error"]["code"], "status": bad["status"], "code": bad["error"]["code"],
              "missing": bad["error"]["details"][0].get("missing_columns"), "results": results_blocked,
              "execute": exec_blocked, "after_fix": good["status"]}
    evidence.update(expected={"requests_file": "REQUESTS_UPLOAD_REJECTED", "status": "Draft", "code": "INPUT_SCHEMA_INVALID",
                              "results": 409, "execute": 409, "after_fix": "Validated"}, actual=actual)
    assert actual["requests_file"] == "REQUESTS_UPLOAD_REJECTED"
    assert bad["status"] == "Draft" and bad["error"]["code"] == "INPUT_SCHEMA_INVALID"
    assert "total_amount_outstanding" in actual["missing"]
    assert results_blocked == 409 and exec_blocked == 409 and good["status"] == "Validated"


@pytest.mark.criteria("E05", "C03", "EC02")
def test_orphan_requests_block_validation(portal, evidence):
    op = portal["operator"]
    lines = LOANS_CSV.read_bytes().decode().splitlines()
    trimmed = "\n".join(l for l in lines if not l.startswith("7764852545,")).encode()
    run = op.create(7)
    run = op.upload(run, trimmed).json()
    op.post(run, "validate")
    run = op.wait(run["run_id"])
    evidence.update(expected={"status": "Draft", "code": "ORPHAN_REQUESTS"},
                    actual={"status": run["status"], "code": run["error"]["code"]})
    assert run["status"] == "Draft" and run["error"]["code"] == "ORPHAN_REQUESTS"


@pytest.mark.criteria("E07", "E11", "EC10", "DX03")
def test_return_revision_and_immutable_approval(portal, evidence):
    op, rv = portal["operator"], portal["reviewer"]
    run = op.ready_run(7)
    run = op.post(run, "submit").json()
    blank = rv.post(run, "review", {"action": "return", "comment": "   "})
    revision_while_submitted = op.client.post(f"/api/v1/runs/{run['run_id']}/revisions", json={"cooldown_days": 3},
                                              headers=op.h(run["version"]))
    returned = rv.post(run, "review", {"action": "return", "comment": "Use a 3-day wait for this client."}).json()
    stale_approve = rv.post(run, "review", {"action": "approve"})
    rev = op.client.post(f"/api/v1/runs/{run['run_id']}/revisions", json={"cooldown_days": 3},
                         headers=op.h(returned["version"])).json()
    old = op.run(run["run_id"])
    actual = {"blank": blank.status_code, "while_submitted": revision_while_submitted.json()["error"]["code"],
              "returned": returned["status"], "comment": returned["review"]["comment"], "stale_approve": stale_approve.status_code,
              "rev_status": rev["status"], "rev_no": rev["revision_no"], "old_status": old["status"],
              "inherits_portfolio": rev["sources"]["portfolio"]["sha256"] == old["sources"]["portfolio"]["sha256"]}
    evidence.update(expected={"blank": 422, "while_submitted": "WITHDRAW_FIRST", "returned": "Returned", "stale_approve": 412,
                              "rev_status": "Draft", "rev_no": 2, "old_status": "Returned"}, actual=actual)
    assert blank.status_code == 422 and actual["while_submitted"] == "WITHDRAW_FIRST"
    assert returned["status"] == "Returned" and stale_approve.status_code == 412
    assert rev["status"] == "Draft" and rev["revision_no"] == 2 and old["status"] == "Returned" and actual["inherits_portfolio"]
    assert op.get(f"/runs/{run['run_id']}/results.csv").status_code == 409


@pytest.mark.criteria("EC10")
def test_revision_from_ready_supersedes_and_approved_stays(portal, evidence):
    op, rv = portal["operator"], portal["reviewer"]
    ready = op.ready_run(7)
    rev = op.client.post(f"/api/v1/runs/{ready['run_id']}/revisions", json={"cooldown_days": 14}, headers=op.h(ready["version"]))
    superseded = op.run(ready["run_id"])
    approved = op.post(op.ready_run(7), "submit").json()
    approved = rv.post(approved, "review", {"action": "approve"}).json()
    rev2 = op.client.post(f"/api/v1/runs/{approved['run_id']}/revisions", json={"cooldown_days": 3}, headers=op.h(approved["version"]))
    still = op.run(approved["run_id"])
    evidence.update(expected=["Superseded", "Approved"], actual=[superseded["status"], still["status"]])
    assert rev.status_code == 201 and superseded["status"] == "Superseded"
    assert op.post(superseded, "submit").status_code == 409
    assert rev2.status_code == 201 and still["status"] == "Approved"


@pytest.mark.criteria("E09", "EC12", "DX04")
def test_restart_marks_running_as_interrupted(make_app, evidence):
    app, settings = make_app("restart")
    op = Portal(app, "operator")
    run = op.create(7)
    run = op.upload(run, LOANS_CSV.read_bytes()).json()
    op.post(run, "validate")
    run = op.wait(run["run_id"])
    conn = sqlite3.connect(settings.db_path)
    conn.execute("UPDATE runs SET status='Running' WHERE id=?", (run["run_id"],))
    conn.commit()
    conn.close()
    app2 = api.create_app(settings, extra_hosts=("testserver",))
    op2 = Portal(app2, "operator")
    after = op2.run(run["run_id"])
    results = op2.get(f"/runs/{run['run_id']}/decisions").status_code
    rev = op2.client.post(f"/api/v1/runs/{run['run_id']}/revisions", json={"cooldown_days": 7}, headers=op2.h(after["version"]))
    evidence.update(expected={"status": "Interrupted", "results": 409, "revision": 201},
                    actual={"status": after["status"], "results": results, "revision": rev.status_code})
    assert after["status"] == "Interrupted" and results == 409 and rev.status_code == 201


@pytest.mark.criteria("E01", "DMO08")
def test_approval_persists_across_restart(make_app, evidence):
    app, settings = make_app("persist")
    op, rv = Portal(app, "operator"), Portal(app, "reviewer")
    run = op.post(op.ready_run(7), "submit").json()
    run = rv.post(run, "review", {"action": "approve"}).json()
    app2 = api.create_app(settings, extra_hosts=("testserver",))
    again = Portal(app2, "reviewer").run(run["run_id"])
    evidence.update(expected={"status": "Approved", "version": run["version"]},
                    actual={"status": again["status"], "version": again["version"]})
    assert again["status"] == "Approved" and again["version"] == run["version"] and again["totals"]["RETRY"] == 400


@pytest.mark.criteria("DMO04")
def test_waiting_queue_ordered_by_next_check_and_filters_are_view_only(portal, evidence):
    op = portal["operator"]
    run = op.ready_run(7)
    rid = run["run_id"]
    wait = op.get(f"/runs/{rid}/decisions?decision=WAIT&page_size=100").json()
    keys = [(r["next_check_date"], r["loan_id"]) for r in wait["items"]]
    flt = op.get(f"/runs/{rid}/decisions?decision=REVIEW_REMEDIATE&reason=LATEST_CHARGEBACK").json()
    summary = op.get(f"/runs/{rid}/summary").json()
    evidence.update(expected={"sorted": True, "chargeback_total": 37, "full_total": 3062},
                    actual={"sorted": keys == sorted(keys), "chargeback_total": flt["total"], "full_total": summary["totals"]["loans"]})
    assert wait["total"] == 1949 and keys == sorted(keys)
    assert flt["total"] == 37 and summary["totals"]["loans"] == 3062

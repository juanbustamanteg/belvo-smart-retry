"""Generate the delivery CSVs from a real, approved run (master section 3).

Runs the actual app (FastAPI + SQLite) against the original CSVs in a disposable data directory:
operator creates the analysis with the portal's default policy, a distinct reviewer approves it,
and the approved exports are written to the project root. The testing CSV merges the rows written
by the last executed pytest and Playwright runs; nothing is declared PASS here.

Usage (from app/):  .venv/bin/python tools/generate_deliverables.py
Run pytest and `npm run e2e` first so the testing rows are current.
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import secrets
import shutil
import sys
import time
import uuid
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
sys.path.insert(0, str(APP))

from fastapi.testclient import TestClient  # noqa: E402

import setup_local  # noqa: E402
from server import api, config  # noqa: E402

POLICY = {"cooldown_days": 7, "fatigue_attempts": 20, "holdout_pct": 10}
ORIGIN = "http://127.0.0.1:8000"
ARTIFACTS = APP / "tests" / "artifacts"


def client(app, username, password):
    c = TestClient(app, base_url="http://testserver")
    c.headers.update({"Origin": ORIGIN})
    r = c.post("/api/v1/auth/login", json={"username": username, "password": password}, headers={"X-Requested-With": "SmartRetry"})
    r.raise_for_status()
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def h(version=None):
    out = {"Idempotency-Key": uuid.uuid4().hex}
    if version is not None:
        out["If-Match"] = f'"{version}"'
    return out


def wait(c, run_id):
    while True:
        run = c.get(f"/api/v1/runs/{run_id}").json()
        if run["status"] not in ("Validating", "Running"):
            return run
        time.sleep(0.2)


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    data = ARTIFACTS / "deliverables-data"
    shutil.rmtree(data, ignore_errors=True)
    pw = {"operator": secrets.token_urlsafe(12), "reviewer": secrets.token_urlsafe(12)}
    rc = setup_local.main(["--data-dir", str(data), "--operator-password", pw["operator"], "--reviewer-password", pw["reviewer"]])
    if rc:
        return rc
    app = api.create_app(config.Settings(data_dir=data), extra_hosts=("testserver",))
    op, rv = client(app, "operator", pw["operator"]), client(app, "reviewer", pw["reviewer"])

    run = op.post("/api/v1/runs", json=POLICY, headers=h()).json()
    loans = ROOT / "PaymentsPM_Challenge_loan_info.csv"
    run = op.put(f"/api/v1/runs/{run['run_id']}/sources", files={"loans_file": (loans.name, loans.read_bytes(), "text/csv")},
                 headers=h(run["version"])).json()
    run = wait(op, op.post(f"/api/v1/runs/{run['run_id']}/validate", headers=h(run["version"])).json()["run_id"])
    run = wait(op, op.post(f"/api/v1/runs/{run['run_id']}/execute", headers=h(run["version"])).json()["run_id"])
    if run["status"] != "Ready":
        print(f"Run did not complete: {run['status']} {run.get('error')}", file=sys.stderr)
        return 1
    run = op.post(f"/api/v1/runs/{run['run_id']}/submit", headers=h(run["version"])).json()
    run = rv.post(f"/api/v1/runs/{run['run_id']}/review", json={"action": "approve"}, headers=h(run["version"])).json()
    assert run["status"] == "Approved", run

    results = ROOT / "Belvo_Smart_Retry_Results.csv"
    requests = ROOT / "Belvo_Smart_Retry_Payment_Requests.csv"
    testing = ROOT / "Belvo_Smart_Retry_Testing.csv"
    results.write_bytes(op.get(f"/api/v1/runs/{run['run_id']}/results.csv").content)
    requests.write_bytes(op.get(f"/api/v1/runs/{run['run_id']}/payment-requests.csv").content)

    rows, sources = [], []
    for name in ("Belvo_Smart_Retry_Testing.csv", "Belvo_Smart_Retry_E2E_Testing.csv"):
        src = ARTIFACTS / name
        if src.exists():
            sources.append((name, dt.datetime.fromtimestamp(src.stat().st_mtime, dt.timezone.utc).isoformat(timespec="seconds")))
            rows += list(csv.DictReader(src.open(encoding="utf-8")))
    if rows:
        with testing.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\r\n")
            w.writeheader()
            w.writerows(rows)

    totals, pset = run["totals"], run["payment_requests"]
    statuses = {}
    for r in rows:
        statuses[r["status"]] = statuses.get(r["status"], 0) + 1
    manifest = ROOT / "Belvo_Smart_Retry_Deliverables.md"
    manifest.write_text(f"""# Smart Retry delivery manifest

Generated {dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')} by `app/tools/generate_deliverables.py` from a real approved run of the local MVP (FastAPI + SQLite {api.sqlite3.sqlite_version}) on the original CSVs. Dataset kind: `belvo_sample`. Unofficial product-challenge prototype.

| File | SHA-256 | Content |
|---|---|---|
| `{results.name}` | `{sha(results)}` | One decision per loan, {totals['loans']:,} rows |
| `{requests.name}` | `{sha(requests)}` | {pset['requests']:,} pending payment requests for {pset['loans']:,} retry candidates, released by approval, not sent |
| `{testing.name}` | `{sha(testing) if rows else 'not generated'}` | {len(rows)} executed test rows: {', '.join(f'{v} {k}' for k, v in sorted(statuses.items())) or 'none'} |

Run `{run['run_id']}` (revision {run['revision_no']}), approved by `{run['review']['reviewed_by']}` at {run['review']['reviewed_at']}.

Policy: {POLICY['cooldown_days']}-day wait, 30-day rest after {POLICY['fatigue_attempts']} insufficient-funds failures in a row, {POLICY['holdout_pct']}% holdout. Evaluated at {run['configuration']['evaluated_at']}. Rule version `{run['configuration']['rule_version']}`.

Totals: {totals['RETRY']:,} retry candidates ({pset['holdout_loans']:,} held out as control), {totals['WAIT']:,} waiting, {totals['REVIEW_REMEDIATE']:,} need attention. With fatigue off the same pair gives 400 / 1,949 / 713 (master section 9).

Sources: loan portfolio `{run['sources']['portfolio']['sha256']}`, payment history `{run['sources']['history']['sha256']}`. Master `{run['master_sha256']}`.

Testing rows come from the most recent executed runs: {'; '.join(f'{n} written {t}' for n, t in sources) or 'none found'}. Rerun `pytest` and `npm run e2e` before regenerating if code changed since then.

None of these files is a bank instruction, a recovery result or evidence of impact.
""", encoding="utf-8")
    print(f"Wrote {results.name}, {requests.name}, {testing.name if rows else '(no testing rows)'} and {manifest.name} to {ROOT}")
    shutil.rmtree(data, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

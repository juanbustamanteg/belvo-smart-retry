"""Shared fixtures and the testing-CSV writer (master section 8, Testing CSV).

Every executed test writes one row with its actual outcome. Nothing is declared PASS
without an executed assertion.
"""
from __future__ import annotations

import csv
import datetime as dt
import hashlib
import json
import random
import shutil
import sqlite3
import sys
import time
import uuid
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP))

from fastapi.testclient import TestClient  # noqa: E402

import setup_local  # noqa: E402
from server import api, config  # noqa: E402

PROJECT = APP.parent
LOANS_CSV = PROJECT / "PaymentsPM_Challenge_loan_info.csv"
REQUESTS_CSV = PROJECT / "PaymentsPM_Challenge_payment_requests.csv"
ORIGIN = "http://127.0.0.1:8000"
PASSWORDS = {"operator": "operator-test-pw", "reviewer": "reviewer-test-pw"}
ARTIFACTS = APP / "tests" / "artifacts"
TEST_RUN_ID = uuid.uuid4().hex
_rows: list[dict] = []


def pytest_configure(config):
    config.addinivalue_line("markers", "criteria(*ids): acceptance criteria covered (C/E/EC/DMO ids)")
    config.addinivalue_line("markers", "kind(name): unit | integration | api | original_regression | synthetic_fixture")


def pytest_runtest_makereport(item, call):
    if call.when != "call" and not (call.when == "setup" and call.excinfo is not None):
        return
    crit = item.get_closest_marker("criteria")
    kind = item.get_closest_marker("kind")
    status = "PASS" if call.excinfo is None else ("SKIPPED" if call.excinfo.typename == "Skipped" else "FAIL")
    evidence = getattr(item, "evidence", {})
    _rows.append({
        "test_run_id": TEST_RUN_ID, "test_id": item.nodeid.split("::")[-1],
        "suite": item.module.__name__, "case_kind": kind.args[0] if kind else "integration",
        "dataset_kind": evidence.get("dataset_kind", "belvo_sample" if "original" in item.nodeid else "test_fixture"),
        "master_sha256": config.master_sha256(), "rule_version": config.RULE_VERSION,
        "application_version": config.APP_VERSION, "engine_version": f"sqlite {sqlite3.sqlite_version}",
        "configuration_json": json.dumps(evidence.get("configuration", {})),
        "expected_json": json.dumps(evidence.get("expected", {}), default=str),
        "actual_json": json.dumps(evidence.get("actual", {}), default=str),
        "status": status, "executed_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "evidence_reference": f"{item.nodeid} criteria={','.join(crit.args) if crit else ''}",
        "error_code": "" if status == "PASS" else (call.excinfo.typename if call.excinfo else ""),
    })


def pytest_sessionfinish(session, exitstatus):
    if not _rows:
        return
    ARTIFACTS.mkdir(exist_ok=True)
    path = ARTIFACTS / "Belvo_Smart_Retry_Testing.csv"
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(_rows[0].keys()), lineterminator="\r\n")
        w.writeheader()
        w.writerows(_rows)


@pytest.fixture
def evidence(request):
    request.node.evidence = {}
    return request.node.evidence


# ------------------------------------------------------------------ environment
@pytest.fixture(scope="session")
def base_data(tmp_path_factory):
    """One imported copy of the original history, cloned per app to keep tests isolated."""
    root = tmp_path_factory.mktemp("base")
    rc = setup_local.main(["--data-dir", str(root), "--history", str(REQUESTS_CSV),
                           "--operator-password", PASSWORDS["operator"], "--reviewer-password", PASSWORDS["reviewer"]])
    assert rc == 0
    return root


def clone_data(base: Path, dest: Path) -> Path:
    shutil.copytree(base, dest)
    # storage_path values point at the base copy; rewrite them to the clone.
    conn = sqlite3.connect(dest / "smart_retry.sqlite3")
    conn.execute("UPDATE source_files SET storage_path = replace(storage_path, ?, ?)", (str(base), str(dest)))
    conn.commit()
    conn.close()
    return dest


@pytest.fixture
def make_app(base_data, tmp_path):
    def factory(name="data"):
        settings = config.Settings(data_dir=clone_data(base_data, tmp_path / name))
        return api.create_app(settings, extra_hosts=("testserver",)), settings
    return factory


class Portal:
    """A signed-in API client that behaves like the browser portal."""

    def __init__(self, app, username):
        self.client = TestClient(app, base_url="http://testserver")
        self.client.headers.update({"Origin": ORIGIN})
        r = self.client.post("/api/v1/auth/login", json={"username": username, "password": PASSWORDS[username]},
                             headers={"X-Requested-With": "SmartRetry"})
        assert r.status_code == 200, r.text
        self.csrf = r.json()["csrf_token"]

    def h(self, version=None, key=True):
        headers = {"X-CSRF-Token": self.csrf}
        if version is not None:
            headers["If-Match"] = f'"{version}"'
        if key:
            headers["Idempotency-Key"] = uuid.uuid4().hex if key is True else key
        return headers

    def get(self, path, **kw):
        return self.client.get("/api/v1" + path, **kw)

    def run(self, run_id):
        return self.get(f"/runs/{run_id}").json()

    def create(self, cooldown=7):
        r = self.client.post("/api/v1/runs", json={"cooldown_days": cooldown}, headers=self.h())
        assert r.status_code == 201, r.text
        return r.json()

    def upload(self, run, content: bytes, name="PaymentsPM_Challenge_loan_info.csv"):
        return self.client.put(f"/api/v1/runs/{run['run_id']}/sources", files={"loans_file": (name, content, "text/csv")},
                               headers=self.h(run["version"]))

    def wait(self, run_id, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            run = self.run(run_id)
            if run["status"] not in ("Validating", "Running"):
                return run
            time.sleep(0.1)
        raise AssertionError("job did not finish")

    def post(self, run, action, json_body=None):
        return self.client.post(f"/api/v1/runs/{run['run_id']}/{action}", json=json_body, headers=self.h(run["version"]))

    def ready_run(self, cooldown=7, content: bytes | None = None):
        run = self.create(cooldown)
        r = self.upload(run, content if content is not None else LOANS_CSV.read_bytes())
        assert r.status_code == 200, r.text
        r = self.post(r.json(), "validate")
        assert r.status_code == 202, r.text
        run = self.wait(run["run_id"])
        assert run["status"] == "Validated", run
        r = self.post(run, "execute")
        assert r.status_code == 202, r.text
        return self.wait(run["run_id"])


@pytest.fixture
def portal(make_app):
    app, settings = make_app()
    return {"app": app, "settings": settings, "operator": Portal(app, "operator"), "reviewer": Portal(app, "reviewer")}


def shuffled_csv(path: Path, seed: int) -> bytes:
    lines = path.read_bytes().decode("utf-8").splitlines(keepends=True)
    lines = [l if l.endswith("\n") else l + "\r\n" for l in lines]
    header, body = lines[0], lines[1:]
    random.Random(seed).shuffle(body)
    return (header + "".join(body)).encode()


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

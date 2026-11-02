"""Start the Smart Retry portal and API on http://127.0.0.1:8000 (one origin, one worker).

SMART_RETRY_PORT and SMART_RETRY_DATA_DIR override the port and data directory (used by the E2E suite).

Run setup_local.py once first. This script performs preflight checks and never rebinds
to another interface or port.
"""
from __future__ import annotations

import socket
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import uvicorn  # noqa: E402

from server import db  # noqa: E402
from server.config import WEB_DIST, Settings  # noqa: E402

HOST = "127.0.0.1"


def preflight(settings: Settings) -> list[str]:
    PORT = settings.port
    problems = []
    if not db.sqlite_version_ok():
        problems.append(f"SQLite {sqlite3.sqlite_version} found; 3.51.3 or newer is required.")
    if not settings.db_path.exists():
        problems.append("No local database. Run: .venv/bin/python setup_local.py")
    if not (WEB_DIST / "index.html").exists():
        problems.append("Portal not built. Run: cd web && npm install && npm run build")
    with socket.socket() as s:
        if s.connect_ex((HOST, PORT)) == 0:
            problems.append(f"Port {PORT} on {HOST} is already in use. Stop the other process first.")
    return problems


def main() -> int:
    settings = Settings()
    problems = preflight(settings)
    if problems:
        for p in problems:
            print(f"Cannot start: {p}", file=sys.stderr)
        return 1
    PORT = settings.port
    print(f"Smart Retry running at http://{HOST}:{PORT}  (SQLite {sqlite3.sqlite_version}). Stop with Ctrl+C.")
    uvicorn.run("server.main:app", host=HOST, port=PORT, workers=1, log_level="info", proxy_headers=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

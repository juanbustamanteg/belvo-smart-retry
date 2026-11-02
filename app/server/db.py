"""SQLite connection handling and migrations."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .config import SQL_DIR, now_text

MIN_SQLITE = (3, 51, 3)
MIGRATIONS = [(1, "001_schema.sql"), (2, "002_payment_requests.sql"), (3, "003_release_flow.sql"), (4, "004_fatigue_holdout.sql")]


def sqlite_version_ok() -> bool:
    return tuple(int(p) for p in sqlite3.sqlite_version.split(".")) >= MIN_SQLITE


def connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=5.0, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection, immediate: bool = True):
    conn.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def migrate(conn: sqlite3.Connection) -> None:
    exists = conn.execute("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone()
    applied = set()
    if exists:
        applied = {r[0] for r in conn.execute("SELECT version FROM schema_migrations")}
    for version, name in MIGRATIONS:
        if version in applied:
            continue
        script = (SQL_DIR / name).read_text()
        # Table rebuilds need foreign keys off; the pragma has no effect inside a transaction.
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            conn.executescript("BEGIN;" + script + f";INSERT INTO schema_migrations VALUES ({version}, '{now_text()}');COMMIT;")
            problems = conn.execute("PRAGMA foreign_key_check").fetchall()
            if problems:
                raise RuntimeError(f"migration {version} left foreign key violations: {problems[:3]}")
        finally:
            conn.execute("PRAGMA foreign_keys = ON")


def rules_sql() -> str:
    return (SQL_DIR / "rules_minimal_v2.sql").read_text()


def payment_requests_sql() -> str:
    return (SQL_DIR / "payment_requests_v1.sql").read_text()

"""Explicit local setup: create the database, import system payment history, create accounts.

Usage (from app/):
    .venv/bin/python setup_local.py                      # defaults to ../PaymentsPM_Challenge_payment_requests.csv
    .venv/bin/python setup_local.py --history PATH
    .venv/bin/python setup_local.py --operator-password X --reviewer-password Y

History import is idempotent for an identical file hash. Existing accounts are never overwritten.
Generated passwords are printed once and never stored in plain text.
"""
from __future__ import annotations

import argparse
import hashlib
import secrets
import shutil
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pwdlib import PasswordHash  # noqa: E402

from server import db, ingest  # noqa: E402
from server.config import MAX_SOURCE_BYTES, PROJECT_DIR, WORKSPACE, Settings, now_text  # noqa: E402

DEFAULT_HISTORY = PROJECT_DIR / "PaymentsPM_Challenge_payment_requests.csv"


def import_history(conn, settings: Settings, path: Path) -> tuple[str, bool]:
    data = path.read_bytes()
    if len(data) > MAX_SOURCE_BYTES:
        raise ingest.IntakeError("INPUT_TOO_LARGE", "History file exceeds 50 MiB.", status=413)
    digest = hashlib.sha256(data).hexdigest()
    existing = conn.execute("SELECT id FROM source_files WHERE kind='requests_history' AND workspace=? AND sha256=? AND status='staged'",
                            (WORKSPACE, digest)).fetchone()
    if existing:
        return existing[0], False
    file_id = str(uuid.uuid4())
    dest = settings.upload_dir / f"history-{file_id}.csv"
    shutil.copyfile(path, dest)
    with db.transaction(conn):
        conn.execute("""INSERT INTO source_files (id, kind, workspace, original_name, storage_path, sha256, size_bytes,
                        status, imported_at) VALUES (?,?,?,?,?,?,?,?,?)""",
                     (file_id, "requests_history", WORKSPACE, path.name, str(dest), digest, len(data), "uploaded", now_text()))
        staged = ingest.stage_history(conn, file_id, dest)
        conn.execute("UPDATE source_files SET status='staged', row_count=?, event_min_us=?, event_max_us=?, warnings_json=? WHERE id=?",
                     (staged["row_count"], staged["event_min_us"], staged["event_max_us"],
                      __import__("json").dumps(staged["warnings"]), file_id))
    return file_id, True


def ensure_user(conn, username: str, role: str, password: str | None) -> str | None:
    if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        return None
    password = password or secrets.token_urlsafe(12)
    with db.transaction(conn):
        conn.execute("INSERT INTO users VALUES (?,?,?,?,?)",
                     (str(uuid.uuid4()), username, role, PasswordHash.recommended().hash(password), now_text()))
    return password


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--history", type=Path, default=DEFAULT_HISTORY)
    parser.add_argument("--operator-password")
    parser.add_argument("--reviewer-password")
    parser.add_argument("--data-dir", type=Path)
    args = parser.parse_args(argv)

    settings = Settings() if args.data_dir is None else Settings(data_dir=args.data_dir)
    if not db.sqlite_version_ok():
        print("SQLite 3.51.3 or newer is required.", file=sys.stderr)
        return 2
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    conn = db.connect(settings.db_path)
    db.migrate(conn)
    try:
        file_id, created = import_history(conn, settings, args.history)
    except ingest.IntakeError as err:
        print(f"History import failed: {err.message}", file=sys.stderr)
        for d in err.details:
            print(f"  {d}", file=sys.stderr)
        print("History stays unavailable. Fix the file and run setup again.", file=sys.stderr)
        return 1
    row = conn.execute("SELECT row_count, sha256 FROM source_files WHERE id=?", (file_id,)).fetchone()
    print(f"History {'imported' if created else 'already present'}: {row['row_count']:,} requests, sha256 {row['sha256']}")
    for username, role, pw in (("operator", "operator", args.operator_password),
                               ("reviewer", "reviewer", args.reviewer_password)):
        new_pw = ensure_user(conn, username, role, pw)
        if new_pw is None:
            print(f"Account '{username}' already exists; unchanged.")
        elif pw:
            print(f"Account '{username}' created with the supplied password.")
        else:
            print(f"Account '{username}' created. Password (shown once): {new_pw}")
    print(f"Local data: {settings.data_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Sessions, login throttling, CSRF and trusted-origin checks (master sections 6 and 13)."""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
from dataclasses import dataclass

from pwdlib import PasswordHash

from . import db
from .config import (LOGIN_LOCK_SECONDS, LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS, SESSION_ABSOLUTE_SECONDS,
                     SESSION_IDLE_SECONDS, now_us)

COOKIE = "sr_session"
LOGIN_HEADER = "x-requested-with"
LOGIN_HEADER_VALUE = "SmartRetry"
_hasher = PasswordHash.recommended()
_DUMMY_HASH = _hasher.hash("timing-equalizer")


@dataclass
class User:
    id: str
    username: str
    role: str
    csrf: str
    token_hash: str
    expires_us: int


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def check_login(conn: sqlite3.Connection, username: str, password: str) -> tuple[str, dict | None]:
    """Returns ('ok', user_row) | ('invalid', None) | ('locked', None)."""
    now = now_us()
    lock = conn.execute("SELECT locked_until FROM login_locks WHERE username=?", (username,)).fetchone()
    if lock and lock[0] > now:
        return "locked", None
    row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    ok = _hasher.verify(password, row["password_hash"]) if row else (_hasher.verify(password, _DUMMY_HASH) and False)
    with db.transaction(conn):
        if ok:
            conn.execute("DELETE FROM login_failures WHERE username=?", (username,))
            conn.execute("DELETE FROM login_locks WHERE username=?", (username,))
            return "ok", row
        window_start = now - LOGIN_WINDOW_SECONDS * 1_000_000
        conn.execute("DELETE FROM login_failures WHERE at_us < ?", (window_start,))
        conn.execute("INSERT INTO login_failures VALUES (?,?)", (username, now))
        failures = conn.execute("SELECT COUNT(*) FROM login_failures WHERE username=? AND at_us>=?",
                                (username, window_start)).fetchone()[0]
        if failures >= LOGIN_MAX_FAILURES:
            conn.execute("INSERT OR REPLACE INTO login_locks VALUES (?,?)",
                         (username, now + LOGIN_LOCK_SECONDS * 1_000_000))
            conn.execute("DELETE FROM login_failures WHERE username=?", (username,))
    return "invalid", None


def create_session(conn: sqlite3.Connection, user_id: str) -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    now = now_us()
    with db.transaction(conn):
        conn.execute("INSERT INTO sessions VALUES (?,?,?,?,?,0)", (token_hash(token), user_id, csrf, now, now))
    return token, csrf


def session_expiry(created_us: int, last_seen_us: int) -> int:
    return min(created_us + SESSION_ABSOLUTE_SECONDS * 1_000_000, last_seen_us + SESSION_IDLE_SECONDS * 1_000_000)


def load_session(conn: sqlite3.Connection, token: str | None, touch: bool = True) -> User | None:
    if not token:
        return None
    th = token_hash(token)
    row = conn.execute("""SELECT s.*, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id
                          WHERE s.token_hash=? AND s.revoked=0""", (th,)).fetchone()
    if not row:
        return None
    now = now_us()
    if now >= session_expiry(row["created_us"], row["last_seen_us"]):
        conn.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (th,))
        return None
    if touch:
        conn.execute("UPDATE sessions SET last_seen_us=? WHERE token_hash=?", (now, th))
    return User(row["user_id"], row["username"], row["role"], row["csrf_token"], th,
                session_expiry(row["created_us"], now if touch else row["last_seen_us"]))


def revoke(conn: sqlite3.Connection, th: str) -> None:
    conn.execute("UPDATE sessions SET revoked=1 WHERE token_hash=?", (th,))

"""Fixed configuration for the Smart Retry local MVP (master sections 5 and 13)."""
from __future__ import annotations

import datetime as dt
import hashlib
import os
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

APP_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = APP_DIR.parent
SQL_DIR = APP_DIR / "sql"
WEB_DIST = APP_DIR / "web" / "dist"
MASTER_PATH = PROJECT_DIR / "Belvo_Payments_Data_Analysis.md"

APP_VERSION = "0.1.0"
RULE_VERSION = "minimal-v2"
ALLOWED_FATIGUE = (10, 20, 30)
DEFAULT_FATIGUE = 20
REST_DAYS = 30  # wait applied instead of the cooldown once a loan reaches the fatigue streak
ALLOWED_HOLDOUT = (0, 10, 20)
DEFAULT_HOLDOUT = 10
WORKSPACE = "demo-merchant"
WORKSPACE_LABEL = "Demo merchant (hypothetical)"

BUSINESS_TZ_NAME = "America/Mexico_City"
BUSINESS_TZ = ZoneInfo(BUSINESS_TZ_NAME)
EVALUATED_AT_TEXT = "2025-11-11T23:59:59-06:00"
EVALUATED_AT = dt.datetime.fromisoformat(EVALUATED_AT_TEXT)
ALLOWED_COOLDOWNS = (3, 7, 14)
DEFAULT_COOLDOWN = 7
PRODUCTION_CHECKS = "UNVERIFIED_LIVE_AUTH_METHOD_DEBT_EXPOSURE_POLICY"

MAX_SOURCE_BYTES = 50 * 1024 * 1024
MAX_COMBINED_BYTES = 100 * 1024 * 1024
MAX_PORTFOLIO_ROWS = 100_000
MAX_REQUEST_ROWS = 1_000_000

SESSION_IDLE_SECONDS = 30 * 60
SESSION_ABSOLUTE_SECONDS = 8 * 60 * 60
LOGIN_MAX_FAILURES = 5
LOGIN_WINDOW_SECONDS = 5 * 60
LOGIN_LOCK_SECONDS = 15 * 60
PAGE_SIZE_DEFAULT = 50
PAGE_SIZE_MAX = 100

LOANS_COLUMNS = ["loan_id", "payment_method_bank", "loan_amount", "total_amount_outstanding", "overdue_at", "overdue_days"]
REQUEST_COLUMNS = ["payment_request_id", "created_at", "completed_at", "chargeback_at", "status", "amount",
                   "failed_reason", "failed_message", "loan_id"]

EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)


def to_us(value: dt.datetime) -> int:
    return (value - EPOCH) // dt.timedelta(microseconds=1)


def from_us(value: int) -> dt.datetime:
    return EPOCH + dt.timedelta(microseconds=value)


def local_day(value: dt.datetime) -> int:
    return value.astimezone(BUSINESS_TZ).date().toordinal()


def day_text(ordinal: int | None) -> str | None:
    return None if ordinal is None else dt.date.fromordinal(ordinal).isoformat()


def iso_utc(us: int | None) -> str | None:
    if us is None:
        return None
    return from_us(us).isoformat(timespec="microseconds").replace("+00:00", "Z")


def now_us() -> int:
    return to_us(dt.datetime.now(dt.timezone.utc))


def now_text() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


CUTOFF_US = to_us(EVALUATED_AT)
EVAL_DAY = local_day(EVALUATED_AT)


def master_sha256() -> str:
    try:
        return hashlib.sha256(MASTER_PATH.read_bytes()).hexdigest()
    except OSError:
        return "unavailable"


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("SMART_RETRY_DATA_DIR", APP_DIR / ".local-data")))
    port: int = field(default_factory=lambda: int(os.environ.get("SMART_RETRY_PORT", "8000")))
    trusted_origins: tuple[str, ...] = ()
    trusted_hosts: tuple[str, ...] = ("127.0.0.1", "localhost")
    secure_cookie: bool = False  # loopback HTTP only; see master section 13

    def __post_init__(self):
        if not self.trusted_origins:
            self.trusted_origins = (f"http://127.0.0.1:{self.port}", f"http://localhost:{self.port}",
                                    "http://127.0.0.1:5173", "http://localhost:5173")

    @property
    def db_path(self) -> Path:
        return self.data_dir / "smart_retry.sqlite3"

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

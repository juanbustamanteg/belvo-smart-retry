-- Smart Retry local MVP schema, migration 001.
-- Money is stored as signed integer cents. Instants are UTC integer microseconds.
-- Calendar days are proleptic Gregorian ordinals (Python date.toordinal) in America/Mexico_City.

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  role          TEXT NOT NULL CHECK (role IN ('operator','reviewer')),
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE login_failures (
  username  TEXT NOT NULL,
  at_us     INTEGER NOT NULL
);
CREATE INDEX login_failures_user ON login_failures(username, at_us);

CREATE TABLE login_locks (
  username     TEXT PRIMARY KEY,
  locked_until INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  csrf_token   TEXT NOT NULL,
  created_us   INTEGER NOT NULL,
  last_seen_us INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);

-- Both kinds of source file: imported request history and uploaded portfolios.
CREATE TABLE source_files (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('requests_history','loans_portfolio')),
  workspace     TEXT NOT NULL,
  original_name TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  row_count     INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('uploaded','staged','invalid')),
  event_min_us  INTEGER,
  event_max_us  INTEGER,
  imported_at   TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE source_loans (
  file_id                   TEXT NOT NULL REFERENCES source_files(id),
  line_no                   INTEGER NOT NULL,
  loan_id                   TEXT NOT NULL,
  payment_method_bank       TEXT NOT NULL,
  loan_amount_cents         INTEGER,
  total_amount_outstanding_cents INTEGER,
  overdue_at                TEXT,
  overdue_days              INTEGER,
  raw_json                  TEXT NOT NULL,
  PRIMARY KEY (file_id, loan_id)
);

CREATE TABLE source_requests (
  file_id               TEXT NOT NULL REFERENCES source_files(id),
  line_no               INTEGER NOT NULL,
  payment_request_id    TEXT NOT NULL,
  loan_id               TEXT NOT NULL,
  created_us            INTEGER NOT NULL,
  completed_us          INTEGER,
  completed_unparseable INTEGER NOT NULL DEFAULT 0,
  chargeback_us         INTEGER,
  chargeback_unparseable INTEGER NOT NULL DEFAULT 0,
  created_local_day     INTEGER NOT NULL,
  completed_local_day   INTEGER,
  status                TEXT NOT NULL,
  amount_cents          INTEGER NOT NULL,
  failed_code           TEXT,
  failed_reason_raw     TEXT NOT NULL,
  failed_message        TEXT NOT NULL,
  created_at_raw        TEXT NOT NULL,
  completed_at_raw      TEXT NOT NULL,
  chargeback_at_raw     TEXT NOT NULL,
  PRIMARY KEY (file_id, payment_request_id)
);
CREATE INDEX source_requests_loan_time ON source_requests(file_id, loan_id, created_us);

CREATE TABLE analyses (
  id         TEXT PRIMARY KEY,
  workspace  TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  analysis_id      TEXT NOT NULL REFERENCES analyses(id),
  parent_run_id    TEXT REFERENCES runs(id),
  revision_no      INTEGER NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL CHECK (status IN ('Draft','Validating','Validated','Running','Failed','Interrupted','Ready','Submitted','Returned','Superseded','Approved')),
  cooldown_days    INTEGER NOT NULL CHECK (cooldown_days IN (3,7,14)),
  evaluated_at     TEXT NOT NULL,
  business_timezone TEXT NOT NULL,
  rule_version     TEXT NOT NULL,
  master_sha256    TEXT NOT NULL,
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,
  loans_file_id    TEXT REFERENCES source_files(id),
  history_file_id  TEXT REFERENCES source_files(id),
  validation_json  TEXT,
  error_json       TEXT,
  summary_json     TEXT,
  submitted_at     TEXT,
  reviewed_by      TEXT REFERENCES users(id),
  reviewed_at      TEXT,
  review_comment   TEXT
);

CREATE TABLE loan_decisions (
  run_id                   TEXT NOT NULL REFERENCES runs(id),
  loan_id                  TEXT NOT NULL,
  decision                 TEXT NOT NULL CHECK (decision IN ('RETRY','WAIT','REVIEW_REMEDIATE')),
  reason_code              TEXT NOT NULL,
  rule_priority            INTEGER NOT NULL,
  next_action_code         TEXT NOT NULL,
  payment_method_bank      TEXT NOT NULL,
  overdue_days             INTEGER,
  total_amount_outstanding_cents INTEGER,
  last_batch_created_us    INTEGER,
  last_batch_rows          INTEGER NOT NULL,
  last_batch_statuses      TEXT NOT NULL,
  last_batch_reasons       TEXT NOT NULL,
  source_payment_request_ids TEXT NOT NULL,
  cooldown_anchor_day      INTEGER,
  days_since_anchor        INTEGER,
  next_check_day           INTEGER,
  PRIMARY KEY (run_id, loan_id)
);
CREATE INDEX loan_decisions_queue ON loan_decisions(run_id, decision, next_check_day, loan_id);

CREATE TABLE run_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id   TEXT NOT NULL REFERENCES runs(id),
  at       TEXT NOT NULL,
  actor_id TEXT,
  event    TEXT NOT NULL,
  detail   TEXT
);

CREATE TABLE idempotency_keys (
  user_id      TEXT NOT NULL,
  action       TEXT NOT NULL,
  key          TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, action, key)
);

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

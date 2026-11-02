-- Migration 002: payment request sets and response-derived history (master section 8, D34).

ALTER TABLE source_files ADD COLUMN origin TEXT NOT NULL DEFAULT 'original'
  CHECK (origin IN ('original','bank','synthetic_demo'));
ALTER TABLE source_files ADD COLUMN parent_file_id TEXT REFERENCES source_files(id);
ALTER TABLE source_files ADD COLUMN responses_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_files ADD COLUMN response_event_max_us INTEGER;

CREATE TABLE payment_request_sets (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL UNIQUE REFERENCES runs(id),
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL,
  requested_at_us        INTEGER NOT NULL,
  loan_count             INTEGER NOT NULL,
  request_count          INTEGER NOT NULL,
  total_cents            INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('Prepared','Responded')),
  responses_sha256       TEXT,
  responses_origin       TEXT CHECK (responses_origin IN ('bank','synthetic_demo')),
  responses_imported_at  TEXT,
  responses_imported_by  TEXT REFERENCES users(id),
  history_file_id        TEXT REFERENCES source_files(id),
  outcome_json           TEXT
);

CREATE TABLE outbound_requests (
  set_id             TEXT NOT NULL REFERENCES payment_request_sets(id),
  payment_request_id TEXT NOT NULL UNIQUE,
  loan_id            TEXT NOT NULL,
  tranche_pct        INTEGER NOT NULL CHECK (tranche_pct IN (5,25,70)),
  amount_cents       INTEGER NOT NULL,
  PRIMARY KEY (set_id, payment_request_id)
);
CREATE INDEX outbound_requests_loan ON outbound_requests(set_id, loan_id);

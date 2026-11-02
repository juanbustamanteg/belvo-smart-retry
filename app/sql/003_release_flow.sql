-- Migration 003: payment request sets are drafted with results and released by approval (D36).
-- Rebuilds the table to change its status CHECK. Run with foreign keys off (see db.migrate).
CREATE TABLE payment_request_sets_new (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL UNIQUE REFERENCES runs(id),
  created_by             TEXT NOT NULL REFERENCES users(id),
  created_at             TEXT NOT NULL,
  requested_at_us        INTEGER NOT NULL,
  loan_count             INTEGER NOT NULL,
  request_count          INTEGER NOT NULL,
  total_cents            INTEGER NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('Draft','Released','Responded')),
  released_by            TEXT REFERENCES users(id),
  released_at            TEXT,
  responses_sha256       TEXT,
  responses_origin       TEXT CHECK (responses_origin IN ('bank','synthetic_demo')),
  responses_imported_at  TEXT,
  responses_imported_by  TEXT REFERENCES users(id),
  history_file_id        TEXT REFERENCES source_files(id),
  outcome_json           TEXT
);
INSERT INTO payment_request_sets_new
SELECT s.id, s.run_id, s.created_by, s.created_at, s.requested_at_us, s.loan_count, s.request_count, s.total_cents,
       CASE s.status WHEN 'Prepared' THEN 'Released' ELSE s.status END,
       r.reviewed_by, s.created_at,
       s.responses_sha256, s.responses_origin, s.responses_imported_at, s.responses_imported_by, s.history_file_id, s.outcome_json
FROM payment_request_sets s JOIN runs r ON r.id = s.run_id;
DROP TABLE payment_request_sets;
ALTER TABLE payment_request_sets_new RENAME TO payment_request_sets;

-- Migration 004: fatigue rule, retry ordering signals and holdout experiment (D38-D40).
ALTER TABLE runs ADD COLUMN fatigue_attempts INTEGER CHECK (fatigue_attempts IS NULL OR fatigue_attempts IN (10, 20, 30));
ALTER TABLE runs ADD COLUMN holdout_pct INTEGER NOT NULL DEFAULT 0 CHECK (holdout_pct IN (0, 10, 20));
ALTER TABLE loan_decisions ADD COLUMN consecutive_soft_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE loan_decisions ADD COLUMN last_success_us INTEGER;

CREATE TABLE experiment_assignments (
  run_id  TEXT NOT NULL REFERENCES runs(id),
  loan_id TEXT NOT NULL,
  arm     TEXT NOT NULL CHECK (arm IN ('treatment', 'control')),
  PRIMARY KEY (run_id, loan_id)
);

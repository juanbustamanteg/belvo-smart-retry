-- rule_version: minimal-v2 (minimal-v1 plus the fatigue rule and ordering signals, D38)
-- Authoritative retry classification (master section 5). This statement is the only
-- production decision engine; Python only binds parameters and serializes results.
--
-- Parameters:
--   :run_id           run receiving the decisions
--   :loans_file_id    validated portfolio dataset
--   :history_file_id  pinned request-history dataset
--   :cutoff_us        evaluated_at as UTC microseconds (2025-11-11T23:59:59-06:00)
--   :eval_day         local calendar day of evaluated_at (date ordinal, America/Mexico_City)
--   :cooldown         active cooldown_days (3, 7 or 14)
--   :fatigue          fatigue_attempts (10, 20, 30) or NULL when the rule is off; NULL reproduces minimal-v1 exactly
--   :rest             rest_days applied instead of the cooldown once a loan reaches the fatigue streak (30)
WITH
loans AS (
  SELECT loan_id, payment_method_bank, overdue_days,
         total_amount_outstanding_cents AS balance
  FROM source_loans WHERE file_id = :loans_file_id
),
req AS (
  SELECT * FROM source_requests WHERE file_id = :history_file_id
),
latest AS (
  SELECT loan_id, MAX(created_us) AS ts FROM req GROUP BY loan_id
),
-- Every historical batch, flagged when all of its members failed for code 04.
all_batches AS (
  SELECT loan_id, created_us, MIN(status = 'failed' AND failed_code IS '04') AS soft
  FROM req GROUP BY loan_id, created_us
),
last_break AS (
  SELECT loan_id, MAX(created_us) AS ts FROM all_batches WHERE soft = 0 GROUP BY loan_id
),
-- Consecutive insufficient-funds attempts, counted back from the latest attempt to the last other outcome.
streak AS (
  SELECT b.loan_id, COUNT(*) AS n
  FROM all_batches b LEFT JOIN last_break k ON k.loan_id = b.loan_id
  WHERE b.soft = 1 AND (k.ts IS NULL OR b.created_us > k.ts)
  GROUP BY b.loan_id
),
last_success AS (
  SELECT loan_id, MAX(created_us) AS ts FROM req WHERE status = 'successful' GROUP BY loan_id
),
-- Every member at the latest parsed creation instant. No deduplication.
batch AS (
  SELECT r.*,
    CASE WHEN r.created_us > :cutoff_us
           OR r.completed_us IS NULL
           OR r.completed_us < r.created_us
           OR r.completed_us > :cutoff_us
           OR r.chargeback_unparseable = 1
           OR (r.chargeback_us IS NOT NULL AND (
                 r.chargeback_us < r.created_us
              OR r.chargeback_us < r.completed_us
              OR r.chargeback_us > :cutoff_us))
         THEN 1 ELSE 0 END AS member_invalid,
    -- Anchor: the later of creation and completion, as a local calendar day.
    CASE WHEN r.completed_us IS NOT NULL AND r.completed_us > r.created_us
         THEN r.completed_local_day ELSE r.created_local_day END AS member_anchor
  FROM req r JOIN latest l ON r.loan_id = l.loan_id AND r.created_us = l.ts
),
features AS (
  SELECT loan_id,
    COUNT(*)                                   AS n,
    MAX(created_us)                            AS ts,
    MAX(member_invalid)                        AS invalid,
    MAX(status = 'chargeback')                 AS any_chargeback,
    MAX(status = 'successful')                 AS any_success,
    CASE WHEN COUNT(DISTINCT status) > 1
           OR COUNT(DISTINCT CASE WHEN status = 'failed' THEN COALESCE(failed_code, '') END) > 1
           OR COUNT(DISTINCT amount_cents) < COUNT(*)
         THEN 1 ELSE 0 END                     AS ambiguous,
    MIN(status = 'failed' AND failed_code IS '04') AS all_soft_04,
    MAX(member_anchor)                         AS anchor,
    json_group_array(DISTINCT status ORDER BY status)                   AS statuses,
    json_group_array(DISTINCT failed_code ORDER BY failed_code)
      FILTER (WHERE failed_code IS NOT NULL)                            AS reasons,
    json_group_array(payment_request_id ORDER BY payment_request_id)    AS request_ids
  FROM batch GROUP BY loan_id
),
-- Ordered decision table: the first matching priority wins.
classified AS (
  SELECT l.loan_id, l.payment_method_bank, l.overdue_days, l.balance, f.*,
    COALESCE(s.n, 0) AS soft_streak, ls.ts AS last_success_ts,
    CASE
      WHEN l.balance IS NULL OR l.balance <= 0 THEN 1
      WHEN f.n IS NULL                         THEN 2
      WHEN f.invalid = 1                       THEN 3
      WHEN f.any_chargeback = 1                THEN 4
      WHEN f.ambiguous = 1                     THEN 5
      WHEN f.any_success = 1                   THEN 6
      WHEN f.all_soft_04 IS NOT 1              THEN 7
      WHEN :fatigue IS NOT NULL AND COALESCE(s.n, 0) >= :fatigue AND :eval_day - f.anchor < :rest THEN 8
      WHEN :eval_day - f.anchor < :cooldown    THEN 9
      ELSE 10
    END AS priority
  FROM loans l LEFT JOIN features f ON f.loan_id = l.loan_id
  LEFT JOIN streak s ON s.loan_id = l.loan_id
  LEFT JOIN last_success ls ON ls.loan_id = l.loan_id
),
decided AS (
  SELECT c.*,
    CASE c.priority WHEN 10 THEN 'RETRY' WHEN 9 THEN 'WAIT' WHEN 8 THEN 'WAIT' ELSE 'REVIEW_REMEDIATE' END AS decision,
    CASE c.priority
      WHEN 1 THEN 'INVALID_BALANCE'
      WHEN 2 THEN 'NO_HISTORY'
      WHEN 3 THEN 'INVALID_TIMESTAMP'
      WHEN 4 THEN 'LATEST_CHARGEBACK'
      WHEN 5 THEN 'AMBIGUOUS_LATEST_BATCH'
      WHEN 6 THEN 'LATEST_SUCCESS_RECONCILE'
      WHEN 7 THEN 'ACCOUNT_AUTH_OR_UNKNOWN_REASON'
      WHEN 8 THEN 'FATIGUE_REST'
      WHEN 9 THEN 'COOLDOWN'
      WHEN 10 THEN 'SOFT_FAILURE_WINDOW_ELAPSED'
    END AS reason_code
  FROM classified c
)
INSERT INTO loan_decisions (
  run_id, loan_id, decision, reason_code, rule_priority, next_action_code,
  payment_method_bank, overdue_days, total_amount_outstanding_cents,
  last_batch_created_us, last_batch_rows, last_batch_statuses, last_batch_reasons,
  source_payment_request_ids, cooldown_anchor_day, days_since_anchor, next_check_day,
  consecutive_soft_failures, last_success_us)
SELECT
  :run_id, loan_id, decision, reason_code, priority,
  CASE decision
    WHEN 'RETRY' THEN 'PREPARE_RETRY_HANDOFF'
    WHEN 'WAIT' THEN 'REASSESS_ON_OR_AFTER_DATE'
    WHEN 'REVIEW_REMEDIATE' THEN 'INVESTIGATE_BEFORE_RETRY'
    ELSE NULL
  END,
  payment_method_bank, overdue_days, balance,
  ts, COALESCE(n, 0), COALESCE(statuses, '[]'), COALESCE(reasons, '[]'), COALESCE(request_ids, '[]'),
  CASE WHEN n IS NOT NULL AND invalid = 0 THEN anchor END,
  CASE WHEN n IS NOT NULL AND invalid = 0 THEN :eval_day - anchor END,
  CASE WHEN priority IN (8, 9, 10) THEN anchor +
    CASE WHEN :fatigue IS NOT NULL AND soft_streak >= :fatigue THEN :rest ELSE :cooldown END END,
  soft_streak, last_success_ts
FROM decided;

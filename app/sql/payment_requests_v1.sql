-- payment_request_version: split-5-25-70-v1
-- Three pending requests per treatment RETRY loan of an Approved run (master section 8, Payment request CSV).
-- 5% and 25% of the snapshot balance are floored to the cent (integer division on positive cents);
-- the 70% tranche takes the remainder so the three tranches sum exactly to the balance.
-- Parameters: :set_id, :run_id
INSERT INTO outbound_requests (set_id, payment_request_id, loan_id, tranche_pct, amount_cents)
SELECT
  :set_id,
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' ||
        hex(randomblob(2)) || '-' || hex(randomblob(6))),
  d.loan_id,
  t.pct,
  CASE t.pct
    WHEN 5  THEN d.total_amount_outstanding_cents * 5 / 100
    WHEN 25 THEN d.total_amount_outstanding_cents * 25 / 100
    ELSE d.total_amount_outstanding_cents
         - d.total_amount_outstanding_cents * 5 / 100
         - d.total_amount_outstanding_cents * 25 / 100
  END
FROM loan_decisions d
CROSS JOIN (SELECT 5 AS pct UNION ALL SELECT 25 UNION ALL SELECT 70) t
WHERE d.run_id = :run_id AND d.decision = 'RETRY'
  -- Holdout control loans stay RETRY candidates but get no requests (D39).
  AND NOT EXISTS (SELECT 1 FROM experiment_assignments a
                  WHERE a.run_id = d.run_id AND a.loan_id = d.loan_id AND a.arm = 'control')
ORDER BY d.loan_id, t.pct;

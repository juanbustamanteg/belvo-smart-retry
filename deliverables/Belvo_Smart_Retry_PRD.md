# Smart Retry: Product Requirements Document

Unofficial Belvo product-challenge prototype · Author: Bernabé Bustamante · Version 1.0 · 2026-11-02

This PRD is a product-facing view of the canonical specification, `Belvo_Payments_Data_Analysis.md` (the master). If they disagree, the master wins. Decision history lives in `Belvo_Smart_Retry_Decision_Log.md`.

## 1. Summary

Smart Retry decides, for every loan in a lender's portfolio, whether a collection should be retried now, wait or go to a person. For retries it also decides how much to request. A Belvo operator uploads the portfolio. The system classifies every loan with ten ordered, explainable rules and drafts payment requests for retry candidates. A different reviewer approves, which releases the requests in the bank's own format. Bank responses flow back as history for the next analysis, and a random holdout measures what retrying actually adds. The MVP never sends money.

## 2. Problem and evidence

Belvo's Managed Collections creates payment requests for lenders' loans and sends them through banking rails. Today retries run without discretion. In the supplied history (3,062 loans, 253,006 requests, 22.3 months):

| Finding | Value |
|---|---|
| Requests that failed | 97.6% |
| Failures for insufficient funds (code 04) | 84.7% of failures |
| Hard failures (cancelled, blocked, stop order, nonexistent account) | about 15% of failures |
| Today's retry candidates that never paid once | 68% (273 of 400) |
| Median insufficient-funds failures in a row for a candidate | 12 |
| Retries right after a hard failure: success rate | 0.19% |
| Retries right after a chargeback: charged back again | 22.9% (vs 0.66% overall) |
| Payday attempts (days 1, 2, 15, 16, 30, 31) vs other days | 1.88% vs 1.85% success |

Consequences: wasted bandwidth and fees on accounts that can't pay, avoidable chargebacks, strain on bank relationships, and no way to tell whether retrying helps at all.

## 3. Goals and non-goals

**Goals (MVP)**
1. One complete, deterministic, explainable decision per loan, reproducible from the two source files.
2. A safe operator workflow: preparation, independent review, release of payment requests, response intake.
3. Stop retries that the evidence says are wasteful, without flooding manual review.
4. Built-in measurement: a holdout that shows what retrying adds before any client relies on it.

**Non-goals (MVP)**
- Sending payments or connecting to any bank or rail.
- Per-loan amount optimization, predictive scoring or ML.
- Manual overrides of a decision.
- Multi-client tenancy, user administration, SSO.
- Claims of recovery lift or peso savings.

## 4. Users

| User | Needs | Main screens |
|---|---|---|
| Belvo operator | Prepare a defensible collection run quickly; understand every decision; fix input problems without engineering help | Workspace, Prepare, Results, Loan detail, Payment requests |
| Belvo reviewer | See exactly what will be released, including money, before approving; return work with a reason | Results (read-only), Payment requests, Approve or Request changes |
| Lender (Belvo client) | Recover more per attempt, fewer chargebacks and complaints, proof before policy changes | Reports and CSVs (post-MVP: client portal) |
| Borrower (affected party) | Not to be debited repeatedly when they clearly can't pay; a hardship path | Indirect; future hardship routing |

## 5. User stories and acceptance criteria

**US-01 Upload and check.** As an operator, I upload the portfolio and immediately learn whether it can be analyzed.
- Given the payment history is available, when I upload a valid portfolio, then I see loans, outstanding total, loans with and without history, and "Portfolio checked".
- Given a file missing a required column, when it is checked, then I see the exact missing column, no results are produced and I can upload a corrected file.
- Given history references loans not in the portfolio, then the check fails with the count of unmatched rows.

**US-02 Set the policy.** As an operator, I choose the wait period, fatigue rest and holdout before checking.
- Given a draft, when I change a parameter, then it is saved on the analysis and shown in the totals and to the reviewer.
- Given results exist, then parameters are locked and changing them requires a new revision.

**US-03 Generate results.** As an operator, I get one decision per loan.
- When I click Generate results, then every loan is classified, totals reconcile with the portfolio and draft payment requests exist for retry candidates outside the holdout.
- If processing fails or is interrupted, then no partial results are shown and I can run again as a new revision.

**US-04 Work the queues.** As an operator, I see Retry candidates, Waiting and Needs attention with plain-language reasons.
- Retry candidates are ordered with previous payers first, then the shortest failure streak.
- Waiting is ordered by next check date.
- Needs attention can be filtered by reason.
- Full-run totals are always visible and separate from visible rows.

**US-05 Understand a loan.** As an operator or reviewer, I open a loan and see what to do and why.
- The panel shows the next step, outstanding balance (never reduced by past payments), last paid date, failures in a row, the three payment requests if any, the matched rule, the date math and every request in the latest attempt with original messages.

**US-06 Submit.** As an operator, I submit the whole revision, not a queue.
- Submitting includes all loans and the draft payment requests; I can withdraw until a decision is made.

**US-07 Approve and release.** As a reviewer, I see the amounts and release them by approving.
- I see the number of requests and total amount before approving.
- Approval releases the requests; I cannot approve my own work or a revision that changed after I loaded it.

**US-08 Request changes.** As a reviewer, I return an analysis with a required comment.
- A blank comment is rejected; the operator sees the comment; draft requests are never released.

**US-09 Download outputs.** As either role, I download the approved result CSV and the released payment request CSV.
- Downloads exist only after approval. The result CSV marks every row not executable and states each loan's payment request status (RELEASED, HOLDOUT or NONE).

**US-10 Import responses and follow up.** As an operator, I import the bank's responses and start a follow-up analysis.
- A response file must answer every request exactly once with matching IDs, amounts and times; otherwise it is rejected whole.
- I declare whether responses come from the bank or are synthetic demo data; synthetic is labeled everywhere afterwards.
- The follow-up analysis uses the new history and is evaluated at the end of the latest response day.

**US-11 Measure the holdout.** As a reviewer or product owner, I compare retried and held-out loans.
- The experiment panel shows both groups; after a later portfolio snapshot it shows recovered amount per loan and the difference, flagged as directional when the control group is under 100 loans.

**US-12 Stay safe.** As any user, my session expires after inactivity and nothing is replayed automatically when I sign in again.

## 6. Functional requirements

### 6.1 Intake
- FR-1 Payment history is imported by local setup, not uploaded in the portal. Portfolio upload accepts one CSV in field `loans_file`.
- FR-2 Required portfolio columns: loan_id, payment_method_bank, loan_amount, total_amount_outstanding, overdue_at, overdue_days. Extra columns warn and are ignored.
- FR-3 Money is parsed exactly to cents; more than two decimals, non-numbers and overflow are rejected with line and column.
- FR-4 Duplicate or invalid IDs, malformed rows and unmatched history rows block the check.
- FR-5 Limits: 50 MiB per file, 100,000 portfolio rows, 1,000,000 request rows.

### 6.2 Decision logic
The first matching rule decides. Only the latest attempt (all requests sharing the latest creation time) is evaluated.

| # | Condition | Decision | Reason code |
|---|---|---|---|
| 1 | Balance missing or not positive | Needs attention | INVALID_BALANCE |
| 2 | No payment history | Needs attention | NO_HISTORY |
| 3 | Latest attempt has missing or inconsistent times | Needs attention | INVALID_TIMESTAMP |
| 4 | Any chargeback in the latest attempt | Needs attention | LATEST_CHARGEBACK |
| 5 | Mixed results, mixed codes or repeated amounts | Needs attention | AMBIGUOUS_LATEST_BATCH |
| 6 | A success in the latest attempt | Needs attention | LATEST_SUCCESS_RECONCILE |
| 7 | Not every request failed for code 04 | Needs attention | ACCOUNT_AUTH_OR_UNKNOWN_REASON |
| 8 | Code 04 streak >= fatigue threshold and fewer than 30 days since the attempt | Waiting | FATIGUE_REST |
| 9 | Code 04 and the cooldown hasn't passed | Waiting | COOLDOWN |
| 10 | Code 04 and the cooldown (or rest) has passed | Retry candidate | SOFT_FAILURE_WINDOW_ELAPSED |

- FR-6 The wait is counted from the later of creation and completion of the latest request, as a Mexico City calendar date. Next check = that date plus the cooldown (or 30 days when resting).
- FR-7 Every decision stores reason, rule number, next action, streak, last success and the latest attempt's evidence.
- FR-8 SQL is the only decision engine; the browser never computes decisions.

### 6.3 Configuration
| Parameter | Options | Portal default | Notes |
|---|---|---|---|
| Wait after insufficient funds | 3, 7, 14 days | 7 | Longer waits can only remove retry candidates |
| Fatigue rest | Off, 10, 20, 30 failures in a row | 20 | Off reproduces the reference counts exactly |
| Holdout | 0, 10, 20% | 10% | Deterministic assignment by run and loan |

- FR-9 Editable only in Draft; locked once results exist; inherited by revisions unless changed.
- FR-10 The evaluation date is fixed for the exercise (2025-11-11 23:59:59 Mexico City); follow-up analyses on response-derived history use the end of the latest response day.

### 6.4 Payment requests
- FR-11 Drafted in the same transaction that publishes results: three requests per retry candidate outside the holdout, 5% and 25% of the balance floored to the cent and 70% taking the remainder, all positive and distinct.
- FR-12 Reconciled before publishing: request count = 3 x eligible loans; total = sum of their balances.
- FR-13 Released only by the reviewer's approval of that exact revision; downloadable only when released.
- FR-14 File format: the nine source columns in order, status `pending`, response columns empty, one shared request time (09:00 Mexico City on the day after evaluation).

### 6.5 Responses and follow-up
- FR-15 Response file must answer every request once with matching ID, loan, amount and time; status successful, failed or chargeback; failed rows need a reason; chargebacks need a chargeback date.
- FR-16 Accepted responses create a new immutable history dataset; earlier analyses keep the history they used.
- FR-17 Successful responses never reduce the portfolio balance; those loans go to reconciliation until a new snapshot arrives.

### 6.6 Review, states and permissions
- FR-18 States: Draft, Checking, Ready to generate, Generating, Ready for review, Awaiting reviewer, Changes requested, Approved, Replaced, Failed, Interrupted.
- FR-19 Operator: create, configure, upload, check, generate, submit, withdraw, create revisions, import responses. Reviewer: approve or return. Nobody can override a decision or choose an amount.
- FR-20 Every change requires the current version; stale changes are refused. Repeated requests have one effect.

### 6.7 Outputs
- FR-21 Result CSV: one row per loan with decision, reason, next action, payment request status and IDs, experiment arm, streak, last success, evidence, configuration, source hashes, and analysis approval metadata. `is_executable` is always false; `recommended_amount` is always empty.
- FR-22 Testing CSV: one row per executed test with expected and actual values.

## 7. UX requirements

- UX-1 One primary action per role and state; secondary actions styled as such.
- UX-2 Plain-language reasons in queues; rule codes only in the evidence panel.
- UX-3 Status never by color alone; keyboard operable; visible focus.
- UX-4 English interface; source messages shown as received.
- UX-5 Copy always states that approval releases requests but Smart Retry doesn't send money.
- UX-6 Persistent "Product challenge · Unofficial prototype" label.

Screens: Sign in; Workspace (history, new analysis with policy, analyses list); Prepare (policy, upload, check results, generate); Results (totals, policy line, three queues, filters, table, pagination); Loan detail side panel; Review controls; Approved summary; Payment requests panel; Holdout experiment panel.

## 8. Non-functional requirements

| Area | Requirement | Measured in MVP |
|---|---|---|
| Performance | Check and classify the reference files interactively | Check about 1 s, classification about 0.1 s for 3,062 loans |
| Reliability | No partial results; restart marks unfinished work Interrupted | Tested |
| Security | Server-side sessions (30 min idle, 8 h max), password hashing, CSRF and origin checks, login throttling, loopback only | Tested |
| Auditability | Every run pins source hashes, rule version, spec hash and approvals | In CSVs and UI |
| Privacy | No credentials or tokens in browser storage or logs | Tested |

## 9. Success metrics and green light

| Metric | Definition | Green light |
|---|---|---|
| Retained recovery (north star) | MXN recovered per eligible loan over 90 days, net of reversals, treatment vs holdout | Loss vs control within the threshold agreed with the lender before the test |
| Requests avoided | Attempts per loan per month vs baseline | Clearly lower |
| Chargeback rate | Chargebacks per 1,000 attempts | Lower than baseline |
| Recovery per attempt | MXN per 1,000 requests | Higher than baseline |
| Guardrails | Complaints, unauthorized or excess debits, queue age, errors | No increase; zero unauthorized debits |

Potential impact from replaying the rules over the history: 60.0% fewer requests, 35.5% fewer chargeback events, MXN per 1,000 requests from 4,719 to 9,734. The stopped attempts held 17.4% of collected money, an upper bound on recovery at risk that the holdout must measure.

## 10. Launch plan and GTM

1. **Internal acceptance.** Done for the MVP: 42 backend and 16 browser tests pass.
2. **Waste audit.** Replay 2-3 design-partner lenders' histories (Mexico, direct debit) to produce their own impact numbers.
3. **Shadow run.** Smart Retry decides alongside today's process with no change to debits.
4. **Holdout pilot.** 90 days, with a loss threshold agreed up front.
5. **Paid tier.** Paid tier of Managed Collections priced per loan under management.
6. **Expansion.** Income-aware tier after proven lift, then a Brazil policy pack (Pix Automático) and Colombia.

## 11. Scalability and expansion

- Policy packs per market and rail: failure-code dictionary, legal retry limits, timing.
- In Brazil, Pix Automático retries are run by the payer's bank within a central-bank window (public sources disagree on details; confirm against the regulation). Smart Retry's value there moves upstream: which charges to schedule, amounts, and when to stop.
- Inputs move from CSV to Belvo payment events; execution moves from a released file to scheduled sends through Belvo's rails with limits; holdouts become always-on.

## 12. Risks, assumptions and kill criteria

| Risk or assumption | Mitigation |
|---|---|
| The 5/25/70 split, 20-failure threshold and 30-day rest are judgment calls | Configurable; measured with holdouts |
| History has final statuses and surviving loans only | Treat findings as associations; holdout for causality |
| Delinquent borrowers may not consent to income data | Measure consent early; rules-only path stays viable |
| Pix Automático retry rules unclear | Confirm with the regulation before the Brazil pack |
| Lenders may resist control groups | No policy change ships without one |

Kill criteria: recovery loss above the agreed threshold; consent too low for income signals; regulatory or reputational concern about using account data on delinquent borrowers.

## 13. Open questions

1. Each design partner's acceptable recovery-loss threshold and cost per attempt.
2. Who in Belvo operations owns the review step at scale.
3. Exact Pix Automático retry rules and failure codes.
4. Whether hardship routing should be part of Managed Collections or a separate product.

## 14. Deliverables

MVP (`app/`, one-command setup `./app/bootstrap.sh`), one-page summary, presentation, result, payment-request and testing CSVs with a manifest, happy-path and edge-case demo videos, user guide, this PRD.

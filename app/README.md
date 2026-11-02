# Smart Retry local MVP

Unofficial product-challenge prototype. Implements the master spec `../Belvo_Payments_Data_Analysis.md` (sections 5, 6, 7, 8 and 13). The SQL in `sql/rules_minimal_v1.sql` is the only decision engine; the browser only renders persisted results.

## Live browser demo

https://juanbustamanteg.github.io/belvo-smart-retry/ runs the portal with the same SQL files in SQLite/WebAssembly; no server. Build it with `cd web && npm run build:demo` (output `web/dist-demo/`, including the two CSVs), test it with `npx playwright test -c playwright.pages.config.ts` (add `PAGES_URL=...` to test the published site), and publish `dist-demo/` plus a `.nojekyll` file to the `gh-pages` branch.

## Quick start

```sh
./app/bootstrap.sh      # creates the environment, builds the portal, imports history, creates accounts, starts the app
```

Then open http://127.0.0.1:8000. Generated passwords print once on first run.

## Delivery files (project root)

`app/tools/generate_deliverables.py` writes `Belvo_Smart_Retry_Results.csv`, `Belvo_Smart_Retry_Payment_Requests.csv`, `Belvo_Smart_Retry_Testing.csv` and `Belvo_Smart_Retry_Deliverables.md` from a real approved run. Run pytest and `npm run e2e` first. Demo videos are re-recorded with `cd web && npx playwright test -c playwright.demo.config.ts` (`walkthrough` for the happy path, `edge_cases`, and `screenshots` for the deck), then converted to MP4 with ffmpeg. The deck is rebuilt with `scripts/deck/build_deck.js`; the PRD and user guide .docx with `python3 scripts/md_to_docx.py`.

## Prerequisites

- Python 3.12 or newer (built and tested on 3.13.2) with SQLite 3.51.3 or newer (tested on 3.53.4)
- Node 24 only to rebuild the frontend (tested on 24.15.0)

## First-time setup

```sh
cd app
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock
.venv/bin/python setup_local.py          # creates .local-data/, imports payment history, creates accounts
(cd web && npm ci && npm run build)
```

`setup_local.py` prints a generated password for `operator` and `reviewer` once. Pass `--operator-password` and `--reviewer-password` to choose them. Existing accounts are never overwritten. Re-running setup with the same history file does nothing new.

## Start

```sh
.venv/bin/python start.py               # http://127.0.0.1:8000
```

Loopback only, one worker. The script refuses to start if the port is busy, the database is missing or the portal isn't built.

Development with hot reload: run `start.py`, then `cd web && npm run dev` and open http://127.0.0.1:5173 (Vite proxies `/api`).

## Demo flow

1. Sign in as `operator`. The workspace shows the preloaded payment history.
2. New analysis with the default policy: 7-day wait, rest 30 days after 20 insufficient-funds failures in a row, 10% holdout. (Choose Off / None to reproduce the master's minimal-v1 counts.) Upload `../PaymentsPM_Challenge_loan_info.csv`. It is checked automatically.
3. Generate results: 3,062 loans, 398 retry candidates (previous payers first), 1,951 waiting (1,623 of them resting), 713 need attention. With fatigue off: 400 / 1,949 / 713. The same step drafts 1,200 payment requests (5/25/70 of each retry candidate's balance), shown under Payment requests and in each retry candidate's detail.
4. Open loans with View details: 7764852545 (six simultaneous requests), 7765852743 (debt 1,520.00 unchanged), 7764910231 (next check 2025-11-18).
5. Submit for review (results and draft requests together), sign out, sign in as `reviewer`. The reviewer sees the request total, then Approve and release payments. Download approved CSV and Download payment requests CSV (1,200 pending rows; nothing is sent).
6. Sign back in as `operator`; the released requests are on the approved analysis.
7. Make synthetic responses outside the portal:
   `.venv/bin/python tools/simulate_bank_responses.py ~/Downloads/Belvo_Smart_Retry_Payment_Requests_XXXX.csv -o ~/Downloads/SYNTHETIC_responses.csv`
8. Import responses, origin "Synthetic demo data". Then Start follow-up analysis: Check portfolio, Generate results. The follow-up is evaluated at the end of the latest response day and is labeled synthetic everywhere.

To measure the holdout, add `--next-portfolio ~/Downloads/SYNTHETIC_next_portfolio.csv` to the simulator, then in the follow-up revision use Replace file with that snapshot and Check portfolio. The Holdout experiment panel on the first revision then compares retried and held-out loans.

With the default seed all loans fail again, matching the historical 99.4% failure rate of three-member batches. Use another `--seed` to see other outcomes; successes and chargebacks are rare by design.

## Reset

There is no reset endpoint. To start clean, stop the server, delete `app/.local-data/` and run `setup_local.py` again.

## Tests

```sh
.venv/bin/python -m pytest
```

Runs pytest against real SQLite and the original CSVs (about 25 s). Writes one row per executed test to `tests/artifacts/Belvo_Smart_Retry_Testing.csv` with the master SHA-256, engine version and expected/actual values.

Browser E2E (first time: `cd web && npx playwright install chromium`):

```sh
cd web && npm run e2e
```

Do not pass `--reporter` on the command line, or the testing CSV isn't written. Playwright starts its own server on 127.0.0.1:8799 with a fresh database in `tests/artifacts/e2e-data/` (test-only passwords in `web/e2e/fixtures.ts`), so it never touches `.local-data/` or a server on port 8000. About 1.5 minutes. Writes `tests/artifacts/Belvo_Smart_Retry_E2E_Testing.csv` in the same schema; traces and screenshots of failures go to `tests/artifacts/e2e-results/`.

| Suite | Covers | Status |
|---|---|---|
| `test_original_regression.py` | Golden counts at 3/7/14 days, reason partition, source controls, row-order invariance, source cases, Approved-only export vs persisted rows | Executed |
| `test_rules_fixtures.py` | Rule order, 6/7-day boundary, local midnight, invalid timing, offsets, intake rejection, exact money | Executed |
| `test_api_workflow.py` | Anonymous access, roles, CSRF/origin, throttle, session expiry, If-Match, idempotency, invalid/orphan input, return and revision, restart recovery, persistence, WAIT ordering | Executed |
| `test_payment_loop.py` | Draft with results, release only by approval, split and format, response validation, follow-up history and clock, success/chargeback routing, synthetic labeling, legacy migration | Executed |
| `web/e2e/*.spec.ts` (Playwright, Chromium) | E01-E15 plus the closed loop (D34) in a real browser against a disposable server on port 8799 | Executed |

## Layout

```
server/   FastAPI app: config, db, ingest (parsing only), engine (jobs, reconciliation), security, api
sql/      migrations 001-003, rules_minimal_v1.sql (classification), payment_requests_v1.sql (5/25/70 split)
tools/    simulate_bank_responses.py (synthetic demo responses, outside the portal)
web/      React + TypeScript + Vite portal
tests/    pytest suites and the testing-CSV writer
```

## Known gaps

- E09 in the browser covers refresh during processing. The restart-to-Interrupted path is covered only by pytest (`test_restart_marks_running_as_interrupted`); there's no fault-injection control.
- E10 simulates expiry by dropping the session cookie; the 30-minute idle expiry itself is tested in pytest by aging the session row.
- E13 checks keyboard operation and visible focus on the main path. It is not a WCAG audit.
- In the results CSV, `analysis_review_state=Approved` repeats on every row because it describes the whole revision. Use `payment_request_status` (RELEASED only for retry candidates) to see which loans were released for collection.
- The 5/25/70 split copies observed practice; it is not a validated collection policy. Nothing is sent to any bank.
- Responses must answer every request in one file; partial bank files are rejected.
- `.local-data/` holds source data in plain files and is not protected from the machine's owner.

# Smart Retry: MVP user guide

Unofficial Belvo product-challenge prototype · Version 1.0 · 2026-11-02

This guide explains how to install the Smart Retry MVP, run an analysis as an operator, approve it as a reviewer, and use the payment request loop. It describes the app as built. Product rules are specified in the master spec and the PRD.

## 0. Try it without installing

Open https://juanbustamanteg.github.io/belvo-smart-retry/ in a desktop browser. It runs the same rules entirely in your browser.
- **Accounts.** Sign in as `operator` or `reviewer` with the password `demo`.
- **Portfolio.** Use the challenge portfolio with one click.
- **Responses.** Import synthetic bank responses with a clearly labeled demo button.
- **Your data.** Everything stays in your tab and resets when you refresh.

## 1. Install and start

You need macOS or Linux with Python 3.12 or newer (with SQLite 3.51.3 or newer) and Node 20 or newer.

From the project folder:

```sh
./app/bootstrap.sh
```

The script creates a Python environment, builds the portal, imports the payment history and creates two accounts, `operator` and `reviewer`. Then it starts the app at http://127.0.0.1:8000.

- **Passwords.** Generated passwords are printed once, the first time. Keep them.
- **Running it again.** It's safe: existing accounts and history are reused.
- **Stopping the app.** Press Ctrl+C in the terminal.

To start again later: `cd app && .venv/bin/python start.py`.

To reset everything: stop the app, delete `app/.local-data/` and run the bootstrap again. New passwords are printed.

## 2. Roles

| Role | Can do | Cannot do |
|---|---|---|
| Operator | Create analyses, set the policy, upload the portfolio, generate results, submit or withdraw, create revisions, import bank responses | Approve their own work |
| Reviewer | Review submitted analyses, approve and release payment requests, request changes with a comment | Change files, policy or decisions |

Nobody can override a decision or choose an amount. Smart Retry never sends money.

## 3. Operator walkthrough

### 3.1 Sign in and check the workspace
Sign in as `operator`. The workspace shows:
- **Payment history.** It's already in the system (253,006 requests for the supplied data). Open *Source details* to see the file, its fingerprint and the date range. If the history is unavailable, new analyses are blocked until local setup is fixed.
- **New analysis.** The three policy settings.
- **Analyses.** Every analysis and revision with its status.

### 3.2 Set the policy
| Setting | Options | Default | What it means |
|---|---|---|---|
| Wait after an insufficient-funds failure | 3, 7, 14 days | 7 | How long to wait after a "no funds" failure before trying again |
| Rest after N failures in a row | Off, 10, 20, 30 | 20 | Loans that failed this many times in a row wait 30 days instead |
| Hold out retry candidates | None, 10%, 20% | 10% | A random share of candidates gets no requests, to measure what retrying adds |

Choose *Off* and *None* to reproduce the reference counts in the spec (400 / 1,949 / 713 at seven days).

Click **New analysis**. You can still change the policy on the next screen until results are generated.

### 3.3 Upload the portfolio
Click **Choose CSV file** and pick the loan portfolio, `PaymentsPM_Challenge_loan_info.csv` for the challenge. Smart Retry checks it right away.

- **If the file is valid,** you see *Portfolio checked* with:
  - 3,062 loans and MXN 10,952,619.00 outstanding.
  - 3,033 loans with history and 29 without.
  - The fixed evaluation date.
  - The policy.
- **If the file has a problem,** you see what's wrong and where, for example "Missing columns: total_amount_outstanding" or "Line 14, total_amount_outstanding: more than two decimal places". Fix the file and choose it again.

### 3.4 Generate results
Click **Generate results**. With the default policy you get:
- 398 retry candidates.
- 1,951 waiting, 1,623 of them resting.
- 713 that need attention.

Results appear only when every loan is classified. If something fails, no partial results are shown and you can run it again as a new revision.

### 3.5 Read the results
- **Totals strip.** The whole run, always. It doesn't change when you filter.
- **Policy line.** The settings this analysis used.
- **Tabs:**
  - *Retry candidates*: loans that have paid before come first.
  - *Waiting*: soonest check date first.
  - *Needs attention*: filter by reason.
- **Table columns:** loan, bank, outstanding, why (plain language), next check, last paid, failures in a row. Held-out loans are tagged *Holdout*.
- **Find loan ID.** Search within the current tab.

What the reasons mean:

| You see | Meaning | What to do |
|---|---|---|
| Insufficient funds. Wait period has passed | Clean "no funds" failure and the wait is over | It gets three draft payment requests |
| Insufficient funds on DATE. Check again after the wait | Still within the wait | Reassess on or after the next check date |
| Insufficient funds N times in a row. Resting until DATE | Too many failures in a row | Leave it for the 30-day rest |
| Last attempt failed with code 03 (or other) | Cancelled, blocked or other account problem | Investigate before any retry |
| Last attempt was charged back | A reversal | Review the reversal and authorization |
| N simultaneous attempts with mixed results or repeated amounts | Unclear evidence | Inspect every attempt |
| Last attempt succeeded | A payment to reconcile | Reconcile with the current debt |
| No payment history | The loan never had a request | Check how it links to history |

### 3.6 Open a loan
Click **View details**. The side panel shows, top to bottom:
- **What to do.**
- **Facts:** outstanding balance (from the snapshot, never reduced by past payments), bank, last paid, failures in a row, overdue days.
- **The three draft payment requests,** for retry candidates.
- **Payment evidence:** the matched rule, the date math and every request in the latest attempt, with the bank's original message.

Close it with **Close** or the Escape key.

### 3.7 Submit
Click **Submit for review**. This sends all loans in the revision and the draft payment requests, not only the tab you're viewing. You can **Withdraw** until the reviewer decides.

## 4. Reviewer walkthrough

1. Sign in as `reviewer` and open the analysis marked *Awaiting reviewer*.
2. Read the note at the top. It states how many loans you are approving and how many payment requests, for how much money, you would release.
3. Check the **Payment requests** panel (total by tranche, holdout) and any loans you want in the side panel.
4. Then choose one:
   - **Approve and release payments** accepts the analysis and releases the requests. The status becomes *Approved* and the requests become *Released, not sent*.
   - **Request changes** opens a comment box. A comment is required. The operator sees it and must create a new revision. Nothing is released.

If the operator changed or withdrew the analysis after you opened it, approval is refused with "This analysis changed since you loaded it." Reload and review again.

## 5. After approval

### 5.1 Downloads
- **Download approved CSV.** One row per loan, with:
  - The decision, reason and next action.
  - `payment_request_status`: RELEASED for retry candidates that got requests, HOLDOUT for the control group, NONE for everyone else.
  - The request IDs and the evidence.

  `analysis_review_state=Approved` repeats on every row because it describes the whole analysis, not each loan.
- **Download payment requests CSV.** The released requests in the same nine columns as the payment history, with status `pending`. This is the file for the payment rails.

### 5.2 Bank responses
When the bank answers, it fills `completed_at`, `status`, `failed_reason`, `failed_message` and, for chargebacks, `chargeback_at`. On the approved analysis:
1. Under **Import responses**, choose the response file.
2. Say where it comes from: *Bank responses* or *Synthetic demo data*.
3. Click **Import responses**.

The file must answer every request exactly once with the same IDs, amounts and times. Otherwise it is rejected whole and nothing changes.

To try this without a bank, generate synthetic responses:

```sh
cd app
.venv/bin/python tools/simulate_bank_responses.py ~/Downloads/Belvo_Smart_Retry_Payment_Requests_XXXX.csv \
  -o ~/Downloads/SYNTHETIC_responses.csv --next-portfolio ~/Downloads/SYNTHETIC_next_portfolio.csv
```

- **How outcomes are drawn.** Each loan gets one outcome for its three requests, using historical frequencies. With the default seed almost all fail, as in history. Use `--seed` for other outcomes.
- **Labeling.** Anything built on synthetic responses is labeled *Synthetic demo* everywhere.

### 5.3 Follow-up analysis
Click **Start follow-up analysis**. It creates revision 2 with the new history, evaluated at the end of the latest response day. Then:
1. **Check portfolio.**
2. **Generate results.**

Loans whose requests succeeded go to reconciliation, because the portfolio balance isn't reduced until a new snapshot arrives. To measure the holdout, use **Replace file** in the follow-up to upload the next portfolio snapshot before checking it.

### 5.4 Holdout experiment
The **Holdout experiment** panel shows retried and held-out loans. After a later snapshot it shows:
- Loans with a lower balance.
- Amount recovered and recovered per loan for each group.
- The difference per loan.

With fewer than 100 held-out loans, treat the result as directional.

## 6. Troubleshooting

| Message or symptom | Cause | Fix |
|---|---|---|
| "Port 8000 on 127.0.0.1 is already in use" | Another app or an earlier Smart Retry is running | Stop it, or set `SMART_RETRY_PORT` to another port |
| "Payment history unavailable" | Setup didn't import history | Run `./app/bootstrap.sh` or `.venv/bin/python setup_local.py` |
| "The loan portfolio file is missing required columns" | Wrong or edited file | Use a file with all six required columns |
| "Payment history references loans that are not in this portfolio" | The portfolio is a subset | Upload the complete portfolio snapshot |
| "This analysis changed since you loaded it" | Someone acted on it after you opened it | Reload the page |
| "Your session ended. Sign in again to continue." | 30 minutes idle or 8 hours total | Sign in; you return to the same analysis |
| "Too many failed attempts. Wait 15 minutes" | Five wrong passwords in five minutes | Wait 15 minutes |
| Downloads missing | The analysis isn't approved yet | Approve first |

## 7. Files and folders

| Path | Contents |
|---|---|
| `app/.local-data/` | Local database, uploads and the demo credentials file. Sensitive; not encrypted |
| `Belvo_Smart_Retry_Results.csv` and the other delivery CSVs | Generated from a real approved run by `app/tools/generate_deliverables.py` |
| `Belvo_Smart_Retry_Demo_Happy_Path.mp4`, `Belvo_Smart_Retry_Demo_Edge_Cases.mp4` | Captioned demo videos recorded from the app |
| `app/README.md` | Developer notes, tests and layout |

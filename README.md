# Smart Retry

**Which loans to retry, when, and for how much.** A working MVP for Belvo's Payments PM challenge, built on the two challenge files, plus the product strategy behind it.

> Unofficial product-challenge prototype. Not a Belvo product. Smart Retry never sends money.

## Try it now, no install

**Live demo: https://juanbustamanteg.github.io/belvo-smart-retry/**

- **Accounts.** Sign in as `operator` (password `demo`), keep the default policy, click New analysis, then Use the challenge portfolio and Generate results. Submit for review, sign out, sign in as `reviewer` (password `demo`) and click Approve and release payments.
- **How it runs.** The demo runs entirely in your browser. It uses the same SQL rules as the app, running in SQLite compiled to WebAssembly over the original challenge files, and gives the same results as the server (400 / 1,949 / 713 with fatigue off; 398 / 1,951 / 713 with the default policy).
- **Simplifications.** The passwords are fixed for the demo. Data stays in your tab and resets when you refresh. A clearly labeled demo button imports synthetic bank responses.
- **Use a desktop browser.** Loading the 253,006-request history takes a few seconds.

## See it in 2 minutes

- **Happy path demo (61 s):** [deliverables/Belvo_Smart_Retry_Demo_Happy_Path.mp4](deliverables/Belvo_Smart_Retry_Demo_Happy_Path.mp4)
- **Edge cases demo (68 s):** [deliverables/Belvo_Smart_Retry_Demo_Edge_Cases.mp4](deliverables/Belvo_Smart_Retry_Demo_Edge_Cases.mp4)

## Run it

You need macOS or Linux with Python 3.12+ (SQLite 3.51.3+) and Node 20+.

```sh
git clone https://github.com/juanbustamanteg/belvo-smart-retry.git
cd belvo-smart-retry
./app/bootstrap.sh
```

Then open http://127.0.0.1:8000. The first run prints the passwords for the `operator` and `reviewer` accounts.
1. Sign in as `operator`, keep the default policy and click New analysis.
2. Upload `PaymentsPM_Challenge_loan_info.csv` from this folder, then click Generate results.
3. Submit for review, sign in as `reviewer`, and click Approve and release payments.

The full walkthrough is in the [user guide](deliverables/Belvo_Smart_Retry_User_Guide.md).

## Deliverables

| Deliverable | File |
|---|---|
| MVP | [`app/`](app/), with developer notes in [`app/README.md`](app/README.md) |
| One-page summary | [Summary (.md)](deliverables/Belvo_Smart_Retry_Summary.md) · [.docx](deliverables/Belvo_Smart_Retry_Summary.docx) |
| Presentation | [Short, 14 slides](deliverables/Belvo_Smart_Retry_Presentation_Short.pptx) · [Full, 32 slides](deliverables/Belvo_Smart_Retry_Presentation.pptx) |
| PRD | [PRD (.md)](deliverables/Belvo_Smart_Retry_PRD.md) · [.docx](deliverables/Belvo_Smart_Retry_PRD.docx) |
| User guide | [Guide (.md)](deliverables/Belvo_Smart_Retry_User_Guide.md) · [.docx](deliverables/Belvo_Smart_Retry_User_Guide.docx) |
| Output files from a real approved run | [Results](deliverables/Belvo_Smart_Retry_Results.csv) · [Payment requests](deliverables/Belvo_Smart_Retry_Payment_Requests.csv) · [Testing](deliverables/Belvo_Smart_Retry_Testing.csv) · [Manifest](deliverables/Belvo_Smart_Retry_Deliverables.md) |
| Specification and evidence | [Master spec](Belvo_Payments_Data_Analysis.md) · [Analytical diagnostic](Belvo_Smart_Retry_Analytical_Diagnostic.md) · [Decision log](Belvo_Smart_Retry_Decision_Log.md) |
| Wireframes | [`wireframes/lofi/smart-retry-lofi.html`](wireframes/lofi/smart-retry-lofi.html) |

## How it works

1. **Upload.** The operator uploads the loan portfolio. The payment history (253,006 requests) is already in the system.
2. **Classify.** SQL classifies every loan with ten ordered rules. Anything ambiguous goes to *Needs attention*. Clean insufficient-funds failures wait out a cooldown. Loans with 20 or more failures in a row rest 30 days.
3. **Draft requests.** Retry candidates get three draft payment requests: 5%, 25% and 70% of the balance.
4. **Hold out.** A random 10% is held out as a control group, to measure what retrying adds.
5. **Approve and release.** A different reviewer sees the amounts and approves, which releases the requests in the bank's own format.
6. **Close the loop.** Bank responses in that same format become history for the next analysis.

On the original data at a 7-day wait: 398 retry candidates, 1,951 waiting, 713 needing a person. Replaying the rules over the 22-month history would have stopped 60% of debit requests and 35.5% of chargeback events. Those stopped attempts held 17.4% of the money collected, which is an upper bound on what's at risk.

## Tests

- **Backend:** 42 tests on real SQLite and the original files. Run `cd app && .venv/bin/python -m pytest`.
- **Browser:** 16 Playwright tests in Chromium. Run `cd app/web && npx playwright install chromium && npm run e2e`.

## Data

`PaymentsPM_Challenge_loan_info.csv` and `PaymentsPM_Challenge_payment_requests.csv` are the files supplied for the challenge, included unchanged so the MVP runs out of the box.

## Notes

- The deck generators in `scripts/deck/` need `pptxgenjs` and an `apply_theme.js` helper that is not included.
- Everything runs locally on 127.0.0.1. Local data lives in `app/.local-data/` and is never committed.

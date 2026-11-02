# Smart Retry delivery manifest

Generated 2026-11-02T11:12:28+00:00 by `app/tools/generate_deliverables.py` from a real approved run of the local MVP (FastAPI + SQLite 3.53.4) on the original CSVs. Dataset kind: `belvo_sample`. Unofficial product-challenge prototype.

| File | SHA-256 | Content |
|---|---|---|
| `Belvo_Smart_Retry_Results.csv` | `a1c1e840789d060e36e0898c0d220fba0edd30df83f6bc17a7d92819301ba700` | One decision per loan, 3,062 rows |
| `Belvo_Smart_Retry_Payment_Requests.csv` | `db65171f55962de64ba951d08a1eec921e2dfd8e2ecf56b93d97b15db00973dd` | 1,077 pending payment requests for 359 retry candidates, released by approval, not sent |
| `Belvo_Smart_Retry_Testing.csv` | `bcfdd5e0510d243ef03a1c777a66b8bc3529b86224f8e6327e4a6000b9b0737c` | 58 executed test rows: 58 PASS |

Run `131e6c51-6d86-4343-9964-c20c3d2fba73` (revision 1), approved by `reviewer` at 2026-11-02T11:12:28Z.

Policy: 7-day wait, 30-day rest after 20 insufficient-funds failures in a row, 10% holdout. Evaluated at 2025-11-11T23:59:59-06:00. Rule version `minimal-v2`.

Totals: 398 retry candidates (39 held out as control), 1,951 waiting, 713 need attention. With fatigue off the same pair gives 400 / 1,949 / 713 (master section 9).

Sources: loan portfolio `667ce705f2e9c89c3ac2f5965ff3492601684c979cf3d55f7ceed1218cb7fc86`, payment history `27b608789d22c87703dd8bb4d70bd0283e468d91dde47adafe5dc2b4738f4b82`. Master `9cd6a146ebf09b7acf375a79c7cbcebdd624f7ef5bf61f35589fdd23057f07f6`.

Testing rows come from the most recent executed runs: Belvo_Smart_Retry_Testing.csv written 2026-11-02T11:10:23+00:00; Belvo_Smart_Retry_E2E_Testing.csv written 2026-11-02T11:12:21+00:00. Rerun `pytest` and `npm run e2e` before regenerating if code changed since then.

None of these files is a bank instruction, a recovery result or evidence of impact.

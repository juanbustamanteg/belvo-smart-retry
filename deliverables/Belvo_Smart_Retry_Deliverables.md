# Smart Retry delivery manifest

Generated 2026-11-02T11:51:51+00:00 by `app/tools/generate_deliverables.py` from a real approved run of the local MVP (FastAPI + SQLite 3.53.4) on the original CSVs. Dataset kind: `belvo_sample`. Unofficial product-challenge prototype.

| File | SHA-256 | Content |
|---|---|---|
| `Belvo_Smart_Retry_Results.csv` | `060061a5360a272a13d8349c2809195ae970f99216d0735ece51a349a22a1b35` | One decision per loan, 3,062 rows |
| `Belvo_Smart_Retry_Payment_Requests.csv` | `7fa96e343065b3cb5b21b0949239affa7894bab456716f402720be5994aa88e0` | 1,053 pending payment requests for 351 retry candidates, released by approval, not sent |
| `Belvo_Smart_Retry_Testing.csv` | `240d434331c8ae0fa1756256da75d796f1ed86454f699146c83f31b13091b3c4` | 58 executed test rows: 58 PASS |

Run `8f65ceb8-ccef-4216-a8f6-1b092934c16b` (revision 1), approved by `reviewer` at 2026-11-02T11:51:51Z.

Policy: 7-day wait, 30-day rest after 20 insufficient-funds failures in a row, 10% holdout. Evaluated at 2025-11-11T23:59:59-06:00. Rule version `minimal-v2`.

Totals: 398 retry candidates (47 held out as control), 1,951 waiting, 713 need attention. With fatigue off the same pair gives 400 / 1,949 / 713 (master section 9).

Sources: loan portfolio `667ce705f2e9c89c3ac2f5965ff3492601684c979cf3d55f7ceed1218cb7fc86`, payment history `27b608789d22c87703dd8bb4d70bd0283e468d91dde47adafe5dc2b4738f4b82`. Master `1d903669767e9ed45a7b6e453164c9bded4f9e31f4a18dea3d82080c6272a7b0`.

Testing rows come from the most recent executed runs: Belvo_Smart_Retry_Testing.csv written 2026-11-02T11:49:48+00:00; Belvo_Smart_Retry_E2E_Testing.csv written 2026-11-02T11:51:44+00:00. Rerun `pytest` and `npm run e2e` before regenerating if code changed since then.

None of these files is a bank instruction, a recovery result or evidence of impact.

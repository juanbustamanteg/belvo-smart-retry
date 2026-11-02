# Smart Retry: one-page summary

Unofficial Belvo product-challenge prototype · Bernabé Bustamante · November 2026

**Problem.** In the supplied data, 97.6% of 253,006 payment requests failed. Retries follow no rule, so the same accounts are hit again and again: 68% of today's retry candidates have never paid once, and the median candidate has failed for insufficient funds 12 times in a row.

**What I built.** A local web app (React, FastAPI, SQLite). A Belvo operator uploads the loan portfolio; the payment history is already in the system. SQL classifies every loan with ten ordered rules: anything ambiguous goes to *Needs attention*, clean insufficient-funds failures wait out a cooldown, and loans with 20+ failures in a row rest 30 days. A different reviewer sees the amounts and approves. Approval releases payment requests (5/25/70 of the balance, the dominant historical split) in the bank's own format. Smart Retry never sends money. Bank responses come back in the same format and feed the next analysis. A random 10% holdout measures what retrying really adds.

**Result on the original data (7-day wait).** 3,062 loans: 398 retry candidates, 1,951 waiting (1,623 resting), 713 needing attention, each with a plain-language reason, the matched rule and the date math.

**Potential impact.** Replaying the rules over the 22-month history:
- 60% fewer debit requests, about 2,240 per 1,000 loans per month.
- 35% fewer chargeback events.
- MXN collected per 1,000 requests doubles, from 4,719 to 9,734.

Those stopped attempts held 17.4% of collected money. That's an upper bound on recovery at risk, since rested loans are retried later. The holdout exists to measure the real figure before any client relies on it.

**Strategy worth pursuing.** Make Smart Retry the decision layer of Belvo's collections rails: whether, when and how much to debit.
1. **0-6 months.** Rules plus holdout inside Managed Collections with 2-3 design-partner lenders.
2. **6-18 months.** Income-aware timing and amounts, using each borrower's consented inflows from Belvo's open-finance data. Calendar paydays alone don't help: 1.88% success versus 1.85% on other days, so timing has to be personal.
3. **18-36 months.** One orchestration layer across Mexican direct debit and Brazil's Pix Automático, learning from outcomes across lenders.
4. **3-5 years.** A collections operating system that routes borrowers to hardship offers when a debit no longer makes sense.

Belvo's edge is owning the rails, the income data and the collections product in one place.

**Trade-offs and kill criteria.**
- Conservative rules add review work.
- The split, the threshold and the rest period are observed practice, not optimized policy.
- Live authorization, account status and debt checks are outside the data.
- **Kill criteria:** stop if recovery loss exceeds the threshold agreed with the lender, or if borrower consent is too low for income signals.

**Evidence.** 58 automated tests passed (42 backend on the original files, 16 in a real browser). Included: the deck, the result, payment-request and testing CSVs, happy-path and edge-case demo videos, a user guide, a detailed PRD, and `./app/bootstrap.sh` to install and start the app with one command.

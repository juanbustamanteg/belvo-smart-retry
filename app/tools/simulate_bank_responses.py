"""Generate SYNTHETIC bank responses for a Smart Retry payment request file.

Demo data only. It is not a bank response, not a forecast and not evidence of recovery.
Import it in the portal with origin "Synthetic demo"; every later result is then labeled synthetic.

How outcomes are drawn (master section 8, Response import):
- One outcome per loan, applied to all of its tranches: 98.1% of historical three-member batches
  had a single outcome.
- Status and failure-code frequencies come from historical three-member batches with one outcome,
  read from the original payment history file. Failure messages are the most frequent message for each code.
- Completion is two days after the request at a seeded minute between 09:00 and 11:00 local.
  Chargebacks are dated three days after completion.

- Optional --next-portfolio writes a SYNTHETIC next loan snapshot for measuring the holdout: each loan whose
  requests succeeded has its outstanding balance reduced by the collected amount. Every other loan, including
  all control loans, keeps its balance: the script assumes no self-cure, which is an assumption, not data.

Usage (from app/):
    .venv/bin/python tools/simulate_bank_responses.py REQUESTS.csv -o SYNTHETIC_responses.csv [--seed 7]
        [--next-portfolio SYNTHETIC_next_portfolio.csv --portfolio ../PaymentsPM_Challenge_loan_info.csv]
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import random
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Mexico_City")
COLUMNS = ["payment_request_id", "created_at", "completed_at", "chargeback_at", "status", "amount",
           "failed_reason", "failed_message", "loan_id"]
DEFAULT_HISTORY = Path(__file__).resolve().parents[2] / "PaymentsPM_Challenge_payment_requests.csv"


def historical_mix(history: Path):
    batches = collections.defaultdict(list)
    messages = collections.defaultdict(collections.Counter)
    for r in csv.DictReader(history.open(encoding="utf-8-sig")):
        batches[(r["loan_id"], r["created_at"])].append((r["status"], r["failed_reason"]))
        if r["status"] == "failed" and r["failed_message"]:
            messages[r["failed_reason"]][r["failed_message"]] += 1
    mix = collections.Counter(v[0] for v in batches.values() if len(v) == 3 and len(set(v)) == 1)
    return mix, {code: c.most_common(1)[0][0] for code, c in messages.items()}


def iso_ms(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("requests", type=Path, help="payment request CSV downloaded from the portal")
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--history", type=Path, default=DEFAULT_HISTORY)
    ap.add_argument("--next-portfolio", type=Path, help="also write a SYNTHETIC next portfolio snapshot")
    ap.add_argument("--portfolio", type=Path, default=DEFAULT_HISTORY.parent / "PaymentsPM_Challenge_loan_info.csv")
    args = ap.parse_args(argv)

    mix, messages = historical_mix(args.history)
    outcomes, weights = zip(*sorted(mix.items()))
    rng = random.Random(args.seed)
    rows = list(csv.DictReader(args.requests.open(encoding="utf-8-sig")))
    if not rows or list(rows[0].keys()) != COLUMNS:
        raise SystemExit("Input is not a Smart Retry payment request file.")
    by_loan = collections.defaultdict(list)
    for r in rows:
        by_loan[r["loan_id"]].append(r)
    out, tally = [], collections.Counter()
    for loan in sorted(by_loan):
        status, code = rng.choices(outcomes, weights)[0]
        tally[status] += 1
        created = dt.datetime.fromisoformat(by_loan[loan][0]["created_at"])
        local = created.astimezone(TZ)
        completed = dt.datetime.combine(local.date() + dt.timedelta(days=2), dt.time(9, 0), tzinfo=TZ) \
            + dt.timedelta(minutes=rng.randrange(120), seconds=rng.randrange(60))
        for r in by_loan[loan]:
            out.append({**r, "completed_at": iso_ms(completed), "status": status,
                        "chargeback_at": iso_ms(completed + dt.timedelta(days=3)) if status == "chargeback" else "",
                        "failed_reason": code if status == "failed" else "",
                        "failed_message": messages.get(code, "") if status == "failed" else ""})
    with args.output.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, lineterminator="\r\n")
        w.writeheader()
        w.writerows(out)
    print(f"SYNTHETIC responses for {len(by_loan)} loans ({len(out)} requests): {dict(tally)}")
    if args.next_portfolio:
        collected = collections.Counter()
        for r in out:
            if r["status"] == "successful":
                collected[r["loan_id"]] += Decimal(r["amount"])
        with args.portfolio.open(encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            fields, loans = reader.fieldnames, list(reader)
        for loan in loans:
            if collected[loan["loan_id"]]:
                left = max(Decimal(loan["total_amount_outstanding"]) - collected[loan["loan_id"]], Decimal(0))
                loan["total_amount_outstanding"] = f"{left:f}"
        with args.next_portfolio.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields, lineterminator="\r\n")
            w.writeheader()
            w.writerows(loans)
        print(f"SYNTHETIC next portfolio: {sum(1 for v in collected.values() if v)} loans reduced. Written to {args.next_portfolio}.")
    print(f"Written to {args.output}. Import with origin 'Synthetic demo'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

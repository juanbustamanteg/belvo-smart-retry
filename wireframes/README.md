# Smart Retry wireframe

English, low-fidelity, unofficial product challenge. The [master](../Belvo_Payments_Data_Analysis.md) is the sole specification: section 5 contains business rules; section 7 defines operational UI hierarchy. This guide is derived, not an independent requirements source.

## Open

Open index.html directly in a browser. Keep wireframe.js beside it. No installation is required. A local server is optional and is not a shareable public URL:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory wireframes
```

Serve only wireframes/, never the project root containing portfolio CSVs. Stop with Ctrl+C. Hosting/audience selection remains pending; do not share original loan data publicly.

## Review the operational flow

1. Sign in to preview as Operator. No credentials are collected.
2. New analysis: choose the portfolio only. System payment history is already available. History provenance and analysis settings are secondary disclosures.
3. Check portfolio, then Generate results. Both operations are simulated, not real CSV/SQL processing.
4. Results: open Retry candidates, Waiting or Needs attention. Inspect the plain-language reason and next check; View details explains what to do next. Expand payment evidence only if needed.
5. Submit for review. This includes all loans, not only the visible queue.
6. In the separate Demo controls panel, change Preview account to Reviewer, sign in, and open the analysis. Approve results or expand Request changes instead and provide a comment.
7. Approved results shows one primary Download approved CSV action. This wireframe previews the handoff and does not fabricate a full result file.

For quick access, expand Demo controls and choose Open result preview. This shortcut explicitly loads reference expectations, not an executed run. Use that panel for invalid portfolio, unavailable history, interruption or expired-session scenarios. Missing history requires setup remediation, not a transaction-upload workaround.

## Evidence and limitations

The interface prioritizes tasks, not explaining the algorithm. Formal rule codes, ordered conditions, SQL, artifact schemas and testing obligations remain in the master. The real app must still expose complete original evidence and revision/source identity on demand.

The three illustrative loan rows are synthetic examples, excluded from the original portfolio totals. Their monetary values and exact dates are not invented. Full-run counts are documented 3/7/14-day expectations, not computed results. Prototype state is in memory; refresh resets it. No real authentication, database, durable history, rule engine, scheduler, CSV download or payment request exists. Reviewer feedback is not a durable audit record here.

Earlier browser walkthroughs covered the previous layout, not this revision. This revision passed JavaScript syntax checking but has not been visually/browser verified: file-URL browser automation was denied. Actual application/E01-E15 tests remain NOT_RUN. No correctness, security, accessibility certification or recovery-lift claim follows from this prototype.

## What to review

Can an agent find the loans that need attention without understanding rule codes? Is the next action obvious? Can a reviewer approve or return the complete output? Is approval clearly distinct from sending a debit? Review those questions before visual polish.

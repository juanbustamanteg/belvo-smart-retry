# Wireframe QA inventory

Scope: navigation prototype only; not the application acceptance suite. Business logic and original portfolio results are not executed here.

## Checks for this revision

| Check | Path / visible assertion | Status |
|---|---|---|
| WF01 | Sign in, empty workspace/results, begin portfolio | Pending |
| WF02 | Use sample portfolio, check, generate, see results without preview shortcut | Pending |
| WF03 | Switch all three queues, open/close details; populated synthetic balances, dates and evidence | Pending |
| WF04 | Return to portfolio/workspace and reopen without losing selection or complete results | Pending |
| WF05 | Submit, switch to Reviewer through separate demo controls, approve, reach output | Pending |
| WF06 | Download clearly labeled three-row fixture, never a fabricated 3,062-row result | Pending |
| WF07 | Return without comment blocks; return with comment displays escaped feedback; revise and resubmit | Pending |
| WF08 | Missing portfolio, invalid portfolio and unavailable system history expose actionable recovery | Pending |
| WF09 | Interrupted processing has no partial output; explicit revised run succeeds | Pending |
| WF10 | Session-expiry scenario, sign out/in, reset, ready preview; no automatic approval | Pending |
| WF11 | 3/7/14 settings and back/forward through app controls retain intended state | Pending |
| WF12 | Desktop and narrower viewport, visible primary action, no unwanted horizontal page overflow; keyboard focus | Pending |

Known initial observations: old Results rendered over HTTP without a reproduced JavaScript crash; however balances/dates were placeholders, selection was lost on rerender, feedback was not shown, export was a dead-end notice and direct-file delivery depended on an external script. Fixes target those reproducible gaps; no unsupported claim about the user's exact browser failure is made.

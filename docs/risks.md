# Risk register (2026-11-24)
Sources: [frontend](audit/frontend.md), [database](audit/database.md), [integrations-booking](audit/integrations-booking.md), [shared-infra](audit/shared-infra.md), [integrations](integrations.md), [data-availability](data-availability.md). L/I ratings are judgement, not measured.

| # | risk | likelihood | impact | evidence | mitigation | owner decision needed? |
|---|---|---|---|---|---|---|
| 1 | Unsourced estimator constants shown as earnings | H | H | index.html:5298-5312, 8801-8830, 8684; audit/frontend.md §2 | cite or drop; show inputs and scenarios; label "estimate" | yes (sources/paid data) |
| 2 | "List once, live everywhere" overclaims vs iCal-only reality | H | H | index.html:12, 8272, 9970; integrations.md L1 | copy at L1; label simulated sync demo-only | yes (copy) |
| 3 | iCal latency causes double-bookings | M | H | integrations.md assumption (latency unverified); guard.ts:136-156 | keep holds + 15-min guard; add EXCLUDE; staleness banner | no |
| 4 | Platform ToS / competitive-use limits | M | H | integrations.md: all cells "not verified" | verify official terms; iCal and manual import only (decision) | yes (counsel, approvals) |
| 5 | ODbL share-alike on stored profiles | M | M | data-availability.md; shared-infra.md constraints | store attribution; isolate OSM/Overture-derived data; legal check | yes |
| 6 | No licence file in sibling repos (CP, SF) | M | M | shared-infra.md "Hard constraints" | owner adds licence before vendoring; pin commit | yes |
| 7 | LA-only data coverage | H | M | audit/frontend.md §3; data-availability.md | per-market registry returning `ok:false`; state coverage | no |
| 8 | Single-file 1.4 MB frontend hard to change safely | H | M | index.html (20k+ lines); everyspace.html identical | split data/logic gradually; tests on pure functions | no |
| 9 | No staging; changes go to live | M | H | live list_branches empty; audit/database.md §6 | local Postgres 16 + PGlite (decision); approval before live | yes (live applies) |
| 10 | Migration drift (8 live vs 6 files) breaks `db push` | H | M | audit/database.md §4 | rename to live versions; add live-only migrations | no |
| 11 | Marketplace positioning conflict in README/demo | H | M | README.md:9, 40, 54; PLAN.md:17, 61; audit/frontend.md §5 | flagged, demo untouched this run (decision); rewrite later | yes |
| 12 | LA Home-Sharing rules unverified | M | H | data-availability.md: STR status NV, assumption only | verify on official page; no compliance claims until then | yes |
| 13 | Single-tenant model blocks teams/co-hosts | M | M | audit/database.md §2 | `orgs` + `memberships`, change `owns_space()` only | no |
| 14 | No tests for Host Console or edge-function handlers | H | M | audit/frontend.md §8; audit/integrations-booking.md §8 | handler tests, fetch/SSRF tests, concurrency test | no |
| 15 | SSRF via host-pasted iCal URLs | M | H | fetch.ts:21,23 | block private ranges, re-check redirects | no |
| 16 | Platform and data research incomplete (network blocked) | H | M | integrations.md, data-availability.md headers | allow hosts, re-run | yes |

## Verified
- Tests: 34 + 15 pass; none for Host Console or handlers (audit files).
- README/PLAN call it a marketplace; vision is management-first.
- No LICENSE in CP or SF (shared-infra audit).

## Assumptions
- iCal refresh latency is minutes to hours (unconfirmed).
- OSM ODbL allows storing derived profiles with attribution (unconfirmed).
- Likelihood/impact ratings are judgement.

## Recommendations
- Resolve #1, #2, #9 first: they are cheap and visible.
- Get owner decisions on #4, #5, #6, #12 before storing any third-party data.
- Add tests for #14 and #15 before extending sync.

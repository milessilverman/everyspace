# Risk register (2026-11-24)
Sources: [audit](audit.md), [security](security.md), [integrations](integrations.md), [data-availability](data-availability.md), [review-gate](audit/review-gate.md). L/I ratings are judgement, not measured. "Mitigated" means fixed in this branch and tested locally; nothing is applied to the live project yet.

| # | risk | L | I | evidence | mitigation / status | owner decision? |
|---|---|---|---|---|---|---|
| 1 | Unsourced constants shown as earnings | H | H | demo `index.html:5298-5312, 8801-8830`; `core/data/assumptions.js` | Estimator (`estimate/`): mitigated, defaults labelled "planning default (uncited)", confidence <= 0.2. Demo map and quiz: still open | yes (sources) |
| 2 | "List once, live everywhere" overclaims vs iCal-only reality | H | H | `index.html:12, 8272`; only `ical` and `manual` adapters exist | open: copy at L1; label simulated sync demo-only | yes (copy) |
| 3 | iCal latency causes double-bookings | M | H | Airbnb imports refresh every 3 h (integrations.md); latency of others not verified | holds + 15-min guard + exclusion constraint + locked sync (staging); residual gap between refreshes | no |
| 4 | Airbnb API terms vs a long-term marketplace | M | H | airbnb.com/help/article/3418, 2026-11-24: bars use "in a product or service that competes with or provides similar features or functionalities as any API Program" and "retaining static copies or building databases"; delete data within thirty days of termination | iCal and manual import only, no Airbnb API; do not apply for the API before deciding on the marketplace | yes (counsel, positioning) |
| 5 | Other platforms' terms not read (Vrbo, Booking.com) | M | H | integrations.md: "not verified" | verify before any adapter beyond iCal | yes |
| 6 | ODbL share-alike on stored profiles | M | M | data-availability.md | store attribution; isolate OSM/Overture-derived data; legal check | yes |
| 7 | No licence file in sibling repos (CP, SF) | M | M | shared-infra.md | owner adds licence before vendoring; pin commit | yes |
| 8 | LA-only data coverage | H | M | data-availability.md | per-market registry returning `ok:false`; state coverage | no |
| 9 | Single-file 1.4 MB frontend hard to change safely | H | M | `index.html` | split gradually; `core/` has tests | no |
| 10 | Nominatim use from the browser (the Census geocoder sends no CORS header) | M | M | operations.osmfoundation.org/policies/nominatim, 2026-11-24: max 1 request/s for the whole application, identifying Referer/User-Agent, no client-side autocomplete, may change without notice | estimator geocodes only on button press, one at a time; fine at small volume; move behind a caching proxy before growth | yes (proxy) |
| 11 | Edge functions in this branch fail on the live schema until migrations are applied | H | H | functions select `calendar_imports.last_ok_at`/`consecutive_failures` and call `sync_calendar_import` (migration M5) | deploy order: migrations, cron script by hand, then functions ([platform/README.md](../platform/README.md)) | yes (apply) |
| 12 | LA Home-Sharing rules unverified | M | H | rule page is script-rendered and could not be read; every rule in `core/data/jurisdictions.js` is `verified:false` | no compliance claims until checked on the official page | yes |
| 13 | Estimator defaults uncited, so every estimate is low confidence by construction | H | M | `core/data/assumptions.js`, `platform-fees.js` (all uncited defaults at confidence <= 0.2) | labelled in the UI; owner can override; license or cite a source per category | yes (sources) |
| 14 | Marketplace positioning conflict (README, demo screens) | H | M | README feature list; demo marketplace screens | flagged under "What's needed before launch"; untouched | yes |
| 15 | Single-tenant model blocks teams | M | M | audit/database.md §2 | mitigated on staging: orgs, roles, memberships (`rls.test.mjs`) | no |
| 16 | SSRF via host-pasted iCal URLs | M | H | `fetch.ts` | mitigated on staging (`fetch.test.ts`); DNS rebinding cannot be fully closed in the edge runtime | no |
| 17 | iCal summaries may carry guest names, shown in the Host Console | M | M | review-gate suspected 4; db1-report | open (product decision) | yes |
| 18 | Shared-resource capacity cannot be expressed in a calendar feed | M | M | db1-report limits | enforced only by booking RPCs; say so in the UI | no |
| 19 | OSM/Overpass steps verified on fixtures only | M | M | overpass-api.de unreachable from the build environment | test against the live service before launch | no |
| 20 | Single-match situs-address parcel hit not observed on the live LA service | M | M | not verified | check once with owner approval | no |

## Fixed or mitigated since the first audit
No tests for handlers (now 231 platform tests); no staging (local Postgres 16 plus PGlite); migration drift (files renamed to live versions, 2 reconstructed); double-booking races (review findings, tested).

## Verified
- Suites on 2026-11-24: platform 231, staging 16, root 272, plus 11 + 18 browser checks.
- Airbnb terms and Nominatim policy read directly on 2026-11-24.

## Assumptions
- iCal refresh latency is minutes to hours (unconfirmed).
- OSM ODbL allows storing derived profiles with attribution (unconfirmed).

## Recommendations
- Decide #4 (marketplace vs Airbnb terms) before any partner application.
- Follow the apply order for #11; do not deploy functions first.
- Get owner decisions on #5, #6, #7, #12 before storing third-party data.

# Everyspace STATE (rewritten each phase; max ~150 lines)

## Demo inventory (moving to milessilverman/everyspace-demo)
Split commit: line numbers below are for the `index.html` at the start of this branch (1.4 MB single file, `everyspace.html` byte-identical).

| files | role |
|---|---|
| `index.html`, `everyspace.html` | the demo app (identical copies); `everyspace.html` becomes a redirect stub, `index.html` becomes the new homepage |
| `tests/domain.test.mjs` | loads the demo's domain modules out of `index.html` (pricing, price rule, iCal, privacy) |
| README "Earnings map", "What's in the app", "What's needed before launch", intro bullets | describe the demo only |

| demo-only part | detail |
|---|---|
| Hash routes (`ROUTES`, line 20584) | `/` `/quiz` `/earn` `/explore` `/saved` `/long-term` `/space/:id` `/book/:id` `/book/pkg/:id` `/trips` `/trip/:id` `/offer/:id` `/inbox` `/chat/:id` `/host` `/host/listings` `/host/calendar` `/host/import` `/host/tasks` `/host/sites` `/xchat/:id` `/host/docs` `/host/team` `/promise` `/host/earnings` `/host/new` `/host/space/:id` `/fair-price` `/biz` `/biz/pipeline` `/map` `/profile` `/plan` `/catalog` (`/earn` listed twice) |
| Embedded library | Leaflet 1.9.4 inlined, `<script id="leaflet-lib">` lines 5101-5108 (BSD-2-Clause) |
| localStorage | `everyspace-demo-v13` (whole demo db, line 10164), `everyspace:<key>` (prefs, lines 10229, 19821); no sessionStorage, no cookies |
| External hosts | fonts.googleapis.com, fonts.gstatic.com, nominatim.openstreetmap.org, overpass-api.de, overpass.kumi.systems, public.gis.lacounty.gov, server.arcgisonline.com (+ CARTO tiles), generativelanguage.googleapis.com (AI description); the rest are outbound links (airbnb, spothero, swimply) |

| reference outside the demo | runtime dependency of the real app? | action |
|---|---|---|
| `core/data/{categories,assumptions,platform-fees,jurisdictions,parcel-services}.js`, `core/parcel.js` comments | no: cite line numbers as origin of copied defaults, nothing imported | retarget to `everyspace-demo index.html:<line>` |
| `core/tests/opportunities.test.mjs` 214, 227-234 | no (test only), but READS `../../index.html` and checks `CATEGORIES` key lines | content check removed (demo no longer here); format check retargeted |
| `core/tests/regulatory.test.mjs` 56 | no, regex on `sourceRef` | regex retargeted |
| `docs/revenue-method.md` | no | retarget |
| `docs/{audit,gaps,risks,roadmap,architecture,data-availability,integrations,security}.md`, `docs/STATE.md` | no, prose | left (historical); `architecture.md` row for demo is now stale |
| `docs/audit/*` | no | untouched by instruction |
| `platform/README.md` line 3, `platform/supabase/migrations/20261124020000_catalog.sql` line 35 | no | README fixed; migration comment left (platform/** and migrations are frozen) |
| `tests/estimate.e2e.mjs`, `tests/host.e2e.mjs` | no: only `estimate/index.html` and `host/index.html` | none |
| `README.md` | no | rewritten |


Updated 2026-11-24, end of run 1. Branch `claude/trusting-cannon-yynabw`. This file plus the paths in a brief are all an agent reads.

## Status
| phase | status | evidence |
|---|---|---|
| 0 Audit + design docs | done | `docs/audit/*.md`, `docs/*.md`; research verified where publishers allowed access |
| 1 Foundation | done on staging | migrations M0-M5, provider adapters, sync hardening; review findings fixed |
| 2 Property intelligence | done (code) | `core/{provenance,profile,geometry,parcel}.js`; one live spot-check of Census + LA County |
| 3 Revenue discovery | done (code) | `core/{opportunities,regulatory,revenue,optimizer}.js`, `estimate/` page |
| 4-6 | documented only | `docs/roadmap.md` |
| Live database / deployed functions | unchanged | nothing applied; see approvals |

## Test commands and last results
| command | result |
|---|---|
| `cd platform && npm test` | 231 pass |
| `cd platform && npm run test:staging` (local Postgres 16, two-connection races) | 16 pass |
| `node --test core/tests/*.test.mjs` (repo root; demo tests moved out) | 257 pass |
| `node tests/home.e2e.mjs` (browser, mocked lookups) | 7 scenarios pass |
| `node tests/estimate.e2e.mjs` (browser, mocked lookups) | 11 scenarios pass |
| `node tests/host.e2e.mjs` (browser, mocked backend) | 18 checks pass |
Baseline before the run: platform 34, root 15.

## Hard rules for every agent
- LIVE Supabase project `hnzcwfvxpfsyjpbebevp` is production. Never write to it, never deploy to it. Staging = local Postgres 16 (`platform/scripts/staging.sh`) + PGlite tests.
- No secrets in frontend or repo. No scraping. No sign-ups, no contact with any provider, no paid service.
- No fabricated market data. A number without a source is tagged `estimated`, source `Everyspace planning default (uncited)`, confidence <= 0.2, and can be overridden by the owner. A missing number is `unavailable`, never 0.
- An opportunity is listed only when an attribute evidences the asset or the owner confirms it.
- Do not touch files outside the ownership in your brief. `index.html`/`everyspace.html` are 1.4 MB: grep, never read whole.
- Deterministic logic = pure functions with tests. `now` is injected.
- Never edit the `20261116*` migrations (they mirror production history); override in later files.

## Decisions (full log: `docs/adr/README.md`)
1 keep stack, no build step · 2 `/core` zero-dependency ES modules · 3 database authoritative for bookings, JS mirror with parity test · 4 tenant = organization, roles are rows · 5 platforms/categories are lookup tables · 6 provider adapters with honest capability levels · 7 append-only provenance, owner-confirmed wins · 8 City Pretty reused by re-implementation at commit `ac7faf3`, not by calling its Worker · 9 restricted third-party data only in `provider_data` with expiry · 10 optimizer = exhaustive feasible-subset search · 11 uncited numbers only as labelled planning defaults · 12 staging = local Postgres + PGlite · 13 external bookings are recorded and flagged, never rejected · 14 browser geocoding via Nominatim, server order Census then Nominatim · 15 a relation between two spaces is mutual exclusion in either arrival order.

## Where things are
| area | paths |
|---|---|
| Contracts | `core/types.js` |
| Property intelligence | `core/{provenance,profile,geometry,parcel}.js`, `core/data/parcel-services.js` |
| Opportunities and rules | `core/{opportunities,regulatory}.js`, `core/data/{categories,jurisdictions}.js` |
| Revenue and optimizer | `core/{revenue,optimizer}.js`, `core/data/{assumptions,platform-fees,scenarios}.js` |
| Availability mirror | `core/availability.js`, cases in `core/tests/fixtures/availability-cases.js` |
| Estimator page | `estimate/{index.html,app.js,app.css}` |
| Host Console | `host/index.html` |
| Migrations | `platform/supabase/migrations/` (`20261116*` = live history, `20261124*` = this run, staging only) |
| Edge functions and adapters | `platform/supabase/functions/`, `_shared/providers/` |
| Tests | `core/tests`, `tests`, `platform/tests`, `platform/tests/staging` |

## Interfaces other work relies on
- Core exports: see `core/types.js` and each module's header. Additions since the first draft: `OpportunityEstimate.notIncluded`, `OptimizationResult.eligibleIds`, `resolveAddress` options `geocoders`, `confirmMatchedAddress`, `parcelApn` and result fields `needsConfirmation`, `matchedAddress`, `candidates`; `defaultResourceCapacity(profile)`, `missingEvidence(profile)`, `OWNER_ATTRIBUTE_KEYS`.
- Booking RPCs: `create_booking`, `cancel_booking`, `reschedule_booking`, `import_reservations` (host imports), `sync_calendar_import` (service role only), `place_hold`, `release_hold`, `availability_conflicts`, `blocking_spaces`. Nobody, including the service role, writes `reservations` directly.
- Membership RPCs: `accept_invite`, `decline_invite`, `org_member_profiles(org)`. Profile RPC: `confirm_attribute`; view `property_profile`.
- Sync health: `calendar_imports.consecutive_failures`, `last_ok_at`, view `sync_health`; `last_error` now holds a short code, never a URL.

## Approvals pending (owner)
| # | request | what it unblocks |
|---|---|---|
| A2 | Apply migrations M0-M5 to the live Supabase project (empty today), then run the cron script, then deploy the four edge functions, in that order | everything in Phase 1 for real hosts; saving estimator profiles to an account |
| A3 | Confirm the licence for reusing City Pretty code patterns and its parcel-registry entries in Everyspace (same owner, no LICENSE file) | publishing `core/data/parcel-services.js` and `core/parcel.js` |
| A4 | Decide the product message: README and demo still present a consumer marketplace with a 3% host fee | home-page link to the estimator; demo cleanup |
| A5 | Merge this branch to `main` (GitHub Pages) | public estimator at `/everyspace/estimate/` and the Host Console changes |
| A6 | Any paid item in `docs/costs.md` (hosted staging project beyond free limits, Channex, market data, domain) | partner-level sync; calibrated estimates |
Granted during the run: network allow-list for 20 official publisher hosts (research and one live spot-check).

## Known limits (verified, not fixed)
- Every estimate is low confidence by construction until the owner enters their own price and bookings: no licensed comparable-data source exists.
- LA Home-Sharing rule text could not be read from the official page (script-rendered); LA rules in `core/data/jurisdictions.js` are marked unverified and capped at confidence 0.3.
- Overpass was unreachable from the build environment: OSM building, pool and transit steps are verified on fixtures only. A single-match situs-address parcel hit was not observed live.
- Browser geocoding uses Nominatim (1 request/second for the whole application, no autocomplete): fine for a pilot, not for promotion. A cached server-side geocoder is the fix (needs a deploy).
- DNS rebinding on host-pasted calendar URLs cannot be fully closed in the edge runtime.
- Calendar feeds cannot express shared-resource capacity; iCal summaries may carry guest names.
- Vault, pg_cron and pg_net are not exercised in staging.

## Next (run 2 candidates, in order)
1. After A2: wire the Host Console to `create_booking`/`cancel_booking`, relations, resources and `property_profile`; "save my estimate" from the estimator.
2. Server-side `property-intel` function: cached geocode + parcel + OSM with provenance.
3. Verify LA rules from the ordinance text; add jurisdictions as data.
4. Move `index.html` onto `core/` (remove its duplicate constants) once A4 is decided.
5. Phase 4 measurement: estimate-vs-actual per host with consent.

## Skipped as off the critical path
Photo upload storage and UI · team invitation UI · hourly calendar view · email booking parser · PostGIS · hosted staging project · index.html demo changes.

## Process note
During the audit one subagent issued a stray `archive_session("self")` call; the service rejected it and nothing was archived. Later briefs forbid session-management tools.

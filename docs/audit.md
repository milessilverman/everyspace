# Current-state audit (2026-11-24)
Consolidated from [frontend](audit/frontend.md), [database](audit/database.md), [integrations-booking](audit/integrations-booking.md), [shared-infra](audit/shared-infra.md), [integrations](integrations.md), [data-availability](data-availability.md). Read-only; no runtime checks added here.

| area | item | status | evidence | keep / modify / replace |
|---|---|---|---|---|
| frontend demo app | Single-file index.html (everyspace.html byte-identical); route table, earnings quiz, map (LA parcels, OSM roofs) | partial | index.html:20584-20620; map 19399-19402 | keep quiz and map; modify inputs |
| frontend demo app | Consumer marketplace screens (explore, book, trips, offers, simulated checkout) | partial (demo) | index.html:20588-96, 12905 | replace/demote; left untouched this run (decision) |
| frontend demo app | `/earn` route declared twice (second dead) | partial | index.html:20586-87, 20615 | modify (fix) |
| frontend demo app | Direct/price/message sync to Airbnb, Booking, Vrbo simulated | partial (fake) | index.html:8272-8281, 8517-8531, 8627-8640 | replace; label demo-only |
| Host Console | host/index.html reads/writes Supabase (calendar, alerts, holds, earnings) | implemented | host/index.html:254-264, 593-716; runtime not verified | keep, modify |
| Host Console | Hourly view, occupancy, per-channel revenue, staleness banner, tasks/team/docs | missing | audit/integrations-booking.md §7; audit/frontend.md §7 | modify (add) |
| database | 13 tables, RLS on all, anon has no policy; DB empty (1 row) | implemented | live; init.sql:282-311 | keep |
| database | Single-owner tenant; no org/roles | missing (orgs, roles) | audit/database.md §2 | keep now; modify if teams |
| database | Platforms hard enum (19 values); categories free text | partial | init.sql:114, :102 | replace enum with lookup; modify categories |
| security | 8 findings, none HIGH | partial | audit/database.md §3 | see [security.md](security.md) |
| security | Service-role key only via Deno.env; cron secret in Vault; anon key in frontend | implemented | audit/database.md §5 | keep |
| security | No staging; migrations 8 live vs 6 files, versions differ, cron not a migration | missing / partial | live list_branches empty; audit/database.md §4, §6 | modify |
| calendar sync | iCal import (15 min cron + Sync now) and export feed per space+site | implemented | calendar-sync/index.ts:24-76; calendar-feed/index.ts:15-43 | keep |
| calendar sync | Provider adapter interface | missing | guard.ts:95-108; booking-guard/index.ts:132-141 | replace (iCal as first adapter, decision) |
| calendar sync | Partner API / Channex / platform terms | planned; not verified | integrations.md matrix (all cells "not verified") | needs owner approval (decision) |
| calendar sync | SSRF: fetch.ts checks only `^https://`, follows redirects | partial | fetch.ts:21,23 | modify (before extending) |
| calendar sync | Failed-sync handling: no backoff/staleness; empty feed cancels future rows | partial | sync/index.ts:69,73; sync.ts:60 | modify |
| availability/conflicts | tstz ranges, parent/child, holds, advisory lock, one-door rule, 15-min guard | implemented | M/...010000:17-190; guard.ts:136-156 | keep |
| availability/conflicts | No exclusion constraint; imports inserted without lock; multi-unit conflicts never reported | partial | audit/database.md §7; M/...010000:288 | modify |
| availability/conflicts | Buffers, typed relations, shared-resource rules only in JS prototype | planned | index.html:6113-6215 | modify (port to engine) |
| estimator/revenue | Fee table PLATFORMS 22 sites, `verified:false` except craigslist/facebook | partial | index.html:5978-6001 | modify (source + date) |
| estimator/revenue | TYPICAL rates, solar, venue constants unsourced | partial | index.html:5298-5312, 8801-8830, 8684 | modify (cite or drop) |
| estimator/revenue | City Pretty inputs in quiz simulated | partial | index.html:17704-25 | replace via vendored functions (decision) |
| estimator/revenue | Revenue-share accrual (10% to $30/mo, then 3%), idempotent | implemented | migration ...020000:16-50 | keep |
| shared infra | City Pretty `parcelAt`, `Sourced<>`, PVWatts, OSM queries | implemented (sibling repo) | shared-infra.md capability map | keep: vendor at pinned commit (decision) |
| shared infra | CP Worker has no parcel/geocode route; allow-list names ES host | partial | CP:workers/api-proxy.ts:47-51, 208-210 | do not call (decision) |
| shared infra | No LICENSE in CP or SF; driveway/pool/demand data missing | missing | shared-infra.md "Hard constraints" | owner decision |
| tests | platform `npm test` 34 pass; root 15 pass; PGlite DB | implemented | audit/integrations-booking.md header | keep |
| tests | None for host/index.html, edge-function handlers, fetch.ts, concurrency, accrual refunds | missing | audit/integrations-booking.md §8; audit/frontend.md §8 | add |
| docs/drift | README calls it a marketplace (3% host fee) vs management-first | partial | README.md:9, 40, 54; PLAN.md:17, 61 | modify (rewrite) |
| docs/drift | Test count 31 vs 34; broken link `../everyspace__1-1.html` | partial | platform/README.md:3 | modify |
| docs/drift | Platform research (integrations, data availability) blocked by network | missing | integrations.md, data-availability.md headers | re-run after owner allows hosts |

## Verified
- Both test suites ran (34 + 15 pass); DB tables, RLS, functions, cron, advisors read live (audit files).
- No real provider API code exists; direct/price/message sync is simulated.
- Only github.com resolved on 2026-11-24; Microsoft footprints ODbL confirmed.

## Assumptions
- Supabase project `hnzcwfvxpfsyjpbebevp` is LIVE with no branches (decision).
- Frontend anon key belongs to that project (audit/database.md).
- Current run-rate is $0 (per repo docs).

## Recommendations
- Fix migration filenames/drift, then add local Postgres 16 + PGlite staging (decision).
- Fix SSRF and sync-staleness before any adapter work.
- Source or label every estimator constant; keep the estimator free.
- Re-run platform and data research once hosts are allowed.

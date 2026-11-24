# Integrations / booking / estimator audit (read-only, 2026-11-24)
Paths relative to repo root. `P`=platform/supabase, `F`=P/functions/_shared, `M`=P/migrations, `IDX`=index.html, `HOST`=host/index.html.
Tests: platform `npm test` 34 pass / 0 fail, ~1.9 s (node --test, PGlite). Root `node --test tests/*.test.mjs` 15 pass / 0 fail, ~0.2 s. Install succeeded first try.

## 1-2. Provider integration and capability honesty
| item | status | evidence | verdict |
|---|---|---|---|
| Real sync = iCal import (every 15 min cron + "Sync now") and iCal export feed per space+site | implemented | functions/calendar-sync/index.ts:24-76,89; calendar-feed/index.ts:15-43 | keep |
| Provider adapter abstraction | missing | only `channel` string + `SITE_NAMES` map (F/guard.ts:95-101); `VERIFIABLE_BY_CALENDAR={airbnb,vrbo}` hardcoded (guard.ts:108); booking-guard branches inline on channel (booking-guard/index.ts:132-141) | replace (new interface; ical becomes first adapter) |
| iCal parse/build, TZ + DST, fold/unfold, no guest data in feed | implemented, tested | F/ical.ts:71,126,147; tests/ical.test.ts (8 tests) | keep |
| RRULE/EXDATE support | missing | grep finds none in ical.ts | modify (add if sources use them) |
| SSRF protection on host-pasted URLs | partial | F/fetch.ts:21 only checks `^https://`; `redirect:'follow'` (l.23); no private-IP/DNS/localhost block, no redirect-hop check | modify (must fix before extending) |
| Timeout / size cap | implemented | fetch.ts:23 (15 s), :2,12 (3 MB streamed cap) | keep |
| Failed-sync handling | partial | status+error stored on `calendar_imports` (sync/index.ts:69,73); no stale-after-N-failures flag, no backoff, no retry count; an empty feed cancels future rows (sync.ts:60); root-level test says empty feed never wipes (tests/domain.test.mjs:61, demo code only) | modify (add staleness + empty-feed guard in platform path) |
| Cron auth | implemented | sync/index.ts:83-87 (Vault secret via `check_cron_secret`) | keep |
| Direct/API connections (Airbnb, Booking.com, Expedia/Vrbo "direct") | planned, simulated | IDX:8272-8281 "connections are simulated"; SITE_INFO connect:'direct' IDX:~8286; `publish()` builds fake `/demo/` URLs and `lastSync: now` IDX:8517-8531 | replace (demo-only; no real API code anywhere) |
| Price sync | simulated | `syncManagedPrices` mutates in-memory db only, logs "Updated ... on Airbnb" IDX:8627-8640, called IDX:8980 | replace; iCal cannot carry price |
| Messaging sync (Airbnb/Vrbo threads) | simulated | IDX:9449 `extThreads`; no platform code | replace |
| "List once, live everywhere" copy / OG tag | overclaim | IDX:12, 8272, 9970; iCal-only reality = availability only | modify copy |
| Prototype disclaimer on payments | implemented | IDX:12803, 12905 | keep |
| Booking.com export can't tell booking vs block | honest | guard.ts:104-107, booking-guard/index.ts:137-139 | keep (good pattern) |

## 3-4. Availability model and conflict detection
| item | status | evidence | verdict |
|---|---|---|---|
| Timestamp ranges (timestamptz) + all_day flag; hourly supported | implemented | M/...010000:95-111 (holds), tstzrange use :124,:283; guard.ts:111-113; booking-guard/index.ts:174-176 | keep |
| Parent/child blocking (house vs room), cycle + same-property check | implemented | `related_spaces`/`space_ancestors` recursive CTE depth<=20 M/...010000:17-29; trigger :35-48; feed includes parent+kids calendar-feed/index.ts:31-32; test tests/no_double_booking:28,113 | keep (extend to typed relations) |
| Non-nesting relations (driveway vs RV pad), turnover/quiet windows, `prepHours` buffers | prototype only | IDX:6113-6215 (JS in-memory `usage`, `peakUsage`, `rulesBetween`, `turnoverPermits`) - not in platform DB | modify (port to engine; it's the best rule model) |
| Buffers / cleaning in platform DB | missing | grep `buffer` in migrations: none relevant | replace |
| Capacity | partial | `spaces.quantity`; `busy_count >= qty` M/...010000:66-79,100; `detect_conflicts` returns 0 if qty>1 (:288) so multi-unit conflicts never reported | modify |
| Shared-resource rules (one pool, many slots) | missing in platform; peak-usage sweep exists in IDX:6165 | - | modify (reuse peakUsage idea) |
| Conflict detection | implemented | SQL `detect_conflicts` M/...010000:275-310 (O(n^2) join, whole family, ignores `block` kind); TS `overlaps` F/ical.ts:137 | keep logic, modify |
| Race protection | implemented | per-property `pg_advisory_xact_lock` in `lock_property` (:50-56) used by place_hold, mark_hold_safe, one-door trigger (:66); `for update` (:157). No exclusion constraint on reservations; synced rows inserted without lock so imports can still overlap (flagged post-hoc by detect_conflicts) | keep lock pattern; modify (add EXCLUDE for internal bookings) |
| One-instant-door rule + holds (24h, safe 3d) + 15-min guard | implemented | M/...010000:58-190; guard.ts:136-156 | keep (it is the honest answer to iCal lag) |
| Tests: overlaps/races/sync failure | partial | overlap+hold lock tests/no_double_booking.test.mjs:48,65,113; guard unit tests guard.test.ts; NO concurrent-transaction race test; NO fetch-failure/timeout/oversize/SSRF test; NO test of calendar-sync/booking-guard/calendar-feed handlers (Deno entrypoints untested) | add |

## 5-6. Estimator / earnings math and revenue share
| item | status | evidence | verdict |
|---|---|---|---|
| Fee table `PLATFORMS` (22 sites, guest/host %, per-booking fee) | implemented, `verified:false` for all but craigslist/facebook | IDX:5978-6001; header admits "ASSUMPTIONS" IDX:5947-5975 | keep as data, modify (move to versioned data with source+date) |
| `takeHomeAt`/`guestPriceFor`, `ourCut`, SERVICE_FEE/HOST_FEE (3%/10%) | implemented, pure, tested | IDX:6008-6030 (approx); tests/domain.test.mjs:24,33,111 | keep |
| Price defaults `TYPICAL` per category/term | implemented, no source cited | IDX:5298-5310 | modify (needs provenance) |
| Event parking `VENUES` (events, days/yr, $/car) + `parkingEstimate` | implemented, pure | IDX:8684,8747; tests domain.test.mjs:123,134. Comment says "typical figures", no sources | keep logic; modify data |
| Solar `SOLAR` (21.5 sqft/panel, 0.4kW, 1650 kWh/kW, $12/20/30 per kW-yr, 5kW min, 20 yr), FACING/SHADE/PITCH factors | implemented, pure | IDX:8801-8830; tests domain.test.mjs:144,158 | keep logic; modify (sources missing) |
| Occupancy = used/cap, hourly caps at 12 h/day magic number | implemented, untested | IDX:8173-8183 | modify |
| Quiz per-category amenity uplifts (e.g. south +0.15) | implemented, untested, unsourced | IDX:5598-5624 | modify |
| Determinism | partly | estimators pure; `Math.random` only in demo ids (IDX:6507 etc.); `now` defaults to wall clock | keep |
| Revenue-share accrual | implemented | `accrue_earnings` M/...020000:16-50: 10% until $30 fee/host/month (tz of property), then 3%; advisory lock; idempotent on `reservation_id`; settings in app_settings | keep |
| Accrual tests | partial | tests/schema.test.mjs:43 (attribution), :58 (cap/month reset). No test: refunds/cancel after accrual, rounding at boundary, null payout_cents, tz month edge | add |
| Attribution rule (`is_attributed`) | implemented | referenced M/...020000:35; body in earlier migration, not read | not verified |

## 7. Host Console (host/index.html, 66 KB)
| item | status | evidence | verdict |
|---|---|---|---|
| Unified calendar: per-property day grid, next 14/28 days, per-space, family-aware, channel colours, closed/held/double-booked states + upcoming list | implemented | HOST:426-460 (day-granular only; hourly bookings shown as whole day) | keep, modify |
| Alerts, requests/holds, conflicts, setup gaps | implemented | HOST:329-425, loadAll 251-266 | keep |
| Earnings view from ledger (gross, attributed, fee, you keep per month) | implemented | HOST:512-526 | keep |
| Missing | missing | no expected-vs-actual revenue, no per-channel/space revenue, no occupancy, no payout/price, no sync-staleness banner beyond last_error, no month/timeline view, no hourly view | add |
| Backend calls | - | edge fns via `callFn` HOST:232-240 (calendar-sync, booking-guard); RPC `dismiss_alert` :624; direct table reads :254-264; `reservations` fetched with `since` window only | - |

## 8. Notable untested areas
Edge-function handlers; fetch.ts; ical RRULE; multi-unit conflicts; hourly feed behaviour end to end; concurrent holds; accrual refunds; occupancy/quiz/TYPICAL; host/index.html (no tests); IDX availability.js overlap rules are tested only via domain.test.mjs booking tests (not in platform).

## Verified vs assumed
- Verified: both suites ran (34+15 pass); all `_shared`, three function files, and the named SQL functions were read.
- Verified: no real provider API code exists; "direct" connections, price and message sync are simulated in index.html.
- Verified: the platform DB has parent/child + quantity + holds + advisory locks; buffers, typed relations, and exclusion constraints exist only in the index.html prototype or not at all.
- Assumed: index.html line numbers for PLATFORMS-adjacent helpers (`takeHomeAt`, SITE_INFO) are approximate (+/-5 lines).
- Not verified: `is_attributed` body, `related_spaces` full text beyond head, 20261116040000/050000 migrations, cron SQL, RLS policies.
- Not verified: whether DNS-rebind/redirect SSRF is mitigated at the Supabase egress layer (not visible in code).

# Part 2: Host Console audit (host/index.html)

Auth settings observed live (one read-only GET /auth/v1/settings): email sign-in only, sign-up open, email confirmation required (autoconfirm off), no phone/anonymous/OAuth/SAML/passkeys.

Method: full read of host/index.html, schema check against `platform/supabase/migrations/20261116*.sql`, three mocked Playwright suites (all `*.supabase.co` traffic answered in-test, anything else aborted), screenshots at 390x844 and 1280x900, light and dark, read by eye (`$HOST_SHOTS` dir).
Line numbers are for host/index.html after the fixes.

| item | where | status | evidence | action |
|---|---|---|---|---|
| Sign-in form, wrong password error | authView 371, submit ~770 | working (fixed) | sign-in had `minlength=8`, which blocked existing 6-7 char passwords before any request | minlength only on sign-up; plain-language errors |
| Form validation (empty, bad email, short password, missing name) | submit handler | broken -> fixed | relied on native bubbles, inconsistent | `novalidate` plus messages in `#authMsg`; nothing sent when invalid |
| Create account + "check your email" | submit handler | broken -> fixed | after sign-up `authMode` flipped without re-render, so the "Sign in" link opened sign-up | re-render with message |
| Forgot password | authView reset | working | identical reply for known/unknown email (test) | none |
| Set-new-password (recovery link) | onAuthStateChange, authView newpw | broken -> fixed | dashboard load raced PASSWORD_RECOVERY and replaced the form; no confirm field; no way out | render guard, confirm field, mismatch check, Cancel link |
| Expired/used email link (`#error_code=otp_expired`) | start() | broken -> fixed | bare sign-in form, no explanation | notice and reset form |
| Redirect URLs | `pageUrl()` | working (hardened) | used full href incl. query | origin+pathname; verified under `/everyspace/host/` |
| Session restore on reload | supabase-js localStorage | working | test | none |
| Session expiry mid-use (SIGNED_OUT, 401 from REST/function) | start(), `endSession` | broken -> fixed | silent; actions toasted raw errors | back to sign-in with "Your session ended" |
| Sign-out | click handler | working (hardened) | failed network call left user signed in | falls back to local sign-out |
| Library (CDN) blocked | bottom of script | broken -> fixed | page stuck on "Loading…" and threw | clear message |
| Backend error / offline on first load | refresh, statusView | broken -> fixed | stayed on "Loading…" forever | readable message, Try again, Sign out |
| Loading state after sign-in | render | broken -> fixed | old sign-in form stayed until data arrived | Loading screen |
| Today: alerts, conflicts, holds, gaps, banners | todayView 435 | working | host.e2e, nav test | none |
| Conflict/alert with missing booking or null `starts_at` | `when` 220 | broken -> fixed | `Intl.format(Invalid Date)` throws, blank render | returns "dates not available" |
| Invalid property timezone | tzOf, calendarView | broken -> fixed | would throw | `validTz` fallback |
| Reservations load capped at 1000 silently | loadAll 314 | broken -> fixed | later dates dropped without notice | warning banner on Today/Calendar; same for ledger |
| Calendar grid: quantity>1 spaces | calendarView 509 | broken -> fixed | two bookings of 3 kayaks drawn "Double booked" (DB skips qty>1) | clash only if overlap > quantity |
| Calendar day-granular hourly/nightly cells | calendarView | working | host.e2e | none |
| Requests list, New request dialog, verdict | requestsView, newRequestDialog | working (depends on `booking-guard`) | mocked | errors in `check` surfaced (was blank verdict) |
| Release request | click handler | working | confirm() dialog; error toast | 401 handled |
| Places: add place / space / site | forms 790-830 | working | columns exist in schema; walk-through test | feed-create error now reported |
| Remove site | click handler 739 | broken -> fixed | errors from `calendar_imports`/`calendar_feeds` deletes ignored | checked with `must`, abort on failure |
| Instant/Request toggle | `mode` | working | DB trigger message shown | none |
| Calendar link form: validation | import branch 814 | broken -> fixed | `webcal://` rejected, junk accepted by URL type only | webcal->https, host check, clear message; saved link stays if sync fails |
| Sync now / Save & sync | syncSpace | broken -> fixed | toasted raw `error` string from calendar-sync; 404 reported as "No calendar links" | codes mapped to sentences, links redacted; 404/5xx/offline have clear messages |
| Calendar link error text | siteRow, gaps | broken -> fixed | showed code like `fetch_failed` | sentence |
| Copy to clipboard | `copy` | working | grant and refusal paths tested | none |
| Earnings | earningsView 603 | working, but stub-like data | no code path sets `payout_cents` for iCal bookings, so ledger stays empty | honest empty-state text |
| Auto refresh every 60 s | start() | broken -> fixed | redraw wiped half-typed forms | skipped while typing |
| Tap targets (phone) | CSS | broken -> fixed | "See all"/"Calendar" links 20px tall | 32px min |
| Layout 390/1280, light/dark | all tabs, 4 dialogs | working | no h-scroll, nothing clipped (test + screenshots) | none |
| Console errors / rejections | all screens | working | zero in all suites | none |
| XSS: names, addresses, guest names, errors | all templates | working | every interpolation goes through `esc`; payload test | `siteName` fallback no longer echoes raw text |
| Secrets in page | line ~165 | working | key decodes to `role":"anon"`, nothing else embedded | none |
| Calendar link tokens | siteRow | working | only in the host's own fields and the Copy button | none |
| External links | all views | working | no external `<a>`; every link is `#` | test fails if one appears without `noopener` |
| Browser back/forward/reload | n/a | finding | no routing; reload returns to Today, Back leaves the console | not changed (as instructed) |

## Fixed (verified by tests/signin.e2e.mjs, tests/host-nav.e2e.mjs, tests/host.e2e.mjs)
- Sign-in, sign-up, reset and recovery flows (validation, messages, double submit, same-page redirects, recovery race).
- Expired sessions, load failures, blocked library and a missing/undeployed function now fail with a clear message.
- Reservations cut-off warning, null-date rendering, quantity>1 false double-bookings, delete-site error handling, sync messages without codes or URLs, webcal links, refresh not wiping forms, phone tap targets.
- Results: signin 62 checks, host-nav 164 checks, host 18 checks, all pass.

## Stubs hidden or removed
None. Nothing in the console is placeholder or sample data; every control reaches a real call.
Two items are out of phase in wording only and were left as they are: the "How Everyspace gets paid" fee explainer (Earnings) and the sign-in line "No monthly fee…". Both match migration 20261116051137 but promise "money Everyspace brings you", which no console feature produces yet. Owner decision A4 in STATE.md.

## Broken and NOT fixed
- Earnings can only fill when a booking has a payout. iCal sync never stores one (`payout_cents` null), and `accrue_earnings` skips those. Needs payout import (booking-import has no UI) or an owner decision to drop the tab.
- Backend deploy: `calendar-sync`, `booking-guard` and `calendar-feed` are not confirmed deployed (STATE.md A2). The UI now says "isn't switched on yet" on a 404, but Requests, Sync and the Everyspace calendar links cannot work until deployed.
- The supabase-js script has no SRI hash (CDN-generated `.min.js`; a wrong hash would break sign-in, so not added). Pin with SRI or self-host.
- Reload does not keep the current tab (no routing, by instruction).
- Booking-guard hold failures (e.g. dates taken) arrive as verdicts; wording comes from the function.

## Not verified (needs the live backend and a real account)
- Real sign-in, sign-up email delivery, reset/confirm links and whether the page URL is on Supabase's redirect allow-list.
- RLS behaviour for each read/write, and PostgREST embed names (`conflicts_a_reservation_id_fkey`, `reservation:reservations`) against the live schema.
- Edge function availability, CORS, and real error shapes from `calendar-sync`/`booking-guard`.
- Real token-refresh failure behaviour in supabase-js (simulated with SIGNED_OUT and 401).

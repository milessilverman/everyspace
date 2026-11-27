# Site audit (Part 2), 2026-11-27

Every page, link, button, form, auth flow and route of the real site, each marked **working**, **broken** or **stub**. Checked in a browser at phone (390 px) and desktop (1280 px) sizes, light and dark, with the console watched for errors. Lookups and the backend were mocked for the browser tests; what could only be confirmed against live services is listed under "Not verified" in each part. The run-1 audit of the old codebase is kept at `docs/audit/run1-audit.md`.

## Summary
| area | items | working | broken, fixed | broken, not fixed | stub |
|---|---|---|---|---|---|
| Public site (home, property flow, redirect, navigation) | 41 | 25 | 14 | 1 | 1 |
| Host Console (sign-in flows, every tab and control) | 38 | about 12 | about 25 | see list | 1 (Earnings has no data source yet) |

| check | result |
|---|---|
| Browser tests | 7 files, all pass: home 10 scenarios, address entry 20, property confirm 8, navigation 12, sign-in 62 checks, console navigation 164 checks, console 18 checks |
| Unit tests (`npm test`) | 257 pass |
| Console errors | none in any tested state |
| Layout | no horizontal scroll or clipping at 390 px or 1280 px |
| Secrets in frontend code | none. The only key is the Supabase anon key in `host/index.html`, which is public by design |
| Live backend functions (read-only check, 2026-11-27) | `calendar-feed`, `calendar-sync`, `booking-guard` answer on the live project; `booking-import` and `property-profile` are not deployed |
| Unknown addresses | now served by a `404.html` with links home and to the console |

Correction to the Host Console part below: it lists the three calendar functions as "not confirmed deployed". The read-only check above shows they are deployed (in their pre-run versions), so Requests, Sync and calendar links are expected to work; the console's new "isn't switched on yet" message only appears if a function is missing.

## Part A: public site

Branch `claude/part2-site-audit`, 2026-11-27. Files owned: `index.html`, `everyspace.html`, `estimate/*`, four tests, `package.json`, `tests/run-e2e.mjs`, README Tests section. Screenshots: 24 images (390x844 and 1280x900, light and dark; home, empty, confirmation, candidates, manual, results) in the session scratchpad `p2-site/`, all viewed; no horizontal scroll in any, contrast of the main text/chip/button pairs is 4.5 or more.
Note: a "Work in progress checkpoint" commit (b3edbba) appeared on the branch during the run. I did not make it.

### Items (line numbers are after the fixes)
| item | where | status | evidence | action |
|---|---|---|---|---|
| `/` homepage, form, footer, attribution | index.html:20-49 | working | home.e2e: 10 scenarios, zero external requests, no storage | none |
| Whitespace-only address on homepage | index.html:28 | broken | submitted `?address=%20`, estimator opened blank with no message | `pattern`, `maxlength=300`; regression in home.e2e |
| Homepage says where the address goes | index.html:31 | broken (silent) | no disclosure of Nominatim / county | line added, test asserts wording |
| `encodeURIComponent` on a lone surrogate | index.html:46 | broken (throws) | URIError would leave the click dead | try/catch |
| `/estimate/` with `#address=` / `?address=` | app.js:785 | working | lookup once, address removed from URL, storage empty | none |
| No / empty / blank / `#foo` / malformed `%E0%A4%A` / 5000-char address | app.js:785, 126 | working (long was unbounded) | long value was sent whole to the geocoder | capped at 300 (input and arrival); estimate.e2e |
| HTML in typed address, fragment address, parcel situs, use type | app.js esc() | working | `<img onerror>` never runs, shown as text in list, table and editor | extra `esc` on number editor value and tag fallback |
| Hash-only change on an open estimator | app.js:785 | stub-like limit | pasting a new `#address=` into an open page does nothing (no reload) | recorded, not changed (not reachable from the site's own links) |
| Address confirmation yes / no | app.js:221-228 | working | focus to Yes; No returns focus to box with text kept; no parcel request before Yes | none |
| Parcel candidates: pick / none of these | app.js:230-240 | working | 10 cap, pick marks parcel "You confirmed", none goes to manual | none |
| Manual mode, "Skip the lookup..." | app.js:198 | working | zero lookups, only owner values | none |
| Submit during a lookup, double submit | app.js:189-196 | broken | second submit or "enter details myself" reset the session while the first lookup finished into it (wrong address / results) | ignored with a message while busy; test |
| Re-search after owner correction | app.js:179 | broken | a second search silently dropped every correction | first press warns, second press proceeds; tests in estimate and property-confirm |
| Profile row edit: valid | app.js:670+ | working | marks "You confirmed", dated, results recompute | none |
| Edit invalid: negative, empty, non-numeric, 2.5 bedrooms, year 12 / 3000, 1e11 | app.js:658 | broken | integers, year range, size limits accepted; message only in the top status line, off screen | `checkNumber`, inline error with `aria-invalid`; test |
| Answer to an owner question, negative number | app.js change handler | broken | error announced then overwritten by "Estimates updated"; field wiped | message kept, inline error, nothing stored |
| Most-up-front field, negative | app.js:763 | broken | silently ignored | message and reset; test |
| Edit cancel, edit twice | app.js | working | second edit starts from corrected value | none |
| Each estimate's breakdown / assumptions editors, goal, constraints, investments toggle | app.js | working | estimate.e2e compares every figure with core | none |
| Button "Save" on in-memory edits | app.js | misleading | contradicts "Nothing is saved" | renamed "Apply" |
| Reload mid-flow | app.js:293 | broken (silent) | empty page, no explanation | note under the plan note |
| Focus after results | app.js:206,370 | broken | focus dropped to body after the disabled button | moves to "Your property" heading; keyboard test |
| aria-live status | estimate/index.html | working | `role=status`, polite, atomic | none |
| Lookup failure and partial failure messages | app.js | working | geocoder 503, parcel 500: step log names the failed step, no invented ideas | tests added |
| Step log "1 steps" | app.js | broken (grammar) | seen in screenshot | fixed |
| No JavaScript on `/estimate/` | estimate/index.html:22 | broken | dead form (reloads with `?q=`) | `<noscript>` message |
| Homepage no-JS GET path | index.html | working | existing test | none |
| Where the address goes (estimator) | estimate/index.html:35 | broken (incomplete) | omitted that the map location goes to Overpass | sentence added |
| Wording: "never a headline number without range" | app.js combo list | broken (minor) | "baseline $X on its own" with no range | shows conservative to optimistic and baseline |
| Combination sentence "Adding everything up would give $X ... realistic $Y" | app.js comboHtml | working, caution | single baseline figures, labelled baseline; the range is in the table above | not changed (needs core totals per scenario) |
| `/everyspace.html` | everyspace.html | working | meta refresh + canonical to demo URL; page said "demo" in text | text reworded to "earlier version" |
| `/index.html`, `/estimate/index.html` | | working | relative links work | none |
| `/estimate` (no slash) | | working on GitHub Pages | 301 to slash (emulated in test) | none |
| `/demo`, any unknown URL | | broken | GitHub Pages serves its default 404; no repo `404.html` | NOT fixed: file is outside my ownership |
| Sub-path `/everyspace/` and root | all pages | working | every link, stylesheet, script and ES module resolves in both (navigation.e2e) | none |
| Estimator to `/host/` (header, footer, results link) and back/forward | | working | sign-in screen renders (stubbed CDN) | none |
| Storage / cookies | all | working | localStorage, sessionStorage, cookies, IndexedDB, caches all empty | none |
| Console errors | all states | working | zero in every scenario and screenshot run | none |
| Dark mode, 390 px, 1280 px | all states | working | viewed | none |
| Sticky header height on phones | estimate/app.css | working, nit | header takes about 3 lines at 390 px | left (no redesign) |
| Investment-ideas toggle, "Needs a permit" group | app.js | working | listed as ideas, outside the total | none |

Counts: 41 items: working 25, broken 15 (14 fixed, 1 not fixed: unknown-URL 404), stub or limit 1 (hash-only change). Plus the misleading "Save" label counted under broken above.

### Fixed
Busy and double-submit guard; no silent loss of owner corrections on re-search; numeric validation with inline errors and no wiped fields; max-upfront message; reload note; focus to results; noscript; homepage whitespace and length checks and disclosure; 300-character cap; escaping hardening; plural fix; "Apply" label; range on the best-combination list; redirect page wording. Each has a regression assertion.

### Stubs hidden or removed
None found: the public pages contain no sign-in, save, account or marketplace promises. Only text removed: the word "Save" on edit buttons and "demo" on the redirect page.

### Broken and NOT fixed
1. Unknown URLs (`/demo`, typos) give the generic GitHub Pages 404. Fix needs a root `404.html` (outside my files).
2. README line 46 ("The home page does not link to it yet") is stale: the homepage opens the estimator. Outside the README Tests section.
3. Core observation, not patched: `applyOwnerCorrection` does no range check (the page now guards typed input only). Verified reproduction: `applyOwnerCorrection(createProfile(), 'year_built', 12, now)` returns `{value:12, tag:'owner-confirmed', confidence:1}` with no error.
   Also: root `package.json` has no `"type"`, so Node prints a harmless module-type warning when it loads `core/*.js` directly.
4. Combination "adding up" sentence shows baseline only.
5. `tests/host-nav.e2e.mjs` fails in `npm run e2e` while the other agent edits it (button size and a click timeout); not mine.

### Secrets scan (`*.html`, `*.js`, `*.css`, excluding node_modules, platform, docs, tests)
Only finding: the Supabase anon JWT in `host/index.html:166` (decoded role `anon`, ref `hnzcwfvxpfsyjpbebevp`), public by design, unchanged. No `sk_`, `AIza`, `service_role`, bearer tokens, passwords or private URLs with tokens. Tests contain a fake token string `SECRETTOKEN123` for a redaction check only.

### Not verified
Real Nominatim, county parcel service and Overpass behaviour (all mocked); real phones, Safari, Firefox (Chromium only); screen readers (aria attributes and focus checked, speech not); GitHub Pages' own redirects (emulated); bfcache behaviour on back/forward in other browsers; the Host Console beyond its sign-in screen.

### Commands
`npm test` 257 pass. `npm run e2e` runs every `tests/*.e2e.mjs`. Own files: home 10, estimate 20, property-confirm 8, navigation 12 scenarios, all pass.

Note: the coordinator's environment update named `/home/user/everyspace-pd` as the working directory; my brief forbids touching it, so all work stayed in `/home/user/everyspace`. The product name Everyspace is unchanged.

## Part B: Host Console

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

### Fixed (verified by tests/signin.e2e.mjs, tests/host-nav.e2e.mjs, tests/host.e2e.mjs)
- Sign-in, sign-up, reset and recovery flows (validation, messages, double submit, same-page redirects, recovery race).
- Expired sessions, load failures, blocked library and a missing/undeployed function now fail with a clear message.
- Reservations cut-off warning, null-date rendering, quantity>1 false double-bookings, delete-site error handling, sync messages without codes or URLs, webcal links, refresh not wiping forms, phone tap targets.
- Results: signin 62 checks, host-nav 164 checks, host 18 checks, all pass.

### Stubs hidden or removed
None. Nothing in the console is placeholder or sample data; every control reaches a real call.
Two items are out of phase in wording only and were left as they are: the "How Everyspace gets paid" fee explainer (Earnings) and the sign-in line "No monthly fee…". Both match migration 20261116051137 but promise "money Everyspace brings you", which no console feature produces yet. Owner decision A4 in STATE.md.

### Broken and NOT fixed
- Earnings can only fill when a booking has a payout. iCal sync never stores one (`payout_cents` null), and `accrue_earnings` skips those. Needs payout import (booking-import has no UI) or an owner decision to drop the tab.
- Backend deploy: `calendar-sync`, `booking-guard` and `calendar-feed` are not confirmed deployed (STATE.md A2). The UI now says "isn't switched on yet" on a 404, but Requests, Sync and the Everyspace calendar links cannot work until deployed.
- The supabase-js script has no SRI hash (CDN-generated `.min.js`; a wrong hash would break sign-in, so not added). Pin with SRI or self-host.
- Reload does not keep the current tab (no routing, by instruction).
- Booking-guard hold failures (e.g. dates taken) arrive as verdicts; wording comes from the function.

### Not verified (needs the live backend and a real account)
- Real sign-in, sign-up email delivery, reset/confirm links and whether the page URL is on Supabase's redirect allow-list.
- RLS behaviour for each read/write, and PostgREST embed names (`conflicts_a_reservation_id_fkey`, `reservation:reservations`) against the live schema.
- Edge function availability, CORS, and real error shapes from `calendar-sync`/`booking-guard`.
- Real token-refresh failure behaviour in supabase-js (simulated with SIGNED_OUT and 401).

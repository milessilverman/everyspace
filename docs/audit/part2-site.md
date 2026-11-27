# Part 2 audit: public site (homepage, estimator property flow, redirect page, cross-site navigation)

Branch `claude/part2-site-audit`, 2026-11-27. Files owned: `index.html`, `everyspace.html`, `estimate/*`, four tests, `package.json`, `tests/run-e2e.mjs`, README Tests section. Screenshots: 24 images (390x844 and 1280x900, light and dark; home, empty, confirmation, candidates, manual, results) in the session scratchpad `p2-site/`, all viewed; no horizontal scroll in any, contrast of the main text/chip/button pairs is 4.5 or more.
Note: a "Work in progress checkpoint" commit (b3edbba) appeared on the branch during the run. I did not make it.

## Items (line numbers are after the fixes)
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

## Fixed
Busy and double-submit guard; no silent loss of owner corrections on re-search; numeric validation with inline errors and no wiped fields; max-upfront message; reload note; focus to results; noscript; homepage whitespace and length checks and disclosure; 300-character cap; escaping hardening; plural fix; "Apply" label; range on the best-combination list; redirect page wording. Each has a regression assertion.

## Stubs hidden or removed
None found: the public pages contain no sign-in, save, account or marketplace promises. Only text removed: the word "Save" on edit buttons and "demo" on the redirect page.

## Broken and NOT fixed
1. Unknown URLs (`/demo`, typos) give the generic GitHub Pages 404. Fix needs a root `404.html` (outside my files).
2. README line 46 ("The home page does not link to it yet") is stale: the homepage opens the estimator. Outside the README Tests section.
3. Core observations, no patch: `ATTR` year, units and area values coming from parcel data are not range-checked in `applyOwnerCorrection` (the page now guards typed input only). Minimal reproduction: `applyOwnerCorrection(createProfile(), 'year_built', 12, now)` returns a profile without error.
4. Combination "adding up" sentence shows baseline only.
5. `tests/host-nav.e2e.mjs` fails in `npm run e2e` while the other agent edits it (button size and a click timeout); not mine.

## Secrets scan (`*.html`, `*.js`, `*.css`, excluding node_modules, platform, docs, tests)
Only finding: the Supabase anon JWT in `host/index.html:166` (decoded role `anon`, ref `hnzcwfvxpfsyjpbebevp`), public by design, unchanged. No `sk_`, `AIza`, `service_role`, bearer tokens, passwords or private URLs with tokens. Tests contain a fake token string `SECRETTOKEN123` for a redaction check only.

## Not verified
Real Nominatim, county parcel service and Overpass behaviour (all mocked); real phones, Safari, Firefox (Chromium only); screen readers (aria attributes and focus checked, speech not); GitHub Pages' own redirects (emulated); bfcache behaviour on back/forward in other browsers; the Host Console beyond its sign-in screen.

## Commands
`npm test` 257 pass. `npm run e2e` runs every `tests/*.e2e.mjs`. Own files: home 10, estimate 19, property-confirm 8, navigation 12 scenarios, all pass.

# Everyspace STATE (rewritten each phase; max ~150 lines)

Updated 2026-11-27. Read this first. Detail lives in the files named here.

## Where things stand
| work | status | where |
|---|---|---|
| Demo split into its own repository | done, live | `milessilverman/everyspace-demo`, https://milessilverman.github.io/everyspace-demo/ |
| Homepage = address input that starts the property flow | done, live | `index.html`; merged in PR #10 |
| Site audit, fixes, browser tests (Part 2) | done on branch | `claude/part2-site-audit`, findings in `docs/audit.md` |
| Property-data providers, yard split, profile storage, accuracy run | done on branch (keyless path) | `claude/trusting-cannon-yynabw`; `docs/property-data.md`, `docs/phase1-accuracy.md` |
| Property-data wired into the homepage flow | done on branch (keyless path) | same branch; LA County addresses use the county locator, assessor and building outlines first, earlier lookup as fallback; address suggestions from the county service |
| Rename to "Spacavia" ("Your space, your way") and repository rename | on hold | waiting for the owner's go-ahead |
| Backend from run 1 (orgs, conflict engine, adapters) | staging only | not applied to the live database |

## Live right now
| address | what |
|---|---|
| https://milessilverman.github.io/everyspace/ | address-input homepage |
| …/everyspace/estimate/ | property flow: confirm, correct, earning options |
| …/everyspace/host/ | Host Console (signed-in, live backend) |
| …/everyspace/everyspace.html | redirect to the demo |
| https://milessilverman.github.io/everyspace-demo/ | the earlier demo |
Live backend functions (checked read-only 2026-11-27): `calendar-feed`, `calendar-sync`, `booking-guard` deployed in their pre-run versions; `booking-import`, `property-profile` not deployed.

## Test commands and last results
| command | result |
|---|---|
| `npm test` (core unit tests) | 257 pass on the Part 2 branch; 370 on the property-data branch |
| `npm run e2e` (every `tests/*.e2e.mjs`) | Part 2 branch: 7 files pass (home 10, address entry 20, property confirm 8, navigation 12, sign-in 62 checks, console navigation 164 checks, console 18 checks). Property-data branch: 8 files pass (adds address suggestions 25; address entry 35, property confirm 10) |
| `cd platform && npm test` | 231 on main; 264 on the property-data branch |
| `cd platform && npm run test:staging` | 16 pass |
| demo repo: `node --test tests/*.test.mjs` | 15 pass |

## Hard rules for every agent
- The Supabase project `hnzcwfvxpfsyjpbebevp` is production. Never write to it or deploy to it without the owner's approval. Staging = local Postgres 16 + PGlite.
- No secrets in the frontend or the repo. No scraping. No sign-ups, no paid service, no contact with providers. If an API key is needed, stop and say which and why.
- No fabricated data. A number without a source is tagged `estimated` with confidence <= 0.2; a missing number is `unavailable`, never 0. Owner corrections always win.
- Deterministic logic = pure functions with tests; `now` and `fetch` are injected.
- Never edit `platform/supabase/migrations/20261116*` (they mirror production history).
- Browser tests mock every external host; nothing in tests reaches a live service.

## Demo inventory (moved 2026-11-27)
| item | detail |
|---|---|
| Files moved | `index.html` (1.4 MB single-file app), `everyspace.html` (identical copy), `tests/domain.test.mjs`; 27 commits of history kept |
| In-page routes | `/` `/quiz` `/earn` `/explore` `/saved` `/long-term` `/space/:id` `/book/*` `/trips` `/trip/:id` `/offer/:id` `/inbox` `/chat/:id` `/host/*` `/biz*` `/catalog` `/plan` `/promise` `/fair-price` `/profile` `/map` `/xchat/:id` |
| Embedded script | Leaflet 1.9.4 (BSD-2-Clause) inlined |
| Browser storage | `everyspace-demo-v13`, `everyspace:<key>` in localStorage |
| External hosts | Google Fonts, CARTO and Esri tiles, Nominatim, Overpass, LA County GIS |
| Left in this repo | `everyspace.html` (redirect to the demo), a footer link on the homepage |
| Shared code | none: nothing in `core/`, `estimate/`, `host/` or `platform/` imported from the demo. `core/data/*.js` cite the demo's line numbers as the origin of copied planning defaults, now written as `everyspace-demo index.html:<line>` |

## Stubs and out-of-phase items (Part 2)
| item | what was done |
|---|---|
| Hidden or removed | none: no control on the real site is a placeholder |
| Host Console "Earnings" | stays empty because calendar sync never carries a payout; the empty state now says so. Needs payout import or an owner decision to drop the tab |
| Host Console fee wording ("How Everyspace gets paid", "No monthly fee") | left as is; owner decision |
| Estimator: changing only the `#address=` part of the URL on an open page does nothing | recorded, not changed |
| Host Console has no page routing (reload returns to Today) | recorded, not changed |
| supabase-js is loaded from a CDN without an integrity hash | recorded; pin or self-host |

## Property data (branch `claude/trusting-cannon-yynabw`)
| piece | status |
|---|---|
| Provider contracts + registry (`core/providers/`) | built; a new provider is one file + one register call |
| LA County assessor (records + parcel), LARIAC building outlines, county address locator, Census geocoder | built, verified live |
| RentCast (primary records), Google Solar (roof) | adapters written from documentation recall, never run: no key. Marked unverified |
| Google Places Autocomplete | only the place-to-address mapping; no key, no script |
| Microsoft building footprints | not built: bulk dataset with no per-address API (see `docs/property-data.md`) |
| Yard split (`core/yard.js`) | built; 60 tests incl. 200 generated lots |
| `buildPropertyProfile` -> one PropertyProfile JSON with per-field source and confidence | built |
| Storage + server endpoint (`property_profiles`, budget guard, `property-profile` function) | built, staging only |
| Accuracy run on 10 LA addresses | done for the keyless path: `docs/phase1-accuracy.md` |

## Keys needed (none exists yet; nothing is called without one)
| key | used for | note |
|---|---|---|
| RentCast API key | primary property records (sq ft, beds, baths, floors, lot, year, type) | server-side only |
| Google Maps Platform key with Places API (New) | address autocomplete in the browser | a browser key by nature: must be restricted by website address and API |
| Google Solar API key | roof area and segments | server-side only; Google's permitted-use and caching terms to be confirmed |
All three need an account with the provider (and a billing account for Google), so they are the owner's to create.

## Approvals pending (owner)
| # | request | unblocks |
|---|---|---|
| A2 | Apply run-1 migrations to the live database, then the cron script, then deploy functions (in that order) | teams, conflict engine, CSV import, profile storage, the server-side property endpoint |
| A3 | Licence confirmation for reusing City Pretty's parcel-lookup pattern | publishing those files with a clear licence |
| A4 | Product message and fee wording | console fee text; README |
| A7 | The three API keys above | RentCast/Solar/Places paths and their accuracy columns |
| A8 | Go-ahead for the Spacavia rename and the repository rename | brand change; the public address changes and Supabase's allowed redirect addresses must be updated |

## Known limits
- Every earnings estimate is low confidence until the owner enters their own price and bookings.
- LA short-term-rental rules are unverified. OpenStreetMap lookups were never run live from the build environment.
- Without RentCast, record fields come from the assessor, so "profile vs assessor" agreement is by construction; only lot area and footprint area were checked independently.
- Yard front/back uses a street-side point, not a street centreline (no keyless centreline source found on the allowed hosts); every yard result carries that warning.
- Sign-in, email delivery and row-level security were tested against a mocked backend only; no real account was used on production.

## Next
1. Merge Part 2, then the property-data pull request.
2. On the owner's go-ahead: rename pass, then repository rename.
3. With keys: verify RentCast and Solar adapters against real responses and fill the accuracy columns.
4. After A2: switch the property flow to the server endpoint and change the "nothing is saved" statement accordingly.

## Process notes
- Run 1: one subagent made a stray, rejected attempt to archive a session; briefs now forbid session tools.
- 2026-11-27: work was paused at the owner's request and resumed; nothing was lost.

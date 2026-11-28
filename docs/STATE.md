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
| Owner-first property screen, fast lookups, progress bar, nationwide autofill; City Pretty and StreetForge methods reused | done on branch | `estimate/`, `core/{roof,transit,building-size}.js`, `core/providers/{overture-buildings,parcel-registry,county-lookup,photon-address}.js`; `docs/audit/reuse-*.md`, `docs/zillow.md` |
| Two-page flow (property, then Next to earnings), remodeled year, usable yard, satellite view with adjustable outlines, yards from street lines | done on branch | `estimate/{app,lot-map,county-path}.js`, `core/{measure,usable-yard,street-ref,aerial,lot-estimate}.js`, `core/providers/{overture-roads,naip-aerial}.js`; measurements in `docs/yard-accuracy.md` |
| Condos and apartment buildings: unit picker, "What do you own here?", condo and building fact lists, earnings by quantity | done on branch | `core/property-profile.js`, `core/providers/la-assessor.js`, `core/opportunities.js`, `core/revenue.js`, `estimate/{app,county-path,unit-adapter,context-map}.js`; `docs/condos-and-buildings.md` |
| Easier to use: picture pinned beside the list, edit one area at a time (lot, house, driveway, front yard, back yard), guided one-at-a-time questions with "I don't know" | done on branch | `estimate/{lot-map,questions}.js`, `core/measure.js` (yard overrides), `core/opportunities.js` (`ownerQuestions`, `askWhen`), `core/data/categories.js` |
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
| `npm test` (core unit tests) | 536 pass |
| `npm run e2e` (every `tests/*.e2e.mjs`) | 12 files pass; takes about 12 minutes (the satellite-view file alone is over 6) |
| `cd platform && npm test` | 264 pass |
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
| Building footprints outside LA County | Overture's public building tiles (include Microsoft's machine-read footprints), read with range requests as StreetForge does; checked live on two public buildings (LA City Hall within 0.2% of the county outline) |
| Roof size | City Pretty's method (footprint x slope for a pitch chosen by build year and state). City Pretty's own notes call the default pitches a rule of thumb with no source, so it stays an estimate the owner can type over |
| Floors | records first; else floor count or height from the footprint source (StreetForge's 3.4 m per floor rule); else living area / footprint |
| Transit | City Pretty's rules: nearest stop, half-mile count, tourist/private stations and trams excluded |
| Parcels and lot size outside LA County | StreetForge's registry: 131 county and state services, all 50 states + DC. Only LA is confirmed readable from a browser; others are tried with a 4 s limit and silently skipped |
| Address autofill | LA County's address service first; Photon (OpenStreetMap, built for search-as-you-type, fair-use) for the rest of the US |
| Zillow | no self-serve source for lot size, no footprint offering; its one records programme is invite-only and commercial; site terms could not be read. See `docs/zillow.md` |
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
- Questions are filtered by relevance rules Everyspace chose (camping and beehives only above half an acre, pasture above two acres, commercial ideas for buildings only, water access only with a water-nearby fact, which no lookup supplies yet). Filtered questions stay reachable under "less common ideas".
- A size given for an attic, basement, shed or storage unit is recorded but does not change any estimate: the revenue model has no size input for them.
- An owner-edited yard outline is measured on a 0.1 m grid (within about 1%). "Floors" can differ between visits because it depends on which outline source answered.
- Condos are recognised from the county's condo use code or a condominium legal description with a unit number; other unit-style codes are not confirmed, so some condos read as a house until the owner picks "A condo or one unit". Mobile homes and rooming houses still read as houses. Outside LA County there is no unit list and the owner says what they own.
- Earnings for several units multiply one unit's estimate by the count: every unit is assumed to perform alike, with no allowance for competing with yourself.
- For an apartment building the footprint line is the largest building only; roof size needs the owner's roof type.
- Driveway detection (paved strip from the street on the aerial photo) is on: checked by eye on ten lots (3 right, 5 partly right, 2 missed under trees, no false alarm), tuned on those same lots, no ground truth. The outline is draggable; a paved front yard can read as a wide driveway.
- Building kinds (garage, ADU, shed, carport, pool house, other) are pre-filled only where the map data states them; LA County outlines state none, so the owner chooses on the satellite view.
- Side yard is computed but not shown (owner's call). Usable yard = open ground at least 10 ft wide (a stated assumption, adjustable); slope is not known.
- From the aerial photo: lawn vs paving is on but not validated; pool detection and tree cover are off (one false pool and one miss in ten lots); the estimated lot is off (median error 14% but one lot off by 274%). Where no parcel record answers, the owner draws the lot on the satellite view.
- The satellite backdrop is the free government photo (about 60 cm per pixel, soft). Mapbox was rejected: its terms require a paid commercial licence for production use in a real-estate-related application. LA County's public aerial tiles are sharp but dated 2008.
- Outside LA County an owner gets footprint, roof and floors, and lot size only when their county's service answers; home size, beds, baths, year and front/back yards stay empty boxes to fill in.
- The property screen deliberately shows no failure or source text; sources are in one collapsed section.
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

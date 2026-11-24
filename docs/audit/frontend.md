# Frontend audit: index.html and host/index.html

Read-only, no network calls. `everyspace.html` is byte-identical to `index.html` (cmp). No CLAUDE.md, AGENTS.md or .claude/ at repo root. Refs are index.html unless prefixed.

## 1. Routes and features (ROUTES, 20584-20620)
| Item | status | evidence | keep / modify / replace |
|---|---|---|---|
| `/`, `/earn`, `/quiz`: earnings quiz (home) | partial (real formula, hard-coded inputs, City Pretty faked) | 20585-87, 18070 | keep, re-source inputs |
| `/map`: parcels, OSM roofs, event parking, solar | implemented (live external data) | 20616, 19484 | keep |
| `/explore`, `/space/:id`, `/long-term`, `/saved` | partial (seed data, consumer search) | 20588-91, 9627 | replace or demote |
| `/book/*`, `/trips`, `/trip/:id`, `/offer/:id` | partial (payment, ID, deposit simulated) | 20592-96, 12803, 12905 | replace (marketplace) |
| `/inbox`, `/chat/:id` | partial (demo threads) | 13411-13439 | modify |
| `/host`, `/host/calendar`, `/host/listings`, `/host/new`, `/host/space/:id` | partial (localStorage demo DB) | 20599-611 | modify |
| `/host/tasks`, `/host/earnings`, `/host/docs`, `/host/team` | partial (demo) | 20603-609 | keep (management-first) |
| `/host/import`, `/host/sites`, `/xchat/:id` | partial (site connections simulated) | 8281, 8517, 16435 | modify |
| `/biz*`, `/catalog`, `/plan`, `/promise`, `/fair-price`, `/profile` | partial / demo | 20608-19 | modify |
| `/earn` declared twice in ROUTES | defect (second entry dead) | 20586-87, 20615 | fix |

## 2. Estimator (quiz)
| Item | status | evidence | action |
|---|---|---|---|
| `TYPICAL` daily/monthly rates per space kind | implemented, unsourced constants | 5298-5312 | sourced, dated table |
| Feature uplift, `suggestPrice()` | implemented, self-described "starting estimates" | 5557-5558, 5648 | keep, tag inputs |
| Monthly math `estimateItem()` (rate x occupancy) | implemented | 17744-17790 | keep |
| City Pretty roof, lot, price index, demand | simulated placeholder (labelled) | 17704-25, 18148 | real integration |
| `SOLAR` (rent $12-30/kW-yr, 1650 kWh/kW) | planning constants, no source | 8805-06 | cite or drop |
| Event venue counts and prices | "typical figures" | 8677-79 | cite or drop |
| User disclosure | partial: "typical", "not promises" | 18344 | show inputs and scenarios |

## 3. Earnings map: browser-side external calls
| Host / URL | data | evidence | provenance label |
|---|---|---|---|
| public.gis.lacounty.gov (Assessor parcel query) | AIN, SitusFullAddress, UseCode, UseType, UseDescription, SQFTmain1, Units1, YearBuilt1, Bedrooms1 | 19399-400 | "Real parcels from LA County Assessor" (19495) |
| overpass-api.de, overpass.kumi.systems | building outlines and tags | 19401 | "OpenStreetMap building outline" (19630) |
| nominatim.openstreetmap.org | address search | 19402 | tile credit only |
| basemaps.cartocdn.com, server.arcgisonline.com | tiles and imagery | 19521-22 | attribution shown |

## 4. Categories and platforms
| Item | status | evidence | action |
|---|---|---|---|
| `CATEGORIES` (about 39), owner and property types, quiz catalog `QI` | implemented, hard-coded in three places | 5151, 5316-25, 17569 | one data file |
| `PLATFORMS`: 21 sites, fee % | hard-coded; all `verified:false` except Craigslist, Facebook | 5978-6001 | keep as data, add source and date |
| Fee labelling | estimates, flagged until verified | 5948-76 | keep |

## 5. Marketplace features conflicting with "management first"
| Item | status | evidence | action |
|---|---|---|---|
| Renter service fee 10%, host fee 3% in price math | implemented (calc) | 5778-79, 5895, 6007, 6012 | replace model |
| Simulated checkout ("Apple Card 4242") | simulated | 12905 | remove |
| Consumer search, saved, trips, offers | partial, demo | 9627, 20588-96 | replace |
| README: "Also a marketplace with a 3% host fee" | contradicts vision | README.md:9 | rewrite |

## 6. Secrets and keys (types only, no values)
| Location | type | status | action |
|---|---|---|---|
| host/index.html:164 `ANON_KEY` | Supabase anon key, legacy JWT, role `anon` | public by design; safe only with RLS | keep; verify RLS |
| host/index.html:163 `SUPABASE_URL` | project URL | public | keep |
| index.html:7316 Gemini endpoint string | no key; canned output, `Math.random` latency (7313) | simulated | remove or label |
| index.html, full grep | no service_role, sk_, AIza or other key literal | clean | none |

## 7. Host Console (host/index.html)
- Storage: Supabase only, no localStorage. Reads (254-264): profiles, properties, spaces, channel_listings, calendar_imports, calendar_feeds, reservations, booking_holds, booking_alerts, conflicts, earnings_ledger.
- Writes: properties (693), spaces (696), channel_listings (700, 635), calendar_feeds (702), calendar_imports upsert (707), deletes (645-46). RPC `dismiss_alert` (624).
- Edge functions: `calendar-sync` (592), `booking-guard` check and release (600, 629, 716), `calendar-feed` iCal link (166).
- Absent from host/: tasks, expenses, team, docs, locks, pricing (demo only in index.html). Implemented against live backend per platform/docs/PLAN.md; runtime not verified.

## 8. Tests (tests/domain.test.mjs, 15 tests)
- Covers: all-in price and fees (24), lower-fee comparison (33), price rule (42), search privacy (51), empty iCal safety (61), site matching (74), list-everywhere consent (85), add-on anchors (95), demo dates (104), preview prices (111), event parking (123, 134), solar (144), roof measuring (158), parcel classification (167).
- Gaps: nothing covers host/index.html or the Host Console; tests load domain code from index.html only.

## Doc contradictions
- README.md:40, :54 and PLAN.md:21: "10% until $30, then 3%" revenue share. Not in index.html; platform SQL not audited.
- README.md:9 and PLAN.md:17, 61 call it a marketplace; PLAN.md:6 says no monthly fee.
- Backend test count: README says 31, platform/README.md says 34. platform/README.md:3 links `../everyspace__1-1.html`, which does not exist.

## Verified vs assumed
- Verified: file identity, no agent files, route table, PLATFORMS and TYPICAL constants, external hosts, Host Console calls, test names.
- Assumed: AI listing description and wizard smart pricing (not traced).
- Not verified: runtime behaviour (no browser run); RLS protecting the anon key; platform revenue-share SQL; the 31 vs 34 count; full category count; routes reachable outside ROUTES.

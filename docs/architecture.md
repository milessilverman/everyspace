# Architecture

Everyspace is a management and intelligence platform. Marketplaces are distribution channels; Everyspace's own records are the system of record. Nothing below depends on any single platform.

## Components
| component | path | runtime | owns | talks to |
|---|---|---|---|---|
| Core domain library | `core/*.js` | browser, Node, Deno (zero deps, no I/O) | provenance, profile, parcel resolution, opportunities, regulatory check, revenue model, optimizer, availability mirror | nothing (fetch is injected) |
| Reference data | `core/data/*.js` | same | categories, jurisdictions, parcel-service registry, planning defaults, platform fees, scenario spreads (each with source + verified flag) | — |
| Public estimator | `estimate/` | static page, GitHub Pages | address -> profile -> corrections -> opportunities -> 3 scenarios; no sign-in, nothing stored | core; public geocoder, county parcel service, OSM (from the visitor's browser) |
| Host Console | `host/index.html` | static page | signed-in management: places, spaces, sites, calendars, requests, alerts, earnings | Supabase (anon key + user JWT, RLS) |
| Demo app | `index.html` (= `everyspace.html`) | static page, local storage | prototype screens incl. marketplace demo (not the product direction; untouched) | none real |
| Database | `platform/supabase/migrations` | Supabase Postgres | orgs, properties, spaces, availability, reservations, pricing, finance, intelligence, projections | — |
| Edge functions | `platform/supabase/functions` | Deno | `calendar-sync`, `calendar-feed`, `booking-guard`, `booking-import` | provider adapters, database (service role only where needed) |
| Provider adapters | `platform/supabase/functions/_shared/providers` | Deno | one file per provider; declares capability levels L0-L4 | the provider (today: iCal URLs and host-uploaded files only) |

## Boundaries and rules
| boundary | rule |
|---|---|
| Core vs I/O | Core never reads a clock, network or storage directly. Callers inject `fetch` and `now`. This is what makes every number reproducible and testable. |
| Database vs core availability | The database is authoritative for bookings (lock + constraint + RPC). `core/availability.js` is a mirror for previews and the optimizer; `platform/tests/availability_parity.test.mjs` fails if they diverge. |
| Everyspace records vs external ids | Every record has its own UUID. External listing/reservation ids are attributes (`channel_listings.external_id`, `reservations.external_uid`), never primary keys or foreign keys. Removing a provider deletes no Everyspace record. |
| Restricted third-party data | Stored only in `provider_data` (provider-scoped, mandatory expiry, purged). Never joined into `property_attributes`, `projections` or any cross-host aggregate. Never used to populate a competing marketplace or to contact a platform's customers. |
| Estimator vs account | The estimator works with no account and stores nothing. Saving a profile needs sign-in and goes through RLS-checked RPCs. |
| Secrets | Only the Supabase anon key appears in frontend code. Service-role key and cron secret live in function env / Vault. Provider tokens (none today) go in Vault. |

## Interfaces
| interface | definition | consumers |
|---|---|---|
| Core contracts | `core/types.js` (`Sourced`, `PropertyProfile`, `Opportunity`, `EstimateInputs`, `OpportunityEstimate`, `OptimizationResult`) | estimator, future edge functions, tests |
| Provider adapter | `providers/adapter.ts`: `key`, `capabilities`, `limits`, optional `importAvailability`, `exportAvailability`, `parseBookingFile`, `verifyClosed`; registry in `providers/registry.ts` | `calendar-sync`, `booking-guard`, `booking-import` |
| Booking RPCs | `create_booking`, `import_reservations`, `place_hold`, `release_hold`, `availability_conflicts` | Host Console, edge functions |
| Profile RPCs | `confirm_attribute`; view `property_profile` | Host Console (after approval A2) |
| Parcel-service registry | `core/data/parcel-services.js`: one entry per county/state service with field map and terms link | `core/parcel.js` |

## City Pretty as a property-intelligence service
| question | answer |
|---|---|
| What is reused today | The parcel-lookup pattern (county service first, then statewide, explicit failure reason), the `Sourced` provenance idea, the Census-then-Nominatim geocoding order, the OSM query shape. Re-implemented in `core/` from City Pretty commit `ac7faf3`; five California county registry entries copied as data. |
| Why not call its Worker | It has no parcel or geocode route, no auth, a shared 60/min limit, and an origin allow-list that admits Everyspace only by accident (`docs/audit/shared-infra.md`). |
| What is not reused | Roof, solar ROI, zoning and valuation engines (unsourced defaults or wrong scope for rental income). |
| Target interface (not built) | A versioned `GET /v1/property?lat&lng` on City Pretty returning `Sourced` attributes, with an API key per consumer. Everyspace would add it as one more source in `core/parcel.js`; no schema change needed because attributes are keyed rows. Requires a decision in the City Pretty project and licence clarity (approval A3). |
| StreetForge | Nothing reused. It already vendors the same parcel registry; a shared registry package is a later option. |

## Deployment
| environment | what | how changes reach it |
|---|---|---|
| Local staging | Postgres 16 in the dev container + PGlite | `npm test`, `npm run test:staging` |
| Production database | Supabase project (free plan, no branches) | only after owner approval, migrations in order |
| Static pages | GitHub Pages from `main` | merge of the working branch (owner decision) |

**Verified:** component inventory and boundaries from the code and audits. **Assumption:** GitHub Pages serves `core/*.js` as ES modules with a JavaScript content type (standard behaviour; confirm after first deploy). **Recommendation:** move reference data that needs frequent updates (fees, rules) into the database lookup tables once A2 is approved, keeping `core/data` as the offline default.

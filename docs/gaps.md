# Gaps against the vision

Evidence for "before" is in `docs/audit/*.md`. "This run" means built and tested on staging on branch `claude/trusting-cannon-yynabw`; nothing is live until merged and approved.

| # | vision requirement | before this run | after this run | remaining gap |
|---|---|---|---|---|
| 1 | Any rentable space, data-driven categories | free-text category in DB; 39 categories hard-coded three times in `index.html` | `space_categories` lookup; `core/data/categories.js` (one list) | `index.html` still has its own copies |
| 2 | Any marketplace, new ones without schema change | 19-value Postgres enum | `channels` lookup with honest capability levels | capabilities unverified against official terms for most platforms (`docs/integrations.md`) |
| 3 | Management platform first, not a marketplace | demo has renter checkout, 10% renter fee, 3% host fee; README says "also a marketplace" | unchanged (flagged) | owner decision: demote or relabel the marketplace demo |
| 4 | "How much more could your property be earning?" free, low friction | quiz with hard-coded uncited numbers; City Pretty lookup simulated | `/estimate` page on real modules: address -> parcel -> profile -> corrections -> 3 scenarios, no sign-up | defaults are uncited planning numbers (low confidence) until a licensed market source exists |
| 5 | Provenance on every attribute; owner overrides | provenance labels only in map UI text | `Sourced` values end to end; `property_attributes` append-only; owner-confirmed wins | not yet wired into the Host Console (needs A2) |
| 6 | Parcel resolution beyond LA | one hard-coded LA County query | registry of county services (LA + 5 CA counties as data) | terms per county unreviewed; most of the US not in the registry |
| 7 | Building, roof, yard, driveway, parking, pool, zoning, transit, demand | OSM roof outline in map; rest absent | footprints, yard, pool (when mapped), transit distance estimated; driveway, parking, garage, ADU, zoning, roof, demand = unavailable and asked of the owner | zoning and demand sources; roof pitch source |
| 8 | Opportunities with regulatory feasibility | none | data-driven identification + feasibility (`unknown` unless a rule is on file) | only LA rules on file, all marked unverified until official text is reviewed |
| 9 | Revenue/expense model with 3 scenarios, NOI, ROI, payback, confidence | single figure, no scenarios | implemented, unit-tested to the cent | seasonality, demand and competition inputs exist but have no data source (flat defaults) |
| 10 | Best feasible combination, owner goals | none (a sum) | exhaustive optimizer, 5 goals, constraints, investments separated | time-sharing between uses is modelled as mutual exclusion, not a calendar split |
| 11 | Organizations, roles, permissions | one host = one user | orgs, memberships, role rows, permission checks, RLS tests | no UI for inviting members |
| 12 | Resource-based availability with relationships, buffers, capacity | parent/child blocking + holds only | relations, shared resources, buffers, capacity, RPC-only writes, exclusion constraint, race tests | hourly calendar view in the Host Console |
| 13 | Provider adapters; iCal honest about limits | iCal logic inline; "list once, live everywhere" overclaims | adapter interface + iCal + manual CSV; capability labels; stale/empty-feed handling; SSRF hardening | demo copy still overclaims; no partner API (needs approvals) |
| 14 | Pricing rules, expenses, revenue, maintenance, communications records | demo only (local storage) | tables + RLS on staging | no UI |
| 15 | Third-party data isolation | none needed (no API data) | `provider_data` with expiry and purge | retention periods per provider to be set from their terms |
| 16 | Staging before production | none | local Postgres 16 + PGlite | no hosted staging (second free project needs owner approval) |
| 17 | Observability | last sync status only | `sync_health` view, failure counters, error codes without secrets | no alerting/metrics pipeline |
| 18 | Photos | none | table only | storage bucket + upload UI |
| 19 | Payments, direct bookings, marketplace | simulated | not built (by design) | readiness criteria in `docs/roadmap.md` |

**Verified:** rows 1-17 "after" columns are covered by tests listed in `docs/STATE.md`. **Assumption:** none. **Recommendation:** decide row 3 first; it changes the public message of the product.

# Everyspace STATE (rewritten each phase; max ~150 lines)

Updated 2026-11-24. Branch `claude/trusting-cannon-yynabw`. This file plus the paths in a brief are all an agent reads.

## Status
| phase | status | notes |
|---|---|---|
| 0 Audit + design docs | in progress | audits in `docs/audit/*.md`; web research blocked by network allow-list (approval requested) |
| 1 Foundation | in progress | migrations on local staging only |
| 2 Property intelligence | in progress | `/core` modules, fixtures only until parcel hosts are allowed |
| 3 Revenue discovery | in progress | `/core` revenue + optimizer + `/estimate` page |
| 4-6 | document only | `docs/roadmap.md` |

## Hard rules for every agent
- LIVE Supabase project `hnzcwfvxpfsyjpbebevp` is production. Never write to it, never deploy to it. Staging = local Postgres 16 (`platform/scripts/staging.sh`) + PGlite tests.
- No secrets in frontend or repo. No scraping. No sign-ups, no contact with any provider, no paid service.
- No fabricated market data. A number without a source is tagged `estimated`, source `Everyspace planning default (uncited)`, confidence <= 0.2, and can be overridden by the owner. A missing number is `unavailable`, never 0.
- Do not touch files outside the ownership in your brief. `index.html`/`everyspace.html` are 1.4 MB: grep, never read whole.
- Deterministic logic = pure functions with tests. `now` is injected.

## Decisions (ADRs in `docs/adr/`)
| # | decision |
|---|---|
| 1 | Keep stack: Supabase Postgres + Deno edge functions (`platform/`), static pages on GitHub Pages, `node --test`. No build step. |
| 2 | `/core/*.js`: zero-dependency ES modules with JSDoc types, shared by browser, Node and Deno. Contract = `core/types.js`. |
| 3 | Database is authoritative for bookings (property advisory lock + exclusion constraint + RPC-only writes). `core/availability.js` mirrors the rules for previews/optimizer; a parity test keeps them equal. |
| 4 | Tenant = organization. Every user gets a personal org; `properties.org_id`; roles are rows in `roles`. `host_id` stays for backward compatibility. |
| 5 | Platforms and categories are lookup tables (`channels`, `space_categories`), not enums. The `channel` enum is converted to `text` + FK. |
| 6 | Provider adapters live in `platform/supabase/functions/_shared/providers/`; each declares honest capability levels L0-L4. Only `ical` and `manual` exist. |
| 7 | Provenance on every attribute: append-only `property_attributes`, `owner_confirmed` always wins (`core/provenance.js` `resolve`). |
| 8 | City Pretty is reused by vendoring its parcel-lookup pattern and `Sourced` type at commit `ac7faf3`; its Worker is not called. |
| 9 | Restricted third-party data goes only in `provider_data` (provider-scoped, `expires_at` required, purged); never joined into intelligence or estimates. |
| 10 | Optimizer = exhaustive search over feasible subsets (<= 20 opportunities), not a sum. |

## File ownership (no two agents edit the same file)
| area | paths | owner |
|---|---|---|
| Migrations M0-M4, RLS tests, staging script | `platform/supabase/migrations/*`, `platform/tests/{foundation,rls}.test.mjs`, `platform/tests/helpers/*`, `platform/scripts/*` | DB-1 |
| Availability M5, JS mirror, race tests | `platform/supabase/migrations/20261124050000_availability.sql`, `core/availability.js`, `core/tests/availability*.test.mjs`, `platform/tests/{availability,race}*.test.mjs` | DB-2 (after DB-1) |
| Provider adapters, fetch hardening, sync staleness | `platform/supabase/functions/**`, `platform/tests/{providers,fetch,sync,guard,ical}.test.ts` | PROV |
| Provenance, geometry, parcel resolver, profile | `core/{provenance,geometry,parcel,profile}.js`, `core/data/parcel-services.js`, `core/tests/{provenance,geometry,parcel,profile}.test.mjs`, `core/tests/fixtures/parcel/*` | INTEL |
| Opportunities, regulatory | `core/{opportunities,regulatory}.js`, `core/data/{categories,jurisdictions}.js`, `core/tests/{opportunities,regulatory}.test.mjs` | OPP |
| Revenue model, optimizer | `core/{revenue,optimizer}.js`, `core/data/{assumptions,platform-fees,scenarios}.js`, `core/tests/{revenue,optimizer}.test.mjs` | REV |
| Public estimator page | `estimate/*`, `tests/estimate.e2e.mjs` | EST (after INTEL, OPP, REV) |
| Host Console tweaks | `host/index.html` | HOST |
| Contracts and docs | `core/types.js`, `docs/*.md`, `docs/adr/*` | orchestrator |

## Interfaces pinned across agents
- `core/types.js` is the contract for `Sourced`, `PropertyProfile`, `Opportunity`, `EstimateInputs`, `ScenarioResult`, `OpportunityEstimate`, `OwnerConstraints`, `OptimizationResult`.
- `core/provenance.js` exports `sourced, unavailable, ownerConfirmed, resolve, confidenceLabel, isStale`.
- `core/profile.js` exports `createProfile, setAttribute, applyOwnerCorrection, getAttribute, summarize` (immutable: each returns a new profile).
- `core/parcel.js` exports `resolveAddress(address, {fetch, now})` -> `{ok, profile, steps:[{step, ok, reason?, source}]}`; plus `geocode, parcelAt, buildingsNear, poolNear, transitNear`. Each returns `{ok:false, reason}` instead of guessing.
- `core/opportunities.js` exports `identifyOpportunities(profile, {now})` -> `Opportunity[]`; `core/regulatory.js` exports `checkFeasibility(categoryKey, profile, {now})` -> `Feasibility`.
- `core/revenue.js` exports `defaultInputs(opportunity, profile)`, `estimateOpportunity(opportunity, inputs)`, `withOverrides(inputs, overrides, now)`; `core/optimizer.js` exports `optimize(opportunities, estimatesById, {goal, constraints, scenario})`.
- `core/data/categories.js` exports `CATEGORIES` (array of `{key, label, unit, group, effort, privacyImpact, strangersInHome, basisDefault, requires, conflictsWith, resourceUse}`); keys are snake_case and are the same keys seeded into `space_categories`.
- DB columns other agents rely on: `calendar_imports.consecutive_failures int`, `calendar_imports.last_ok_at timestamptz` (added in M5); `channels.key text` holds the former enum values unchanged.
- SQL functions kept stable: `owns_space(uuid)`, `lock_property(uuid)`, `related_spaces(uuid)`, `place_hold`, `detect_conflicts(uuid)`.

## Schema summary (detail in `docs/schema-proposal.md`)
- M0 drift fix · M1 `organizations, roles, memberships` + membership-based RLS · M2 `channels, space_categories, amenities, space_amenities` · M3 `parcels, buildings, property_attributes, property_photos, regulatory_rules, property_regulatory, opportunities, projections, provider_data` · M4 `pricing_rules, expenses, revenue_entries, maintenance_tasks, communications` · M5 `space_relations, resources, space_resources`, buffers, `availability_conflicts()`, `create_booking()`, `import_reservations()`, exclusion constraint, RPC-only reservation writes.

## Test commands
- `cd platform && npm test` (PGlite + pure TS) · `cd platform && npm run test:staging` (local Postgres 16, races) · `node --test tests/*.test.mjs core/tests/*.test.mjs` (repo root).
- Baseline before this run: platform 34 pass, root 15 pass.

## Approvals pending (owner)
| # | request | blocks |
|---|---|---|
| A1 | Allow official platform/data-publisher hosts in this cloud environment's network list | `docs/integrations.md`, `docs/data-availability.md` verification; live parcel spot-check |
| A2 | Apply migrations M0-M5 to the live Supabase project (empty today) | saving profiles from the estimator; Host Console use of new tables |
| A3 | Confirm licence for reusing City Pretty code in Everyspace (same owner, no LICENSE file) | publishing vendored code |

## Open questions / skipped (off critical path)
- Marketplace/consumer demo screens and README "marketplace with a 3% host fee" conflict with "management first": left untouched, needs owner call.
- Photo upload storage bucket, email/CSV booking parser beyond a simple CSV, server-side `property-intel` edge function with caching: not built.
- Unsourced constants in `index.html` (`TYPICAL`, `VENUES`, `SOLAR`, quiz uplifts): not edited; new estimator labels them as uncited.
- A subagent made one stray, rejected `archive_session("self")` call during the audit; nothing was archived.

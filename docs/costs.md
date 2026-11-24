# Costs and monetization (2026-11-24)
Pricing pages were not reachable on 2026-11-24 ([integrations](integrations.md), [data-availability](data-availability.md)). Figures appear only where an input states one. Run-rate $0 is per repo docs (decision).

| item | needed for | current cost | cost if enabled | pricing source | approval needed |
|---|---|---|---|---|---|
| Supabase free plan | live DB, auth, edge functions, cron | $0 (per repo docs) | n/a | decision (stay on free plan) | no |
| Second free Supabase project (hosted staging) | optional hosted staging; free plan allows 2 active | $0 not enabled | $0 on free plan (audit/database.md §6); not verified on pricing page | audit/database.md §6 | yes (creating a project) |
| Supabase Pro / branching | branches; not on free plan | not enabled | not verified, pricing page not reachable 2026-11-24 | audit/database.md §6 | yes |
| GitHub Pages | frontend hosting | $0 (per repo docs) | n/a | decision | no |
| Domain | custom host domain | not verified | not verified (no input states a figure) | none | yes |
| Channex / channel manager | partner-API sync | not enabled | not verified, pricing page not reachable 2026-11-24 | integrations.md | yes |
| Stripe | payments, later booking fees | not enabled (checkout simulated) | not verified, pricing page not reachable 2026-11-24 | audit/frontend.md §5 | yes |
| AI model usage | listing text, advisor | simulated (canned output) | not verified, pricing page not reachable 2026-11-24 | audit/frontend.md §6 | yes |
| Google Solar API | roof solar yield | not enabled | paid; terms limit to solar feasibility, 30-day cache; amount not verified, pricing page not reachable 2026-11-24 | shared-infra.md; data-availability.md | yes |
| Regrid | parcels outside LA | not enabled | not verified, pricing page not reachable 2026-11-24 | data-availability.md | yes |
| AirDNA | STR comparables | not enabled | commercial; amount not verified, pricing page not reachable 2026-11-24 | data-availability.md | yes |
| NREL PVWatts key | solar yield | DEMO_KEY shared, rate-limited | free (assumption); own key needed; limits not verified | data-availability.md | no (free key); confirm |
| Mapbox | geocoding/tiles | not used by ES (SF only) | not verified, pricing page not reachable 2026-11-24; do not store temporary geocodes | shared-infra.md | yes |

## Monetization
Existing: revenue share 10% until $30 fee/host/month, then 3% (app_settings; migration ...020000:16-50). Estimator stays free in every row.

| stream | depends on | cost drivers | deters free discovery? | verdict |
|---|---|---|---|---|
| subscriptions | Host Console value, accounts | infra, support | no (paywall only on console) | later |
| automation (sync, holds, guards) | iCal adapter, cron | integration, infra | no | now |
| multi-property | single-tenant model, orgs | infra, support | no | later |
| analytics | revenue/occupancy views (missing) | data, infra | no | later |
| integration services | partner APIs (unverified) | integration, support | no | later |
| reports | sourced estimator data | data | no, if estimator stays free | later |
| enterprise | orgs/roles (missing) | support, infra | no | avoid (for now) |
| booking fees / commissions | marketplace, payments (demo only) | payments, support | yes | avoid (conflicts with positioning) |
| existing revenue share | ledger, attribution | payments, support | no | now (keep) |

## Verified
- Run-rate and plans: free plan, GitHub Pages (decision; repo docs).
- Revenue-share rule is implemented in SQL (audit files).
- Free plan allows 2 active projects; no branching on free (audit/database.md §6).

## Assumptions
- PVWatts own key is free (not checked).
- No cost exists beyond $0 today (per repo docs).

## Recommendations
- Approve no paid item until pricing pages are re-fetched.
- Keep the estimator and map free; charge for the Host Console later.
- Re-run pricing research once hosts are allowed.

# Costs and monetization (2026-11-24)
Most pricing pages were not reachable on 2026-11-24 ([integrations](integrations.md), [data-availability](data-availability.md)); only Channex was fetched. Figures appear only where a fetched source states one. Every paid item requires owner approval. Run-rate $0 is per repo docs (decision).

| item | needed for | current cost | cost if enabled | pricing source | approval needed |
|---|---|---|---|---|---|
| Supabase free plan | live DB, auth, edge functions, cron | $0 (per repo docs) | n/a | decision (stay on free plan) | no (already in use) |
| Second free Supabase project (hosted staging) | optional hosted staging; free plan allows 2 active | $0 not enabled | $0 on free plan (audit/database.md §6); not verified on pricing page | audit/database.md §6 | yes (creating a project) |
| Supabase Pro / branching | branches; not on free plan | not enabled | not verified, pricing page not reachable 2026-11-24 | audit/database.md §6 | requires owner approval |
| GitHub Pages | frontend hosting | $0 (per repo docs) | n/a | decision | no |
| Domain | custom host domain | not verified | not verified (no input states a figure) | none | requires owner approval |
| Channex / channel manager | partner-API sync | not enabled | verified 2026-11-24: $130/month platform fee + vacation-rental units from $0.50 per unit (messaging add-on $0.50/unit); no setup fee. Live use also needs Channex certification and per-OTA authorisation | https://channex.io/pricing (fetched 2026-11-24) | requires owner approval |
| Stripe | payments, later booking fees | not enabled (checkout simulated) | not verified, pricing page not reachable 2026-11-24 | audit/frontend.md §5 | requires owner approval |
| AI model usage | listing text, advisor | simulated (canned output) | not verified, pricing page not reachable 2026-11-24 | audit/frontend.md §6 | requires owner approval |
| Google Solar API | roof solar yield | not enabled | paid; terms limit to solar feasibility, 30-day cache; amount not verified, pricing page not reachable 2026-11-24 | shared-infra.md; data-availability.md | requires owner approval |
| Regrid | parcels outside LA | not enabled | not verified, pricing page not reachable 2026-11-24 | data-availability.md | requires owner approval |
| AirDNA | STR comparables | not enabled | commercial; amount not verified, pricing page not reachable 2026-11-24 | data-availability.md | requires owner approval |
| NREL PVWatts key | solar yield | DEMO_KEY shared, rate-limited | free (assumption); own key needed; limits not verified | data-availability.md | sign-up needs owner approval; confirm free |
| Mapbox | geocoding/tiles | not used by ES (SF only) | not verified, pricing page not reachable 2026-11-24; do not store temporary geocodes | shared-infra.md | requires owner approval |

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
- Channex: $130/month platform fee and vacation-rental units from $0.50 per unit, from channex.io/pricing on 2026-11-24 (live use also needs certification).
- Run-rate and plans: free plan, GitHub Pages (decision; repo docs).
- Revenue-share rule is implemented in SQL (audit files).
- Free plan allows 2 active projects; no branching on free (audit/database.md §6).

## Assumptions
- PVWatts own key is free (not checked).
- No cost exists beyond $0 today (per repo docs).

## Recommendations
- Approve no paid item until its pricing page is re-fetched; Channex alone has a verified price.
- Keep the estimator and map free; charge for the Host Console later.
- Re-run pricing research once hosts are allowed.

# Database and security audit (read-only)
Project `hnzcwfvxpfsyjpbebevp`, Postgres, free plan, audited 2026-11-24. No writes made. Evidence: repo `platform/supabase/...` or "live:" (MCP catalog reads).
**Headline: no HIGH issues. The database is empty (0 rows except app_settings=1), so it is the cheapest moment to change the schema.**

## 1. Table inventory (all in `public`, RLS on for all 13, live: list_tables / pg_policies)
| table | purpose | tenant key | policies (cmd) | rows |
|---|---|---|---|---|
| app_settings | single-row pricing config (intro 10% to $30 cap, then 3%) | none (global) | SELECT authenticated `true` | 1 |
| profiles | host, 1:1 with auth.users (auto-created by trigger) | id = auth.uid() | ALL own | 0 |
| properties | physical site, has timezone | host_id | ALL own | 0 |
| spaces | rentable unit, `parent_space_id` tree, quantity | via properties.host_id (EXISTS) | ALL own | 0 |
| channel_connections | host's account per site, unique(host,channel) | host_id | ALL own | 0 |
| channel_listings | space on a site; booking_mode instant/request/closed | via owns_space() | ALL own | 0 |
| calendar_imports | iCal URLs we read (URL contains a secret) | via owns_space() | ALL own | 0 |
| calendar_feeds | iCal feeds we publish, `token` per space+site | via owns_space() | ALL own | 0 |
| reservations | every booking/block from every source | via owns_space() | ALL own | 0 |
| conflicts | detected overlaps | via owns_space() | SELECT | 0 |
| earnings_ledger | per-booking revenue-share fee | host_id | SELECT | 0 |
| booking_holds | 24h holds placed before accepting a request | via owns_space() | SELECT (writes via RPC only) | 0 |
| booking_alerts | guard alerts, "close these dates" | via owns_space() | SELECT | 0 |
All policies target `authenticated` only (no anon policy). Evidence: init.sql:282-311, no_double_booking.sql:622-625.

## 2. Tenant model and roles
| item | status | evidence | verdict |
|---|---|---|---|
| Single-owner tenant: tenant = host = auth user | implemented | `profiles.id -> auth.users`; `properties.host_id`; all policies key on `auth.uid()` | keep for solo hosts |
| Organization / team / membership | missing | no org or members table in any migration or live | replace if teams, co-hosts or cleaners are needed (add `orgs` + `memberships`, change `owns_space()` only) |
| Roles / permissions | missing | no role column. Only Postgres roles anon/authenticated/service_role. Admin work uses service_role | modify when needed |
| Single choke point for ownership | implemented | `owns_space()` used by 7 policies (init.sql:294) | keep (makes a later org change cheap) |

## 3. Security findings
| # | severity | finding | evidence | fix |
|---|---|---|---|---|
| 1 | medium | Hosts can write `reservations` directly (policy ALL) without the property lock, so a host or buggy client can insert overlapping bookings. The only guards are after-the-fact `detect_conflicts` and the holds flow | init.sql:309; no EXCLUDE constraint (see 7) | restrict writes to RPC or service role, or add a GiST exclusion for qty=1 |
| 2 | medium | Calendar tokens and iCal import URLs are plaintext. A feed token is the only credential for a public no-JWT endpoint. There is no rotation, expiry or rate limit, and the endpoint is wildcard-CORS | init.sql:163; config.toml:1-5; cors.ts:3 | add a rotate-token RPC, optionally hash tokens, add rate limiting |
| 3 | medium | No staging or branch. Any migration or function deploy goes straight to production | live: list_branches empty (given); see 6 | see 6 |
| 4 | low | 4 SECURITY DEFINER RPCs callable by `authenticated` (advisor 0029): `dismiss_alert`, `owns_space`, `place_hold`, `release_hold`. All have `search_path=""` and an `owns_space` check, so this is intended | live: get_advisors security; pg_proc | accept; document |
| 5 | low | `place_hold` allows `auth.uid()` NULL to skip the ownership check. Safe only because anon has no EXECUTE (live: has_function_privilege anon=false) | no_double_booking.sql:450 | require `service_role` explicitly |
| 6 | low | `app_settings` is readable by any signed-in user (pricing). No write policy, so writes are service-role only | init.sql:299 | accept |
| 7 | low | `site_name()` is executable by anon but is an immutable non-definer helper, harmless | live: pg_proc | accept |
| 8 | low | Edge-function CORS is `*`. Access is gated by JWT or token, not origin | cors.ts:3 | accept; tighten if a fixed host domain exists |
Good: all 20 public functions have `search_path=""` (live: pg_proc.proconfig); internal definer functions have EXECUTE revoked from anon/authenticated; no views in public; performance advisor returns 0 lints; service-role key is read only from `Deno.env` (3 functions).

## 4. Repo-vs-live drift
| item | status | evidence | verdict |
|---|---|---|---|
| Migrations: 8 live vs 6 files | partial | live-only: `enable_scheduling_extensions`, `move_pg_net_to_extensions_schema`. Repo mirrors them in `cron/calendar_sync.sql:2-3` (not a migration) | modify: add 2 migration files, or `supabase migration repair` |
| Version numbers differ | partial | live `20261116050935_init` vs file `20261116000000_init` (all 6 differ). `supabase db push` would see them as unrelated | modify: rename the files to the live versions |
| Edge functions 3/3 present both sides | implemented | live: calendar-feed v2 (verify_jwt=false), calendar-sync v3, booking-guard v4 (true), matching config.toml. Source hash not compared | keep |
| Cron jobs | partial | live has 2 jobs (calendar-sync */15, accrue-earnings 17 9). Both are in `cron/calendar_sync.sql` but it is a manual script, not a migration, so a fresh DB will not have them | modify |
| Live cron command embeds the anon JWT | implemented | live: cron.job command (truncated at "Authoriza..."), repo uses `<anon key>` placeholder | keep (anon key is public) |

## 5. Secrets
| item | status | evidence | verdict |
|---|---|---|---|
| Service-role key | implemented | only `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` in 3 functions. No literal in repo (grep eyJ/service_role matched only the anon key and doc text) | keep |
| Cron secret | implemented | in Vault `calendar_sync_cron_secret`, checked by `check_cron_secret()` (service_role only, length>=32). Sent as `x-cron-secret` | keep |
| Frontend key | implemented | `host/index.html:163-165` holds a legacy JWT with role=anon (not `sb_publishable_`, not service_role) | keep; fine to be public if RLS holds |
| iCal feed tokens | partial | plaintext 64-hex in `calendar_feeds.token`, unique (see finding 2) | modify |
| Channel API tokens | planned | comment says "API tokens go in Vault", no code uses it yet (init.sql:125) | keep |

## 6. Staging
| item | status | evidence | verdict |
|---|---|---|---|
| Supabase branches / second project | missing | none. Branching is not on the free plan | n/a |
| Local `supabase start` | partial | `config.toml` has only functions blocks, no `project_id` or `[db]`. `supabase/` has no seed.sql | modify |
| In-memory test DB | implemented | PGlite, a stub auth schema, all migrations replayed (`tests/helpers/db.mjs:4-24`); `npm test` = `node --test`. It does not model cron, Vault or pg_net (check_cron_secret depends on vault) | keep as the unit layer |
Cheapest safe option: (a) CI on PGlite for every migration; (b) local `supabase start` (Docker, free) as the staging DB; (c) if a hosted staging is needed, a second free project (free plan allows 2 active) linked by `supabase link` and deployed before prod. Fix the migration filenames first (section 4).

## 7. Double-booking at schema level
- No exclusion constraints and no `btree_gist` installed (live: list_extensions). `reservations` only has unique(space_id, channel, external_uid) and check(ends_at > starts_at).
- Overlap detection is procedural: `detect_conflicts()` records pairs in `conflicts` (qty=1 only; multi-unit is "checked in the app").
- "One open door" trigger `enforce_one_door` allows one instant listing per space family (parents and children via recursive `related_spaces`).
- Holds (`booking_holds` + `place_hold` / `mark_hold_safe` / `settle_holds`) take `pg_advisory_xact_lock` keyed on the property. Only the RPC path is serialised (see finding 1).
- `check_space_parent` trigger blocks cycles and cross-property parents; alerts via `booking_alerts` and `record_door_gaps`.
Status: partial (procedural, not declarative). Keep the design, modify to add a GiST exclusion for qty=1.

## 8. Data-driven-ness
| item | status | evidence | verdict |
|---|---|---|---|
| Space categories | implemented (free text) | `spaces.category text not null`, no CHECK, no lookup (init.sql:102). New categories need no schema change | modify: add a `space_categories` lookup + FK for validation and metadata |
| Platforms | partial (hard enum) | Postgres enum `channel` with 19 values, used in 6 tables (init.sql:114). A new platform needs `ALTER TYPE ADD VALUE` (a migration). `site_name()` is also hard-coded | replace with a `channels` lookup table |
| Statuses/kinds | partial | CHECK lists on text columns (cheaper to alter than an enum) | keep |

## Verified vs assumed
- Verified live: table/RLS/policy/row-count list, function search_path and anon/authenticated EXECUTE, 2 cron jobs, 8 migrations, 3 functions, and both advisors.
- Verified in repo: all 6 migrations read in full; config.toml, cron script, tests helper, function key handling by grep.
- Not verified: edge function source vs deployed source (only the hash is available); Auth settings (leaked-password protection, email confirm, redirect URLs); backups/PITR.
- Assumed: the anon key in host/index.html belongs to this project (role=anon decoded, not matched to the project ref).
- Not verified: whether GRANTs on tables for anon exist (RLS blocks anon either way, no anon policy); view/materialized-view absence checked by table list only.
- Not verified: storage buckets and `auth` schema config (deliberately not queried).

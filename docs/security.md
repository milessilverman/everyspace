# Security findings (2026-11-24)
Source: [audit/database.md](audit/database.md) §3-§6, [integrations-booking](audit/integrations-booking.md), [shared-infra](audit/shared-infra.md), [data-availability](data-availability.md). No HIGH items in the DB audit.

| # | severity | finding | evidence | fix | status |
|---|---|---|---|---|---|
| 1 | medium | Hosts can write `reservations` directly (policy ALL) without the property lock; overlaps possible | init.sql:309; no EXCLUDE | restrict writes to RPC/service role or GiST exclusion for qty=1 | fix planned this run |
| 2 | medium | Calendar tokens and iCal import URLs plaintext; token is sole credential for no-JWT endpoint; no rotation, expiry, rate limit; wildcard CORS | init.sql:163; config.toml:1-5; cors.ts:3 | rotate-token RPC, optional hashing, rate limit | fix planned this run |
| 3 | medium | No staging or branch; migrations/functions go straight to production | live list_branches empty (decision) | local Postgres 16 + PGlite staging (decision) | fix planned this run |
| 4 | low | 4 SECURITY DEFINER RPCs callable by authenticated (advisor 0029): dismiss_alert, owns_space, place_hold, release_hold; all search_path="" with owns_space check | live get_advisors | accept; document | open |
| 5 | low | `place_hold` lets `auth.uid()` NULL skip ownership check; safe only because anon has no EXECUTE | no_double_booking.sql:450 | require service_role explicitly | fix planned this run |
| 6 | low | `app_settings` (pricing) readable by any signed-in user; no write policy | init.sql:299 | accept | open |
| 7 | low | `site_name()` executable by anon; immutable non-definer helper | live pg_proc | accept | open |
| 8 | low | Edge-function CORS `*`; access gated by JWT/token | cors.ts:3 | accept; tighten if fixed domain | open |
| 9 | medium | SSRF gap: fetch.ts checks only `^https://`, `redirect:'follow'`, no private-IP/DNS/localhost or redirect-hop check; Supabase egress mitigation not verified | fetch.ts:21,23 | block private/loopback ranges, re-check each hop; add tests (none exist) | fix planned this run |
| 10 | medium | Plaintext iCal tokens/URLs (URL contains a secret) | init.sql:163; audit/database.md §5 | hash tokens, encrypt or Vault import URLs | fix planned this run |
| 11 | medium | Migration drift: 8 live vs 6 files, all version numbers differ, 2 live-only, cron jobs only in manual script | audit/database.md §4 | rename files to live versions, add 2 migrations or `migration repair`, move cron into migration | fix planned this run |
| 12 | medium | City Pretty Worker origin allow-list names `milessilverman.github.io`, no auth, shared 60/min limit; works for ES by accident | CP:workers/api-proxy.ts:47-51 | do not call the Worker; vendor pure functions (decision) | fix planned this run |
| 13 | medium | Third-party/restricted marketplace data (e.g. platform or paid-provider data) not isolated; terms not verified | integrations.md, data-availability.md ("not verified") | provider-scoped tables, per-provider retention/expiry, no mixing into shared profile, delete on terms change | needs approval |
| 14 | low | Auth settings (leaked-password protection, email confirm, redirects) and backups/PITR not checked | audit/database.md "Verified vs assumed" | review in dashboard | open |

## Controls that must not be weakened
- RLS on all public tables, `authenticated` only; no anon policy.
- `owns_space()` as the single ownership choke point.
- `search_path=""` on all functions; EXECUTE revoked from anon on internal definer functions.
- Service-role key only via `Deno.env`; cron secret via Vault `check_cron_secret()`.
- Nothing applied to the live project without owner approval (decision).

## Secrets handling
| what | where stored | never in frontend |
|---|---|---|
| Service-role key | edge-function env (`Deno.env`) | yes, never |
| Cron secret | Vault `calendar_sync_cron_secret` | yes, never |
| Anon key / project URL | host/index.html:163-165 (public by design) | n/a, RLS must hold |
| iCal feed tokens, import URLs | `calendar_feeds.token`, `calendar_imports` (plaintext today) | feed URL is shared by design; rotate |
| Channel API tokens | planned: Vault (init.sql:125) | yes, never |
| Third-party keys (PVWatts, Google Solar, Regrid, Mapbox, AirDNA) | not verified; edge-function env or Worker secret | yes, never (no key literals found in index.html) |

## Verified
- All 13 tables RLS-on; 20 functions have search_path set (live, per audit).
- No service_role/sk_/AIza literal in index.html (audit/frontend.md §6).
- 3 edge functions present live and in repo; source hash not compared.

## Assumptions
- Anon key in host/index.html belongs to this project.
- Egress layer may not stop DNS-rebind SSRF.

## Recommendations
- Fix #1, #2, #5, #9, #10, #11 in staging first; apply to live only with owner approval.
- Add tests for fetch.ts, handlers and concurrent holds.
- Define the provider-scoped schema before storing any third-party data.

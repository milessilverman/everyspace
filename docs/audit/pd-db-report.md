# PD-DB report: property profile storage and endpoint (local staging only)

Status: done. `npm test` 264/264 pass (12 new in `property_profiles.test.mjs`, 19 in `property_profile_fn.test.ts`, 2 new rls checks). `npm run test:staging` 16/16 pass on local Postgres 16. Nothing committed, pushed, deployed, or sent to the hosted project.

## Objects added
- `platform/supabase/migrations/20261127010000_property_profiles.sql`
  - `property_profiles` (unique `address_key`, indexes on place_id, apn, expires_at, property_id; checks: lower-case key, profile is a JSON object under 256 KB, `expires_at > created_at`, FIPS and coordinate ranges).
  - `provider_usage (provider, day, calls)`, RLS on with no policies.
  - `reserve_provider_call(provider, cap)`: one upsert, `where calls < cap`; cap <= 0 or null is false; UTC day.
  - `store_property_profile` (upsert by key, keeps an existing owner claim, refuses a past expiry), `get_cached_property_profile` (newest non-expired, matched on key or place_id), `purge_expired_property_profiles`, and `assert_service_caller` (in-function role check, as `can_book` does).
  - RLS: anon has nothing; signed-in users have no writes; a member with `property.read` sees only non-expired profiles whose `property_id` is their own property.
  - All functions SECURITY DEFINER, `search_path=''`, EXECUTE revoked from public/anon/authenticated and granted to service_role.
- `platform/supabase/functions/property-profile/index.ts` and `logic.ts`; `config.toml` entry (`verify_jwt = false`, commented).
- Tests above; `rls.test.mjs` classifies `property_profiles` (TENANT) and `provider_usage` (new SERVICE_ONLY list).

## Before production
1. Owner approves the migration and the privacy change below. Apply `20261127010000` after `20261124050000` (no new dependency beyond `properties` and `has_property_permission`).
2. Function secrets, set on the hosted project by the owner (not by an agent): `RENTCAST_API_KEY`, `GOOGLE_SOLAR_API_KEY`, `RENTCAST_DAILY_CAP`, `GOOGLE_SOLAR_DAILY_CAP` (a paid provider stays off until its key and a positive cap are both set), `ALLOWED_ORIGINS` (default `https://milessilverman.github.io`).
3. Bundling check: the builder is imported from repo-root `core/` by relative path (`../../../../core/...`). Verify on a non-production deploy that the bundler includes it; fallback is a deploy step copying `core/` into `functions/_shared/core/` and changing the three import paths.
4. Schedule `purge_expired_property_profiles()` daily. I did not edit `supabase/cron/` (not in my file list); expired rows are invisible to members and never returned by the cache meanwhile.
5. Confirm the Google Solar 30-day retention and RentCast terms with the owner; the expiry follows the providers' `retentionDays`.

## Privacy
The table records which addresses were looked up (and the provider data returned), never visitor identity: no IP, user agent, or user id is stored or logged (logs carry codes only). The estimator's "nothing you enter is saved" statement becomes false once this endpoint is switched on and must be changed first.

## Open risks
- No per-visitor rate limit: only the global daily caps limit paid calls, so one visitor can use the day's budget. Non-browser callers send no Origin and are not blocked by CORS.
- A reserved budget unit is spent even if the builder then makes no call to that provider.
- A failed budget check is treated as "daily limit reached" (fails closed).
- A cached profile is served to every visitor until expiry, including data from a paid provider.
- Profile claim by a signed-in owner (`property_id`) has no function yet; only the column and read policy exist.
- Output scrubbing removes secret values and URL query strings from the response, but the stored copy is whatever the builder returns, so the builder must redact.

# Security findings (2026-11-24)
Status words: "fixed on staging" = fixed in this branch and tested locally, NOT applied to the live project. See [audit/review-gate.md](audit/review-gate.md) and [audit/db1-report.md](audit/db1-report.md).
Source: [audit/database.md](audit/database.md) §3-§6, [integrations-booking](audit/integrations-booking.md), [shared-infra](audit/shared-infra.md), [data-availability](data-availability.md). No HIGH items in the DB audit.

| # | sev | finding | status |
|---|---|---|---|
| 1 | med | Hosts could write `reservations` directly without the lock | fixed on staging: writes are RPC-only, exclusion constraint added (`rls.test.mjs`, `availability.test.mjs`); limit: constraint covers same-space qty-1 rows only |
| 2 | med | Calendar tokens and import URLs plaintext, no rotation or rate limit, CORS `*` | open (hashing, rotation, rate limit not built); partly fixed on staging: only `space.write` members can read them (`rls.test.mjs`) |
| 3 | med | No staging; changes go straight to production | fixed: local Postgres 16 + PGlite (`npm run test:staging`); hosted branch not enabled, needs approval (cost) |
| 4 | low | 4 SECURITY DEFINER RPCs callable by authenticated | open (accepted); `rls.test.mjs` now lists the exact callable set |
| 5 | low | `place_hold` trusted a NULL `auth.uid()` | fixed on staging: caller identity from the `role` setting (`availability.test.mjs`) |
| 6 | low | `app_settings` readable by any signed-in user | open (accepted) |
| 7 | low | `site_name()` executable by anon | open (accepted) |
| 8 | low | Edge-function CORS `*` | open (accepted) |
| 9 | med | SSRF in `fetch.ts` | fixed on staging (`fetch.test.ts`: private ranges, redirect hops, DNS fail closed); DNS rebinding open, see below |
| 10 | med | Plaintext iCal tokens/URLs | open (not hashed or moved to Vault) |
| 11 | med | Migration drift (8 live vs 6 files) | fixed in repo: files renamed to live versions, 2 reconstructed; check `supabase migration list` before any push |
| 12 | med | City Pretty Worker origin and no auth | fixed by not calling it (decision) |
| 13 | med | Third-party data not isolated, terms unverified | needs approval; `provider_data` has expiry, RLS ignores expired rows and a daily purge exists (staging) |
| 14 | low | Auth settings, backups/PITR not checked | open |
| R1 | high | Relation blocks only one way (double booking) | fixed on staging (`review_fixes` finding 1; `review_race`) |
| R2 | high | Moving a parent to another property split the lock | fixed on staging (`review_fixes` finding 2; `review_race`) |
| R3 | med | `import_reservations` could move or cancel owner bookings | fixed on staging (`review_fixes` finding 3) |
| R4 | med | `mark_hold_safe` ignored relations | fixed on staging (`review_fixes` finding 4) |
| R5 | med | Calendar sync wrote without the lock | fixed on staging (`sync_calendar_import`; `handlers.test.ts`, `review_race`); needs deploy after migrations |
| R6 | med | One-door rule ignored relations | fixed on staging (`review_fixes` finding 6) |
| R7 | med | Admin could add any user as active member and read profile | fixed on staging (`review_fixes` finding 7) |
| R8 | med | `provider_data` never purged, expiry ignored | fixed on staging (`review_fixes` finding 8); purge job must be run by hand from `cron/calendar_sync.sql` |
| R9-R10 | med | Cleaning cost dropped; confidence ignored fee and seasonality | fixed (`core/tests/revenue.test.mjs`) |
| R11-R13 | low | Budget per item; ex-member earnings; partial DNS answer | fixed (`optimizer.test.mjs`, `review_fixes` finding 12, `fetch.test.ts`) |
| O1 | med | DNS rebinding cannot be fully closed (fetch resolves the name again) | open (edge runtime limit) |
| O2 | med | iCal summaries may carry guest names; Host Console shows them | open (product decision) |
| O3 | low | Shared-resource capacity cannot be expressed in a calendar feed | open (enforced only by booking RPCs) |
| O4 | low | Estimator geocodes in the browser with Nominatim | open, small volume only; see [risks](risks.md) |
| O5 | med | Edge functions need migration M5; live schema lacks it | needs approval (deploy migrations first) |

## Controls that must not be weakened
- RLS on all public tables; no anon policy. `owns_space()` is the ownership choke point.
- `search_path=""` on all functions; service-role key only via `Deno.env`; cron secret via Vault.
- Nothing applied to the live project without owner approval (decision).

## Secrets handling
Service-role key: edge-function env only. Cron secret: Vault. Anon key is public by design (`host/index.html`); RLS must hold. iCal tokens and import URLs are plaintext today (#2, #10). Third-party keys: not verified.

## Verified
- 231 platform tests, 16 staging tests, 272 root tests pass (2026-11-24); the live project has no branches and 0 user rows.
- All 2 high, 8 medium and 3 low review findings have regression tests.

## Assumptions
- Anon key in `host/index.html` belongs to this project.
- Hosted PostgREST sets the `role` setting the booking functions read (not checked).

## Recommendations
- Before any production apply, follow the checklist in [platform/README.md](../platform/README.md).
- Decide on token hashing/rotation (#2, #10) and the guest-name question (O2).
- Do not store third-party data until #13 has an approved plan.

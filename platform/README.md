# Everyspace platform

The real backend behind Everyspace and its Host Console ([`../host/`](../host/)). The earlier single-file demo now lives in [milessilverman/everyspace-demo](https://github.com/milessilverman/everyspace-demo). It runs on Supabase's free plan: Postgres, Auth, Edge Functions and pg_cron. The game plan is in [docs/PLAN.md](docs/PLAN.md).

**Live:** Supabase project `everyspace` (`hnzcwfvxpfsyjpbebevp`, West US, free plan). Functions are at `https://hnzcwfvxpfsyjpbebevp.supabase.co/functions/v1/<name>`.

**This branch is NOT applied to the live project.** As of 2026-11-24 the live project has no branches and no user rows. Everything below marked "new" was tested only on local staging. The edge functions in this branch select `calendar_imports.last_ok_at` / `consecutive_failures` and call `sync_calendar_import`, so they only work after migration `20261124050000_availability.sql`.

## What's here

### Migrations (`supabase/migrations/`)

| File | What it is |
|---|---|
| `20261116050935_init.sql` | Hosts, properties, spaces (parent spaces for whole house vs room), site connections, calendar links in and out, reservations, double-booking detection, revenue-share ledger. Row-level security on every table. |
| `20261116051049_no_double_booking.sql` | One instant site per space, date holds under a lock, the guard, alerts. |
| `20261116051137_pricing.sql` | Revenue-share settings (10% until the fee reaches $30 a month, then 3%) and the accrual. |
| `20261116051641_enable_scheduling_extensions.sql` | Enables pg_cron and pg_net (guarded no-op where they are missing). Contents of the live version not visible; reconstructed. |
| `20261116052016_cron_secret.sql` | Cron secret check (kept in Vault), so only the schedule can call calendar-sync. |
| `20261116052212_move_pg_net_to_extensions_schema.sql` | Moves pg_net to the `extensions` schema (guarded). Reconstructed like the file above. |
| `20261116052245_indexes.sql` | Indexes on foreign keys flagged by Supabase's advisor. |
| `20261116110046_alerts_polish.sql` | Clearer guard alerts and a way to acknowledge "accepted without the check" alerts. |
| `20261124010000_orgs_roles.sql` | new: organizations, roles, memberships (invite and accept), permission checks, personal org per user. |
| `20261124020000_catalog.sql` | new: `channels` and `space_categories` lookup tables replace the fixed lists; amenities. |
| `20261124030000_property_intelligence.sql` | new: parcels, buildings, attributes with source and confidence, profile view, photos, rules, opportunities, third-party data with expiry. |
| `20261124040000_operations.sql` | new: pricing rules, expenses, revenue entries, maintenance tasks, messages. |
| `20261124050000_availability.sql` | new: space relations, shared resources, buffers, exclusion constraint, booking RPCs (`create_booking`, `cancel_booking`, `reschedule_booking`, `import_reservations`, `sync_calendar_import`), sync health. Reservation writes are RPC-only. |

The first 8 file names match the live migration history.

### Functions (`supabase/functions/`)

| Path | What it is |
|---|---|
| `calendar-sync` | Reads every connected calendar link every 15 minutes, or on "Sync now". Writes through `sync_calendar_import`; records health and backs off after failures. |
| `calendar-feed` | The link a host pastes into Airbnb, Vrbo and others. It never shows guest names or prices. |
| `booking-guard` | "Is it safe to accept this request?" Holds the dates, reads the instant site's calendar live, answers accept, close the dates first, or decline. |
| `booking-import` | new: a host uploads a CSV of reservations exported from a site; answers inserted, updated, cancelled and conflicts. |
| `_shared/ical.ts`, `sync.ts` | Read and write calendar files; decide what to save and what to publish. |
| `_shared/fetch.ts` | Safe fetch of host-pasted links: https only, public addresses only, redirects re-checked, size and time caps. |
| `_shared/guard.ts`, `door.ts` | The door checks behind "safe to accept". |
| `_shared/cors.ts` | Lets the Host Console call the functions from the browser. |
| `_shared/providers/` | new: adapter contract, registry, iCal adapter and manual CSV adapter. Only these two exist. |

### Other

| Path | What it is |
|---|---|
| `supabase/cron/calendar_sync.sql` | Schedules the sync, the daily revenue-share accrual and (new) the daily purge of expired third-party data. Run by hand, not a migration. |
| `scripts/staging.sh` | Local Postgres 16 staging cluster with every migration applied. |
| `tests/*.test.ts`, `*.test.mjs` | 231 tests in an in-memory Postgres (PGlite): schema, row-level security, no double booking, foundation, availability and SQL/JS parity, review-fix regressions, and handler, fetch, iCal, provider and sync tests. |
| `tests/staging/` | 16 race and replay tests on local Postgres 16 (`race`, `replay`, `review_race`). |
| `tests/helpers/` | PGlite helper and the Supabase auth stand-in. |

## Run the tests

```bash
npm install
```

```bash
npm test
```

231 pass. The staging run needs a local Postgres 16 and starts and stops its own cluster:

```bash
npm run test:staging
```

16 pass.

## Before applying to production

Nothing here has been applied. Do each step only with the owner's explicit yes.

1. Confirm `supabase migration list` matches the first 8 files (two were reconstructed).
2. Confirm the `btree_gist` extension can be created on the hosted project (it goes in `extensions`).
3. Confirm nothing outside this repo writes `reservations` with the service key. Direct writes are revoked, including for the service role, so such a writer would break.
4. Confirm hosted PostgREST sets the `role` setting the booking functions read (SQL-editor or cron calls must `set role service_role`), and confirm that relations now mean "mutual exclusion".
5. Apply the migrations (`supabase db push`).
6. Run `supabase/cron/calendar_sync.sql` by hand with the anon key filled in. It includes the new purge job; the purge is not part of any migration.
7. Deploy the functions last: `supabase functions deploy calendar-feed calendar-sync booking-guard booking-import`. Deploying them earlier breaks sync on the old schema.
8. Rollback: the live database had 0 user rows on 2026-11-24, so a failed apply puts no user data at risk today. Once real users exist, take a backup first (backup settings were not checked).

Anything that would cost money (a paid plan, a channel manager, Stripe, AI model usage, a domain) is listed in [../docs/costs.md](../docs/costs.md) and waits for approval.

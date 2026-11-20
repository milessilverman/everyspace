# Everyspace platform

The backend for the [Everyspace Host Console](../host/). It runs on Supabase's free plan: Postgres, Auth, Edge Functions and pg_cron. The game plan is in [docs/PLAN.md](docs/PLAN.md).

**Live:** Supabase project `everyspace` (`hnzcwfvxpfsyjpbebevp`, West US, free plan). Functions are at `https://hnzcwfvxpfsyjpbebevp.supabase.co/functions/v1/<name>`.

## What's here

| Path | What it is |
|---|---|
| `supabase/migrations/20261116000000_init.sql` | Hosts, properties, spaces (with parent spaces for whole house vs room), site connections, calendar links in and out, reservations, double-booking detection, revenue-share ledger. Row-level security on every table. |
| `supabase/functions/_shared/ical.ts` | Reads and writes calendar files. Handles time zones and daylight saving, Airbnb's "Not available" blocks and line folding. |
| `supabase/functions/_shared/sync.ts` | Decides what to save when a site's calendar is read, and what to publish when a site reads ours. |
| `supabase/functions/calendar-sync` | Reads a bounded batch of calendar links on the existing schedule or when a host requests a refresh. Current booking records are preserved when a read fails. |
| `supabase/functions/calendar-feed` | Publishes recorded busy times for compatible provider calendars. Providers apply updates on their own schedules. It excludes guest names and prices. |
| `supabase/migrations/20261116010000_no_double_booking.sql` | The no-double-booking rules: one instant site per space, date holds under a lock, the guard, and alerts. |
| `supabase/functions/_shared/cors.ts` | Lets the Host Console call the functions from the browser. Access still depends on the login token. |
| `supabase/functions/booking-guard` | Places unit holds and checks known availability under the property lock. The host verifies provider availability before accepting. |
| `supabase/functions/booking-email` | Parses host-submitted forwarded messages, queues review, and records host-verified external confirmations. |
| `supabase/cron/calendar_sync.sql` | Schedules the sync and the daily revenue-share accrual. Run it once after deploying. Already done on the live project. |
| `supabase/functions/channel-reservations` | Provider webhook and worker entry points, with disabled Airbnb and Vrbo transports pending partner access. |
| `tests/` | Platform tests, including the full schema in Postgres, row-level security, and separate-session concurrency. |

See [universal rental management](docs/UNIVERSAL_CHANNELS.md) for the catalog, email workflow and rollout limits. See [Airbnb and Vrbo reservation connectivity](docs/CHANNEL_RESERVATIONS.md) for verified provider capabilities, onboarding and local testing.

The [technical audit](docs/TECHNICAL_AUDIT.md) records the verified tests and staging requirements. The [provider audit](docs/PROVIDER_AUDIT.md) covers all 22 channels, access requirements and the Swimply strategy.

The [staging and pilot runbook](docs/STAGING_PILOT.md) covers the isolated rehearsal, operational warnings, rollback and approvals. The [Swimply read-only calendar plan](docs/SWIMPLY_READ_ONLY.md) documents the host calendar connection, authorization, latency measurements and costs.

## Run the tests

```bash
npm install
```

```bash
npm test
```

Run the isolated staging rehearsal from the repository root as described in the runbook.

```bash
npm ci --prefix platform
npm run test:staging --prefix platform
```

## Deploy after approval

1. Create a Supabase project on the free plan in the West US region.
2. Apply the database migration:

   ```bash
   supabase link --project-ref <ref>
   ```

   ```bash
   supabase db push
   ```

3. Deploy the calendar, booking guard and forwarded-email functions:

   ```bash
   supabase functions deploy calendar-feed calendar-sync booking-guard booking-email
   ```

4. Schedule the jobs:
   - In the SQL editor, run `supabase/cron/calendar_sync.sql` with the project's anon key filled in.
   - It creates its own random secret in Vault, so no master key is ever copied anywhere.

Review staging usage, plan limits and costs before approving a rollout. A paid plan, channel manager, Stripe, model usage or domain needs founder approval.

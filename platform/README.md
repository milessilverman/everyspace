# Everyspace platform

The real backend behind the Everyspace demo (`../everyspace__1-1.html`). It runs on Supabase's free plan: Postgres, Auth, Edge Functions and pg_cron. The game plan is in [docs/PLAN.md](docs/PLAN.md).

**Live:** Supabase project `everyspace` (`hnzcwfvxpfsyjpbebevp`, West US, free plan). Functions are at `https://hnzcwfvxpfsyjpbebevp.supabase.co/functions/v1/<name>`.

## What's here

| Path | What it is |
|---|---|
| `supabase/migrations/20261116000000_init.sql` | Hosts, properties, spaces (with parent spaces for whole house vs room), site connections, calendar links in and out, reservations, double-booking detection, revenue-share ledger. Row-level security on every table. |
| `supabase/functions/_shared/ical.ts` | Reads and writes calendar files. Handles time zones and daylight saving, Airbnb's "Not available" blocks and line folding. |
| `supabase/functions/_shared/sync.ts` | Decides what to save when a site's calendar is read, and what to publish when a site reads ours. |
| `supabase/functions/calendar-sync` | Reads every connected calendar link. Runs every 15 minutes, or when a host taps "Sync now". |
| `supabase/functions/calendar-feed` | The link a host pastes into Airbnb, Vrbo and others, so a booking anywhere blocks the dates everywhere. It never shows guest names or prices. |
| `supabase/migrations/20261116010000_no_double_booking.sql` | The no-double-booking rules: one instant site per space, date holds under a lock, the guard, and alerts. |
| `supabase/functions/_shared/cors.ts` | Lets the Host Console call the functions from the browser. Access still depends on the login token. |
| `supabase/functions/booking-guard` | "Is it safe to accept this request?" Holds the dates, reads the instant site's calendar live, and answers accept, close the dates first, or decline. |
| `supabase/cron/calendar_sync.sql` | Schedules the sync and the daily revenue-share accrual. Run it once after deploying. Already done on the live project. |
| `tests/` | 34 tests, including the full schema run in an in-memory Postgres with row-level security checks. |

## Run the tests

```bash
npm install
```

```bash
npm test
```

## Deploy (free plan, $0)

1. Create a Supabase project on the free plan in the West US region.
2. Apply the database migration:

   ```bash
   supabase link --project-ref <ref>
   ```

   ```bash
   supabase db push
   ```

3. Deploy the three functions:

   ```bash
   supabase functions deploy calendar-feed calendar-sync booking-guard
   ```

4. Schedule the jobs:
   - In the SQL editor, run `supabase/cron/calendar_sync.sql` with the project's anon key filled in.
   - It creates its own random secret in Vault, so no master key is ever copied anywhere.

Everything above stays inside the free plan's limits. Anything that would cost money (a paid plan, a channel manager, Stripe, AI model usage, a domain) is listed in the plan and waits for approval.

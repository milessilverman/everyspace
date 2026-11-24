-- Runs once, after the functions are deployed. Everything here is free on Supabase (pg_cron, pg_net, Vault).
create extension if not exists pg_net schema extensions; -- keep it out of the public schema (security advisor)
create extension if not exists pg_cron;

-- A random secret that never leaves the database; calendar-sync checks it with public.check_cron_secret().
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'calendar_sync_cron_secret',
  'Lets the 15-minute schedule call calendar-sync');

-- Read every connected calendar every 15 minutes. The Authorization header carries the project's public (anon) key,
-- which only gets past the gateway; the cron secret is what grants access to all hosts' calendars.
select cron.schedule('calendar-sync-every-15-min', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://hnzcwfvxpfsyjpbebevp.supabase.co/functions/v1/calendar-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <anon key>',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'calendar_sync_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
$$);

-- Revenue share: add finished stays to the ledger once a day (2:17 AM Los Angeles time).
select cron.schedule('accrue-earnings-daily', '17 9 * * *', $$ select public.accrue_earnings(); $$);

-- Restricted provider data (ADR 9): delete rows past expires_at once a day (3:23 AM Los Angeles time). The read policy
-- already hides expired rows; this removes them. Guarded so re-running this script does not add a second job.
select cron.schedule('purge-expired-provider-data-daily', '23 11 * * *', $$ select public.purge_expired_provider_data(); $$)
where not exists (select 1 from cron.job where jobname = 'purge-expired-provider-data-daily')
  and exists (select 1 from pg_proc where proname = 'purge_expired_provider_data' and pronamespace = 'public'::regnamespace);

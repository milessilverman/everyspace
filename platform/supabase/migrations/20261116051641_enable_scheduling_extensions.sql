-- Mirrors the live-only migration of the same version (applied by hand on the hosted project; see
-- supabase/cron/calendar_sync.sql). pg_cron schedules calendar-sync and accrue-earnings; pg_net makes the HTTP call.
-- Guarded: a no-op where the extensions are not installed or cannot be created (PGlite, plain local Postgres 16),
-- so a fresh database replays the same history as live.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    begin
      create schema if not exists extensions;
      execute 'create extension if not exists pg_net schema extensions';
    exception when others then
      raise notice 'pg_net not enabled here: %', sqlerrm;
    end;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      execute 'create extension if not exists pg_cron';
    exception when others then -- needs shared_preload_libraries; absent on local staging
      raise notice 'pg_cron not enabled here: %', sqlerrm;
    end;
  end if;
end $$;

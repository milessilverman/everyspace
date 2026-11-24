-- Mirrors the live-only migration of the same version: keep pg_net out of the public schema (security advisor).
-- pg_net is not relocatable, so it is dropped and recreated in `extensions`. A no-op where pg_net is not installed.
do $$
begin
  if exists (select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
             where e.extname = 'pg_net' and n.nspname <> 'extensions') then
    create schema if not exists extensions;
    execute 'drop extension pg_net';
    execute 'create extension pg_net schema extensions';
  end if;
end $$;

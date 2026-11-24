-- Stand-in for what Supabase provides before any migration runs: the API roles, the auth schema with auth.users and
-- auth.uid(), and Supabase's default privileges (every new table and function in public is granted to anon,
-- authenticated and service_role; access is then narrowed by RLS and by the REVOKEs in the migrations).
-- Used by the PGlite test helper (tests/helpers/db.mjs) and by the local Postgres 16 staging runner (scripts/staging.sh).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

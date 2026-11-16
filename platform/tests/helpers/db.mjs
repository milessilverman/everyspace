// An in-memory Postgres (PGlite) with a stand-in for Supabase's auth schema and every migration applied.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const AUTH_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
`;

export async function freshDb() {
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  for (const f of readdirSync(new URL('../../supabase/migrations/', import.meta.url)).sort()) {
    await db.exec(readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8'));
  }
  await db.exec(`grant usage on schema public to anon, authenticated; grant select, insert, update, delete on all tables in schema public to authenticated;`);
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  return { db, one };
}

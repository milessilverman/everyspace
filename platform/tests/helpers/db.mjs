// An in-memory Postgres (PGlite) with a stand-in for Supabase's auth schema and every migration applied.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const AUTH_STUB = readFileSync(new URL('./auth_stub.sql', import.meta.url), 'utf8');
const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
export const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

// Optional `pause`: { before: '<version prefix>', run: async (db) => {} } runs `run` just before the first migration
// whose file name sorts at or after `before` (used to seed legacy data and prove the backfill).
export async function freshDb({ pause } = {}) {
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  let paused = false;
  for (const f of migrationFiles()) {
    if (pause && !paused && f >= pause.before) { paused = true; await pause.run(db); }
    try {
      await db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    } catch (e) {
      e.message = `${f}: ${e.message}`;
      throw e;
    }
  }
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  return { db, one };
}

// Run fn as a signed-in user (or anon when user is null), then return to the superuser.
export async function as(db, user, fn) {
  await db.exec(user
    ? `set role authenticated; select set_config('request.jwt.claim.sub', '${user}', false);`
    : `set role anon; select set_config('request.jwt.claim.sub', '', false);`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}

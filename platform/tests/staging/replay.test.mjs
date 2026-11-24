// Runs against the local Postgres 16 staging cluster created by scripts/staging.sh (npm run test:staging).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import pg from 'pg';

const envFile = new URL('../../.staging/env', import.meta.url);
const url = process.env.DATABASE_URL ?? readFileSync(envFile, 'utf8').trim().replace(/^DATABASE_URL=/, '');
const files = readdirSync(new URL('../../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
let client;

before(async () => { client = new pg.Client({ connectionString: url }); await client.connect(); });
after(async () => { await client?.end(); });

test('runs on Postgres 16', async () => {
  const { rows } = await client.query(`select current_setting('server_version_num')::int as v`);
  assert.ok(rows[0].v >= 160000 && rows[0].v < 170000, `server_version_num ${rows[0].v}`);
});

test('every migration file was applied, in order', async () => {
  const { rows } = await client.query(`select version || '_' || name || '.sql' as f from supabase_migrations.schema_migrations order by version`);
  assert.deepEqual(rows.map((r) => r.f), files);
});

test('row-level security is enabled on every public table', async () => {
  const { rows: all } = await client.query(`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p')`);
  assert.ok(all[0].n >= 34, `found ${all[0].n} tables`);
  const { rows } = await client.query(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity`);
  assert.deepEqual(rows, []);
});

test('the channel enum is gone and the lookups are seeded', async () => {
  const { rows } = await client.query(`select (select count(*)::int from pg_type where typname = 'channel' and typnamespace = 'public'::regnamespace) as enum_left,
    (select count(*)::int from public.channels) as channels, (select count(*)::int from public.roles) as roles,
    (select count(*)::int from public.space_categories) as cats`);
  assert.deepEqual(rows[0], { enum_left: 0, channels: 19, roles: 5, cats: 43 });
});

test('the legacy Host Console path works on real Postgres: personal org, property with only host_id', async () => {
  await client.query('begin');
  try {
    const id = '99999999-9999-9999-9999-999999999999';
    await client.query(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name":"Stage"}')`, [id]);
    await client.query(`set local role authenticated`);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [id]);
    const { rows } = await client.query(`insert into public.properties (host_id, title) values ($1, 'Staging place') returning org_id`, [id]);
    const { rows: org } = await client.query(`select kind from public.organizations where id = $1`, [rows[0].org_id]);
    assert.equal(org[0].kind, 'personal');
  } finally {
    await client.query('rollback');
  }
});

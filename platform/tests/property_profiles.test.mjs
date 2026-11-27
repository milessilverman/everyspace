// Property profile cache and provider budget: storage, expiry, privileges, tenant visibility.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as } from './helpers/db.mjs';

const MAYA = '11111111-1111-1111-1111-111111111111'; // owner of org A
const SAM = '22222222-2222-2222-2222-222222222222'; // owner of org B
const NOBODY = '66666666-6666-6666-6666-666666666666'; // signed in, no membership anywhere
let db, one, propA, propB;

const STORE = `select public.store_property_profile($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11) as id`;
const args = (key, over = {}) => [key, over.place ?? null, over.apn ?? null, over.fips ?? null, over.address ?? key, 34.1, -118.2,
  JSON.stringify(over.profile ?? { address: key, lot_sqft: 6000 }), JSON.stringify(over.providers ?? [{ id: 'county', status: 'used' }]),
  'v1', over.exp ?? new Date(Date.now() + 30 * 864e5).toISOString()];
const svc = async (fn) => { await db.exec('set role service_role'); try { return await fn(); } finally { await db.exec('reset role'); } };
const stored = (key, over) => svc(() => one(STORE, args(key, over)));
const cached = (key, place = null) => svc(async () => (await one(`select public.get_cached_property_profile($1, $2) as c`, [key, place])).c);

before(async () => {
  ({ db, one } = await freshDb());
  await db.query(`insert into auth.users (id) values ($1), ($2), ($3)`, [MAYA, SAM, NOBODY]);
  propA = (await one(`insert into public.properties (host_id, title) values ($1, 'A') returning id`, [MAYA])).id;
  propB = (await one(`insert into public.properties (host_id, title) values ($1, 'B') returning id`, [SAM])).id;
});

test('store then get round-trips the profile, providers and expiry', async () => {
  const { id } = await stored('10 main st, la', { place: 'pl-1', apn: '123', fips: '06037', providers: [{ id: 'rentcast', status: 'used', retentionDays: 30 }] });
  assert.match(id, /^[0-9a-f-]{36}$/);
  const c = await cached('10 main st, la');
  assert.equal(c.id, id);
  assert.deepEqual(c.profile, { address: '10 main st, la', lot_sqft: 6000 });
  assert.deepEqual(c.providers, [{ id: 'rentcast', status: 'used', retentionDays: 30 }]);
  assert.equal(c.model_version, 'v1');
  assert.ok(new Date(c.expires_at) > new Date());
  assert.equal((await cached('10 main st, la', 'other-place')).id, id, 'address key still matches');
  assert.equal((await cached('different key', 'pl-1')).id, id, 'place_id matches');
  assert.equal(await cached('nothing here', 'pl-none'), null);
  assert.equal(await cached('nothing here'), null);
});

test('upsert replaces by address_key and keeps one row', async () => {
  const a = (await stored('20 oak ave', { profile: { v: 1 } })).id;
  const b = (await stored('20 oak ave', { profile: { v: 2 }, place: 'pl-2' })).id;
  assert.equal(a, b);
  assert.equal((await one(`select count(*)::int as n from public.property_profiles where address_key = '20 oak ave'`)).n, 1);
  assert.deepEqual((await cached('20 oak ave')).profile, { v: 2 });
});

test('a re-store keeps an existing owner claim', async () => {
  const { id } = await stored('30 elm rd');
  await db.query(`update public.property_profiles set property_id = $1 where id = $2`, [propA, id]);
  await stored('30 elm rd', { profile: { v: 9 } });
  assert.equal((await one(`select property_id from public.property_profiles where id = $1`, [id])).property_id, propA);
});

test('expired rows are not returned and are purged; live rows stay', async () => {
  await stored('40 gone st');
  await stored('41 live st');
  await db.query(`update public.property_profiles set created_at = now() - interval '3 days', expires_at = now() - interval '1 day' where address_key = '40 gone st'`);
  assert.equal(await cached('40 gone st'), null);
  const n = await svc(async () => (await one(`select public.purge_expired_property_profiles() as n`)).n);
  assert.ok(n >= 1);
  assert.equal((await one(`select count(*)::int as n from public.property_profiles where address_key = '40 gone st'`)).n, 0);
  assert.ok(await cached('41 live st'));
  // After expiry, storing the same key again works (the old row was purged or is replaced).
  await stored('40 gone st');
  assert.ok(await cached('40 gone st'));
});

test('constraints: object profile, expiry after creation and in the future, key rules, bad coordinates', async () => {
  const bad = (over, re) => svc(() => assert.rejects(one(STORE, args('50 bad st', over)), re));
  await bad({ profile: [1, 2] }, /check|violates/i);
  await bad({ exp: new Date(Date.now() - 1000).toISOString() }, /expires_at must be in the future/);
  await assert.rejects(db.query(`insert into public.property_profiles (address_key, address, profile, model_version, expires_at) values ('Upper Case St', 'x st', '{}', 'v', now() + interval '1 day')`), /check/);
  await assert.rejects(db.query(`insert into public.property_profiles (address_key, address, profile, model_version, created_at, expires_at) values ('51 x st', 'x st', '{}', 'v', now(), now() - interval '1 day')`), /check/);
  await assert.rejects(db.query(`insert into public.property_profiles (address_key, address, profile, model_version, expires_at, lat) values ('52 x st', 'x st', '{}', 'v', now() + interval '1 day', 91)`), /check/);
  await assert.rejects(db.query(`insert into public.property_profiles (address_key, address, profile, model_version, expires_at) values ('53 x st', 'x st', null, 'v', now() + interval '1 day')`), /null/);
  await assert.rejects(db.query(`insert into public.property_profiles (address_key, address, profile, model_version, expires_at, county_fips) values ('54 x st', 'x st', '{}', 'v', now() + interval '1 day', '6037')`), /check/);
  await assert.rejects(db.query(`insert into public.provider_usage (provider, day, calls) values ('Bad Name', current_date, 1)`), /check/);
  await assert.rejects(db.query(`insert into public.provider_usage (provider, day, calls) values ('ok', current_date, -1)`), /check/);
});

test('anon and signed-in users cannot touch either table or call any function', async () => {
  const sqls = [
    `select count(*) from public.provider_usage`,
    `insert into public.provider_usage (provider, day, calls) values ('x', current_date, 1)`,
    `update public.provider_usage set calls = 0`,
    `delete from public.provider_usage`,
    `insert into public.property_profiles (address_key, address, profile, model_version, expires_at) values ('60 x st', 'x st', '{}', 'v', now() + interval '1 day')`,
    `update public.property_profiles set address = 'pwned'`,
    `delete from public.property_profiles`,
    `select public.reserve_provider_call('rentcast', 100)`,
    `select public.get_cached_property_profile('10 main st, la', null)`,
    `select public.purge_expired_property_profiles()`,
    `select public.store_property_profile('61 x st', null, null, null, 'x st', null, null, '{}', '[]', 'v', now() + interval '1 day')`,
    `select public.assert_service_caller()`,
  ];
  for (const who of [null, MAYA, NOBODY]) {
    await as(db, who, async () => {
      for (const q of sqls) await assert.rejects(db.query(q), /permission denied/, `${who ?? 'anon'}: ${q}`);
      // Anon cannot even read the profile table; a signed-in user sees zero unclaimed rows.
      if (who === NOBODY) assert.equal((await one(`select count(*)::int as n from public.property_profiles`)).n, 0);
      else if (who === null) await assert.rejects(db.query(`select count(*) from public.property_profiles`), /permission denied/);
    });
  }
  // Defence in depth: even if EXECUTE were granted to an API role, the in-function caller check refuses it.
  await db.exec(`grant execute on function public.reserve_provider_call(text, int) to authenticated`);
  try {
    await as(db, MAYA, () => assert.rejects(db.query(`select public.reserve_provider_call('rentcast', 100)`), /service role only/));
  } finally { await db.exec(`revoke execute on function public.reserve_provider_call(text, int) from authenticated`); }
});

test('a member reads only non-expired profiles claimed for their own property', async () => {
  const mk = async (key, prop) => { const { id } = await stored(key); await db.query(`update public.property_profiles set property_id = $1 where id = $2`, [prop, id]); return id; };
  await db.query(`delete from public.property_profiles`);
  const a = await mk('70 a st', propA);
  const b = await mk('71 b st', propB);
  const old = await mk('72 old st', propA);
  await db.query(`update public.property_profiles set created_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id = $1`, [old]);
  const ids = async (u) => as(db, u, async () => (await db.query(`select id from public.property_profiles order by id`)).rows.map((r) => r.id));
  assert.deepEqual(await ids(MAYA), [a]);
  assert.deepEqual(await ids(SAM), [b]);
  assert.deepEqual(await ids(NOBODY), []);
});

test('reserve_provider_call: cap 0 or less is always false and counts nothing', async () => {
  await svc(async () => {
    for (const cap of [0, -5, null]) assert.equal((await one(`select public.reserve_provider_call('rentcast', $1) as ok`, [cap])).ok, false);
    assert.equal((await one(`select count(*)::int as n from public.provider_usage where provider = 'rentcast'`)).n, 0);
  });
});

test('reserve_provider_call: exact boundary, then refusals that do not change the count', async () => {
  await svc(async () => {
    const got = [];
    for (let i = 0; i < 6; i++) got.push((await one(`select public.reserve_provider_call('solar', 3) as ok`)).ok);
    assert.deepEqual(got, [true, true, true, false, false, false]);
    assert.equal((await one(`select calls from public.provider_usage where provider = 'solar' and day = (now() at time zone 'utc')::date`)).calls, 3);
    // Raising the cap lets the next call through; another provider is independent.
    assert.equal((await one(`select public.reserve_provider_call('solar', 4) as ok`)).ok, true);
    assert.equal((await one(`select public.reserve_provider_call('rentcast', 1) as ok`)).ok, true);
    assert.equal((await one(`select public.reserve_provider_call('rentcast', 1) as ok`)).ok, false);
  });
});

test('reserve_provider_call: a new UTC day starts from zero (yesterday\'s full counter does not block today)', async () => {
  await db.query(`insert into public.provider_usage (provider, day, calls) values ('daily', (now() at time zone 'utc')::date - 1, 50)`);
  await svc(async () => {
    assert.equal((await one(`select public.reserve_provider_call('daily', 50) as ok`)).ok, true);
  });
  const rows = (await db.query(`select (day = (now() at time zone 'utc')::date) as today, calls from public.provider_usage where provider = 'daily' order by day`)).rows;
  assert.deepEqual(rows, [{ today: false, calls: 50 }, { today: true, calls: 1 }]);
});

test('the budget is one atomic upsert statement (no read-then-write)', async () => {
  const { src } = await one(`select pg_get_functiondef('public.reserve_provider_call(text,int)'::regprocedure) as src`).then((r) => ({ src: r.src }));
  assert.match(src, /on conflict \(provider, day\) do update set calls = u\.calls \+ 1 where u\.calls < p_daily_cap\s+returning/i);
  assert.doesNotMatch(src, /select[^;]*calls[^;]*from public\.provider_usage/i);
  // Sequential over-cap loop: never exceeds the cap however many calls arrive.
  await svc(async () => {
    let ok = 0;
    for (let i = 0; i < 25; i++) if ((await one(`select public.reserve_provider_call('loop', 10) as ok`)).ok) ok++;
    assert.equal(ok, 10);
  });
  // Both queries in flight together still respect the cap (PGlite serialises them; Postgres row locks do the same).
  await svc(async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => one(`select public.reserve_provider_call('par', 5) as ok`)));
    assert.equal(rs.filter((r) => r.ok).length, 5);
  });
});

test('every function is security definer with an empty search_path and closed to PUBLIC, anon and signed-in users', async () => {
  const names = ['assert_service_caller', 'reserve_provider_call', 'store_property_profile', 'get_cached_property_profile', 'purge_expired_property_profiles'];
  const rows = (await db.query(`select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon,
    has_function_privilege('authenticated', p.oid, 'execute') as authn, has_function_privilege('service_role', p.oid, 'execute') as svc
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1) order by 1`, [names])).rows;
  assert.equal(rows.length, names.length);
  for (const r of rows) {
    assert.ok(r.prosecdef, r.proname);
    assert.ok(r.proconfig.includes('search_path=""'), r.proname);
    assert.equal(r.anon || r.authn, false, `${r.proname} anon=${r.anon} authn=${r.authn}`);
    assert.equal(r.svc, r.proname !== 'assert_service_caller', r.proname);
  }
});

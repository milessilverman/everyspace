// M5 availability engine on PGlite: create_booking, import_reservations, RPC-only writes, the exclusion constraint,
// detect_conflicts on the new rules, and sync_health. This file loads btree_gist into PGlite so the exclusion
// constraint exists here too (the shared helper's PGlite has no extensions, and the migration skips it there).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { migrationFiles, as } from './helpers/db.mjs';

const MAYA = '11111111-1111-1111-1111-111111111111'; // owner of org A
const SAM = '22222222-2222-2222-2222-222222222222'; // another tenant
const VIC = '33333333-3333-3333-3333-333333333333'; // viewer in A
const OLI = '44444444-4444-4444-4444-444444444444'; // operator in A (booking.write)
let db, one, org, prop, house, room1, room2, lawn, pool, kayaks, adu;

async function freshDbWithGist() {
  const d = new PGlite({ extensions: { btree_gist } });
  await d.exec(readFileSync(new URL('./helpers/auth_stub.sql', import.meta.url), 'utf8'));
  for (const f of migrationFiles()) {
    try { await d.exec(readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8')); }
    catch (e) { e.message = `${f}: ${e.message}`; throw e; }
  }
  return d;
}

const book = (space, s, e, extra = {}) => one(
  `select public.create_booking($1, $2, $3, p_kind => $4, p_guest_name => $5) as id`, [space, s, e, extra.kind ?? 'booking', extra.guest ?? null]).then((r) => r.id);
const imp = (space, channel, rows, source = 'ical') => one(
  `select public.import_reservations($1, $2, $3::jsonb, $4) as r`, [space, channel, JSON.stringify(rows), source]).then((r) => r.r);
const n = async (sql, params) => (await one(sql, params)).n;

before(async () => {
  db = await freshDbWithGist();
  one = async (sql, params) => (await db.query(sql, params)).rows[0];
  await db.query(`insert into auth.users (id) values ($1), ($2), ($3), ($4)`, [MAYA, SAM, VIC, OLI]);
  org = (await one(`select id from public.organizations where created_by = $1`, [MAYA])).id;
  await db.query(`insert into public.memberships (org_id, user_id, role_key) values ($1, $2, 'viewer'), ($1, $3, 'operator')`, [org, VIC, OLI]);
  prop = (await one(`insert into public.properties (host_id, title) values ($1, 'Maple St') returning id`, [MAYA])).id;
  const sp = (title, cat, extra = {}) => one(`insert into public.spaces (property_id, category, title, parent_space_id, quantity, cleanup_minutes)
    values ($1, $2, $3, $4, $5, $6) returning id`, [prop, cat, title, extra.parent ?? null, extra.qty ?? 1, extra.cleanup ?? 0]).then((r) => r.id);
  house = await sp('Whole house', 'entire_home', { cleanup: 120 });
  room1 = await sp('Garden room', 'private_room', { parent: house });
  room2 = await sp('Loft room', 'private_room', { parent: house });
  lawn = await sp('Lawn', 'other');
  pool = await sp('Pool', 'pool');
  kayaks = await sp('Kayaks', 'kayak', { qty: 2 });
  adu = await sp('ADU', 'adu');
  await db.query(`insert into public.space_relations (space_id, blocks_space_id) values ($1, $2)`, [lawn, pool]);
});

test('the exclusion constraint exists and refuses a raw overlapping exclusive insert; imported facts may overlap', async () => {
  assert.equal(await n(`select count(*)::int as n from pg_constraint where conname = 'reservations_exclusive_no_overlap'`), 1);
  const ins = (uid, s, e, exclusive) => db.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at, exclusive)
    values ($1, 'direct', $2, 'manual', $3, $4, $5)`, [adu, uid, s, e, exclusive]);
  await db.exec('begin');
  try {
    await ins('X1', '2028-01-01', '2028-01-05', true);
    await assert.rejects(ins('X2', '2028-01-04', '2028-01-06', true), (e) => e.code === '23P01');
  } finally { await db.exec('rollback'); }
  await db.exec('begin');
  try {
    await ins('X1', '2028-01-01', '2028-01-05', true);
    await ins('X3', '2028-01-05', '2028-01-06', true); // back-to-back is fine
    await ins('X4', '2028-01-02', '2028-01-03', false); // a reported fact is recorded
    await db.query(`update public.reservations set status = 'cancelled' where external_uid = 'X1'`);
    await ins('X5', '2028-01-02', '2028-01-04', true); // cancelled rows no longer hold the slot
  } finally { await db.exec('rollback'); }
});

test('create_booking: books a free slot exclusively, and refuses a taken one with the conflicts as JSON', async () => {
  const id = await as(db, MAYA, () => book(room1, '2027-03-01', '2027-03-04', { guest: 'Ana' }));
  assert.deepEqual(await one(`select exclusive, source, channel, kind, guest_name from public.reservations where id = $1`, [id]),
    { exclusive: true, source: 'everyspace', channel: 'everyspace', kind: 'booking', guest_name: 'Ana' });
  // The whole house overlaps the room booking.
  const err = await as(db, MAYA, () => book(house, '2027-03-03', '2027-03-06')).then(() => null, (e) => e);
  assert.ok(err, 'refused');
  assert.equal(err.code, '23P01');
  assert.match(err.message, /not available/);
  const detail = JSON.parse(err.detail);
  assert.deepEqual(detail.map((c) => [c.kind, c.reservation_id]), [['overlap', id]]);
  // House cleaning is 2 hours: a stay starting right at check-out of a house stay is a buffer conflict.
  const h = await as(db, MAYA, () => book(house, '2027-04-01', '2027-04-03'));
  const e2 = await as(db, MAYA, () => book(house, '2027-04-03', '2027-04-05')).then(() => null, (e) => e);
  assert.deepEqual(JSON.parse(e2.detail).map((c) => [c.kind, c.reservation_id]), [['buffer', h]]);
  // A sibling room on the same dates is independent; the lawn relation blocks the pool but not the other way.
  assert.ok(await as(db, MAYA, () => book(room2, '2027-03-01', '2027-03-04')));
  await as(db, MAYA, () => book(lawn, '2027-05-01 17:00Z', '2027-05-01 23:00Z'));
  await assert.rejects(as(db, MAYA, () => book(pool, '2027-05-01 18:00Z', '2027-05-01 19:00Z')), /not available/);
  // Quantity 2: two overlapping bookings fit, not exclusive; the third is refused for capacity.
  const k1 = await as(db, MAYA, () => book(kayaks, '2027-06-01 09:00Z', '2027-06-01 12:00Z'));
  await as(db, MAYA, () => book(kayaks, '2027-06-01 10:00Z', '2027-06-01 13:00Z'));
  assert.equal((await one(`select exclusive from public.reservations where id = $1`, [k1])).exclusive, false);
  const e3 = await as(db, MAYA, () => book(kayaks, '2027-06-01 11:00Z', '2027-06-01 11:30Z')).then(() => null, (e) => e);
  assert.deepEqual(JSON.parse(e3.detail).map((c) => c.kind), ['capacity', 'capacity']);
  await assert.rejects(as(db, MAYA, () => book(adu, '2027-07-02', '2027-07-01')), /end has to be after the start/);
  await assert.rejects(as(db, MAYA, () => book(adu, '2027-07-01', '2027-07-02', { kind: 'party' })), /Kind must be/);
});

test('create_booking permissions: other tenant and viewer refused, operator and service role allowed, anon cannot call', async () => {
  await assert.rejects(as(db, SAM, () => book(adu, '2027-08-01', '2027-08-02')), /Space not found/);
  await assert.rejects(as(db, VIC, () => book(adu, '2027-08-01', '2027-08-02')), /Space not found/);
  await assert.rejects(as(db, null, () => book(adu, '2027-08-01', '2027-08-02')), /permission denied/);
  assert.ok(await as(db, OLI, () => book(adu, '2027-08-01', '2027-08-02')));
  // Service role: explicitly allowed, with no user at all.
  await db.exec(`set role service_role; select set_config('request.jwt.claim.sub', '', false);`);
  try { assert.ok(await book(adu, '2027-08-03', '2027-08-04')); } finally { await db.exec('reset role'); }
  // A signed-in user can neither forge "no user" (empty sub) nor read another tenant's availability.
  await assert.rejects(as(db, SAM, () => db.query(`select * from public.availability_conflicts($1, '2027-08-01', '2027-08-02')`, [adu])), /Space not found/);
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '', false);`);
  try { await assert.rejects(book(adu, '2027-08-05', '2027-08-06'), /Space not found/); } finally { await db.exec('reset role'); }
  assert.equal((await as(db, VIC, () => db.query(`select * from public.availability_conflicts($1, '2027-08-01', '2027-08-02')`, [adu]))).rows.length, 1);
});

test('direct writes on reservations are refused for signed-in users; reads stay under RLS', async () => {
  await as(db, MAYA, async () => {
    await assert.rejects(db.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at)
      values ($1, 'direct', 'raw-1', 'manual', '2027-09-01', '2027-09-02')`, [adu]), /permission denied/);
    await assert.rejects(db.query(`update public.reservations set status = 'cancelled'`), /permission denied/);
    await assert.rejects(db.query(`delete from public.reservations`), /permission denied/);
    assert.ok(await n(`select count(*)::int as n from public.reservations`) > 0);
  });
  assert.equal(await as(db, SAM, () => n(`select count(*)::int as n from public.reservations`)), 0);
});

test('import_reservations is an idempotent upsert, and validates every row before writing', async () => {
  const rows = [
    { external_uid: 'HM-1', starts_at: '2027-10-01', ends_at: '2027-10-04', guest_count: 2, payout_cents: 45000 },
    { external_uid: 'HM-2', starts_at: '2027-10-10', ends_at: '2027-10-12', kind: 'block', all_day: true },
  ];
  assert.deepEqual(await as(db, OLI, () => imp(adu, 'airbnb', rows)), { inserted: 2, updated: 0, cancelled: 0, conflicts: [] });
  assert.deepEqual(await as(db, OLI, () => imp(adu, 'airbnb', rows)), { inserted: 0, updated: 0, cancelled: 0, conflicts: [] });
  const moved = [{ ...rows[0], ends_at: '2027-10-05' }, { ...rows[1], status: 'cancelled' }];
  assert.deepEqual(await as(db, OLI, () => imp(adu, 'airbnb', moved)), { inserted: 0, updated: 1, cancelled: 1, conflicts: [] });
  assert.deepEqual(await one(`select exclusive, source, guest_count, payout_cents::int as pay, ends_at = '2027-10-05'::timestamptz as moved
    from public.reservations where external_uid = 'HM-1'`), { exclusive: false, source: 'ical', guest_count: 2, pay: 45000, moved: true });
  const before = await n(`select count(*)::int as n from public.reservations`);
  for (const [bad, msg] of [
    [[{ external_uid: 'OK-1', starts_at: '2027-11-01', ends_at: '2027-11-02' }, { starts_at: '2027-11-01', ends_at: '2027-11-02' }], /Row 2: external_uid/],
    [[{ external_uid: 'B', starts_at: 'tomorrow', ends_at: '2027-11-02' }], /Row 1: starts_at and ends_at/],
    [[{ external_uid: 'B', starts_at: '2027-11-03', ends_at: '2027-11-02' }], /Row 1: the end has to be after/],
    [[{ external_uid: 'B', starts_at: '2027-11-01', ends_at: '2027-11-02', kind: 'party' }], /Row 1: kind/],
    [[{ external_uid: 'B', starts_at: '2027-11-01', ends_at: '2027-11-02', guest_count: 1.5 }], /Row 1: guest_count/],
    [[{ external_uid: 'B', starts_at: '2027-11-01', ends_at: '2027-11-02', payout_cents: -1 }], /Row 1: payout_cents/],
    [[{ external_uid: 'B', starts_at: '2027-11-01', ends_at: '2027-11-02' }, { external_uid: 'B', starts_at: '2027-11-03', ends_at: '2027-11-04' }], /appears twice/],
    ['not an array', /JSON array/],
  ]) {
    await assert.rejects(as(db, OLI, () => imp(adu, 'airbnb', bad)), msg);
  }
  await assert.rejects(as(db, OLI, () => imp(adu, 'nowhere', [])), /Unknown site/);
  await assert.rejects(as(db, OLI, () => imp(adu, 'airbnb', [], 'scraped')), /Source must be/);
  await assert.rejects(as(db, SAM, () => imp(adu, 'airbnb', rows)), /Space not found/);
  await assert.rejects(as(db, VIC, () => imp(adu, 'airbnb', rows)), /Space not found/);
  assert.equal(await n(`select count(*)::int as n from public.reservations`), before, 'nothing written');
});

test('an overlapping external booking is recorded, returned in conflicts and recorded in public.conflicts', async () => {
  const mine = await as(db, MAYA, () => book(adu, '2027-12-01', '2027-12-05'));
  const r = await as(db, OLI, () => imp(adu, 'vrbo', [{ external_uid: 'VR-9', starts_at: '2027-12-03', ends_at: '2027-12-06' }]));
  assert.equal(r.inserted, 1);
  assert.deepEqual(r.conflicts.map((c) => [c.external_uid, c.kind, c.conflicting_reservation_id]), [['VR-9', 'overlap', mine]]);
  const vr = (await one(`select id, status from public.reservations where external_uid = 'VR-9'`));
  assert.equal(vr.status, 'confirmed');
  const pair = [mine, vr.id].sort();
  assert.equal(await n(`select count(*)::int as n from public.conflicts where a_reservation_id = $1 and b_reservation_id = $2 and resolved_at is null`, pair), 1);
  // The marketplace cancels it: the conflict resolves.
  const c = await as(db, OLI, () => imp(adu, 'vrbo', [{ external_uid: 'VR-9', starts_at: '2027-12-03', ends_at: '2027-12-06', status: 'cancelled' }]));
  assert.deepEqual([c.cancelled, c.conflicts], [1, []]);
  assert.equal(await n(`select count(*)::int as n from public.conflicts where a_reservation_id = $1 and b_reservation_id = $2 and resolved_at is null`, pair), 0);
});

test('detect_conflicts is quantity-, relation- and resource-aware', async () => {
  const day = (h1, h2) => ({ starts_at: `2028-02-01T${h1}:00:00Z`, ends_at: `2028-02-01T${h2}:00:00Z` });
  // Quantity 2: two overlapping kayak rentals are fine, a third makes all of them conflict.
  await imp(kayaks, 'peerspace', [{ external_uid: 'K1', ...day('09', '12') }, { external_uid: 'K2', ...day('10', '13') }]);
  assert.equal(await n(`select public.detect_conflicts($1) as n`, [kayaks]), 0);
  const r = await imp(kayaks, 'peerspace', [{ external_uid: 'K3', ...day('11', '12') }]);
  assert.deepEqual(r.conflicts.map((c) => c.kind), ['capacity', 'capacity']);
  assert.equal(await n(`select count(*)::int as n from public.conflicts where space_id = $1 and resolved_at is null`, [kayaks]), 3);
  // Directional relation: an imported lawn party and a pool booking at the same time are flagged from either side.
  await imp(pool, 'swimply', [{ external_uid: 'SW-1', ...day('18', '20') }]);
  await imp(lawn, 'peerspace', [{ external_uid: 'PS-1', ...day('17', '23') }]);
  const pairs = async () => n(`select count(*)::int as n from public.conflicts c join public.reservations a on a.id = c.a_reservation_id
    join public.reservations b on b.id = c.b_reservation_id where 'SW-1' in (a.external_uid, b.external_uid) and 'PS-1' in (a.external_uid, b.external_uid) and c.resolved_at is null`);
  assert.equal(await pairs(), 1);
  // Shared bathroom between the two rooms.
  const bath = (await one(`insert into public.resources (property_id, name, capacity) values ($1, 'Bathroom', 1) returning id`, [prop])).id;
  await db.query(`insert into public.space_resources (space_id, resource_id) values ($1, $3), ($2, $3)`, [room1, room2, bath]);
  await imp(room1, 'airbnb', [{ external_uid: 'R1', starts_at: '2028-03-01', ends_at: '2028-03-03' }]);
  const rr = await imp(room2, 'booking_com', [{ external_uid: 'R2', starts_at: '2028-03-02', ends_at: '2028-03-04' }]);
  assert.deepEqual(rr.conflicts.map((c) => [c.kind, c.resource_id]), [['resource', bath]]);
  // Two pairs: R1/R2, and the two room bookings made in March 2027 before the bathroom was shared (adding a shared
  // resource later exposes clashes that already exist).
  assert.equal(await n(`select public.detect_conflicts($1) as n`, [room1]), 2);
});

test('place_hold uses the same rules: a relation or shared resource blocks a hold', async () => {
  await assert.rejects(one(`select public.place_hold($1, 'vrbo', '2028-02-01 18:30Z', '2028-02-01 19:30Z')`, [pool]), /already taken/);
  await assert.rejects(one(`select public.place_hold($1, 'vrbo', '2028-03-02', '2028-03-03')`, [room2]), /already taken/);
  assert.ok((await one(`select public.place_hold($1, 'vrbo', '2028-04-02', '2028-04-03') as id`, [room2])).id);
});

test('relations and resource links must stay within one property', async () => {
  const other = (await one(`insert into public.properties (host_id, title) values ($1, 'Elsewhere') returning id`, [MAYA])).id;
  const far = (await one(`insert into public.spaces (property_id, category, title) values ($1, 'pool', 'Far pool') returning id`, [other])).id;
  await assert.rejects(db.query(`insert into public.space_relations (space_id, blocks_space_id) values ($1, $2)`, [lawn, far]), /does not belong/);
  const res = (await one(`insert into public.resources (property_id, name, capacity) values ($1, 'Far parking', 1) returning id`, [other])).id;
  await assert.rejects(db.query(`insert into public.space_resources (space_id, resource_id) values ($1, $2)`, [lawn, res]), /does not belong/);
  await assert.rejects(db.query(`update public.spaces set property_id = $1 where id = $2`, [other, lawn]), /before moving it/);
  await assert.rejects(db.query(`insert into public.space_relations (space_id, blocks_space_id) values ($1, $1)`, [lawn]), /check constraint/);
});

test('sync_health: stale when never ok, last ok over 3 hours ago, or 3 failures in a row', async () => {
  const imports = {};
  for (const ch of ['airbnb', 'vrbo', 'swimply']) {
    imports[ch] = (await one(`insert into public.calendar_imports (space_id, channel, url) values ($1, $2, 'https://example.test/c.ics') returning id`, [adu, ch])).id;
  }
  const health = async (id) => one(`select stale, consecutive_failures as f, last_ok_at is not null as ok from public.sync_health where import_id = $1`, [id]);
  assert.deepEqual(await health(imports.airbnb), { stale: true, f: 0, ok: false }); // never ok
  // The sync function only writes last_status / last_synced_at; the counters follow.
  await db.query(`update public.calendar_imports set last_status = 'ok', last_synced_at = now() where id = $1`, [imports.airbnb]);
  assert.deepEqual(await health(imports.airbnb), { stale: false, f: 0, ok: true });
  for (let i = 0; i < 3; i++) {
    await db.query(`update public.calendar_imports set last_status = 'error', last_synced_at = now() + $2 * interval '1 second' where id = $1`, [imports.airbnb, i + 1]);
  }
  assert.deepEqual(await health(imports.airbnb), { stale: true, f: 3, ok: true });
  await db.query(`update public.calendar_imports set last_status = 'ok', last_synced_at = now() + interval '5 seconds' where id = $1`, [imports.airbnb]);
  assert.deepEqual(await health(imports.airbnb), { stale: false, f: 0, ok: true });
  await db.query(`update public.calendar_imports set last_status = 'ok', last_synced_at = now() - interval '4 hours' where id = $1`, [imports.vrbo]);
  assert.deepEqual(await health(imports.vrbo), { stale: true, f: 0, ok: true }); // last ok 4 hours ago
  // A writer that manages the counters itself is not overridden.
  await db.query(`update public.calendar_imports set last_status = 'error', consecutive_failures = 7 where id = $1`, [imports.swimply]);
  assert.deepEqual(await health(imports.swimply), { stale: true, f: 7, ok: false });
  // Runs as the caller: calendar links are readable only with space.write, so a viewer sees no rows.
  assert.equal(await as(db, VIC, () => n(`select count(*)::int as n from public.sync_health`)), 0);
  assert.equal(await as(db, MAYA, () => n(`select count(*)::int as n from public.sync_health`)), 3);
});

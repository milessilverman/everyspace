// Two-connection regression tests for review findings 1, 2 and 5 on the local Postgres 16 staging cluster
// (npm run test:staging). Each test holds one transaction open while the other connection runs, so the interleaving
// is forced rather than left to chance, and then checks the final table state.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const envFile = new URL('../../.staging/env', import.meta.url);
const url = process.env.DATABASE_URL ?? readFileSync(envFile, 'utf8').trim().replace(/^DATABASE_URL=/, '');
const USER = randomUUID();
let admin, c1, c2, propA, propB;
const q1 = async (c, sql, params) => (await c.query(sql, params)).rows[0];
const settle = (p) => p.then((r) => ({ ok: true, rows: r.rows }), (e) => ({ ok: false, code: e.code, message: e.message }));
const space = async (title, prop = propA, parent = null) => (await q1(admin,
  `insert into public.spaces (property_id, category, title, parent_space_id) values ($1, 'other', $2, $3) returning id`, [prop, title, parent])).id;
const asUser = async (c) => { await c.query('begin'); await c.query('set local role authenticated'); await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [USER]); };
const asService = async (c) => { await c.query('begin'); await c.query('set local role service_role'); };
const confirmed = async (spaces, s, e) => (await admin.query(`select id, space_id from public.reservations where space_id = any($1) and status = 'confirmed'
  and tstzrange(starts_at, ends_at) && tstzrange($2, $3)`, [spaces, s, e])).rows;
// Has c's backend started waiting on a lock? (so the interleaving is the one we mean)
async function waitsOnLock(c) {
  const pid = (await q1(c, 'select pg_backend_pid() as pid')).pid;
  return async () => {
    for (let i = 0; i < 100; i++) {
      const r = await q1(admin, `select wait_event_type from pg_stat_activity where pid = $1`, [pid]);
      if (r?.wait_event_type === 'Lock') return true;
      await new Promise((res) => setTimeout(res, 20));
    }
    return false;
  };
}

before(async () => {
  admin = new pg.Client({ connectionString: url }); c1 = new pg.Client({ connectionString: url }); c2 = new pg.Client({ connectionString: url });
  await Promise.all([admin.connect(), c1.connect(), c2.connect()]);
  await admin.query(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name":"Review race"}')`, [USER]);
  propA = (await q1(admin, `insert into public.properties (host_id, title) values ($1, 'Review A') returning id`, [USER])).id;
  propB = (await q1(admin, `insert into public.properties (host_id, title) values ($1, 'Review B') returning id`, [USER])).id;
});
after(async () => { await Promise.all([c1, c2, admin].map((c) => c?.end().catch(() => {}))); });

test('finding 2: a parent cannot move away from its child, so Room and House can no longer both commit', async () => {
  const house = await space('House'), room = await space('Room', propA, house);
  await assert.rejects(admin.query(`update public.spaces set property_id = $1 where id = $2`, [propB, house]), /same property|cannot move/);
  const s = '2029-02-10', e = '2029-02-15';
  await asUser(c1); await asUser(c2);
  await c1.query(`select public.create_booking($1, $2, $3)`, [room, s, e]);
  const blocked = await waitsOnLock(c2);
  const p2 = settle(c2.query(`select public.create_booking($1, '2029-02-11', '2029-02-12')`, [house]));
  assert.ok(await blocked(), 'the house booking waits for the room booking (one lock for the family)');
  await c1.query('commit');
  const r2 = await p2; await c2.query(r2.ok ? 'commit' : 'rollback');
  assert.equal(r2.ok, false); assert.equal(r2.code, '23P01');
  assert.equal((await confirmed([house, room], s, e)).length, 1);
});

test('finding 2: a move waits for an in-flight booking and is then refused', async () => {
  const loose = await space('Loose');
  await asUser(c1);
  await c1.query(`select public.create_booking($1, '2029-03-01', '2029-03-03')`, [loose]);
  await c2.query('begin');
  const blocked = await waitsOnLock(c2);
  const mv = settle(c2.query(`update public.spaces set property_id = $1 where id = $2`, [propB, loose]));
  assert.ok(await blocked(), 'the move waits for the property lock');
  await c1.query('commit');
  const r = await mv; await c2.query('rollback');
  assert.equal(r.ok, false); assert.match(r.message, /cannot move/);
  assert.equal((await q1(admin, `select property_id from public.spaces where id = $1`, [loose])).property_id, propA);
});

test('finding 1: concurrent bookings of two related spaces, in both arrival orders: exactly one commits', async () => {
  const lawn = await space('Lawn'), pool = await space('Pool');
  await admin.query(`insert into public.space_relations (space_id, blocks_space_id) values ($1, $2)`, [lawn, pool]);
  for (const [first, second, day] of [[pool, lawn, '2029-04-01'], [lawn, pool, '2029-04-02']]) {
    const s = `${day} 17:00Z`, e = `${day} 23:00Z`;
    await asUser(c1); await asUser(c2);
    await c1.query(`select public.create_booking($1, $2, $3)`, [first, s, e]);
    const p2 = settle(c2.query(`select public.create_booking($1, $2, $3)`, [second, `${day} 18:00Z`, `${day} 19:00Z`]));
    await c1.query('commit');
    const r2 = await p2; await c2.query(r2.ok ? 'commit' : 'rollback');
    assert.equal(r2.ok, false, `second booking on ${day} must be refused`);
    assert.equal((await confirmed([lawn, pool], s, e)).length, 1);
  }
});

test('finding 5: calendar sync racing create_booking ends with a rejection or a recorded conflict, never two unflagged overlaps', async () => {
  const adu = await space('ADU');
  const feed = (uid, s, e) => JSON.stringify([{ external_uid: uid, kind: 'booking', status: 'confirmed', starts_at: s, ends_at: e, all_day: true, summary: 'Reserved' }]);
  // Order 1: the booking is in flight when the sync arrives (the reviewer's C1). The sync waits, then flags.
  await asUser(c1);
  await c1.query(`select public.create_booking($1, '2029-01-10', '2029-01-15')`, [adu]);
  await asService(c2);
  const blocked = await waitsOnLock(c2);
  const sync = settle(c2.query(`select public.sync_calendar_import($1, 'airbnb', $2::jsonb, '{}') as r`, [adu, feed('HM-1', '2029-01-12T00:00:00Z', '2029-01-14T00:00:00Z')]));
  assert.ok(await blocked(), 'the sync waits for the in-flight booking');
  await c1.query('commit');
  const r = await sync; await c2.query('commit');
  assert.ok(r.ok, r.message);
  assert.equal(r.rows[0].r.new_conflicts, 1);
  assert.equal((await confirmed([adu], '2029-01-10', '2029-01-15')).length, 2);
  // Order 2: the sync is in flight when the booking arrives. The booking waits, then is refused.
  await asService(c2);
  await c2.query(`select public.sync_calendar_import($1, 'airbnb', $2::jsonb, '{}')`, [adu, feed('HM-2', '2029-02-12T00:00:00Z', '2029-02-14T00:00:00Z')]);
  await asUser(c1);
  const bk = settle(c1.query(`select public.create_booking($1, '2029-02-10', '2029-02-15')`, [adu]));
  await c2.query('commit');
  const b = await bk; await c1.query(b.ok ? 'commit' : 'rollback');
  assert.equal(b.ok, false); assert.equal(b.code, '23P01');
  // Free-running rounds, then the invariant over the whole space: every overlapping confirmed pair is flagged.
  for (let i = 0; i < 6; i++) {
    const d = `2029-03-${String(10 + i * 2).padStart(2, '0')}`;
    await Promise.all([
      (async () => { await asUser(c1); const x = await settle(c1.query(`select public.create_booking($1, $2, $3)`, [adu, `${d} 15:00Z`, `${d} 18:00Z`])); await c1.query(x.ok ? 'commit' : 'rollback'); })(),
      (async () => { await asService(c2); const x = await settle(c2.query(`select public.sync_calendar_import($1, 'airbnb', $2::jsonb, '{}')`, [adu, feed(`HM-R${i}`, `${d}T15:00:00Z`, `${d}T18:00:00Z`)])); await c2.query(x.ok ? 'commit' : 'rollback'); assert.ok(x.ok, x.message); })(),
    ]);
  }
  const unflagged = await q1(admin, `select count(*)::int as n from public.reservations a join public.reservations b
      on a.id < b.id and a.space_id = b.space_id and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
    where a.space_id = $1 and a.status = 'confirmed' and b.status = 'confirmed'
      and not exists (select 1 from public.conflicts c where c.a_reservation_id = a.id and c.b_reservation_id = b.id and c.resolved_at is null)`, [adu]);
  assert.equal(unflagged.n, 0);
  // The service role cannot bypass the RPC with a direct write any more.
  await asService(c2);
  const raw = await settle(c2.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at) values ($1, 'airbnb', 'RAW', 'ical', '2029-05-01', '2029-05-02')`, [adu]));
  await c2.query('rollback');
  assert.equal(raw.ok, false); assert.equal(raw.code, '42501');
});

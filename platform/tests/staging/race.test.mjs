// Two-connection (and N-connection) race tests on the local Postgres 16 staging cluster (npm run test:staging).
// Every booking path takes the per-property lock, so concurrent writers for one property run one after the other and
// the final table never holds an unflagged overlap. Assertions check the final table state, not only return codes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const envFile = new URL('../../.staging/env', import.meta.url);
const url = process.env.DATABASE_URL ?? readFileSync(envFile, 'utf8').trim().replace(/^DATABASE_URL=/, '');
const N = 20;
const USER = randomUUID();
let admin, clients = [];
let prop, adu, house, room, roomA, roomB, studio, pool;

const q1 = async (c, sql, params) => (await c.query(sql, params)).rows[0];

// One call as the signed-in owner, in its own transaction (like a PostgREST request).
async function asUser(c, sql, params) {
  await c.query('begin');
  try {
    await c.query(`set local role authenticated`);
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [USER]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return { ok: true, rows: r.rows };
  } catch (e) {
    await c.query('rollback');
    return { ok: false, code: e.code, message: e.message };
  }
}
const createBooking = (c, space, s, e) => asUser(c, `select public.create_booking($1, $2, $3) as id`, [space, s, e]);

async function space(title, cat, extra = {}) {
  return (await q1(admin, `insert into public.spaces (property_id, category, title, parent_space_id) values ($1, $2, $3, $4) returning id`,
    [prop, cat, title, extra.parent ?? null])).id;
}

before(async () => {
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  for (let i = 0; i < N; i++) { const c = new pg.Client({ connectionString: url }); await c.connect(); clients.push(c); }
  await admin.query(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name":"Race"}')`, [USER]);
  prop = (await q1(admin, `insert into public.properties (host_id, title) values ($1, 'Race St') returning id`, [USER])).id;
  adu = await space('ADU', 'adu');
  house = await space('House', 'entire_home');
  room = await space('Room', 'private_room', { parent: house });
  roomA = await space('Room A', 'private_room');
  roomB = await space('Room B', 'private_room');
  studio = await space('Studio', 'studio');
  pool = await space('Pool', 'pool');
  const bath = (await q1(admin, `insert into public.resources (property_id, name, capacity) values ($1, 'Bathroom', 1) returning id`, [prop])).id;
  await admin.query(`insert into public.space_resources (space_id, resource_id) values ($1, $3), ($2, $3)`, [roomA, roomB, bath]);
});

after(async () => {
  for (const c of clients) await c.end().catch(() => {});
  await admin?.end();
});

// Confirmed reservations on these spaces that overlap [s, e).
const overlapping = async (spaces, s, e) => (await admin.query(
  `select id, space_id, channel from public.reservations where space_id = any($1) and status = 'confirmed'
     and tstzrange(starts_at, ends_at) && tstzrange($2, $3)`, [spaces, s, e])).rows;

test('the exclusion constraint is in place on Postgres 16', async () => {
  const r = await q1(admin, `select count(*)::int as n from pg_constraint where conname = 'reservations_exclusive_no_overlap'`);
  assert.equal(r.n, 1);
});

test(`${N} concurrent create_booking calls for the same slot: exactly one wins`, async () => {
  const s = '2029-01-10', e = '2029-01-13';
  const results = await Promise.all(clients.map((c) => createBooking(c, adu, s, e)));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.filter((r) => !r.ok).slice(0, 2)));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === '23P01'), 'every loser is a conflict, not some other error');
  assert.equal((await overlapping([adu], s, e)).length, 1);
});

test('concurrent whole-house and room bookings: exactly one wins', async () => {
  const s = '2029-02-01', e = '2029-02-05';
  const results = await Promise.all(clients.map((c, i) => createBooking(c, i % 2 ? house : room, s, e)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await overlapping([house, room], s, e)).length, 1);
});

test('concurrent bookings of two rooms sharing a capacity-1 bathroom: exactly one wins', async () => {
  const s = '2029-03-01', e = '2029-03-03';
  const results = await Promise.all(clients.map((c, i) => createBooking(c, i % 2 ? roomA : roomB, s, e)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal((await overlapping([roomA, roomB], s, e)).length, 1);
});

test('concurrent holds and bookings for the same slot: exactly one takes it', async () => {
  const s = '2029-04-01 17:00Z', e = '2029-04-01 20:00Z';
  const results = await Promise.all(clients.map((c, i) => i % 2
    ? createBooking(c, studio, s, e)
    : asUser(c, `select public.place_hold($1, 'vrbo', $2, $3, false) as id`, [studio, s, e])));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results.filter((r) => !r.ok).map((r) => r.message).slice(0, 2)));
  const holds = (await admin.query(`select count(*)::int as n from public.booking_holds where space_id = $1 and status in ('holding', 'safe')
    and tstzrange(starts_at, ends_at) && tstzrange($2, $3)`, [studio, s, e])).rows[0].n;
  assert.equal(holds + (await overlapping([studio], s, e)).length, 1);
});

test('concurrent import and create_booking: a rejection or a recorded conflict, never an unflagged overlap', async () => {
  for (let round = 0; round < 5; round++) {
    const day = `2029-05-${String(10 + round * 3).padStart(2, '0')}`;
    const s = `${day} 15:00Z`, e = `${day} 18:00Z`;
    const rows = JSON.stringify([{ external_uid: `SW-${round}`, starts_at: s, ends_at: e }]);
    const [booked, imported] = await Promise.all([
      createBooking(clients[0], pool, s, e),
      asUser(clients[1], `select public.import_reservations($1, 'swimply', $2::jsonb, 'ical') as r`, [pool, rows]),
    ]);
    assert.ok(imported.ok, imported.message); // a marketplace fact is never rejected
    const rows2 = await overlapping([pool], s, e);
    assert.ok(rows2.some((r) => r.channel === 'swimply'), 'the imported booking is recorded');
    if (booked.ok) {
      // Booking ran first, then the import landed on top of it: the pair must be flagged, in the result and the table.
      assert.equal(rows2.length, 2);
      assert.equal(imported.rows[0].r.conflicts.length, 1);
      const [a, b] = rows2.map((r) => r.id).sort();
      const c = await q1(admin, `select count(*)::int as n from public.conflicts where a_reservation_id = $1 and b_reservation_id = $2 and resolved_at is null`, [a, b]);
      assert.equal(c.n, 1, 'overlap is flagged');
    } else {
      assert.equal(booked.code, '23P01');
      assert.equal(rows2.length, 1);
    }
  }
  // Across all rounds: every overlapping confirmed pair on the pool is in public.conflicts.
  const unflagged = await q1(admin, `select count(*)::int as n from public.reservations a join public.reservations b
      on a.id < b.id and a.space_id = b.space_id and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
    where a.space_id = $1 and a.status = 'confirmed' and b.status = 'confirmed'
      and not exists (select 1 from public.conflicts c where c.a_reservation_id = a.id and c.b_reservation_id = b.id and c.resolved_at is null)`, [pool]);
  assert.equal(unflagged.n, 0);
});

test('without the RPC, the exclusion constraint still refuses two exclusive overlapping rows written at once', async () => {
  const s = '2029-06-01', e = '2029-06-04';
  const raw = (c, uid) => c.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at, exclusive)
    values ($1, 'direct', $2, 'manual', $3, $4, true)`, [adu, uid, s, e]).then(() => ({ ok: true }), (err) => ({ ok: false, code: err.code }));
  const results = await Promise.all([raw(clients[2], 'RAW-1'), raw(clients[3], 'RAW-2')]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.code), ['23P01']);
  assert.equal((await overlapping([adu], s, e)).length, 1);
});

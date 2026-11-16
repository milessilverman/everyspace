// The database rules that make double bookings impossible, run against the real migrations.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.mjs';

const MAYA = '11111111-1111-1111-1111-111111111111';
const SAM = '22222222-2222-2222-2222-222222222222';
let db, one, house, room1, room2, pool;
const d = (s) => `${s} 08:00Z`; // LA midnight in winter
const hold = (space, channel, s, e) => one(`select public.place_hold($1, $2, $3, $4) as id`, [space, channel, d(s), d(e)]).then((r) => r.id);
const status = async (id) => (await one('select status from public.booking_holds where id = $1', [id])).status;
const reserve = (space, channel, uid, s, e, extra = {}) => one(
  `insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at, all_day, kind, created_at)
   values ($1, $2, $3, 'ical', $4, $5, true, $6, coalesce($7::timestamptz, now())) returning id`,
  [space, channel, uid, d(s), d(e), extra.kind ?? 'booking', extra.created_at ?? null]).then((r) => r.id);

before(async () => {
  ({ db, one } = await freshDb());
  await db.query(`insert into auth.users (id) values ($1), ($2)`, [MAYA, SAM]);
  const prop = (await one(`insert into public.properties (host_id, title) values ($1, 'Maple St') returning id`, [MAYA])).id;
  const sp = (title, cat, parent = null) => one(`insert into public.spaces (property_id, category, title, parent_space_id) values ($1, $2, $3, $4) returning id`, [prop, cat, title, parent]).then((r) => r.id);
  house = await sp('Whole house', 'entire_home');
  room1 = await sp('Garden room', 'private_room', house);
  room2 = await sp('Loft room', 'private_room', house);
  pool = await sp('Pool', 'pool');
});

test('a space cannot sit inside itself or inside another property', async () => {
  await assert.rejects(db.query('update public.spaces set parent_space_id = $1 where id = $2', [room1, house]), /inside itself/);
  const other = (await one(`insert into public.properties (host_id, title) values ($1, 'Elsewhere') returning id`, [MAYA])).id;
  await assert.rejects(db.query(`insert into public.spaces (property_id, category, title, parent_space_id) values ($1, 'adu', 'ADU', $2)`, [other, house]), /same property/);
});

test('rule 1: only one site per space can take instant bookings', async () => {
  await db.query(`insert into public.channel_listings (space_id, channel, status, booking_mode) values ($1, 'airbnb', 'live', 'instant')`, [house]);
  // Same space, second instant site: refused.
  await assert.rejects(db.query(`insert into public.channel_listings (space_id, channel, status, booking_mode) values ($1, 'vrbo', 'live', 'instant')`, [house]), /Only one site can take instant bookings/);
  // A room inside the house can't be instant elsewhere either (booking the room would collide with a house stay).
  await assert.rejects(db.query(`insert into public.channel_listings (space_id, channel, status, booking_mode) values ($1, 'booking_com', 'live', 'instant')`, [room1]), /Only one site/);
  // Request-to-book everywhere else is fine, and an unrelated space (the pool) can have its own instant site.
  await db.query(`insert into public.channel_listings (space_id, channel, status, booking_mode) values ($1, 'vrbo', 'live', 'request'), ($2, 'airbnb', 'live', 'request'), ($3, 'swimply', 'live', 'instant')`, [house, room1, pool]);
  // Switching Vrbo to instant later is refused too.
  await assert.rejects(db.query(`update public.channel_listings set booking_mode = 'instant' where space_id = $1 and channel = 'vrbo'`, [house]), /Only one site/);
  const doors = (await db.query('select channel::text from public.door_listings($1) order by 1', [room1])).rows.map((r) => r.channel);
  assert.deepEqual(doors, ['airbnb']);
});

test('rule 2: a hold locks the dates across the whole house', async () => {
  const h = await hold(room1, 'airbnb', '2026-12-01', '2026-12-04');
  assert.equal(await status(h), 'holding');
  // The whole house overlaps the held room: refused. The other room is separate: allowed.
  await assert.rejects(hold(house, 'vrbo', '2026-12-03', '2026-12-05'), /already taken/);
  const h2 = await hold(room2, 'vrbo', '2026-12-01', '2026-12-04');
  // Back-to-back (checkout day = next check-in) is fine.
  const h3 = await hold(room1, 'vrbo', '2026-12-04', '2026-12-06');
  // An existing booking or closed dates also block a hold.
  await reserve(house, 'airbnb', 'HM-1', '2026-12-10', '2026-12-12');
  await assert.rejects(hold(room1, 'vrbo', '2026-12-11', '2026-12-13'), /already taken/);
  await reserve(pool, 'swimply', 'closed-1', '2026-12-20', '2026-12-21', { kind: 'owner_block' });
  await assert.rejects(hold(pool, 'peerspace', '2026-12-20', '2026-12-21'), /already taken/);
  for (const id of [h, h2, h3]) await db.query('select public.release_hold($1)', [id]);
  assert.equal(await status(h), 'released');
});

test('rule 2: if the instant site sells the dates first, the hold loses', async () => {
  const h = await hold(house, 'vrbo', '2027-01-08', '2027-01-11');
  // The host closes the dates on Airbnb (a block, which is expected)...
  await reserve(house, 'airbnb', 'closed-jan', '2027-01-08', '2027-01-11', { kind: 'block' });
  assert.equal((await one('select public.mark_hold_safe($1) as ok', [h])).ok, true);
  assert.equal(await status(h), 'safe');
  // ...but in a second case an Airbnb guest instant-booked before the host closed them.
  const h2 = await hold(house, 'vrbo', '2027-02-01', '2027-02-04');
  await reserve(house, 'airbnb', 'HM-feb', '2027-02-02', '2027-02-05');
  assert.equal((await one('select public.mark_hold_safe($1) as ok', [h2])).ok, false);
  assert.deepEqual(await one('select status, released_reason from public.booking_holds where id = $1', [h2]), { status: 'released', released_reason: 'taken' });
});

test('rule 3: holds turn into bookings; accepting without the check is flagged', async () => {
  // Pre-existing Vrbo stay from before Everyspace set Vrbo to request-to-book: not flagged.
  await reserve(house, 'vrbo', 'VR-old', '2027-03-01', '2027-03-03', { created_at: '2026-01-01' });
  // The safe January hold's Vrbo booking arrives: linked, no alert.
  const ok = await reserve(house, 'vrbo', 'VR-jan', '2027-01-08', '2027-01-11');
  // A Vrbo booking the host accepted straight on Vrbo, without a hold: flagged.
  const rogue = await reserve(house, 'vrbo', 'VR-rogue', '2027-04-01', '2027-04-03');
  assert.equal((await one('select public.settle_holds($1) as n', [house])).n, 1);
  assert.equal((await one(`select status from public.booking_holds where reservation_id = $1`, [ok])).status, 'confirmed');
  const alerts = (await db.query(`select reservation_id from public.booking_alerts where kind = 'unchecked_accept'`)).rows.map((r) => r.reservation_id);
  assert.deepEqual(alerts, [rogue]);
  assert.equal((await one('select public.settle_holds($1) as n', [house])).n, 0); // not repeated
});

test('rule 3: guard alerts when the instant site reopens dates, and clears once closed again', async () => {
  const reqs = (await db.query(`select kind, id from public.door_requirements($1, 'airbnb')`, [house])).rows;
  const vrbo = (await db.query(`select id from public.reservations where channel = 'vrbo' and external_uid in ('VR-jan', 'VR-rogue', 'VR-old') order by starts_at`)).rows.map((r) => r.id);
  assert.deepEqual(reqs.filter((r) => r.kind === 'reservation').map((r) => r.id).sort(), [...vrbo].sort());
  assert.equal((await one(`select public.record_door_gaps($1, 'airbnb', $2::uuid[], '{}') as n`, [house, [vrbo[1]]])).n, 1);
  const msg = (await one(`select message from public.booking_alerts where kind = 'door_open' and resolved_at is null`)).message;
  assert.equal(msg, 'Close the nights of Mar 1 – Mar 2 on Airbnb now. They\'re booked on Vrbo, but still open there.');
  await one(`select public.record_door_gaps($1, 'airbnb', '{}', '{}')`, [house]);
  assert.equal((await one(`select count(*)::int as n from public.booking_alerts where kind = 'door_open' and resolved_at is null`)).n, 0);
});

test('hosts can acknowledge an accepted-without-check alert, but not someone else\'s, and not a dates-still-open alert', async () => {
  const unchecked = (await one(`select id from public.booking_alerts where kind = 'unchecked_accept' and resolved_at is null`)).id;
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${SAM}', false);`);
  assert.equal((await one('select public.dismiss_alert($1) as ok', [unchecked])).ok, false);
  await db.exec(`select set_config('request.jwt.claim.sub', '${MAYA}', false);`);
  assert.equal((await one('select public.dismiss_alert($1) as ok', [unchecked])).ok, true);
  await db.exec('reset role');
  assert.ok((await one('select resolved_at from public.booking_alerts where id = $1', [unchecked])).resolved_at);
});

test('double-booking check now covers the whole house vs a room inside it', async () => {
  await reserve(room2, 'booking_com', 'BK-room', '2026-12-10', '2026-12-11'); // overlaps the Airbnb whole-house stay HM-1
  assert.equal((await one('select public.detect_conflicts($1) as n', [room2])).n, 1);
  // The January Vrbo stay sits on dates closed on Airbnb for it: not a conflict. Only the room/house clash is.
  assert.equal((await one('select public.detect_conflicts($1) as n', [house])).n, 1);
  assert.equal((await one('select count(*)::int as n from public.conflicts where resolved_at is null')).n, 1);
});

test('only the host can hold their dates; signed-out visitors cannot call it at all', async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${SAM}', false);`);
  await assert.rejects(hold(house, 'vrbo', '2027-06-01', '2027-06-03'), /Space not found/);
  await assert.rejects(db.query('select public.mark_hold_safe(gen_random_uuid())'), /permission denied/);
  await db.exec(`select set_config('request.jwt.claim.sub', '${MAYA}', false);`);
  assert.ok(await hold(house, 'vrbo', '2027-06-01', '2027-06-03'));
  await db.exec(`reset role; set role anon; select set_config('request.jwt.claim.sub', '', false);`);
  await assert.rejects(hold(house, 'vrbo', '2027-07-01', '2027-07-03'), /permission denied/);
  await db.exec('reset role');
});

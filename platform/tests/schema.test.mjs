// Applies the real migration to an in-memory Postgres (PGlite) with a stand-in for Supabase's auth schema,
// then checks sign-up, conflicts, revenue share and row-level security.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.mjs';

const MAYA = '11111111-1111-1111-1111-111111111111';
const SAM = '22222222-2222-2222-2222-222222222222';
let db, one;

before(async () => { ({ db, one } = await freshDb()); });


test('sign-up creates a profile with LA defaults', async () => {
  await db.query(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name":"Maya"}'), ($2, '{"full_name":"Sam"}')`, [MAYA, SAM]);
  const p = await one('select full_name, market, notify_by from public.profiles where id = $1', [MAYA]);
  assert.deepEqual(p, { full_name: 'Maya', market: 'los_angeles', notify_by: 'sms' });
});

let house, pool, poolFeedToken;
test('properties, spaces and a publishable calendar feed', async () => {
  const prop = await one(`insert into public.properties (host_id, title, city) values ($1, '412 Maple St', 'Los Angeles') returning id, timezone`, [MAYA]);
  assert.equal(prop.timezone, 'America/Los_Angeles');
  house = (await one(`insert into public.spaces (property_id, category, title) values ($1, 'entire_home', 'Whole house') returning id`, [prop.id])).id;
  pool = (await one(`insert into public.spaces (property_id, category, title, added_by_everyspace) values ($1, 'pool', 'Pool', true) returning id`, [prop.id])).id;
  const feed = await one(`insert into public.calendar_feeds (space_id, for_channel) values ($1, 'airbnb') returning token`, [pool]);
  poolFeedToken = feed.token;
  assert.match(poolFeedToken, /^[0-9a-f]{64}$/);
});

test('detects a double booking across sites, then resolves it when one is cancelled', async () => {
  const a = await one(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at) values ($1, 'airbnb', 'A1', 'ical', '2026-12-10', '2026-12-13') returning id`, [house]);
  const b = await one(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at) values ($1, 'vrbo', 'V1', 'ical', '2026-12-12', '2026-12-15') returning id`, [house]);
  await db.query(`insert into public.reservations (space_id, channel, external_uid, kind, source, starts_at, ends_at) values ($1, 'airbnb', 'B1', 'block', 'ical', '2026-12-20', '2026-12-22'), ($1, 'vrbo', 'B2', 'block', 'ical', '2026-12-21', '2026-12-23')`, [house]);
  assert.equal((await one('select public.detect_conflicts($1) as n', [house])).n, 1); // two overlapping blocks are fine
  assert.equal((await one('select count(*)::int as n from public.conflicts where space_id = $1 and resolved_at is null', [house])).n, 1);
  await db.query(`update public.reservations set status = 'cancelled' where id = $1`, [b.id]);
  await one('select public.detect_conflicts($1)', [house]);
  assert.equal((await one('select count(*)::int as n from public.conflicts where space_id = $1 and resolved_at is null', [house])).n, 0);
  assert.ok(a.id);
});

test('revenue share only charges what Everyspace brought in', async () => {
  // Airbnb stay on the house the host already had: not attributed.
  await db.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at, payout_cents) values ($1, 'airbnb', 'A-past', 'api', '2026-10-01', '2026-10-04', 60000)`, [house]);
  // Pool booking: the pool was added by Everyspace, so it is attributed.
  await db.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at, payout_cents) values ($1, 'swimply', 'S-past', 'email', '2026-10-05 20:00Z', '2026-10-05 23:00Z', 13500)`, [pool]);
  // Booking.com stay on the house after Everyspace published it there: attributed.
  await db.query(`insert into public.channel_listings (space_id, channel, status, listed_by_everyspace) values ($1, 'booking_com', 'live', true)`, [house]);
  await db.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at, payout_cents) values ($1, 'booking_com', 'BK-past', 'api', '2026-10-10', '2026-10-12', 40000)`, [house]);
  assert.equal((await one('select public.accrue_earnings() as n')).n, 3);
  assert.equal((await one('select public.accrue_earnings() as n')).n, 0); // idempotent
  const sum = await one(`select sum(gross_cents)::int as gross, sum(fee_cents)::int as fee, sum(case when attributed then gross_cents else 0 end)::int as attributed from public.earnings_ledger`);
  // October: pool $135 → 10% = $13.50. Booking.com $400 → 10% of the next $165 ($16.50, reaching the $30 cap) + 3% of $235 ($7.05).
  assert.deepEqual(sum, { gross: 113500, attributed: 53500, fee: 3705 });
});

test('pricing: 10% until the fee reaches $30 in a month, then 3%, and it resets each month', async () => {
  // November: $1,000 of pool bookings → $30 + 3% of $700 = $51.
  await db.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at, payout_cents) values ($1, 'swimply', 'S-nov', 'email', '2026-11-01 20:00Z', '2026-11-01 23:00Z', 100000)`, [pool]);
  assert.equal((await one('select public.accrue_earnings() as n')).n, 1);
  assert.deepEqual(await one(`select period::text, fee_cents::int as fee, share_pct::text from public.earnings_ledger l join public.reservations r on r.id = l.reservation_id where r.external_uid = 'S-nov'`),
    { period: '2026-11-01', fee: 5100, share_pct: '5.10' });
});

test('row-level security keeps hosts in their own data', async () => {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${SAM}', false);`);
  assert.equal((await one('select count(*)::int as n from public.reservations')).n, 0);
  assert.equal((await one('select count(*)::int as n from public.calendar_feeds')).n, 0);
  await assert.rejects(db.query(`insert into public.spaces (property_id, category, title) select id, 'pool', 'Sneaky' from public.properties limit 1`).then(async () => {
    // RLS hides Maya's property from Sam, so the insert selects nothing; prove that, then force a direct attempt.
    const p = (await db.query(`select id from public.properties`)).rows; if (!p.length) throw new Error('hidden');
  }));
  await db.exec(`select set_config('request.jwt.claim.sub', '${MAYA}', false);`);
  assert.equal((await one('select count(*)::int as n from public.reservations')).n, 8);
  assert.equal((await one('select count(*)::int as n from public.earnings_ledger')).n, 4);
  await assert.rejects(db.query(`update public.app_settings set standard_share_pct = 0`).then((r) => { if (!r.affectedRows) throw new Error('no rows changed'); }));
  await db.exec('reset role;');
});

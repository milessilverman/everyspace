// Regression tests for the phase-gate review findings (docs/audit/review-gate.md, section 2) on PGlite with btree_gist.
// Each test names the finding it covers; every one of them failed on the code before the fix.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { migrationFiles, as } from './helpers/db.mjs';

const MAYA = '11111111-1111-1111-1111-111111111111'; // owner of org A
const SAM = '22222222-2222-2222-2222-222222222222'; // another user (own personal org)
const VIC = '33333333-3333-3333-3333-333333333333'; // viewer in A
const OLI = '44444444-4444-4444-4444-444444444444'; // operator in A
const MGR = '55555555-5555-5555-5555-555555555555'; // manager in a team org
let db, org, prop, prop2;

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.query(sql, params)).rows;
const n = async (sql, params) => (await one(sql, params)).n;
const space = (title, p = prop, parent = null) => one(`insert into public.spaces (property_id, category, title, parent_space_id)
  values ($1, 'other', $2, $3) returning id`, [p, title, parent]).then((r) => r.id);
const relate = (a, b) => db.query(`insert into public.space_relations (space_id, blocks_space_id) values ($1, $2)`, [a, b]);
const book = (s, a, b, extra = {}) => one(`select public.create_booking($1, $2, $3, p_channel => $4, p_external_uid => $5) as id`,
  [s, a, b, extra.channel ?? 'everyspace', extra.uid ?? null]).then((r) => r.id);
const imp = (s, channel, rows, source = 'ical') => one(`select public.import_reservations($1, $2, $3::jsonb, $4) as r`,
  [s, channel, JSON.stringify(rows), source]).then((r) => r.r);
async function asService(fn) {
  await db.exec(`set role service_role; select set_config('request.jwt.claim.sub', '', false);`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const openConflicts = (s) => n(`select count(*)::int as n from public.conflicts where space_id = $1 and resolved_at is null`, [s]);

before(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  await db.exec(readFileSync(new URL('./helpers/auth_stub.sql', import.meta.url), 'utf8'));
  for (const f of migrationFiles()) {
    try { await db.exec(readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8')); }
    catch (e) { e.message = `${f}: ${e.message}`; throw e; }
  }
  await db.query(`insert into auth.users (id) values ($1), ($2), ($3), ($4), ($5)`, [MAYA, SAM, VIC, OLI, MGR]);
  org = (await one(`select id from public.organizations where created_by = $1 and kind = 'personal'`, [MAYA])).id;
  await db.query(`insert into public.memberships (org_id, user_id, role_key) values ($1, $2, 'viewer'), ($1, $3, 'operator')`, [org, VIC, OLI]);
  prop = (await one(`insert into public.properties (host_id, title) values ($1, 'Maple') returning id`, [MAYA])).id;
  prop2 = (await one(`insert into public.properties (host_id, title) values ($1, 'Oak') returning id`, [MAYA])).id;
});

// ---------------------------------------------------------------- finding 1: relations are mutual exclusion
test('finding 1: a relation blocks in both arrival orders, and each pair is stored once', async () => {
  const lawn = await space('Lawn'), pool = await space('Pool');
  await relate(lawn, pool);
  assert.equal(await n(`select count(*)::int as n from information_schema.columns where table_name = 'space_relations' and column_name = 'symmetric'`), 0);
  // Pool first, then lawn (the old engine accepted this and flagged nothing).
  await as(db, MAYA, () => book(pool, '2027-05-01 18:00Z', '2027-05-01 19:00Z'));
  await assert.rejects(as(db, MAYA, () => book(lawn, '2027-05-01 17:00Z', '2027-05-01 23:00Z')), (e) => e.code === '23P01');
  // Lawn first, then pool.
  await as(db, MAYA, () => book(lawn, '2027-06-01 17:00Z', '2027-06-01 23:00Z'));
  await assert.rejects(as(db, MAYA, () => book(pool, '2027-06-01 18:00Z', '2027-06-01 19:00Z')), (e) => e.code === '23P01');
  // Holds too, from either side.
  await assert.rejects(one(`select public.place_hold($1, 'vrbo', '2027-06-01 20:00Z', '2027-06-01 21:00Z')`, [pool]), /already taken/);
  // Imports are flagged from either side, in the import result and in public.conflicts.
  const r1 = await imp(pool, 'swimply', [{ external_uid: 'SW-7', starts_at: '2027-07-01T18:00:00Z', ends_at: '2027-07-01T20:00:00Z' }]);
  assert.deepEqual(r1.conflicts, []);
  const r2 = await imp(lawn, 'peerspace', [{ external_uid: 'PS-7', starts_at: '2027-07-01T17:00:00Z', ends_at: '2027-07-01T23:00:00Z' }]);
  assert.deepEqual(r2.conflicts.map((c) => c.kind), ['overlap']);
  assert.equal(await one(`select public.detect_conflicts($1) as n`, [pool]).then((r) => r.n), 1);
  // Stored once: the reverse pair and a self-relation are refused.
  await assert.rejects(relate(pool, lawn), /duplicate key|space_relations_pair/);
  await assert.rejects(relate(lawn, lawn), /check constraint/);
  // blocking_spaces is the same from both ends.
  const bs = async (s) => (await all(`select b from public.blocking_spaces($1) b`, [s])).map((r) => r.b).sort();
  assert.deepEqual(await bs(lawn), [lawn, pool].sort());
  assert.deepEqual(await bs(pool), [lawn, pool].sort());
});

// ---------------------------------------------------------------- finding 2: a family cannot span two properties
test('finding 2: a space with a parent, children, bookings or holds cannot change property', async () => {
  const house = await space('House'), room = await space('Room', prop, house);
  await assert.rejects(db.query(`update public.spaces set property_id = $1 where id = $2`, [prop2, house]), /same property|cannot move/);
  await assert.rejects(db.query(`update public.spaces set property_id = $1 where id = $2`, [prop2, room]), /same property|cannot move/);
  await assert.rejects(db.query(`update public.spaces set property_id = $1, parent_space_id = null where id = $2`, [prop2, room]), /cannot move/);
  const booked = await space('Booked');
  await as(db, MAYA, () => book(booked, '2027-08-01', '2027-08-02'));
  await assert.rejects(db.query(`update public.spaces set property_id = $1 where id = $2`, [prop2, booked]), /cannot move/);
  const held = await space('Held');
  await one(`select public.place_hold($1, 'vrbo', '2027-08-01', '2027-08-02')`, [held]);
  await assert.rejects(db.query(`update public.spaces set property_id = $1 where id = $2`, [prop2, held]), /cannot move/);
  // Signed-in managers hit the same rule.
  await assert.rejects(as(db, MAYA, () => db.query(`update public.spaces set property_id = $1 where id = $2`, [prop2, house])), /same property|cannot move/);
  // A space with nothing attached may still move.
  const loose = await space('Loose');
  assert.equal((await db.query(`update public.spaces set property_id = $1 where id = $2`, [prop2, loose])).affectedRows, 1);
  const fam = await all(`select distinct s.property_id from public.spaces s where s.id in (select public.related_spaces($1))`, [room]);
  assert.equal(fam.length, 1, 'the family stays on one property');
});

// ---------------------------------------------------------------- finding 3: imports cannot touch owner bookings
test('finding 3: import_reservations refuses channel/source everyspace and never rewrites an Everyspace booking', async () => {
  const adu = await space('ADU');
  const a1 = await as(db, MAYA, () => book(adu, '2027-07-01', '2027-07-05'));
  const a2 = await as(db, MAYA, () => book(adu, '2027-07-10', '2027-07-12'));
  const uid2 = (await one(`select external_uid from public.reservations where id = $1`, [a2])).external_uid;
  await assert.rejects(as(db, OLI, () => imp(adu, 'everyspace', [{ external_uid: uid2, starts_at: '2027-07-02', ends_at: '2027-07-04' }], 'everyspace')), /not imported/);
  await assert.rejects(as(db, OLI, () => imp(adu, 'airbnb', [], 'everyspace')), /Source must be/);
  // An Everyspace booking recorded under a marketplace uid is still protected.
  const a3 = await as(db, MAYA, () => book(adu, '2027-07-20', '2027-07-22', { channel: 'airbnb', uid: 'HM-OWN' }));
  await assert.rejects(as(db, OLI, () => imp(adu, 'airbnb', [{ external_uid: 'HM-OWN', starts_at: '2027-07-20', ends_at: '2027-07-22', status: 'cancelled' }])), /made in Everyspace/);
  const rows = await all(`select id, starts_at::text as s, status, exclusive from public.reservations where id = any($1) order by starts_at`, [[a1, a2, a3]]);
  assert.deepEqual(rows.map((r) => [r.status, r.exclusive]), [['confirmed', true], ['confirmed', true], ['confirmed', true]]);
  assert.equal(rows[1].s, '2027-07-10 00:00:00+00');
});

test('finding 3: cancel_booking and reschedule_booking manage Everyspace bookings under the same rules', async () => {
  const studio = await space('Studio');
  const b1 = await as(db, OLI, () => book(studio, '2027-09-01', '2027-09-03'));
  const b2 = await as(db, OLI, () => book(studio, '2027-09-05', '2027-09-07'));
  // Caller checks: viewer and other tenant refused.
  await assert.rejects(as(db, VIC, () => one(`select public.cancel_booking($1)`, [b1])), /Booking not found/);
  await assert.rejects(as(db, SAM, () => one(`select public.reschedule_booking($1, '2027-10-01', '2027-10-02')`, [b1])), /Booking not found/);
  await assert.rejects(as(db, null, () => one(`select public.cancel_booking($1)`, [b1])), /permission denied/);
  // Reschedule: overlapping itself is fine (p_ignore), overlapping the other booking is refused with the conflicts.
  assert.equal((await as(db, OLI, () => one(`select public.reschedule_booking($1, '2027-09-02', '2027-09-04') as id`, [b1]))).id, b1);
  const err = await as(db, OLI, () => one(`select public.reschedule_booking($1, '2027-09-03', '2027-09-06')`, [b1])).then(() => null, (e) => e);
  assert.equal(err?.code, '23P01');
  assert.deepEqual(JSON.parse(err.detail).map((c) => [c.kind, c.reservation_id]), [['overlap', b2]]);
  await assert.rejects(as(db, OLI, () => one(`select public.reschedule_booking($1, '2027-09-04', '2027-09-02')`, [b1])), /end has to be after/);
  // Cancel frees the slot; a second cancel is a no-op.
  assert.equal((await as(db, MAYA, () => one(`select public.cancel_booking($1) as ok`, [b2]))).ok, true);
  assert.equal((await as(db, MAYA, () => one(`select public.cancel_booking($1) as ok`, [b2]))).ok, false);
  assert.ok(await as(db, MAYA, () => book(studio, '2027-09-05', '2027-09-07')));
  await assert.rejects(as(db, MAYA, () => one(`select public.reschedule_booking($1, '2027-09-10', '2027-09-11')`, [b2])), /cancelled/);
  // Imported rows are the marketplace's facts: not cancellable here.
  await imp(studio, 'airbnb', [{ external_uid: 'HM-S', starts_at: '2027-11-01', ends_at: '2027-11-02' }]);
  const hm = (await one(`select id from public.reservations where external_uid = 'HM-S'`)).id;
  await assert.rejects(as(db, MAYA, () => one(`select public.cancel_booking($1)`, [hm])), /another site/);
});

test('finding 3: cancelling an Everyspace booking resolves the conflict it was part of', async () => {
  const cabin = await space('Cabin');
  const mine = await as(db, MAYA, () => book(cabin, '2027-12-01', '2027-12-05'));
  await imp(cabin, 'vrbo', [{ external_uid: 'VR-C', starts_at: '2027-12-03', ends_at: '2027-12-06' }]);
  assert.equal(await openConflicts(cabin), 1);
  await as(db, MAYA, () => one(`select public.cancel_booking($1)`, [mine]));
  assert.equal(await openConflicts(cabin), 0);
});

// ---------------------------------------------------------------- finding 4: mark_hold_safe uses the shared rules
test('finding 4: mark_hold_safe re-checks relations (and ignores closed-dates blocks, as before)', async () => {
  const lawn = await space('Lawn 4'), pool = await space('Pool 4');
  await relate(lawn, pool);
  const hold = (await one(`select public.place_hold($1, 'vrbo', '2028-08-01 18:00Z', '2028-08-01 20:00Z') id`, [pool])).id;
  await imp(lawn, 'peerspace', [{ external_uid: 'PS-9', starts_at: '2028-08-01T17:00:00Z', ends_at: '2028-08-01T23:00:00Z' }]);
  assert.equal((await one(`select public.mark_hold_safe($1) ok`, [hold])).ok, false);
  assert.deepEqual(await one(`select status, released_reason from public.booking_holds where id = $1`, [hold]), { status: 'released', released_reason: 'taken' });
  // Dates closed on another site for this request (kind 'block') are the system working: still safe.
  const hold2 = (await one(`select public.place_hold($1, 'vrbo', '2028-09-01', '2028-09-03') id`, [pool])).id;
  await imp(pool, 'airbnb', [{ external_uid: 'BLK-1', starts_at: '2028-09-01', ends_at: '2028-09-03', kind: 'block' }]);
  assert.equal((await one(`select public.mark_hold_safe($1) ok`, [hold2])).ok, true);
});

// ---------------------------------------------------------------- finding 5: calendar sync goes through the lock
test('finding 5: sync_calendar_import is service-role only, upserts, cancels and flags in one call', async () => {
  const room = await space('Sync room');
  const mine = await as(db, MAYA, () => book(room, '2028-01-10', '2028-01-15'));
  const rows = [{ external_uid: 'HM-1', kind: 'booking', status: 'confirmed', starts_at: '2028-01-12T00:00:00Z', ends_at: '2028-01-14T00:00:00Z', all_day: true, summary: 'Reserved' },
    { external_uid: 'HM-2', kind: 'booking', status: 'confirmed', starts_at: '2028-02-01T00:00:00Z', ends_at: '2028-02-03T00:00:00Z', all_day: true, summary: 'Reserved' }];
  const sync = (r, cancel) => one(`select public.sync_calendar_import($1, 'airbnb', $2::jsonb, $3::text[]) as r`, [room, JSON.stringify(r), cancel]).then((x) => x.r);
  // Not for signed-in users, not even the owner (they use import_reservations).
  await assert.rejects(as(db, MAYA, () => sync(rows, [])), /permission denied|Space not found/);
  const r = await asService(() => sync(rows, []));
  assert.equal(r.inserted, 2);
  assert.deepEqual(r.conflicts.map((c) => [c.external_uid, c.conflicting_reservation_id]), [['HM-1', mine]]);
  assert.equal(r.new_conflicts, 1);
  assert.equal(await openConflicts(room), 1, 'flagged in the same transaction');
  // Next sync: HM-2 vanished from the feed; the caller lists it to cancel. Everyspace rows are never cancelled.
  const esUid = (await one(`select external_uid from public.reservations where id = $1`, [mine])).external_uid;
  const r2 = await asService(() => sync([rows[0]], ['HM-2', esUid]));
  assert.deepEqual([r2.inserted, r2.updated, r2.cancelled], [0, 0, 1]);
  assert.equal((await one(`select status from public.reservations where id = $1`, [mine])).status, 'confirmed');
  assert.equal((await one(`select status from public.reservations where external_uid = 'HM-2'`)).status, 'cancelled');
  // The direct write path is closed for the service role too.
  await assert.rejects(asService(() => db.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at)
    values ($1, 'airbnb', 'RAW', 'ical', '2028-03-01', '2028-03-02')`, [room])), /permission denied/);
  await assert.rejects(asService(() => db.query(`update public.reservations set status = 'cancelled' where id = $1`, [mine])), /permission denied/);
});

// ---------------------------------------------------------------- finding 6: one open door across related spaces
test('finding 6: one instant site across related spaces; door_listings and door_requirements include them', async () => {
  const lawn = await space('Lawn 6'), pool = await space('Pool 6'), deck = await space('Deck 6'), spa = await space('Spa 6');
  await relate(lawn, pool);
  const listing = (s, ch, mode = 'instant') => db.query(`insert into public.channel_listings (space_id, channel, booking_mode, status) values ($1, $2, $3, 'live')`, [s, ch, mode]);
  await listing(pool, 'swimply');
  await assert.rejects(listing(lawn, 'peerspace'), /Only one site can take instant bookings/);
  await listing(lawn, 'peerspace', 'request');
  assert.deepEqual((await all(`select space_id, channel from public.door_listings($1)`, [lawn])).map((r) => r.channel), ['swimply']);
  const party = (await imp(lawn, 'peerspace', [{ external_uid: 'PS-6', starts_at: '2029-07-01T17:00:00Z', ends_at: '2029-07-01T23:00:00Z' }]), (await one(`select id from public.reservations where external_uid = 'PS-6'`)).id);
  assert.ok((await all(`select id from public.door_requirements($1, 'swimply')`, [pool])).some((r) => r.id === party));
  // Linking two spaces that both take instant bookings is refused.
  await listing(deck, 'airbnb'); await listing(spa, 'vrbo');
  await assert.rejects(relate(deck, spa), /Both spaces take instant bookings/);
});

// ---------------------------------------------------------------- finding 7: no membership without consent
test('finding 7: an admin can only invite; only the invitee accepts; profiles only between active members', async () => {
  await db.query(`update public.profiles set phone = '+1-555-0100', full_name = 'Sam Secret' where id = $1`, [SAM]);
  const profile = (who, id) => as(db, who, () => all(`select full_name, phone from public.profiles where id = $1`, [id]));
  const members = (who) => as(db, who, () => all(`select user_id, status, full_name, phone from public.org_member_profiles($1)`, [org]));
  await as(db, MAYA, () => db.query(`insert into public.memberships (org_id, user_id, role_key, status) values ($1, $2, 'viewer', 'active')`, [org, SAM]));
  const m = await one(`select status, invited_by from public.memberships where org_id = $1 and user_id = $2`, [org, SAM]);
  assert.deepEqual(m, { status: 'invited', invited_by: MAYA });
  assert.deepEqual(await profile(MAYA, SAM), [], 'no profile through the table');
  assert.deepEqual((await members(MAYA)).find((r) => r.user_id === SAM), { user_id: SAM, status: 'invited', full_name: null, phone: null });
  assert.equal(await as(db, SAM, () => n(`select count(*)::int as n from public.properties where id = $1`, [prop])), 0, 'an invite grants nothing');
  // Nobody but Sam can make it active.
  await assert.rejects(as(db, MAYA, () => db.query(`update public.memberships set status = 'active' where org_id = $1 and user_id = $2`, [org, SAM])), /Only the invited person/);
  assert.equal((await as(db, VIC, () => one(`select public.accept_invite($1) as ok`, [org]))).ok, false, 'already active: nothing to accept');
  // Sam sees the invitation and accepts it.
  assert.equal(await as(db, SAM, () => n(`select count(*)::int as n from public.memberships where org_id = $1 and user_id = $2 and status = 'invited'`, [org, SAM])), 1);
  assert.equal((await as(db, SAM, () => one(`select public.accept_invite($1) as ok`, [org]))).ok, true);
  assert.equal(await as(db, SAM, () => n(`select count(*)::int as n from public.properties where id = $1`, [prop])), 1);
  // Names between active members; the phone only for org.manage (Maya), not for a viewer (Vic).
  assert.deepEqual((await members(MAYA)).find((r) => r.user_id === SAM), { user_id: SAM, status: 'active', full_name: 'Sam Secret', phone: '+1-555-0100' });
  assert.deepEqual((await members(VIC)).find((r) => r.user_id === SAM), { user_id: SAM, status: 'active', full_name: 'Sam Secret', phone: null });
  assert.deepEqual(await profile(VIC, SAM), [], 'still no other user rows through the table');
  assert.deepEqual(await as(db, SAM, () => all(`select * from public.org_member_profiles((select id from public.organizations where created_by = $1 and kind = 'personal'))`, [VIC])), [], 'non-members see nothing');
  // Declining: a fresh invite to OLI's personal org is declined by MAYA herself.
  const oliOrg = (await one(`select id from public.organizations where created_by = $1 and kind = 'personal'`, [OLI])).id;
  await as(db, OLI, () => db.query(`insert into public.memberships (org_id, user_id, role_key) values ($1, $2, 'viewer')`, [oliOrg, MAYA]));
  assert.equal((await as(db, SAM, () => one(`select public.decline_invite($1) as ok`, [oliOrg]))).ok, false);
  assert.equal((await as(db, MAYA, () => one(`select public.decline_invite($1) as ok`, [oliOrg]))).ok, true);
  assert.equal(await n(`select count(*)::int as n from public.memberships where org_id = $1 and user_id = $2`, [oliOrg, MAYA]), 0);
  // The last owner can be neither removed nor demoted; personal-org bootstrap still makes an active owner.
  await assert.rejects(as(db, MAYA, () => db.query(`delete from public.memberships where org_id = $1 and user_id = $2`, [org, MAYA])), /at least one owner/);
  await assert.rejects(as(db, MAYA, () => db.query(`update public.memberships set status = 'suspended' where org_id = $1 and user_id = $2`, [org, MAYA])), /own role|at least one owner/);
  const NEW = '66666666-6666-6666-6666-666666666666';
  await db.query(`insert into auth.users (id) values ($1)`, [NEW]);
  assert.deepEqual(await one(`select m.role_key, m.status from public.memberships m join public.organizations o on o.id = m.org_id
    where o.created_by = $1 and o.kind = 'personal' and m.user_id = $1`, [NEW]), { role_key: 'owner', status: 'active' });
  const team = await as(db, NEW, () => one(`select public.create_organization('New team') as id`)).then((r) => r.id);
  assert.equal((await one(`select status from public.memberships where org_id = $1 and user_id = $2`, [team, NEW])).status, 'active');
});

// ---------------------------------------------------------------- finding 8: expired provider data
test('finding 8: expired provider_data is not readable, even before the purge runs', async () => {
  await db.query(`insert into public.provider_data (channel_key, org_id, kind, payload, retrieved_at, expires_at)
    values ('airbnb', $1, 'old', '{"restricted":1}', now() - interval '30 days', now() - interval '29 days'),
           ('airbnb', $1, 'fresh', '{}', now(), now() + interval '1 day')`, [org]);
  assert.deepEqual(await as(db, MAYA, () => all(`select kind from public.provider_data order by kind`)), [{ kind: 'fresh' }]);
  const cron = readFileSync(new URL('../supabase/cron/calendar_sync.sql', import.meta.url), 'utf8');
  assert.match(cron, /cron\.schedule\('purge-expired-provider-data-daily'[\s\S]*purge_expired_provider_data\(\)/);
});

// ---------------------------------------------------------------- finding 12 (orchestrator #9): earnings after removal
test('finding 12: a host removed from a team org no longer reads that org\'s earnings', async () => {
  const OWN = '77777777-7777-7777-7777-777777777777';
  await db.query(`insert into auth.users (id) values ($1)`, [OWN]);
  const team = await as(db, OWN, () => one(`select public.create_organization('Team') id`)).then((r) => r.id);
  await as(db, OWN, () => db.query(`insert into public.memberships (org_id, user_id, role_key) values ($1, $2, 'manager')`, [team, MGR]));
  await as(db, MGR, () => one(`select public.accept_invite($1)`, [team]));
  const p = await as(db, MGR, () => one(`insert into public.properties (host_id, org_id, title) values ($1, $2, 'Team house') returning id`, [MGR, team])).then((r) => r.id);
  const sp = await space('Team room', p);
  const res = (await one(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at, payout_cents)
    values ($1, 'airbnb', 'X-T', 'ical', '2027-01-01', '2027-01-05', 90000) returning id`, [sp])).id;
  await db.query(`insert into public.earnings_ledger (host_id, reservation_id, period, gross_cents, attributed, share_pct, fee_cents)
    values ($1, $2, '2027-01-01', 90000, true, 3, 2700)`, [MGR, res]);
  const sees = (u) => as(db, u, () => n(`select count(*)::int as n from public.earnings_ledger where reservation_id = $1`, [res]));
  assert.equal(await sees(MGR), 1);
  await as(db, OWN, () => db.query(`delete from public.memberships where org_id = $1 and user_id = $2`, [team, MGR]));
  assert.equal(await sees(MGR), 0);
  assert.equal(await sees(OWN), 1);
});

// ---------------------------------------------------------------- suspected 3: the owner is not a superuser on hosted
test('suspected 3: a session of the functions\' owner may book even when that owner is not a superuser', async () => {
  const s = await space('Owner session');
  await db.exec(`create role fake_owner nosuperuser bypassrls; grant usage on schema public, auth to fake_owner;
    grant all on all tables in schema public to fake_owner; grant execute on all functions in schema public to fake_owner;
    create role someone_else nosuperuser; grant usage on schema public, auth to someone_else;
    grant execute on function public.can_book(uuid) to someone_else;
    alter function public.can_book(uuid) owner to fake_owner;
    alter function public.create_booking(uuid, timestamptz, timestamptz, text, text, text, int, bigint, boolean, text, text) owner to fake_owner;`);
  try {
    await db.exec(`set session authorization fake_owner`);
    assert.ok(await book(s, '2030-01-01', '2030-01-02'));
    await db.exec(`reset session authorization; set session authorization someone_else`);
    assert.equal((await one(`select public.can_book($1) as ok`, [s])).ok, false, 'any other non-superuser session is refused');
  } finally {
    await db.exec(`reset session authorization`); // this is the file's last test: the changed owners stay as they are
  }
});

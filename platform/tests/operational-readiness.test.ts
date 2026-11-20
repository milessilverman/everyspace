import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectCalendarObservation, IncompleteCalendarObservation } from '../supabase/functions/_shared/calendar-observation.ts';
import type { CalendarEvent } from '../supabase/functions/_shared/ical.ts';
import { freshDb } from './helpers/db.mjs';

const start = '2037-08-10T14:00:00Z';
const end = '2037-08-10T16:00:00Z';
const event = (uid: string, sequence = 1): CalendarEvent => ({
  uid, start, end, sequence, cancelled: false, allDay: false, kind: 'booking', summary: 'Reserved',
});

test('a complete paged observation deduplicates replays and preserves explicit changes', async () => {
  const initial = event('same');
  const removed = { ...event('removed', 3), cancelled: true };
  const seen: (string | null)[] = [];
  const read = await collectCalendarObservation(async (cursor) => {
    seen.push(cursor);
    return cursor === null
      ? { events: [initial], nextPage: 'next' }
      : { events: [initial, removed], nextPage: null };
  });
  assert.deepEqual(seen, [null, 'next']);
  assert.deepEqual(read, [initial, removed]);
});

test('interrupted, contradictory, looping and over-limit observations cannot publish partial reservations', async () => {
  await assert.rejects(collectCalendarObservation(async (cursor) => {
    if (cursor) throw new Error('Fixture transport stopped');
    return { events: [event('partial')], nextPage: 'next' };
  }), (error) => error instanceof IncompleteCalendarObservation && /final page/.test(error.message));
  await assert.rejects(collectCalendarObservation(async (cursor) => ({
    events: [event('same', cursor ? 2 : 1)], nextPage: cursor ? null : 'next',
  })), /changed while/);
  await assert.rejects(collectCalendarObservation(async () => ({ events: [], nextPage: 'loop' })), /read to the end/);
  await assert.rejects(collectCalendarObservation(async () => ({
    events: [event('one'), event('two')], nextPage: null,
  }), { pages: 1, events: 1 }), /supported event limit/);
});

const makeHost = async ({ one }: Awaited<ReturnType<typeof freshDb>>) => {
  const { id: host } = await one('insert into auth.users(id) values (gen_random_uuid()) returning id');
  const { id: property } = await one("insert into public.properties(host_id,title) values ($1,'Private property') returning id", [host]);
  const { id: space } = await one("insert into public.spaces(property_id,title,category) values ($1,'Pool','pool') returning id", [property]);
  await one("insert into public.channel_listings(space_id,channel) values ($1,'swimply')", [space]);
  return { host, space };
};

test('calendar monitoring preserves last good occupancy and clears after a complete retry', async () => {
  const database = await freshDb();
  const { db, one } = database;
  try {
    const { space } = await makeHost(database);
    const url = 'https://calendar.example/pilot.ics';
    const { id } = await one("insert into public.calendar_imports(space_id,channel,url) values ($1,'swimply',$2) returning id", [space, url]);
    const claim = async () => (await one('select public.claim_calendar_sync($1,$2,0) as lease', [id, url])).lease;
    const sync = (lease: string, rows: object[], error: string | null, issue: string | null) => one(
      "select public.apply_calendar_observation($1,$2,'America/Los_Angeles',$3,$4,$5) as result", [id, lease, rows, error, issue],
    );
    const rows = [{ external_uid: 'same', kind: 'booking', status: 'confirmed', starts_at: start, ends_at: end, all_day: false }];
    const first = await claim();
    assert.equal((await sync(first, rows, null, null)).result.status, 'ok');
    const success = (await one('select last_synced_at from public.calendar_imports where id = $1', [id])).last_synced_at;
    assert.equal((await sync(await claim(), [], 'Partial calendar', 'incomplete_import')).result.status, 'error');
    assert.deepEqual(await one('select last_issue,last_synced_at from public.calendar_imports where id = $1', [id]),
      { last_issue: 'incomplete_import', last_synced_at: success });
    assert.equal((await one('select status from public.reservations where space_id = $1', [space])).status, 'confirmed');
    assert.equal((await sync(first, [], 'Stale worker', 'fetch_failed')).result.status, 'superseded');
    assert.equal((await one('select last_issue from public.calendar_imports where id = $1', [id])).last_issue, 'incomplete_import');
    assert.equal((await sync(await claim(), rows, null, null)).result.status, 'ok');
    assert.equal((await one('select last_issue from public.calendar_imports where id = $1', [id])).last_issue, null);
  } finally {
    await db.close();
  }
});

test('operational warnings use host scope, expose safe counts, and do not resolve duplicate or uncertain bookings', async () => {
  const database = await freshDb();
  const { db, one } = database;
  try {
    const first = await makeHost(database);
    const second = await makeHost(database);
    const secretLink = 'https://calendar.example/private-test';
    await one(`insert into public.calendar_imports(space_id,channel,url,last_attempt_at,last_synced_at,last_status,last_issue)
      values ($1,'swimply',$3,now(),now()-interval '45 minutes','error','fetch_failed'),
             ($2,'swimply',$3,now(),null,'error','fetch_failed')`, [first.space, second.space, secretLink]);
    await one(`insert into public.reservations(space_id,channel,external_uid,source,starts_at,ends_at,calendar_missing_since)
      values ($1,'swimply','calendar-copy','ical',$2,$3,now()), ($1,'swimply','manual-copy','manual',$2,$3,null)`, [first.space, start, end]);
    await one(`insert into public.booking_holds(space_id,channel,starts_at,ends_at,created_at,expires_at)
      values ($1,'swimply',$2,$3,now()-interval '3 hours',now()+interval '3 hours'),
             ($1,'swimply',$2,$3,now()-interval '4 hours',now()-interval '1 second')`, [first.space, start, end]);
    await one(`insert into public.booking_email_reviews(space_id,channel,fingerprint,reported_status)
      values ($1,'swimply',repeat('f',64),'modified')`, [first.space]);
    const api = await one(`insert into public.channel_api_listings(space_id,channel,account_ref,listing_ref)
      values ($1,'airbnb','synthetic-account','synthetic-listing') returning id`, [first.space]);
    await one(`insert into public.channel_reservation_requests(listing_id,external_request_ref,status,starts_at,ends_at,approval_started_at)
      values ($1,'synthetic-request','uncertain',$2,$3,now()-interval '1 hour')`, [api.id, start, end]);

    await db.exec('set role anon');
    await assert.rejects(one('select public.host_operational_warnings()'), /permission denied/);
    await db.exec('set role authenticated');
    await one("select set_config('request.jwt.claim.sub',$1,false)", [first.host]);
    const { value: result } = await one('select public.host_operational_warnings() as value');
    const kinds = result.warnings.map(({ kind }: { kind: string }) => kind).sort();
    assert.deepEqual(kinds, ['email_update_review', 'failed_sync', 'incomplete_import', 'pending_reconciliation',
      'possible_duplicate', 'stale_calendar', 'unresolved_hold']);
    assert.equal(result.total, kinds.length);
    assert.ok(result.warnings.every((item: { space_id: string; affected: number }) => item.space_id === first.space && item.affected === 1));
    assert.doesNotMatch(JSON.stringify(result), /private-test|calendar-copy|synthetic-request/);
    await assert.rejects(one('select public.operational_readiness()'), /permission denied/);

    await one("select set_config('request.jwt.claim.sub',$1,false)", [second.host]);
    const { value: isolated } = await one('select public.host_operational_warnings() as value');
    assert.deepEqual(isolated.warnings, [{ kind: 'failed_sync', channel: 'swimply', affected: 1, space_id: second.space }]);

    await db.exec('set role service_role');
    const { value: aggregate } = await one('select public.operational_readiness() as value');
    assert.equal(aggregate.calendar_connections, 2);
    assert.equal(aggregate.warnings.failed_sync, 2);
    assert.equal(aggregate.warnings.pending_reconciliation, 1);
    assert.doesNotMatch(JSON.stringify(aggregate), /private-test|space_id|synthetic/);
    const { count } = await one("select count(*)::int as count from public.reservations where space_id = $1 and status = 'confirmed'", [first.space]);
    assert.equal(count, 2);
  } finally {
    await db.close();
  }
});

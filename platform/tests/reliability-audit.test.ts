import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createCalendarFetcher } from '../supabase/functions/_shared/fetch.ts';
import { parseProviderCalendar } from '../supabase/functions/_shared/ical.ts';
import { calendarRows } from '../supabase/functions/_shared/sync.ts';
import { parseBookingEmail } from '../supabase/functions/_shared/booking-email.ts';
import { enabledOperation, unavailableAdapter, type ChannelAdapter } from '../supabase/functions/_shared/channel-adapters.ts';
import { freshDb } from './helpers/db.mjs';

const ZONE = 'America/Los_Angeles';
const START = '2037-08-10T15:00:00Z';
const END = '2037-08-10T17:00:00Z';
let database: Awaited<ReturnType<typeof freshDb>>;
before(async () => { database = await freshDb(); });
after(async () => { await database?.db.close(); });

async function fixture(quantity = 1, turnover = 0) {
  const { one } = database;
  const { id: host } = await one('insert into auth.users(id) values (gen_random_uuid()) returning id');
  const { id: property } = await one("insert into public.properties(host_id, title) values ($1, 'Retreat') returning id", [host]);
  const { id: space } = await one(`insert into public.spaces(property_id, title, category, quantity, turnover_minutes)
    values ($1,'Pool','pool',$2,$3) returning id`, [property, quantity, turnover]);
  return { host, property, space };
}

const envelope = (...items: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...items, 'END:VCALENDAR'].join('\r\n');
const event = (...properties: string[]) => ['BEGIN:VEVENT', ...properties, 'END:VEVENT'].join('\r\n');

test('only complete, unambiguous snapshots participate in calendar writes', () => {
  const valid = event('UID:stay', 'DTSTART;VALUE=DATE:20370810', 'DTEND;VALUE=DATE:20370811', 'SEQUENCE:3', 'SUMMARY:Reserved');
  const block = event('UID:closed', 'DTSTART;VALUE=DATE:20370811', 'SUMMARY:Airbnb (Not available)');
  const echo = event('UID:274b1fd4-a6cf-4a8e-9f49-c570959c6d18@everyspace.app',
    'DTSTART;VALUE=DATE:20370812', 'SUMMARY:Not available');
  assert.deepEqual(parseProviderCalendar(envelope(valid, block, echo), ZONE, 'airbnb').map((e) => [e.kind, e.sequence]),
    [['booking', 3], ['block', undefined]]);
  assert.throws(() => parseProviderCalendar(envelope(valid).replace('END:VCALENDAR', ''), ZONE, 'airbnb'), /incomplete/);
  assert.throws(() => parseProviderCalendar(envelope(valid, valid), ZONE, 'airbnb'), /could not be verified/);
  const impossible = event('UID:x', 'DTSTART;TZID=America/Los_Angeles:20270314T023000', 'DTEND;TZID=America/Los_Angeles:20270314T043000');
  assert.throws(() => parseProviderCalendar(envelope(impossible), ZONE, 'airbnb'), /could not be verified/);
  assert.throws(() => parseProviderCalendar(envelope(valid.replace('END:VEVENT', 'RRULE:FREQ=DAILY\r\nEND:VEVENT')), ZONE, 'airbnb'), /unsupported/);
});

test('calendar access follows only separately approved HTTPS redirects', async () => {
  const seen: string[] = [];
  const reader = createCalendarFetcher('calendar-one.example,calendar-two.example', async (url, init) => {
    const host = new URL(String(url)).hostname;
    seen.push(host);
    assert.equal(init?.redirect, 'manual');
    return host === 'calendar-two.example'
      ? new Response(envelope())
      : new Response(null, { status: 302, headers: { location: 'https://calendar-two.example/sample.ics' } });
  });
  assert.equal(await reader('https://calendar-one.example/sample.ics'), envelope());
  assert.deepEqual(seen, ['calendar-one.example', 'calendar-two.example']);
  await assert.rejects(reader('https://not-approved.example/sample.ics'), /needs verification/);
  assert.equal(seen.length, 2);
  const disabledRedirect = createCalendarFetcher('calendar-one.example', async () =>
    new Response(null, { status: 302, headers: { location: 'https://calendar-two.example/sample.ics' } }));
  await assert.rejects(disabledRedirect('https://calendar-one.example/sample.ics'), /needs verification/);
});

async function calendarFixture(quantity = 1) {
  const { host, property, space } = await fixture(quantity);
  const url = 'https://calendar.example/sample.ics';
  const { one } = database;
  const { id } = await one("insert into public.calendar_imports(space_id, channel, url) values ($1, 'airbnb', $2) returning id", [space, url]);
  const claim = async (link = url) => (await one('select public.claim_calendar_sync($1,$2,0) as lease', [id, link])).lease;
  const apply = async (lease: string, rows: ReturnType<typeof calendarRows>, error = null) =>
    (await one('select public.apply_calendar_sync($1,$2,$3,$4,$5) as result', [id, lease, ZONE, rows, error])).result;
  return { id, host, property, space, url, claim, apply };
}

const busyEvent = (uid: string, sequence = 3, status = 'confirmed', ends = END) =>
  [{ external_uid: uid, kind: 'booking' as const, status: status as 'confirmed' | 'cancelled',
    calendar_sequence: sequence, starts_at: START, ends_at: ends, all_day: false }];

test('calendar snapshots preserve disappeared bookings and ignore earlier explicit revisions', async () => {
  const c = await calendarFixture(2);
  const { one } = database;
  assert.equal((await c.apply(await c.claim(), busyEvent('original'))).status, 'ok');
  const disappeared = await c.apply(await c.claim(), []);
  assert.equal(disappeared.status, 'needs_review');
  assert.equal(disappeared.missing, 1);
  const active = await one('select status, calendar_missing_since from public.reservations where space_id = $1', [c.space]);
  assert.equal(active.status, 'confirmed');
  assert.ok(active.calendar_missing_since);
  await assert.rejects(one("select public.place_hold($1, 'swimply', $2, $3, false)", [c.space, START, END]), /above capacity/);

  const older = await c.apply(await c.claim(), busyEvent('original', 2, 'cancelled'));
  assert.equal(older.older, 1);
  assert.equal((await one('select status from public.reservations where space_id = $1', [c.space])).status, 'confirmed');
  assert.equal((await c.apply(await c.claim(), busyEvent('original', 4, 'cancelled'))).status, 'ok');
  assert.equal((await one('select status from public.reservations where space_id = $1', [c.space])).status, 'cancelled');
  assert.ok(await one("select public.place_hold($1, 'swimply', $2, $3, false)", [c.space, START, END]));
});

test('calendar link changes discard in-flight reads and failed reads preserve the last success', async () => {
  const c = await calendarFixture();
  const { one, db } = database;
  const first = await c.claim();
  assert.equal(await c.claim(), null);
  await c.apply(first, busyEvent('current'));
  const success = (await one('select last_synced_at from public.calendar_imports where id = $1', [c.id])).last_synced_at;
  const failed = await c.claim();
  assert.equal((await one("select public.apply_calendar_sync($1,$2,$3,'[]','Calendar unavailable') as value", [c.id, failed, ZONE])).value.status, 'error');
  assert.deepEqual((await one('select last_synced_at from public.calendar_imports where id = $1', [c.id])).last_synced_at, success);

  const stale = await c.claim();
  const newUrl = 'https://calendar.example/replacement.ics';
  try {
    await db.exec('set role authenticated');
    await one("select set_config('request.jwt.claim.sub',$1,false)", [c.host]);
    await assert.rejects(one("update public.calendar_imports set last_status = 'ok' where id = $1", [c.id]), /permission denied/);
    await one('update public.calendar_imports set url = $2 where id = $1', [c.id, newUrl]);
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub');
  }
  assert.equal((await c.apply(stale, busyEvent('old-response', 3, 'cancelled'))).status, 'superseded');
  assert.equal((await one('select status from public.reservations where space_id = $1', [c.space])).status, 'confirmed');
  assert.ok(await c.claim(newUrl));
});

test('the final manual guard rejects a changed feed or time zone', async () => {
  const c = await calendarFixture();
  const { one } = database;
  await one(`insert into public.channel_listings(space_id, channel, booking_mode, status)
    values ($1,'airbnb','instant','live')`, [c.space]);
  const held = await one("select public.place_hold($1,'direct',$2,$3,false) as id", [c.space, START, END]);
  const snapshot = async () => (await one('select public.manual_guard_snapshot($1) as value', [c.space])).value;
  const mark = async (observed: object) =>
    (await one('select public.mark_hold_checked_snapshot($1,$2) as ok', [held.id, observed])).ok;
  const first = await snapshot();
  await one('update public.calendar_imports set url = $2 where id = $1', [c.id, 'https://calendar.example/replacement.ics']);
  assert.equal(await mark(first), null);
  const second = await snapshot();
  await assert.rejects(one("update public.properties set timezone = 'Invalid/Zone' where id = $1", [c.property]), /valid property time zone/);
  await one("update public.properties set timezone = 'America/New_York' where id = $1", [c.property]);
  assert.equal(await mark(second), null);
  assert.equal(await mark(await snapshot()), true);
});

test('instant-listing alerts only apply to the current calendar observation', async () => {
  const c = await calendarFixture();
  const { one } = database;
  await one("insert into public.channel_listings(space_id, channel, booking_mode, status) values ($1,'airbnb','instant','live')", [c.space]);
  const { id: booking } = await one(`insert into public.reservations(space_id, channel, external_uid, source, starts_at, ends_at)
    values ($1,'direct','pending-closure','manual',$2,$3) returning id`, [c.space, START, END]);
  const older = await c.apply(await c.claim(), []);
  const current = await c.apply(await c.claim(), []);
  const report = (seenAt: string) => one('select public.record_calendar_door_gaps($1,$2,$3,$4) as count', [c.id, seenAt, [booking], []]);
  assert.equal((await report(older.seen_at)).count, 0);
  assert.equal((await report(current.seen_at)).count, 1);
});

test('an export excludes foreign calendar closures and contains more than the REST row limit', async () => {
  const { space } = await fixture();
  const { one } = database;
  await one(`insert into public.reservations(space_id, channel, external_uid, source, starts_at, ends_at)
    select $1, 'direct', 'confirmed-' || n, 'manual',
      '2037-01-01'::timestamptz + n * interval '1 hour', '2037-01-01'::timestamptz + n * interval '1 hour' + interval '20 minutes'
    from generate_series(1, 1001) n`, [space]);
  await one(`insert into public.reservations(space_id, channel, external_uid, source, kind, starts_at, ends_at)
    values ($1,'airbnb','closed','ical','block',$2,$3)`, [space, START, END]);
  const result = await one("select jsonb_array_length(public.calendar_feed_snapshot($1,'vrbo')) as total", [space]);
  assert.equal(result.total, 1001);
});

test('a managed confirmation and a managed extension can never exceed local capacity', async () => {
  const { space } = await fixture(1, 20);
  const { one } = database;
  const confirm = (ref: string, start: string, end: string) => one(`insert into public.reservations
    (space_id, channel, external_uid, source, starts_at, ends_at) values ($1,'everyspace',$2,'everyspace',$3,$4) returning id`,
  [space, ref, start, end]);
  const first = await confirm('first', START, END);
  await assert.rejects(confirm('overlapping', '2037-08-10T17:05:00Z', '2037-08-10T19:00:00Z'), /exceed confirmed capacity/);
  const second = await confirm('adjacent', '2037-08-10T17:20:00Z', '2037-08-10T19:00:00Z');
  await assert.rejects(one("update public.reservations set ends_at = '2037-08-10T17:30Z' where id = $1", [first.id]), /exceed confirmed capacity/);
  assert.ok(second.id);
  await assert.rejects(one('update public.spaces set turnover_minutes = 30 where id = $1', [space]), /conflict with a managed booking/);
});

test('unknown iCal unit demand is surfaced as a conflict when a known booking overlaps it', async () => {
  const c = await calendarFixture(4);
  const { one } = database;
  await one("insert into public.reservations(space_id, channel, external_uid, source, starts_at, ends_at) values ($1,'direct','test','manual',$2,$3)",
    [c.space, START, END]);
  await c.apply(await c.claim(), busyEvent('unknown-units'));
  assert.equal((await one('select count(*)::int as count from public.conflicts where space_id = $1 and resolved_at is null', [c.space])).count, 1);
});

test('verified external moves are versioned and report conflicts instead of rewriting other bookings', async () => {
  const { host, space } = await fixture();
  const { one, db } = database;
  await one(`insert into public.reservations(space_id, channel, source, external_uid, starts_at, ends_at)
    values ($1, 'airbnb','ical','other','2037-08-10T17:30Z','2037-08-10T20:00Z')`, [space]);
  try {
    await db.exec('set role authenticated');
    await one("select set_config('request.jwt.claim.sub',$1,false)", [host]);
    const row = await one(`select public.record_external_booking($1,'direct',$2,$3,false,1,'changeable') as id`, [space, START, END]);
    const original = await one('select updated_at from public.reservations where id = $1', [row.id]);
    const edit = (end: string) => one('select public.record_external_booking_change($1,$2,$3,$4,false,1) as ok',
      [row.id, original.updated_at, START, end]);
    assert.equal((await edit('2037-08-10T18:00:00Z')).ok, true);
    assert.equal((await edit('2037-08-10T18:00:00Z')).ok, true);
    await assert.rejects(edit('2037-08-10T19:00:00Z'), /changed since/);
    assert.equal((await one('select count(*)::int as count from public.conflicts where space_id = $1 and resolved_at is null', [space])).count, 1);
    assert.equal((await one('select public.cancel_recorded_external_booking($1) as ok', [row.id])).ok, true);
    assert.equal((await one('select count(*)::int as count from public.conflicts where space_id = $1 and resolved_at is null', [space])).count, 0);
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub');
  }
});

test('repeating the same host command cannot create a second multi-unit hold', async () => {
  const { host, space } = await fixture(3);
  const { one, db } = database;
  const command = crypto.randomUUID();
  try {
    await db.exec('set role authenticated');
    await one("select set_config('request.jwt.claim.sub',$1,false)", [host]);
    const submit = (units: number) => one("select public.place_inventory_hold_once($1,'direct',$2,$3,false,null,null,$4,$5) as id",
      [space, START, END, units, command]);
    assert.deepEqual(await submit(1), await submit(1));
    await assert.rejects(submit(2), /already created a hold/);
    assert.equal((await one('select count(*)::int as count from public.booking_holds where space_id = $1', [space])).count, 1);
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub');
  }
});

test('provider operations require independent authorization, testing and activation', () => {
  const off = unavailableAdapter('swimply');
  const run = async () => {};
  const entries = [
    { authorized: false, tested: true, enabled: true },
    { authorized: true, tested: false, enabled: true },
    { authorized: true, tested: true, enabled: false },
  ];
  assert.equal(enabledOperation(off, 'approve'), undefined);
  for (const gate of entries) {
    const adapter: ChannelAdapter<'swimply'> = { ...off, operations: { approve: { ...gate, run } } };
    assert.equal(enabledOperation(adapter, 'approve'), undefined);
  }
  const adapter: ChannelAdapter<'swimply'> = { ...off, operations: { approve: { authorized: true, tested: true, enabled: true, run } } };
  assert.equal(enabledOperation(adapter, 'approve'), run);
  assert.equal(enabledOperation(adapter, 'cancel'), undefined);
});

test('removing a tracked listing unlinks its feeds atomically and retains recorded occupancy', async () => {
  const c = await calendarFixture();
  const { one, db } = database;
  await c.apply(await c.claim(), busyEvent('retain-this'));
  const { id } = await one("insert into public.channel_listings(space_id, channel) values ($1,'airbnb') returning id", [c.space]);
  await one("insert into public.calendar_feeds(space_id, for_channel) values ($1,'airbnb')", [c.space]);
  const outsider = await fixture();
  try {
    await db.exec('set role authenticated');
    await one("select set_config('request.jwt.claim.sub',$1,false)", [outsider.host]);
    assert.equal((await one('select public.remove_tracked_listing($1) as removed', [id])).removed, false);
    await one("select set_config('request.jwt.claim.sub',$1,false)", [c.host]);
    assert.equal((await one('select public.remove_tracked_listing($1) as removed', [id])).removed, true);
    for (const table of ['channel_listings', 'calendar_imports', 'calendar_feeds']) {
      assert.equal((await one(`select count(*)::int as count from public.${table} where space_id = $1`, [c.space])).count, 0);
    }
    assert.equal((await one('select status from public.reservations where space_id = $1', [c.space])).status, 'confirmed');
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub');
  }
});

test('extension and refund notices remain separate review events without occupancy or money movement', async () => {
  const source = { text: 'Reservation code: TEST-11', timeZone: ZONE };
  for (const [subject, state] of [['Fwd: Booking extended', 'modified'], ['Fwd: Booking extension requested', 'modified'], ['Fwd: Refund issued', 'refund']]) {
    const parsed = parseBookingEmail({ ...source, subject });
    assert.equal(parsed.status, state);
    assert.equal(parsed.startsAt, null);
  }
  const { host, space } = await fixture();
  const { one, db } = database;
  await one("insert into public.channel_listings(space_id, channel, status) values ($1,'swimply','live')", [space]);
  const review = await one(`insert into public.booking_email_reviews(space_id, channel, fingerprint, reported_status)
    values ($1,'swimply',repeat('0', 64),'refund') returning id`, [space]);
  try {
    await db.exec('set role authenticated');
    await one("select set_config('request.jwt.claim.sub',$1,false)", [host]);
    for (const action of ['hold', 'record']) {
      await assert.rejects(one('select public.review_booking_email($1,$2,$3,$4,false,1,$5)',
        [review.id, action, START, END, 'TEST-11']), /reconcile the original calendar entry/);
    }
    assert.equal((await one('select status from public.booking_email_reviews where id = $1', [review.id])).status, 'needs_review');
    assert.equal((await one('select count(*)::int as count from public.reservations where space_id = $1', [space])).count, 0);
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub');
  }
});

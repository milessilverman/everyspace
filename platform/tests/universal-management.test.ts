import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import PostalMime from 'postal-mime';
import { CATEGORY_NAMES, CHANNEL_GROUPS, INTEGRATIONS } from '../../host/integration-catalog.mjs';
import { emailFingerprint, parseBookingEmail } from '../supabase/functions/_shared/booking-email.ts';
import { reservationInstant, reservationRange } from '../supabase/functions/_shared/reservation-time.ts';
import { feedEvents } from '../supabase/functions/_shared/sync.ts';
import { freshDb } from './helpers/db.mjs';

const LA = 'America/Los_Angeles';
let database: Awaited<ReturnType<typeof freshDb>>;
before(async () => { database = await freshDb(); });
after(async () => { await database?.db.close(); });

test('the registry preserves the 22 demo platforms, requested groups, and launch priorities', () => {
  for (const page of ['index.html', 'everyspace.html']) {
    const html = readFileSync(new URL(`../../${page}`, import.meta.url), 'utf8');
    const source = html.match(/const PLATFORMS = (\{[\s\S]*?\n\});/)?.[1];
    const catalog = new Function(`return ${source}`)();
    assert.equal(Object.keys(catalog).length, 22);
    assert.deepEqual(Object.keys(INTEGRATIONS).sort(), Object.keys(catalog).sort());
    for (const [id, entry] of Object.entries(INTEGRATIONS)) assert.equal(entry.name, catalog[id].name);
  }
  assert.equal(Object.keys(CATEGORY_NAMES).length, 7);
  assert.deepEqual(CHANNEL_GROUPS.flatMap(([, ids]) => ids).sort(), Object.keys(INTEGRATIONS).sort());
  assert.deepEqual(Object.keys(INTEGRATIONS).filter((id) => INTEGRATIONS[id].priority).sort(),
    ['airbnb', 'booking_com', 'neighbor', 'peerspace', 'sniffspot', 'spothero', 'swimply', 'vrbo']);
  const states = new Set(['implemented', 'verified', 'planned', 'unsupported', 'unverified']);
  for (const entry of Object.values(INTEGRATIONS)) {
    assert.equal(entry.apiAccess, 'disabled');
    assert.equal(entry.manual.status, 'implemented');
    for (const method of [entry.calendarImport, entry.calendarExport, entry.bookingEmail, entry.api, entry.forwardedEmail, entry.forwardingAddress]) {
      assert.ok(states.has(method.status));
      if (['verified', 'unsupported'].includes(method.status)) assert.ok(method.source.startsWith('https://'));
    }
  }
  assert.equal(INTEGRATIONS.furnished_finder.calendarImport.status, 'unsupported');
  assert.equal(INTEGRATIONS.neighbor.api.status, 'unverified');
  assert.equal(INTEGRATIONS.peerspace.calendarExport.status, 'unverified');
});

test('all catalog and legacy channel identifiers are valid database channels', async () => {
  const { rows } = await database.db.query<{ id: string }>('select unnest(enum_range(null::public.channel))::text as id');
  assert.deepEqual(rows.map(({ id }) => id).sort(), [...Object.keys(INTEGRATIONS), 'direct', 'other', 'everyspace'].sort());
});

async function fixture(quantity = 1, turnover = 0) {
  const { one } = database;
  const { id: host } = await one('insert into auth.users(id) values (gen_random_uuid()) returning id');
  const { id: property } = await one("insert into public.properties(host_id, title) values ($1, 'House') returning id", [host]);

  async function addSpace(label: string, max: number, clean: number, parent: string | null = null) {
    const { id } = await one(`insert into public.spaces(property_id, title, category, quantity, turnover_minutes, parent_space_id)
      values ($1, $2, 'other', $3, $4, $5) returning id`, [property, label, max, clean, parent]);
    return id;
  }
  const space = await addSpace('House', quantity, turnover);
  return { host, property, space, addSpace };
}

const day = '2037-07-14';
const at = (hour: string) => `${day}T${hour}:00Z`;
const hold = (space: string, start: string, end: string, units = 1) => database.one(
  "select public.place_inventory_hold($1, 'direct', $2, $3, false, null, null, $4) as id", [space, start, end, units]);

async function book(space: string, start: string, end: string, units = 1, channel = 'direct') {
  const { id } = await database.one(`insert into public.reservations(space_id, channel, external_uid, source, starts_at, ends_at, units)
    values ($1, $5, gen_random_uuid()::text, 'manual', $2, $3, $4) returning id`, [space, start, end, units, channel]);
  return id;
}

test('hourly multi-unit holds use peak concurrent capacity instead of counting every intersecting booking', async () => {
  const { space } = await fixture(3);
  await book(space, at('10:00'), at('11:00'));
  await book(space, at('11:00'), at('12:00'));
  const selected = await hold(space, at('10:00'), at('12:00'), 2);
  assert.equal((await database.one('select units from public.booking_holds where id = $1', [selected.id])).units, 2);
  assert.equal((await database.one('select public.mark_hold_safe($1) as ok', [selected.id])).ok, true);
  await assert.rejects(hold(space, at('11:15'), at('11:30')), /already taken or above capacity/);
  await assert.rejects(hold(space, at('14:15'), at('15:30'), 4), /space capacity/);
});

test('cleanup extends a booking and its candidate hold while half-open boundaries still work', async () => {
  const { space } = await fixture(1, 30);
  await book(space, at('12:00'), at('13:00'));
  await assert.rejects(hold(space, at('13:15'), at('14:00')), /already taken/);
  await assert.rejects(hold(space, at('10:00'), at('11:45')), /already taken/);
  assert.ok((await hold(space, at('13:30'), at('14:00'))).id);
});

test('exclusive pool blocks an overnight whole-property booking while a driveway can book independently', async () => {
  const { space: home, addSpace } = await fixture(1);
  const pool = await addSpace('Pool', 1, 15, home);
  const driveway = await addSpace('Independent driveway', 1, 0);
  await hold(pool, at('17:00'), at('18:00'));
  const night = reservationRange(day, '2037-07-15', true, LA);
  await assert.rejects(database.one("select public.place_hold($1, 'airbnb', $2, $3)", [home, night.startsAt, night.endsAt]), /already taken/);
  assert.ok(await hold(driveway, at('17:00'), at('18:00')));
});

test('recorded conflicts respect capacity and clear when the property is within capacity again', async () => {
  const { space } = await fixture(2, 30);
  const { one } = database;
  await book(space, at('10:00'), at('11:00'));
  await book(space, at('11:00'), at('12:00'));
  assert.equal((await one('select public.detect_conflicts($1) as n', [space])).n, 0);
  const third = await book(space, at('11:00'), at('11:15'));
  assert.equal((await one('select public.detect_conflicts($1) as n', [space])).n, 3);
  await one("update public.reservations set status = 'cancelled' where id = $1", [third]);
  assert.equal((await one('select public.detect_conflicts($1) as n', [space])).n, 0);
  assert.equal((await one('select count(*)::int as n from public.conflicts where space_id = $1 and resolved_at is null', [space])).n, 0);
});

test('buffer-only conflicts are detected for parent and child reservations', async () => {
  const { addSpace, space: home } = await fixture(1, 30);
  const pool = await addSpace('Pool', 1, 0, home);
  await book(home, at('10:00'), at('11:00'));
  await book(pool, at('11:15'), at('12:00'));
  assert.equal((await database.one('select public.detect_conflicts($1) as n', [pool])).n, 1);
  const events = (await database.db.query('select ends_at from public.calendar_feed_reservations($1)', [pool])).rows;
  assert.ok(events.some((event) => new Date(event.ends_at).toISOString() === '2037-07-14T11:30:00.000Z'));
});

test('a manual guard result is invalidated by a change to cleanup or the instant listing', async () => {
  const { space } = await fixture(1, 20);
  const held = await hold(space, at('10:00'), at('11:00'));
  const { one } = database;
  const verify = (doors: object[], turnover: number) =>
    one('select public.mark_hold_safe_snapshot($1, $2, $3) as ok', [held.id, doors, turnover]);
  assert.equal((await verify([], 0)).ok, null);
  await one("insert into public.channel_listings(space_id, channel, status, booking_mode) values ($1, 'airbnb', 'live', 'instant')", [space]);
  assert.equal((await verify([], 20)).ok, null);
  assert.equal((await verify([{ space_id: space, channel: 'airbnb' }], 20)).ok, true);
});

test('date-only booking spans use the property zone and honor DST length', () => {
  const range = reservationRange('2027-03-14', '2027-03-15', true, LA);
  assert.deepEqual(range, { startsAt: '2027-03-14T08:00:00.000Z', endsAt: '2027-03-15T07:00:00.000Z' });
  assert.equal(reservationInstant('2027-01-14T10:00', false, 'America/New_York'), '2027-01-14T15:00:00.000Z');
  assert.throws(() => reservationInstant('2027-02-30', true, LA), /calendar date/);
  assert.throws(() => reservationInstant('2027-03-14T02:30', false, LA), /skipped or repeated/);
  assert.throws(() => reservationInstant('2027-11-07T01:30', false, LA), /skipped or repeated/);
  assert.equal(reservationInstant('2027-11-07T01:30-07:00', false, LA), '2027-11-07T08:30:00.000Z');
  assert.equal(reservationInstant('2027-11-07T01:30-08:00', false, LA), '2027-11-07T09:30:00.000Z');
});

test('all-day calendar exports cover partial cleanup', () => {
  assert.deepEqual(feedEvents({ forChannel: 'vrbo', timeZone: LA, now: '2037-07-01T07:00:00Z', rows: [{
    id: 'stay', channel: 'airbnb', status: 'confirmed', all_day: true,
    starts_at: '2037-07-14T07:00:00Z', ends_at: '2037-07-15T07:30:00Z',
  }] }), [{ id: 'stay', start: '2037-07-14', end: '2037-07-16' }]);
});

const mail = (text: string, subject = '') => parseBookingEmail({ text, subject, timeZone: LA });

test('forwarded overnight and hourly notices normalize to dates, status, and units', async () => {
  const text = 'Confirmation code: C8-12\nCheck-in: Tuesday, July 14, 2037\nCheck-out: July 17, 2037';
  const overnight = mail(text, 'Fwd: Booking confirmed');
  assert.deepEqual(overnight, {
    startsAt: '2037-07-14T07:00:00.000Z', endsAt: '2037-07-17T07:00:00.000Z', allDay: true,
    status: 'confirmed', reference: 'C8-12', units: 1, issues: [],
  });
  const quoted = '> ' + text.replaceAll('\n', '\n> ');
  assert.equal(await emailFingerprint(overnight, text), await emailFingerprint(mail(quoted, 'Fwd: Booking confirmed'), quoted));
  assert.notEqual(await emailFingerprint(overnight, text), await emailFingerprint(mail(text, 'Booking cancelled'), text));
  const timed = mail('Status: Request\nBooking reference: SB-95\nDate: 2037-07-14\nStart time: 11:30 AM\nEnd time: 2:00 PM\nUnits: 2');
  assert.equal(timed.allDay, false);
  assert.equal(timed.startsAt, '2037-07-14T18:30:00.000Z');
  assert.equal(timed.endsAt, '2037-07-14T21:00:00.000Z');
  assert.equal(timed.units, 2);
});

test('ambiguous dates and contradictory details remain in review without an inferred reservation', async () => {
  const text = 'Check-in: 7/14/37\nCheck-out: 7/15/37\nUnits: several\nReference: missing code';
  const parsed = mail(text);
  assert.equal(parsed.startsAt, null);
  assert.equal(parsed.status, 'unknown');
  assert.equal(parsed.units, null);
  for (const issue of ['dates_unverified', 'status_unverified', 'units_unverified', 'reference_unverified']) assert.ok(parsed.issues.includes(issue));
  assert.equal(await emailFingerprint(parsed, text), await emailFingerprint(parsed, text.replaceAll('\n', '\r\n') + '\r\n'));
  assert.ok(mail('Check-in: 2037-07-14\nCheck-in: 2037-07-15\nCheck-out: 2037-07-16').issues.includes('conflicting_details'));
});

test('saved MIME messages decode before parsing without reading the original inbox', async () => {
  const raw = [
    'From: sender@example.test', 'To: host@example.test', 'Subject: Fwd: Booking request', 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from('Booking code: EX-01\nStart: 2037-07-14T23:00\nEnd: 2037-07-15T01:00\n').toString('base64'),
  ].join('\r\n');
  const decoded = await PostalMime.parse(raw, { maxNestingDepth: 12, maxHeadersSize: 16 * 1024 });
  const parsed = mail(decoded.text ?? '', decoded.subject);
  assert.equal(parsed.reference, 'EX-01');
  assert.equal(parsed.status, 'request');
  assert.equal(parsed.endsAt, '2037-07-15T08:00:00.000Z');
  assert.ok(!JSON.stringify(parsed).includes('sender@example.test'));
});

test('email intake is scoped and idempotent, and a host review makes an atomic hold', async () => {
  const { host, space } = await fixture();
  const other = await fixture();
  const { db, one } = database;
  await one("insert into public.channel_listings(space_id, channel) values ($1, 'swimply')", [space]);
  const insert = `insert into public.booking_email_reviews(space_id, channel, fingerprint, reported_status, reference)
    values ($1, 'swimply', repeat('a', 64), 'request', 'S-1') on conflict (space_id, channel, fingerprint) do nothing returning id`;
  const { id } = await one(insert, [space]);
  assert.equal(await one(insert, [space]), undefined);
  assert.equal((await one('select count(*)::int as n from public.booking_holds where space_id = $1', [space])).n, 0);
  const accept = () => one("select public.review_booking_email($1, 'hold', $2, $3, false, 1, 'S-1') as hold", [id, at('12:00'), at('13:00')]);
  try {
    await db.exec('set role anon');
    await assert.rejects(one("select public.review_booking_email($1, 'dismiss')", [id]), /permission denied/);
    await db.exec('reset role; set role authenticated;');
    await one("select set_config('request.jwt.claim.sub', $1, false)", [other.host]);
    assert.equal(await one('select id from public.booking_email_reviews where id = $1', [id]), undefined);
    await assert.rejects(accept(), /not found/);
    await one("select set_config('request.jwt.claim.sub', $1, false)", [host]);
    assert.ok((await one('select id from public.booking_email_reviews where id = $1', [id])).id);
    await assert.rejects(one('select fingerprint from public.booking_email_reviews where id = $1', [id]), /permission denied/);
    const first = await accept();
    assert.deepEqual(await accept(), first);
    assert.equal((await one('select status from public.booking_email_reviews where id = $1', [id])).status, 'held');
    assert.equal((await one('select count(*)::int as n from public.reservations where space_id = $1', [space])).n, 0);
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub');
  }
});

test('host-recorded email confirmations detect outside conflicts and keep stable reservation identity', async () => {
  const { host, space } = await fixture();
  const { db, one } = database;
  await one("insert into public.channel_listings(space_id, channel) values ($1, 'giggster')", [space]);
  await book(space, at('13:00'), at('15:00'));
  const { id } = await one(`insert into public.booking_email_reviews(space_id, channel, fingerprint, reported_status)
    values ($1, 'giggster', repeat('b', 64), 'confirmed') returning id`, [space]);
  const record = "select public.review_booking_email($1, 'record', $2, $3, false, 1, 'GG-1') as booking";
  try {
    await db.exec('set role authenticated');
    await one("select set_config('request.jwt.claim.sub', $1, false)", [host]);
    const first = await one(record, [id, at('12:00'), at('14:00')]);
    assert.deepEqual(await one(record, [id, at('12:00'), at('14:00')]), first);
    assert.equal((await one('select source from public.reservations where id = $1', [first.booking])).source, 'email');
    assert.equal((await one('select count(*)::int as n from public.conflicts where space_id = $1 and resolved_at is null', [space])).n, 1);
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub');
  }
});

test('a host can record and cancel a confirmation for a manual hold without a provider calendar', async () => {
  const { host, space } = await fixture(2);
  const other = await fixture();
  const { db, one } = database;
  const held = await hold(space, at('13:00'), at('15:00'), 2);
  const submit = () => one(`select public.record_external_booking($1, 'direct', $2, $3, false, 2,
    'MANUAL-1', 'manual', $4) as id`, [space, at('13:00'), at('15:00'), held.id]);
  try {
    await db.exec('set role authenticated');
    await one("select set_config('request.jwt.claim.sub', $1, false)", [other.host]);
    await assert.rejects(submit(), /Space not found/);
    await one("select set_config('request.jwt.claim.sub', $1, false)", [host]);
    const booking = await submit();
    assert.deepEqual(await submit(), booking);
    assert.equal((await one('select status from public.booking_holds where id = $1', [held.id])).status, 'confirmed');
    await assert.rejects(hold(space, at('13:00'), at('15:00')), /already taken/);
    const cancel = () => one('select public.cancel_recorded_external_booking($1) as ok', [booking.id]);
    await one("select set_config('request.jwt.claim.sub', $1, false)", [other.host]);
    assert.equal((await cancel()).ok, false);
    await one("select set_config('request.jwt.claim.sub', $1, false)", [host]);
    assert.equal((await cancel()).ok, true);
    assert.equal((await one('select status from public.reservations where id = $1', [booking.id])).status, 'cancelled');
    assert.ok(await hold(space, at('13:00'), at('15:00'), 2));
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub');
  }
});

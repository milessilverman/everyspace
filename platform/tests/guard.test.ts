import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, localDayToUtc } from '../supabase/functions/_shared/ical.ts';
import { checkDoor, doorGaps, describeDates, describeDays, describeNights } from '../supabase/functions/_shared/guard.ts';

const LA = 'America/Los_Angeles';
const cal = (...ev: string[]) => parseIcs(`BEGIN:VCALENDAR\n${ev.join('\n')}\nEND:VCALENDAR`, { defaultTimeZone: LA });
const day = (uid: string, s: string, e: string, summary: string, extra = '') =>
  `BEGIN:VEVENT\nUID:${uid}\nDTSTART;VALUE=DATE:${s}\nDTEND;VALUE=DATE:${e}\nSUMMARY:${summary}\n${extra}END:VEVENT`;
const hold = (s: string, e: string) => ({ starts_at: localDayToUtc(s, LA), ends_at: localDayToUtc(e, LA) });

test('safe only when the instant site shows the whole stay closed', () => {
  const h = hold('2026-12-01', '2026-12-04');
  assert.deepEqual(checkDoor({ hold: h, timeZone: LA, doorEvents: cal() }).ok, false);
  // Closed in two pieces that touch: covered.
  assert.deepEqual(checkDoor({ hold: h, timeZone: LA, doorEvents: cal(
    day('b1', '20261201', '20261203', 'Airbnb (Not available)'), day('b2', '20261203', '20261205', 'Airbnb (Not available)')) }), { ok: true });
  // Only the first two nights closed: tells you exactly which night is still open.
  const partial = checkDoor({ hold: h, timeZone: LA, doorEvents: cal(day('b1', '20261201', '20261203', 'Airbnb (Not available)')) });
  assert.deepEqual(partial, { ok: false, reason: 'not_closed', gapStart: localDayToUtc('2026-12-03', LA), gapEnd: localDayToUtc('2026-12-04', LA) });
});

test('a guest booking on the instant site wins: decline the request', () => {
  const r = checkDoor({ hold: hold('2026-12-01', '2026-12-04'), timeZone: LA, doorEvents: cal(
    day('b1', '20261201', '20261204', 'Airbnb (Not available)'), day('HMX123', '20261203', '20261206', 'Reserved')) });
  assert.deepEqual(r, { ok: false, reason: 'taken', uid: 'HMX123' });
  // A cancelled booking doesn't count.
  const c = checkDoor({ hold: hold('2026-12-01', '2026-12-04'), timeZone: LA, doorEvents: cal(
    day('b1', '20261201', '20261204', 'Blocked'), day('HMX9', '20261203', '20261206', 'Reserved', 'STATUS:CANCELLED\n')) });
  assert.deepEqual(c, { ok: true });
});

test('an hourly pool booking is covered by a closed day on Airbnb', () => {
  const h = { starts_at: '2026-12-05T21:00:00.000Z', ends_at: '2026-12-06T00:00:00.000Z' }; // 1–4 PM in LA
  assert.deepEqual(checkDoor({ hold: h, timeZone: LA, doorEvents: cal(day('b', '20261205', '20261206', 'Airbnb (Not available)')) }), { ok: true });
  assert.equal(checkDoor({ hold: h, timeZone: LA, doorEvents: cal(day('b', '20261206', '20261207', 'Airbnb (Not available)')) }).ok, false);
});

test('a live calendar check accounts for cleanup after the instant listing’s booking', () => {
  const doorEvents = cal(
    day('house-stay', '20261204', '20261205', 'Reserved'),
    day('closed', '20261205', '20261206', 'Airbnb (Not available)'),
  );
  const check = (starts_at: string) => checkDoor({
    hold: { starts_at, ends_at: '2026-12-05T10:00:00.000Z' }, timeZone: LA, doorEvents, bookingTurnoverMinutes: 30,
  });
  assert.deepEqual(check('2026-12-05T08:15:00.000Z'), { ok: false, reason: 'taken', uid: 'house-stay' });
  assert.deepEqual(check('2026-12-05T08:30:00.000Z'), { ok: true });
});

test('guard lists every booking the instant site no longer shows as busy', () => {
  const gaps = doorGaps({ timeZone: LA, doorEvents: cal(day('x', '20261210', '20261213', 'Airbnb (Not available)')), required: [
    { id: 'vrbo-stay', ...hold('2026-12-10', '2026-12-13') },
    { id: 'reopened', ...hold('2026-12-20', '2026-12-22') },
    { id: 'half', ...hold('2026-12-12', '2026-12-15') },
  ] });
  assert.deepEqual(gaps, ['reopened', 'half']);
});

test('dates read the way hosts say them', () => {
  assert.equal(describeDates(localDayToUtc('2026-12-01', LA), localDayToUtc('2026-12-04', LA), true, LA), 'Dec 1 – Dec 4');
  assert.equal(describeDates('2026-12-05T21:00:00.000Z', '2026-12-06T00:00:00.000Z', false, LA), 'Dec 5, 1:00 PM – 4:00 PM');
});

test('closing instructions name the nights, not the check-out day', () => {
  assert.equal(describeNights(localDayToUtc('2026-12-01', LA), localDayToUtc('2026-12-04', LA), LA), 'the nights of Dec 1 – Dec 3');
  assert.equal(describeNights(localDayToUtc('2026-12-08', LA), localDayToUtc('2026-12-09', LA), LA), 'the night of Dec 8');
});

test('hourly bookings ask for the whole day to be closed on day-based sites', () => {
  assert.equal(describeDays('2026-12-20T21:00:00.000Z', '2026-12-21T00:00:00.000Z', LA), 'all of Dec 20');
});

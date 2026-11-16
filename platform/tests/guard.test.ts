import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, localDayToUtc } from '../supabase/functions/_shared/ical.ts';
import { checkDoor, doorGaps, describeDates } from '../supabase/functions/_shared/guard.ts';

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

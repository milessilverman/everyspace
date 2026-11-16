import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, buildIcs, fold, overlaps, parseIcsDate } from '../supabase/functions/_shared/ical.ts';

// Shaped like Airbnb's export: all-day stays, owner blocks, folded description lines.
const AIRBNB = [
  'BEGIN:VCALENDAR', 'PRODID;X-RICAL-TZSOURCE=TZINFO:-//Airbnb Inc//Hosting Calendar 1.0//EN', 'CALSCALE:GREGORIAN', 'VERSION:2.0',
  'BEGIN:VEVENT', 'DTEND;VALUE=DATE:20261123', 'DTSTART;VALUE=DATE:20261120', 'UID:1418fb94e984-abc@airbnb.com',
  'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMABCDEF\\nPhone Number (Last 4 Dig',
  ' its): 1234', 'SUMMARY:Reserved', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTEND;VALUE=DATE:20261202', 'DTSTART;VALUE=DATE:20261130', 'UID:7f3c-blocked@airbnb.com', 'SUMMARY:Airbnb (Not available)', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parses Airbnb-style stays and blocks as all-day events', () => {
  const ev = parseIcs(AIRBNB);
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[0], { uid: '1418fb94e984-abc@airbnb.com', start: '2026-11-20', end: '2026-11-23', allDay: true, summary: 'Reserved', cancelled: false, kind: 'booking' });
  assert.equal(ev[1].kind, 'block');
});

test('converts TZID times to UTC, including across daylight saving', () => {
  const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART;TZID=America/Los_Angeles:20260715T130000\nDTEND;TZID=America/Los_Angeles:20260715T160000\nSUMMARY:Pool party\nEND:VEVENT\n'
    + 'BEGIN:VEVENT\nUID:b\nDTSTART;TZID=America/Los_Angeles:20261215T130000\nDTEND;TZID=America/Los_Angeles:20261215T160000\nEND:VEVENT\nEND:VCALENDAR';
  const [summer, winter] = parseIcs(ics);
  assert.equal(summer.start, '2026-07-15T20:00:00.000Z'); // PDT = UTC-7
  assert.equal(winter.start, '2026-12-15T21:00:00.000Z'); // PST = UTC-8
  assert.equal(summer.allDay, false);
});

test('floating times use the property time zone', () => {
  const r = parseIcsDate('20261120T150000', '', 'America/Los_Angeles');
  assert.deepEqual(r, { value: '2026-11-20T23:00:00.000Z', allDay: false });
});

test('fills a missing end, skips empty events, reads cancellations', () => {
  const ics = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART;VALUE=DATE:20261201\nSUMMARY:Booked\\, thanks\nEND:VEVENT\n'
    + 'BEGIN:VEVENT\nUID:y\nDTSTART:20261201T100000Z\nDTEND:20261201T100000Z\nEND:VEVENT\n'
    + 'BEGIN:VEVENT\nUID:z\nDTSTART:20261203T100000Z\nDTEND:20261203T120000Z\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR';
  const ev = parseIcs(ics);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].end, '2026-12-02');
  assert.equal(ev[0].summary, 'Booked, thanks');
  assert.equal(ev[1].cancelled, true);
});

test('rejects text that is not a calendar', () => {
  assert.throws(() => parseIcs('<html>Sign in</html>'), /calendar file/);
});

test('builds a feed that parses back to the same dates, without guest details', () => {
  const ics = buildIcs({ name: 'Pool (Everyspace)', now: '2026-11-16T00:00:00Z', events: [
    { id: 'r1', start: '2026-11-20', end: '2026-11-23' },
    { id: 'r2', start: '2026-11-21T21:00:00.000Z', end: '2026-11-22T00:00:00.000Z' },
  ] });
  assert.match(ics, /\r\n/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  const back = parseIcs(ics);
  assert.deepEqual(back.map((e) => [e.start, e.end, e.summary]), [['2026-11-20', '2026-11-23', 'Not available'], ['2026-11-21T21:00:00.000Z', '2026-11-22T00:00:00.000Z', 'Not available']]);
});

test('folds long lines at 75 octets and they unfold again', () => {
  const long = `SUMMARY:${'Lakeview cottage — '.repeat(10)}`;
  const folded = fold(long);
  for (const line of folded.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75);
  const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:f\r\nDTSTART;VALUE=DATE:20261201\r\n${folded}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
  assert.equal(parseIcs(ics)[0].summary, long.slice(8).trim().slice(0, 160)); // titles are capped at 160 characters
});

test('finds double bookings across sites and ignores cancelled ones', () => {
  const pairs = overlaps([
    { id: 'airbnb', start: '2026-11-20', end: '2026-11-23' },
    { id: 'vrbo', start: '2026-11-22', end: '2026-11-25' },
    { id: 'swimply', start: '2026-11-23', end: '2026-11-24' },
    { id: 'old', start: '2026-11-20', end: '2026-11-30', cancelled: true },
  ]);
  assert.deepEqual(pairs.map(([a, b]) => `${a.id}+${b.id}`), ['airbnb+vrbo', 'vrbo+swimply']);
});

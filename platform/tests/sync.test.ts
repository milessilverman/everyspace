import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, localDayToUtc, utcToLocalDay } from '../supabase/functions/_shared/ical.ts';
import { calendarRows, feedEvents } from '../supabase/functions/_shared/sync.ts';

const LA = 'America/Los_Angeles';
const NOW = '2026-11-16T18:00:00.000Z';

test('local days anchor to LA midnight and back', () => {
  assert.equal(localDayToUtc('2026-11-20', LA), '2026-11-20T08:00:00.000Z');
  assert.equal(localDayToUtc('2026-07-04', LA), '2026-07-04T07:00:00.000Z');
  assert.equal(utcToLocalDay('2026-11-20T08:00:00.000Z', LA), '2026-11-20');
});

test('snapshot normalization uses local dates and leaves old events outside the import horizon', () => {
  const events = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:keep\nDTSTART;VALUE=DATE:20261120\nDTEND;VALUE=DATE:20261123\nSUMMARY:Reserved\nEND:VEVENT\n'
    + 'BEGIN:VEVENT\nUID:old\nDTSTART;VALUE=DATE:20260101\nDTEND;VALUE=DATE:20260103\nEND:VEVENT\nEND:VCALENDAR');
  const rows = calendarRows(events, LA, NOW);
  assert.deepEqual(rows.map((r) => [r.external_uid, r.starts_at, r.ends_at, r.all_day]), [['keep', '2026-11-20T08:00:00.000Z', '2026-11-23T08:00:00.000Z', true]]);
});

test('feed: leaves out the reading site, cancelled and long-past rows; dates stay in local time', () => {
  const ev = feedEvents({ forChannel: 'airbnb', timeZone: LA, now: NOW, rows: [
    { id: 'a', channel: 'airbnb', status: 'confirmed', starts_at: '2026-11-20T08:00:00Z', ends_at: '2026-11-23T08:00:00Z', all_day: true },
    { id: 'v', channel: 'vrbo', status: 'confirmed', starts_at: '2026-11-25T08:00:00Z', ends_at: '2026-11-28T08:00:00Z', all_day: true },
    { id: 's', channel: 'swimply', status: 'confirmed', starts_at: '2026-11-21T21:00:00.000Z', ends_at: '2026-11-22T00:00:00.000Z', all_day: false },
    { id: 'x', channel: 'vrbo', status: 'cancelled', starts_at: '2026-11-29T08:00:00Z', ends_at: '2026-11-30T08:00:00Z', all_day: true },
    { id: 'p', channel: 'vrbo', status: 'confirmed', starts_at: '2026-10-01T07:00:00Z', ends_at: '2026-10-03T07:00:00Z', all_day: true },
  ] });
  assert.deepEqual(ev, [
    { id: 's', start: '2026-11-21T21:00:00.000Z', end: '2026-11-22T00:00:00.000Z' },
    { id: 'v', start: '2026-11-25', end: '2026-11-28' },
  ]);
});

test('feed: a whole-house stay on Airbnb still blocks the room\'s separate Airbnb listing', () => {
  const ev = feedEvents({ forChannel: 'airbnb', spaceId: 'room', timeZone: LA, now: NOW, rows: [
    { id: 'own', space_id: 'room', channel: 'airbnb', status: 'confirmed', starts_at: '2026-11-20T08:00:00Z', ends_at: '2026-11-22T08:00:00Z', all_day: true },
    { id: 'house', space_id: 'house', channel: 'airbnb', status: 'confirmed', starts_at: '2026-12-01T08:00:00Z', ends_at: '2026-12-04T08:00:00Z', all_day: true },
  ] });
  assert.deepEqual(ev, [{ id: 'house', start: '2026-12-01', end: '2026-12-04' }]);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, localDayToUtc, utcToLocalDay } from '../supabase/functions/_shared/ical.ts';
import {
  planImport, feedEvents, backoffMs, shouldSkipImport, isStale, decideRead, emptyReadsSoFar, successPatch, failurePatch, emptyFeedPatch,
  errorCodeOf, explainSyncError, type ImportRecord,
} from '../supabase/functions/_shared/sync.ts';
import { ProviderError } from '../supabase/functions/_shared/providers/adapter.ts';

const LA = 'America/Los_Angeles';
const NOW = '2026-11-16T18:00:00.000Z';

test('local days anchor to LA midnight and back', () => {
  assert.equal(localDayToUtc('2026-11-20', LA), '2026-11-20T08:00:00.000Z');
  assert.equal(localDayToUtc('2026-07-04', LA), '2026-07-04T07:00:00.000Z');
  assert.equal(utcToLocalDay('2026-11-20T08:00:00.000Z', LA), '2026-11-20');
});

test('import: upserts stays, cancels future ones that vanished, keeps past ones', () => {
  const events = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:keep\nDTSTART;VALUE=DATE:20261120\nDTEND;VALUE=DATE:20261123\nSUMMARY:Reserved\nEND:VEVENT\n'
    + 'BEGIN:VEVENT\nUID:old\nDTSTART;VALUE=DATE:20260101\nDTEND;VALUE=DATE:20260103\nEND:VEVENT\nEND:VCALENDAR');
  const plan = planImport({ events, timeZone: LA, now: NOW, existing: [
    { external_uid: 'keep', status: 'confirmed', ends_at: '2026-11-23T08:00:00Z' },
    { external_uid: 'gone-future', status: 'confirmed', ends_at: '2026-12-05T08:00:00Z' },
    { external_uid: 'gone-past', status: 'confirmed', ends_at: '2026-11-01T08:00:00Z' },
  ] });
  assert.deepEqual(plan.upserts.map((r) => [r.external_uid, r.starts_at, r.ends_at, r.all_day]), [['keep', '2026-11-20T08:00:00.000Z', '2026-11-23T08:00:00.000Z', true]]);
  assert.deepEqual(plan.cancelUids, ['gone-future']);
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

// ---- resilience: backoff, staleness, empty-feed guard (pure; `now` is passed in)

const MIN = 60_000; const HOUR = 60 * MIN;
const at = (msAgo: number) => new Date(Date.parse(NOW) - msAgo).toISOString();

test('backoff schedule: none when healthy, then 30 min, 1 h, 2 h, 4 h, capped at 6 h', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(backoffMs), [0, 30 * MIN, 60 * MIN, 2 * HOUR, 4 * HOUR, 6 * HOUR, 6 * HOUR, 6 * HOUR]);
  assert.equal(backoffMs(-1), 0);
});

test('an import is skipped until its backoff has passed', () => {
  const skip = (ago: number, failures: number) => shouldSkipImport({ lastAttemptAt: at(ago), consecutiveFailures: failures }, NOW);
  assert.equal(skip(5 * MIN, 0), false); // healthy imports follow the 15-minute schedule
  assert.equal(skip(29 * MIN, 1), true);
  assert.equal(skip(31 * MIN, 1), false);
  assert.equal(skip(59 * MIN, 2), true);
  assert.equal(skip(5 * HOUR, 5), true);
  assert.equal(skip(6 * HOUR + MIN, 20), false);
  assert.equal(shouldSkipImport({ lastAttemptAt: null, consecutiveFailures: 4 }, NOW), false);
});

test('stale: never read OK, last OK over 3 hours ago, or 3 failures in a row', () => {
  assert.equal(isStale({ lastOkAt: null, consecutiveFailures: 0 }, NOW), true);
  assert.equal(isStale({ lastOkAt: at(10 * MIN), consecutiveFailures: 0 }, NOW), false);
  assert.equal(isStale({ lastOkAt: at(3 * HOUR), consecutiveFailures: 0 }, NOW), false); // exactly 3 h is not over
  assert.equal(isStale({ lastOkAt: at(3 * HOUR + 1), consecutiveFailures: 0 }, NOW), true);
  assert.equal(isStale({ lastOkAt: at(MIN), consecutiveFailures: 2 }, NOW), false);
  assert.equal(isStale({ lastOkAt: at(MIN), consecutiveFailures: 3 }, NOW), true);
  assert.equal(isStale({ lastOkAt: at(MIN), consecutiveFailures: 0 }, new Date(NOW)), false); // Date objects work too
});

test('empty-feed guard: first and second empty reads change nothing, the third is accepted', () => {
  let rec: ImportRecord = { event_count: 4, last_error: null, consecutive_failures: 0, last_ok_at: at(HOUR) };
  const run = (events: number, i: number) => {
    const d = decideRead(rec, events);
    const now = at(-i * 15 * MIN);
    rec = { ...rec, ...(d.kind === 'hold_empty' ? emptyFeedPatch(rec, d.emptyReads, now) : successPatch(now, events)) };
    return d;
  };
  assert.deepEqual(run(0, 1), { kind: 'hold_empty', emptyReads: 1 });
  assert.equal(rec.last_error, 'empty_feed:1'); assert.equal(rec.event_count, 4); assert.equal(rec.consecutive_failures, 1);
  assert.deepEqual(run(0, 2), { kind: 'hold_empty', emptyReads: 2 });
  assert.equal(rec.last_error, 'empty_feed:2'); assert.equal(rec.event_count, 4); assert.equal(rec.consecutive_failures, 2);
  assert.deepEqual(run(0, 3), { kind: 'apply' });
  assert.equal(rec.event_count, 0); assert.equal(rec.consecutive_failures, 0); assert.equal(rec.last_error, null);
  assert.deepEqual(run(0, 4), { kind: 'apply' }); // it had no events, so an empty read is normal now
});

test('empty-feed guard: a non-empty read, or any other error, resets the count; a feed that never had events is not held', () => {
  const held: ImportRecord = { event_count: 4, last_error: 'empty_feed:2', consecutive_failures: 2 };
  assert.deepEqual(decideRead(held, 1), { kind: 'apply' });
  assert.deepEqual(decideRead({ ...held, last_error: 'timeout' }, 0), { kind: 'hold_empty', emptyReads: 1 });
  assert.deepEqual(decideRead({ event_count: 0, last_error: null }, 0), { kind: 'apply' });
  assert.deepEqual(decideRead({ event_count: null }, 0), { kind: 'apply' });
  assert.equal(emptyReadsSoFar({ last_error: 'empty_feed:2' }), 2); assert.equal(emptyReadsSoFar({ last_error: 'fetch_failed' }), 0);
});

test('outcome patches: success resets failures and records last_ok_at; failure counts up with a URL-free code', () => {
  assert.deepEqual(successPatch(NOW, 3), { last_synced_at: NOW, last_ok_at: NOW, last_status: 'ok', last_error: null, consecutive_failures: 0, event_count: 3 });
  const f = failurePatch({ consecutive_failures: 2 }, 'timeout', NOW);
  assert.deepEqual(f, { last_synced_at: NOW, last_status: 'error', last_error: 'timeout', consecutive_failures: 3 });
  assert.ok(!('last_ok_at' in f) && !('event_count' in f), 'a failure never touches last_ok_at or event_count');
  assert.equal(failurePatch({}, 'x', NOW).consecutive_failures, 1);
});

test('error codes: ProviderError codes pass through; anything else is a generic code with no message', () => {
  assert.equal(errorCodeOf(new ProviderError('blocked_url', 'https://x/?token=SECRET')), 'blocked_url');
  assert.equal(errorCodeOf(new Error('duplicate key at https://x/?token=SECRET')), 'sync_failed');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { code: 'space_not_found' })), 'space_not_found');
  assert.equal(errorCodeOf(Object.assign(new Error('x'), { code: '23505; DROP' })), 'sync_failed');
  assert.equal(errorCodeOf(null), 'sync_failed');
  assert.match(explainSyncError('empty_feed:2'), /empty calendar/); assert.equal(explainSyncError(null), '');
});

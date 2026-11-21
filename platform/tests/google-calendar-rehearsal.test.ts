import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rehearseGoogleCalendar, type CalendarRehearsal } from '../staging/google-calendar-rehearsal.ts';

const empty: CalendarRehearsal = {
  calendarId: 'dedicated-pool-fixture', timeZone: 'America/Los_Angeles', syncToken: null, busy: [], reviews: [],
};
const pool = {
  id: 'pool-window', status: 'confirmed', updated: '2037-05-01T08:00:00Z',
  start: { dateTime: '2037-07-16T15:00:00-07:00' }, end: { dateTime: '2037-07-16T17:30:00-07:00' },
  summary: 'private fixture title', description: 'private fixture text', attendees: [{ email: 'test@example.invalid' }],
};
const confirmed = await rehearseGoogleCalendar(empty, async () => ({
  status: 200, body: { items: [pool], nextSyncToken: 'known-cursor' },
}));

test('Google fixture pages use one dedicated calendar and commit only on the final token', async () => {
  const read: (string | null)[] = [];
  const state = await rehearseGoogleCalendar(empty, async ({ calendarId, syncToken, pageToken }) => {
    assert.equal(calendarId, empty.calendarId);
    assert.equal(syncToken, null);
    read.push(pageToken);
    return pageToken === null
      ? { status: 200, body: { items: [pool], nextPageToken: 'next-page' } }
      : { status: 200, body: { items: [pool, {
        id: 'all-day', status: 'confirmed', updated: pool.updated, start: { date: '2037-07-18' }, end: { date: '2037-07-19' },
      }], nextSyncToken: 'checkpoint' } };
  });
  assert.deepEqual(read, [null, 'next-page']);
  assert.equal(state.syncToken, 'checkpoint');
  assert.deepEqual(state.busy.map(({ startsAt, endsAt, allDay }) => [startsAt, endsAt, allDay]), [
    ['2037-07-16T22:00:00.000Z', '2037-07-17T00:30:00.000Z', false],
    ['2037-07-18T07:00:00.000Z', '2037-07-19T07:00:00.000Z', true],
  ]);
  assert.doesNotMatch(JSON.stringify(state), /private fixture|test@example/);
  await assert.rejects(rehearseGoogleCalendar({ ...empty, calendarId: 'primary' },
    () => assert.fail('Read requires explicit dedicated calendar')), /dedicated Calendar ID/);
});

test('a partial, contradictory or unauthorized Calendar response leaves the prior checkpoint intact', async () => {
  const before = structuredClone(confirmed);
  for (const status of [403, 503]) {
    await assert.rejects(rehearseGoogleCalendar(confirmed, async ({ syncToken, pageToken }) => {
      assert.equal(syncToken, 'known-cursor');
      return pageToken ? { status } : { status: 200, body: { items: [pool], nextPageToken: 'partial' } };
    }), /could not be completed/);
  }
  await assert.rejects(rehearseGoogleCalendar(confirmed, async ({ pageToken }) => pageToken
    ? { status: 200, body: { items: [{ id: pool.id, status: 'cancelled' }], nextSyncToken: 'next' } }
    : { status: 200, body: { items: [pool], nextPageToken: 'page' } }), /disagree/);
  await assert.rejects(rehearseGoogleCalendar(confirmed, async () => ({ status: 200, body: { items: [pool] } })), /checkpoint/);
  assert.deepEqual(confirmed, before);
});

test('a 410 discards the partial read and rebuilds from a full read without clearing known occupancy', async () => {
  const seen: (string | null)[] = [];
  const state = await rehearseGoogleCalendar(confirmed, async ({ syncToken, pageToken }) => {
    seen.push(syncToken);
    if (syncToken && !pageToken) return { status: 200, body: { items: [{ ...pool, id: 'discarded' }], nextPageToken: 'partial' } };
    if (syncToken) return { status: 410 };
    return { status: 200, body: { nextSyncToken: 'replacement-cursor' } };
  });
  assert.deepEqual(seen, ['known-cursor', 'known-cursor', null]);
  assert.deepEqual(state.busy, confirmed.busy);
  assert.deepEqual(state.reviews, [{ id: pool.id, reason: 'missing' }]);
  assert.equal(state.syncToken, 'replacement-cursor');
});

test('Google moves, old revisions, and deletion markers do not release previously observed busy time', async () => {
  const changed = await rehearseGoogleCalendar(confirmed, async () => ({ status: 200, body: {
    items: [{ ...pool, updated: '2037-05-02T08:00:00Z', start: { dateTime: '2037-07-16T16:00:00-07:00' } }],
    nextSyncToken: 'changed',
  } }));
  assert.equal(changed.busy.length, 2);
  assert.deepEqual(changed.reviews, [{ id: pool.id, reason: 'moved' }]);
  const stale = await rehearseGoogleCalendar(changed, async () => ({ status: 200, body: {
    items: [pool], nextSyncToken: 'stale',
  } }));
  assert.deepEqual(stale.busy, changed.busy);
  assert.deepEqual(stale.reviews, [{ id: pool.id, reason: 'stale' }]);
  const cancelled = await rehearseGoogleCalendar(stale, async () => ({ status: 200, body: {
    items: [{ id: pool.id, status: 'cancelled' }], nextSyncToken: 'gone',
  } }));
  assert.deepEqual(cancelled.busy, changed.busy);
  assert.deepEqual(cancelled.reviews, [{ id: pool.id, reason: 'cancelled' }]);
});

// Run synthetic Google Calendar responses through the read-only observation rules.
// This module has no network, database, OAuth or provider mutation code.
import { reservationInstant } from '../supabase/functions/_shared/reservation-time.ts';

type EventTime = { date?: string; dateTime?: string; timeZone?: string };
type Event = {
  id: string;
  status?: string;
  transparency?: string;
  updated?: string;
  start?: EventTime;
  end?: EventTime;
};
type Page = { items?: readonly Event[]; nextPageToken?: string; nextSyncToken?: string };
type ReadPage = (request: { calendarId: string; syncToken: string | null; pageToken: string | null }) =>
  Promise<{ status: number; body?: Page }>;

type BusyWindow = { id: string; startsAt: string; endsAt: string; allDay: boolean; revision: number };
type ReviewReason = 'cancelled' | 'missing' | 'moved' | 'stale' | 'unverified';
type Change = { id: string; review: 'cancelled' | 'unverified' } | { id: string; window: BusyWindow };
export type CalendarRehearsal = {
  calendarId: string;
  timeZone: string;
  syncToken: string | null;
  busy: BusyWindow[];
  reviews: { id: string; reason: ReviewReason }[];
};

function normalize(event: Event, timeZone: string): Change {
  const { id, start, end } = event;
  if (typeof id !== 'string' || !id || id.length > 512) throw new Error('Calendar event identity could not be verified.');
  if (event.status === 'cancelled') return { id, review: 'cancelled' };
  if (event.status !== 'confirmed' || event.transparency === 'transparent') return { id, review: 'unverified' };
  const allDay = typeof start?.date === 'string';
  const revision = Date.parse(event.updated ?? '');
  if (!Number.isFinite(revision) || !start || !end
      || (allDay ? !end.date || start.dateTime || end.dateTime : !start.dateTime || !end.dateTime || end.date)) {
    throw new Error('Calendar event revision or date range could not be verified.');
  }
  const startsAt = reservationInstant(allDay ? start.date : start.dateTime, allDay, start.timeZone ?? timeZone);
  const endsAt = reservationInstant(allDay ? end.date : end.dateTime, allDay, end.timeZone ?? timeZone);
  if (endsAt <= startsAt) throw new Error('Calendar event date range could not be verified.');
  return { id, window: { id, startsAt, endsAt, allDay, revision } };
}

async function readPages(state: CalendarRehearsal, load: ReadPage, syncToken: string | null) {
  const changes = new Map<string, Change>();
  const seenTokens = new Set<string>();
  let pageToken: string | null = null;
  let count = 0;
  for (let page = 0; page < 30; page++) {
    const response = await load({ calendarId: state.calendarId, syncToken, pageToken });
    if (response.status === 410 && syncToken) return null;
    if (response.status !== 200 || !response.body) throw new Error('Calendar observation could not be completed.');
    const { items = [], nextPageToken, nextSyncToken } = response.body;
    count += items.length;
    if (count > 3000) throw new Error('Calendar observation exceeds the event limit.');
    for (const event of items) {
      const change = normalize(event, state.timeZone);
      const previous = changes.get(change.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(change)) {
        throw new Error('Calendar pages disagree about an event.');
      }
      changes.set(change.id, change);
    }
    if (!nextPageToken && nextSyncToken) return { changes, syncToken: nextSyncToken };
    if (!nextPageToken || nextSyncToken || seenTokens.has(nextPageToken)) break;
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  throw new Error('Calendar observation has no complete checkpoint.');
}

const windowKey = (window: BusyWindow) => JSON.stringify([window.id, window.startsAt, window.endsAt, window.allDay]);

export async function rehearseGoogleCalendar(state: CalendarRehearsal, load: ReadPage): Promise<CalendarRehearsal> {
  if (!state.calendarId || state.calendarId === 'primary') throw new Error('A dedicated Calendar ID is required.');
  const incremental = await readPages(state, load, state.syncToken);
  // Google 410 invalidates its cursor. A full read may replace the calendar view,
  // but missing calendar events cannot invalidate previously observed occupancy.
  const observation = incremental ?? await readPages(state, load, null);
  if (!observation) throw new Error('Calendar observation could not be completed.');
  const fullRead = !state.syncToken || !incremental;
  const busy = new Map(state.busy.map((item) => [windowKey(item), item]));
  const latest = new Map<string, BusyWindow>();
  const reviews = new Map(state.reviews.map(({ id, reason }) => [id, reason]));
  for (const window of state.busy) {
    const recorded = latest.get(window.id);
    if (!recorded || recorded.revision < window.revision) latest.set(window.id, window);
    if (fullRead && !observation.changes.has(window.id)) reviews.set(window.id, 'missing');
  }
  for (const change of observation.changes.values()) {
    if ('review' in change) {
      reviews.set(change.id, change.review);
      continue;
    }
    const current = latest.get(change.id);
    const moved = current && windowKey(current) !== windowKey(change.window);
    if (current && (change.window.revision < current.revision || (moved && change.window.revision === current.revision))) {
      reviews.set(change.id, 'stale');
      continue;
    }
    if (moved) reviews.set(change.id, 'moved');
    busy.set(windowKey(change.window), change.window);
  }
  return { ...state, syncToken: observation.syncToken, busy: [...busy.values()],
    reviews: [...reviews].map(([id, reason]) => ({ id, reason })) };
}

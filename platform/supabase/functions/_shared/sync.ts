// What to write when a site's calendar is read, and what to publish when a site reads ours.
// Pure functions (no database, no network) so they can be tested directly.
import { type CalendarEvent, localDayToUtc, utcToLocalDay, type FeedEvent } from './ical.ts';

export type ExistingReservation = { external_uid: string; status: 'confirmed' | 'cancelled'; ends_at: string };
export type ReservationRow = {
  external_uid: string; kind: 'booking' | 'block'; status: 'confirmed' | 'cancelled';
  starts_at: string; ends_at: string; all_day: boolean; summary: string;
};

const ms = (v: string) => Date.parse(v);
const KEEP_PAST_DAYS = 30;

/**
 * Turns a freshly read calendar into database changes for one space and one site.
 * - Every event becomes an upsert keyed by its UID (all-day dates are anchored to the property's local midnight).
 * - A future reservation we had before that is missing from the feed now was cancelled on that site.
 *   Past ones simply age out of feeds, so they are left alone.
 */
export function planImport({ events, existing, timeZone, now = new Date().toISOString() }:
  { events: CalendarEvent[]; existing: ExistingReservation[]; timeZone: string; now?: string }): { upserts: ReservationRow[]; cancelUids: string[] } {
  const cutoff = ms(now) - KEEP_PAST_DAYS * 86_400_000;
  const upserts: ReservationRow[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const starts_at = e.allDay ? localDayToUtc(e.start, timeZone) : e.start;
    const ends_at = e.allDay ? localDayToUtc(e.end, timeZone) : e.end;
    seen.add(e.uid);
    if (ms(ends_at) < cutoff) continue;
    upserts.push({ external_uid: e.uid, kind: e.kind, status: e.cancelled ? 'cancelled' : 'confirmed', starts_at, ends_at, all_day: e.allDay, summary: e.summary });
  }
  const cancelUids = (events.length ? existing : []).filter((r) => r.status === 'confirmed' && !seen.has(r.external_uid) && ms(r.ends_at) > ms(now)).map((r) => r.external_uid);
  return { upserts, cancelUids };
}

/** First local date outside a half-open range, including the day of a partial cleanup period. */
function exclusiveLocalEnd(end: string, timeZone: string): string {
  const lastDay = utcToLocalDay(new Date(ms(end) - 1).toISOString(), timeZone);
  return new Date(ms(lastDay) + 86_400_000).toISOString().slice(0, 10);
}

export type BusyRow = { id: string; space_id?: string; channel: string; status: string; starts_at: string; ends_at: string; all_day: boolean };

/**
 * Busy times to publish to one site: everything confirmed on this space (and on its parent space, since booking the
 * whole house blocks a room inside it) except what came from that same site for this same listing, which it already
 * knows about. A whole-house Airbnb stay still goes into the room's Airbnb feed: Airbnb treats them as separate listings.
 * All-day stays go out as dates in the property's time zone; hourly bookings go out as exact times. Sites that
 * only understand whole days (like Airbnb) will block the whole day for an hourly booking, which is the safe side.
 */
export function feedEvents({ rows, forChannel, spaceId, timeZone, now = new Date().toISOString() }:
  { rows: BusyRow[]; forChannel: string; spaceId?: string; timeZone: string; now?: string }): FeedEvent[] {
  const ownListing = (r: BusyRow) => r.channel === forChannel && (!spaceId || !r.space_id || r.space_id === spaceId);
  return rows
    .filter((r) => r.status === 'confirmed' && !ownListing(r) && ms(r.ends_at) > ms(now) - 86_400_000)
    .sort((a, b) => ms(a.starts_at) - ms(b.starts_at))
    .map((r) => (r.all_day
      ? { id: r.id, start: utcToLocalDay(r.starts_at, timeZone), end: exclusiveLocalEnd(r.ends_at, timeZone) }
      : { id: r.id, start: r.starts_at, end: r.ends_at }));
}

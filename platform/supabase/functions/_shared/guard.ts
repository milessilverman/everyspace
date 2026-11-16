// No double bookings, ever: the checks behind "safe to accept".
//
// Why calendar links alone are not enough: each site re-reads other calendars on its own schedule (Airbnb: every few
// hours). If two sites can both confirm a booking instantly, a guest can book in that gap. So Everyspace enforces:
//   1. One open door: for any physical space, at most one site takes Instant Book (enforced in the database).
//   2. Every other booking starts as a request. Everyspace holds the dates (a database lock, so no second request can
//      take them), the dates get closed on the instant site, Everyspace reads that site's calendar live to prove it,
//      and only then says "safe to accept".
//   3. A guard re-checks every 15 minutes that the instant site still shows every other booking as closed.
// Pure functions (no network, no database) so they are tested directly.
import { type CalendarEvent, localDayToUtc } from './ical.ts';

export const SITE_NAMES: Record<string, string> = {
  everyspace: 'Everyspace', airbnb: 'Airbnb', vrbo: 'Vrbo', booking_com: 'Booking.com', expedia: 'Expedia',
  furnished_finder: 'Furnished Finder', swimply: 'Swimply', peerspace: 'Peerspace', neighbor: 'Neighbor', spothero: 'SpotHero',
  sniffspot: 'Sniffspot', hipcamp: 'Hipcamp', getmyboat: 'GetMyBoat', outdoorsy: 'Outdoorsy', rvshare: 'RVshare',
  craigslist: 'Craigslist', facebook: 'Facebook', direct: 'Direct', other: 'the other site',
};
export const siteName = (c: string) => SITE_NAMES[c] ?? c;

/**
 * Sites whose calendar export tells a guest's booking apart from a date the host closed (Airbnb: "Reserved" vs
 * "Airbnb (Not available)"; Vrbo: "Reserved" vs "Blocked"). Only these can be checked by calendar link. Booking.com's
 * export marks both as "CLOSED - Not available", so it needs its direct (API) connection before it can be checked.
 */
export const VERIFIABLE_BY_CALENDAR = new Set(['airbnb', 'vrbo']);

type Range = [number, number];
const range = (e: CalendarEvent, timeZone: string): Range => (e.allDay
  ? [Date.parse(localDayToUtc(e.start, timeZone)), Date.parse(localDayToUtc(e.end, timeZone))]
  : [Date.parse(e.start), Date.parse(e.end)]);

/** The first stretch of [start, end) that none of the ranges cover, or null if fully covered. */
function firstGap(start: number, end: number, ranges: Range[]): Range | null {
  let at = start;
  for (const [s, e] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (s > at) break;
    if (e > at) at = e;
    if (at >= end) return null;
  }
  return at >= end ? null : [at, Math.min(end, ranges.filter(([s]) => s > at).map(([s]) => s).sort((a, b) => a - b)[0] ?? end)];
}

export type DoorCheck =
  | { ok: true }
  | { ok: false; reason: 'taken'; uid: string }
  | { ok: false; reason: 'not_closed'; gapStart: string; gapEnd: string };

/**
 * Is a held stretch of time safely closed on the instant site? Reads that site's live calendar:
 * - a guest booking overlapping it there means the instant site sold it first: decline the request;
 * - otherwise the whole stretch must be covered by dates the host closed there.
 */
export function checkDoor({ hold, doorEvents, timeZone }:
  { hold: { starts_at: string; ends_at: string }; doorEvents: CalendarEvent[]; timeZone: string }): DoorCheck {
  const s = Date.parse(hold.starts_at); const e = Date.parse(hold.ends_at);
  const live = doorEvents.filter((ev) => !ev.cancelled);
  for (const ev of live) {
    const [a, b] = range(ev, timeZone);
    if (ev.kind === 'booking' && a < e && b > s) return { ok: false, reason: 'taken', uid: ev.uid };
  }
  const gap = firstGap(s, e, live.filter((ev) => ev.kind === 'block').map((ev) => range(ev, timeZone)));
  return gap ? { ok: false, reason: 'not_closed', gapStart: new Date(gap[0]).toISOString(), gapEnd: new Date(gap[1]).toISOString() } : { ok: true };
}

/**
 * Guard: which bookings (and safe holds) from other sites are not shown as busy on the instant site right now?
 * Any busy event counts here; a guest booking on top of another booking is caught separately as a double booking.
 */
export function doorGaps({ required, doorEvents, timeZone }:
  { required: { id: string; starts_at: string; ends_at: string }[]; doorEvents: CalendarEvent[]; timeZone: string }): string[] {
  const busy = doorEvents.filter((ev) => !ev.cancelled).map((ev) => range(ev, timeZone));
  return required.filter((r) => firstGap(Date.parse(r.starts_at), Date.parse(r.ends_at), busy) !== null).map((r) => r.id);
}

/** "Dec 1 – Dec 4" (all-day, end exclusive shown as checkout day) or "Dec 1, 2:00 PM – 5:00 PM" in the property's zone. */
export function describeDates(startIso: string, endIso: string, allDay: boolean, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' });
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  const s = new Date(startIso); const e = new Date(endIso);
  return allDay ? `${day.format(s)} – ${day.format(e)}` : `${day.format(s)}, ${time.format(s)} – ${time.format(e)}`;
}

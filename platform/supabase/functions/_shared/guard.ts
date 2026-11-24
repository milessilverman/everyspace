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
//
// Per-site facts (display names, whether a site's calendar can tell a guest's booking from dates the host closed) are
// not written here: they live in the provider adapters (providers/ical.ts) and are read through the registry.
import { canVerifyClosed, labelOf } from './providers/index.ts';
import { isStale, type HealthState } from './sync.ts';

export { checkDoor, doorGaps, type DoorCheck } from './door.ts';

/** A site's display name, from its adapter. Unknown sites show their key. */
export const siteName = (c: string): string => labelOf(c);

/**
 * Can this site's calendar link prove that dates are closed? Only when its adapter can tell a guest's booking apart
 * from a date the host closed (Airbnb: "Reserved" vs "Airbnb (Not available)"; Vrbo: "Reserved" vs "Blocked").
 * Booking.com's export marks both as "CLOSED - Not available", so its adapter has no `verifyClosed`.
 */
export const isVerifiableByCalendar = (c: string): boolean => canVerifyClosed(c);

/**
 * Why the instant site's calendar can't be trusted right now, in words for the host. `state` is the import's health
 * (from calendar_imports); `error` is what went wrong on the live read just attempted.
 */
export function unreadableCalendarMessage({ site, state, now, error }:
  { site: string; state: HealthState; now: string; error?: string }): string {
  if (isStale(state, now)) {
    const when = state.lastOkAt ? `the last good read was ${Math.max(0, Math.round((Date.parse(now) - Date.parse(state.lastOkAt)) / 3_600_000))} hours ago` : 'it has never been read successfully';
    return `Everyspace could not read ${site}'s calendar recently (${when}). Don't accept yet: check that the calendar link still works, then try again.`;
  }
  return `Couldn't read ${site}'s calendar just now (${error ?? 'error'}). Don't accept yet; try again in a minute.`;
}

/** "Dec 1 – Dec 4" (all-day, end exclusive shown as checkout day) or "Dec 1, 2:00 PM – 5:00 PM" in the property's zone. */
export function describeDates(startIso: string, endIso: string, allDay: boolean, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' });
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  const s = new Date(startIso); const e = new Date(endIso);
  return allDay ? `${day.format(s)} – ${day.format(e)}` : `${day.format(s)}, ${time.format(s)} – ${time.format(e)}`;
}

/**
 * The nights to close on a site, for instructions: "the night of Dec 1" or "the nights of Dec 1 – Dec 3".
 * Check-out day isn't included, so the host doesn't lose a night they could rent.
 */
export function describeNights(startIso: string, endIso: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' });
  const first = day.format(new Date(startIso));
  const last = day.format(new Date(Date.parse(endIso) - 12 * 3_600_000)); // the last night starts the evening before check-out
  return first === last ? `the night of ${first}` : `the nights of ${first} – ${last}`;
}

/** For an hourly booking: the day(s) to close on a site that only closes whole days (Airbnb, Vrbo). */
export function describeDays(startIso: string, endIso: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' });
  const first = day.format(new Date(startIso)); const last = day.format(new Date(Date.parse(endIso) - 1));
  return first === last ? `all of ${first}` : `all of ${first} – ${last}`;
}

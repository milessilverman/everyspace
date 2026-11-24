// The pure door checks: is a stretch of time closed on the instant site? (Split out of guard.ts so provider adapters can use
// them without importing the guard, which itself asks the provider registry.)
import { type CalendarEvent, localDayToUtc } from './ical.ts';

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


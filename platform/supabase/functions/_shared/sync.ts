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
  const cancelUids = existing.filter((r) => r.status === 'confirmed' && !seen.has(r.external_uid) && ms(r.ends_at) > ms(now)).map((r) => r.external_uid);
  return { upserts, cancelUids };
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
      ? { id: r.id, start: utcToLocalDay(r.starts_at, timeZone), end: utcToLocalDay(r.ends_at, timeZone) }
      : { id: r.id, start: r.starts_at, end: r.ends_at }));
}

// ---------------------------------------------------------------- resilience: failures, backoff, staleness, empty feeds
// All pure: `now` is always passed in, nothing reads a clock or a database.

export const MIN_BACKOFF_MS = 15 * 60_000;
export const MAX_BACKOFF_MS = 6 * 3_600_000;
export const STALE_AFTER_MS = 3 * 3_600_000;
export const STALE_AFTER_FAILURES = 3;
/** A feed that had events and comes back empty is believed only on this many consecutive empty reads. */
export const EMPTY_FEED_ACCEPT_AFTER = 3;

type TimeLike = string | number | Date;
const t = (v: TimeLike) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));

/** How long to leave an import alone after `failures` failures in a row: min(15 min * 2^failures, 6 h). Healthy imports (0) are never held back. */
export function backoffMs(failures: number): number {
  if (!(failures > 0)) return 0;
  return Math.min(MIN_BACKOFF_MS * 2 ** Math.min(failures, 30), MAX_BACKOFF_MS);
}

/** Skip this import now? True while its last attempt is more recent than the backoff for its failure count. */
export function shouldSkipImport({ lastAttemptAt, consecutiveFailures }: { lastAttemptAt: string | null; consecutiveFailures: number }, now: TimeLike): boolean {
  if (!lastAttemptAt || !(consecutiveFailures > 0)) return false;
  return t(now) - t(lastAttemptAt) < backoffMs(consecutiveFailures);
}

export type HealthState = { lastOkAt: string | null; consecutiveFailures: number };

/** A calendar we should not trust for decisions: never read OK, last OK over 3 hours ago, or 3+ failures in a row. */
export function isStale({ lastOkAt, consecutiveFailures }: HealthState, now: TimeLike): boolean {
  if (!lastOkAt) return true;
  return t(now) - t(lastOkAt) > STALE_AFTER_MS || consecutiveFailures >= STALE_AFTER_FAILURES;
}

/** The calendar_imports columns the sync decisions read. */
export type ImportRecord = {
  last_synced_at?: string | null; last_ok_at?: string | null; consecutive_failures?: number | null;
  last_error?: string | null; event_count?: number | null;
};

/** Column updates to write on calendar_imports. */
export type ImportPatch = {
  last_synced_at: string; last_status: 'ok' | 'error'; last_error: string | null; consecutive_failures: number;
  last_ok_at?: string; event_count?: number;
};

/** Empty reads in a row so far. They are recorded as last_error `empty_feed:N`; any other outcome resets the count. */
export function emptyReadsSoFar(prev: ImportRecord): number {
  const m = /^empty_feed:(\d+)$/.exec(prev.last_error ?? '');
  return m ? Number(m[1]) : 0;
}

export type ReadDecision = { kind: 'apply' } | { kind: 'hold_empty'; emptyReads: number };

/**
 * Empty-feed guard. A site that listed events last time and now lists none is far more often a broken feed than a host
 * who cleared every booking, and applying it would cancel every future reservation. So the first and second empty reads
 * change nothing; the third consecutive one is accepted.
 */
export function decideRead(prev: ImportRecord, eventsRead: number): ReadDecision {
  if (eventsRead > 0 || !((prev.event_count ?? 0) > 0)) return { kind: 'apply' };
  const emptyReads = emptyReadsSoFar(prev) + 1;
  return emptyReads >= EMPTY_FEED_ACCEPT_AFTER ? { kind: 'apply' } : { kind: 'hold_empty', emptyReads };
}

export const successPatch = (now: string, eventCount: number): ImportPatch => ({
  last_synced_at: now, last_ok_at: now, last_status: 'ok', last_error: null, consecutive_failures: 0, event_count: eventCount,
});

/** `code` is a short code with no URL in it (see errorCodeOf). */
export const failurePatch = (prev: ImportRecord, code: string, now: string): ImportPatch => ({
  last_synced_at: now, last_status: 'error', last_error: code, consecutive_failures: (prev.consecutive_failures ?? 0) + 1,
});

export const emptyFeedPatch = (prev: ImportRecord, emptyReads: number, now: string): ImportPatch =>
  failurePatch(prev, `empty_feed:${emptyReads}`, now);

/** A short, URL-free code for any thrown error: a ProviderError's code, an error's own `code`, else 'sync_failed'. */
export function errorCodeOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z_]{1,32}$/.test(code) ? code : 'sync_failed';
}

const EXPLANATIONS: Record<string, string> = {
  fetch_failed: "Everyspace couldn't read this calendar link. It will try again.",
  timeout: 'The site took too long to answer. Everyspace will try again.',
  too_large: 'This calendar is too large to read.',
  blocked_url: "This link can't be read by Everyspace. Copy a fresh calendar link from the site.",
  parse_error: "The link didn't return a calendar file. Copy a fresh link from the site.",
  empty_feed: 'The site returned an empty calendar although it had bookings before. Everyspace kept the existing bookings and will check again.',
  unsupported: "Everyspace can't sync this site's calendar yet.",
  space_not_found: 'The space for this calendar was not found.',
  sync_failed: 'Something went wrong while syncing. Everyspace will try again.',
};
/** Host-facing sentence for a stored last_error code (`empty_feed:2` is understood). */
export const explainSyncError = (code: string | null): string => (code ? EXPLANATIONS[code.replace(/:\d+$/, '')] ?? EXPLANATIONS.sync_failed : '');

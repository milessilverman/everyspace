// iCalendar (.ics) reading and writing for calendar sync.
//
// Every major rental site can export a calendar link (Airbnb, Vrbo, Booking.com, Hipcamp, Peerspace…) and most can
// import one. That is the one sync method that works today with no partner approval, so it is the first real
// connection Everyspace ships:
//   - import: we fetch each site's calendar link for a space and store the busy dates;
//   - export: we publish one feed per space and site with everything busy *elsewhere*, which the host pastes
//     into that site once, so a booking anywhere blocks the dates everywhere.
//
// Pure functions with no Deno or Node APIs, so the same file runs in Supabase Edge Functions and in tests.

export type CalendarEvent = {
  uid: string;
  start: string; // YYYY-MM-DD for all-day events, otherwise an ISO timestamp in UTC
  end: string; // exclusive, same format as start
  allDay: boolean;
  summary: string;
  cancelled: boolean;
  kind: 'booking' | 'block';
};

const DAY_MS = 86_400_000;

/** Joins folded lines (RFC 5545 §3.1) and normalises line endings. */
export function unfold(text: string): string {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

/** Offset (minutes) of an IANA time zone from UTC at a given UTC instant. */
function tzOffsetMinutes(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - utcMs) / 60_000);
}

/** Wall-clock time in a time zone → UTC milliseconds. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const first = guess - tzOffsetMinutes(timeZone, guess) * 60_000;
    return guess - tzOffsetMinutes(timeZone, first) * 60_000; // second pass handles DST edges
  } catch {
    return guess; // unknown zone: treat as UTC rather than failing the whole calendar
  }
}

/**
 * Parses a DTSTART/DTEND value. `params` is the text between the property name and the colon, e.g. `;TZID=America/Los_Angeles`.
 * Floating times (no Z, no TZID) use `defaultTimeZone`, which should be the property's own zone.
 */
export function parseIcsDate(value: string, params = '', defaultTimeZone = 'UTC'): { value: string; allDay: boolean } | null {
  const m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h || /VALUE=DATE(?!-TIME)/i.test(params)) return { value: `${y}-${mo}-${d}`, allDay: true };
  const tzid = params.match(/TZID=("?)([^;:"]+)\1/i)?.[2];
  const ms = z ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0)) : zonedToUtc(+y, +mo, +d, +h, +mi, +(s ?? 0), tzid ?? defaultTimeZone);
  return { value: new Date(ms).toISOString(), allDay: false };
}

const toMs = (v: string) => Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);

/** Parses an .ics file into events. Throws if the text is not a calendar at all. */
export function parseIcs(text: string, { defaultTimeZone = 'UTC' }: { defaultTimeZone?: string } = {}): CalendarEvent[] {
  const src = unfold(text);
  if (!/BEGIN:VCALENDAR/i.test(src)) throw new Error("That doesn't look like a calendar file (.ics). It should start with BEGIN:VCALENDAR.");
  const events: CalendarEvent[] = [];
  for (const block of src.split(/BEGIN:VEVENT/i).slice(1)) {
    const body = block.split(/END:VEVENT/i)[0];
    const prop = (name: string) => {
      const m = body.match(new RegExp(`^${name}((?:;[^:\\n]*)?):(.*)$`, 'mi'));
      return m ? { params: m[1] ?? '', value: m[2] } : null;
    };
    const ds = prop('DTSTART');
    const start = ds && parseIcsDate(ds.value, ds.params, defaultTimeZone);
    if (!start) continue;
    const de = prop('DTEND');
    let end = de && parseIcsDate(de.value, de.params, defaultTimeZone);
    if (!end) {
      // No end: one day for all-day events, otherwise an hour (RFC 5545 says zero length; an hour is safer for blocking).
      end = start.allDay
        ? { value: new Date(toMs(start.value) + DAY_MS).toISOString().slice(0, 10), allDay: true }
        : { value: new Date(toMs(start.value) + 3_600_000).toISOString(), allDay: false };
    }
    if (toMs(end.value) <= toMs(start.value)) continue;
    const summary = unescapeText(prop('SUMMARY')?.value ?? 'Reserved') || 'Reserved';
    const uid = unescapeText(prop('UID')?.value ?? '') || `${start.value}/${end.value}/${summary}`;
    const cancelled = /CANCELLED/i.test(prop('STATUS')?.value ?? '');
    // Airbnb exports owner blocks as "Airbnb (Not available)" and stays as "Reserved".
    const kind = /not available|blocked|unavailable|closed/i.test(summary) ? 'block' : 'booking';
    events.push({ uid, start: start.value, end: end.value, allDay: start.allDay && end.allDay, summary: summary.slice(0, 160), cancelled, kind });
  }
  return events;
}

const escapeText = (s: string) => String(s ?? '').replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\n/g, '\\n');
const stamp = (iso: string) => new Date(toMs(iso)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateProp = (name: string, v: string) => (v.length === 10 ? `${name};VALUE=DATE:${v.replace(/-/g, '')}` : `${name}:${stamp(v)}`);

/** Folds a content line at 75 octets (RFC 5545 §3.1). */
export function fold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = '';
  let curLen = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (curLen + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; curLen = 0; }
    cur += ch; curLen += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export type FeedEvent = { id: string; start: string; end: string; summary?: string };

/** Builds a calendar feed. Summaries default to "Not available" so guests' details never leave Everyspace. */
export function buildIcs({ name, events, now = new Date().toISOString() }: { name: string; events: FeedEvent[]; now?: string }): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Everyspace//Calendar sync//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${escapeText(e.id)}@everyspace.app`, `DTSTAMP:${stamp(now)}`, dateProp('DTSTART', e.start), dateProp('DTEND', e.end),
      `SUMMARY:${escapeText(e.summary ?? 'Not available')}`, 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Pairs of overlapping, non-cancelled events (for double-booking checks across sites). */
export function overlaps<T extends { start: string; end: string; cancelled?: boolean }>(items: T[]): [T, T][] {
  const live = items.filter((x) => !x.cancelled).sort((a, b) => toMs(a.start) - toMs(b.start));
  const pairs: [T, T][] = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length && toMs(live[j].start) < toMs(live[i].end); j++) pairs.push([live[i], live[j]]);
  }
  return pairs;
}

/** A calendar date (YYYY-MM-DD) at local midnight in a time zone, as an ISO timestamp. */
export function localDayToUtc(day: string, timeZone: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(zonedToUtc(y, m, d, 0, 0, 0, timeZone)).toISOString();
}

/** The local calendar date (YYYY-MM-DD) of an instant in a time zone. */
export function utcToLocalDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

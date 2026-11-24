// Manual import adapter: the host uploads a CSV of reservations exported from a site (capability: booking L2, import only).
// No calendar, pricing or messaging. Nothing is fetched; the file is the only input.
//
// Rules:
//   - header row required; columns found by tolerant name matching (case/space/punctuation-insensitive, small alias table);
//   - required: start, end. Optional: uid, status, kind, guests, payout. Every other column is ignored and never stored,
//     so guest names/emails/phones in an export are dropped, not persisted;
//   - dates: YYYY-MM-DD (whole days; end is the check-out day, exclusive, like a calendar) or ISO date-times
//     (an offset/Z is honoured; without one the property's time zone is used);
//   - any bad row rejects the whole file with row-numbered messages (row 1 is the header), no partial imports;
//   - rows without a uid get a stable one from a hash of start, end and kind (plus a counter for identical rows), so
//     importing the same file twice changes nothing.
import { localDayToUtc, zonedToUtc } from '../ical.ts';
import { NO_CAPABILITIES, ProviderError, type NormalizedReservation, type ProviderAdapter } from './adapter.ts';

export const MAX_ROWS = 2000;
export const MAX_BYTES = 1_048_576;
const MAX_REPORTED_ERRORS = 20;

type Field = 'start' | 'end' | 'uid' | 'status' | 'kind' | 'guests' | 'payout' | 'payout_cents';
const ALIASES: Record<Field, string[]> = {
  start: ['start', 'startdate', 'starts', 'startsat', 'checkin', 'checkindate', 'arrival', 'arrivaldate', 'from', 'begin'],
  end: ['end', 'enddate', 'ends', 'endsat', 'checkout', 'checkoutdate', 'departure', 'departuredate', 'to', 'until'],
  uid: ['uid', 'id', 'externaluid', 'externalid', 'reservationid', 'reservationcode', 'confirmationcode', 'confirmationnumber', 'confirmation', 'bookingid', 'bookingreference', 'reference', 'ref'],
  status: ['status', 'bookingstatus', 'reservationstatus', 'state'],
  kind: ['kind', 'type', 'reservationtype'],
  guests: ['guests', 'guestcount', 'numberofguests', 'numguests', 'partysize', 'people', 'adults'],
  payout: ['payout', 'payoutamount', 'hostpayout', 'netpayout', 'earnings', 'income'],
  payout_cents: ['payoutcents', 'amountcents'],
};
const FIELD_OF = new Map<string, Field>();
for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) for (const n of names) FIELD_OF.set(n, field);
const normHeader = (h: string) => h.replace(/^﻿/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** RFC 4180: quoted fields, "" escapes, commas and line breaks inside quotes, CRLF or LF. Throws on an unterminated quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false; let i = 0; let fieldStarted = false;
  const endField = () => { row.push(field); field = ''; fieldStarted = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && !fieldStarted) { quoted = true; fieldStarted = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r') { i += text[i + 1] === '\n' ? 2 : 1; endRow(); continue; }
    if (c === '\n') { i++; endRow(); continue; }
    field += c; fieldStarted = true; i++;
  }
  if (quoted) throw new ProviderError('parse_error', 'The file has a quote that is never closed.');
  if (fieldStarted || field !== '' || row.length) endRow();
  return rows;
}

// ---- value parsers: each returns the value, or a string message when the cell is bad

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i;
const validDay = (y: number, m: number, d: number) => y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

type When = { iso: string; dayOnly: boolean };
function parseWhen(raw: string, timeZone: string): When | string {
  const v = raw.trim();
  let m = DATE_RE.exec(v);
  if (m) return validDay(+m[1], +m[2], +m[3]) ? { iso: localDayToUtc(v, timeZone), dayOnly: true } : 'is not a real date';
  m = DATETIME_RE.exec(v);
  if (!m) return 'is not a date (use YYYY-MM-DD or YYYY-MM-DDTHH:MM)';
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)];
  if (!validDay(y, mo, d) || h > 23 || mi > 59 || s > 59) return 'is not a real date';
  const z = m[7];
  if (!z) return { iso: new Date(zonedToUtc(y, mo, d, h, mi, s, timeZone)).toISOString(), dayOnly: false };
  const base = Date.UTC(y, mo - 1, d, h, mi, s);
  if (z.toUpperCase() === 'Z') return { iso: new Date(base).toISOString(), dayOnly: false };
  const sign = z[0] === '-' ? -1 : 1; const digits = z.slice(1).replace(':', '');
  return { iso: new Date(base - sign * (+digits.slice(0, 2) * 60 + +digits.slice(2)) * 60_000).toISOString(), dayOnly: false };
}

const STATUS: Record<string, 'confirmed' | 'cancelled'> = {
  confirmed: 'confirmed', booked: 'confirmed', reserved: 'confirmed', accepted: 'confirmed', active: 'confirmed', ok: 'confirmed',
  cancelled: 'cancelled', canceled: 'cancelled', cancelledbyguest: 'cancelled', cancelledbyhost: 'cancelled', declined: 'cancelled', void: 'cancelled',
};
const KIND: Record<string, 'booking' | 'block'> = {
  booking: 'booking', reservation: 'booking', stay: 'booking', reserved: 'booking',
  block: 'block', blocked: 'block', unavailable: 'block', closed: 'block', notavailable: 'block',
};

function parseMoney(raw: string): number | string {
  const v = raw.trim().replace(/^[$€£]\s*/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return 'is not an amount (use a number like 125.50)';
  return Math.round(Number(v) * 100);
}

/** Two independent 53-bit string hashes (cyrb53), joined: a stable id, not a security hash. */
function hash(s: string): string {
  const one = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed; let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return one(0) + one(7);
}

export function parseReservationsCsv(text: string, { timeZone = 'UTC' }: { timeZone?: string } = {}): NormalizedReservation[] {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new ProviderError('too_large', 'That file is too large to import (over 1 MB).');
  const table = parseCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim() !== ''));
  if (!table.length) throw new ProviderError('empty_feed', 'That file is empty.');
  const header = table[0];
  const col = new Map<Field, number>();
  const dupes: string[] = [];
  header.forEach((h, i) => {
    const f = FIELD_OF.get(normHeader(h));
    if (!f) return; // unknown column: never read, never stored
    if (col.has(f)) dupes.push(f); else col.set(f, i);
  });
  if (dupes.length) throw new ProviderError('parse_error', `Row 1: more than one column means "${dupes[0]}". Keep one.`, [`Row 1: duplicate ${dupes[0]} column`]);
  const missing = (['start', 'end'] as Field[]).filter((f) => !col.has(f));
  if (missing.length) throw new ProviderError('parse_error', `Row 1: the file needs a "${missing.join('" and "')}" column in its first row (for example check-in and check-out).`, [`Row 1: missing ${missing.join(', ')}`]);
  const data = table.slice(1);
  if (!data.length) throw new ProviderError('empty_feed', 'That file has a header but no reservations.');
  if (data.length > MAX_ROWS) throw new ProviderError('too_large', `That file has ${data.length} rows; the limit is ${MAX_ROWS}. Split it and import in parts.`);

  const errors: string[] = []; const rows: NormalizedReservation[] = [];
  const seenUid = new Map<string, number>(); const occurrence = new Map<string, number>();
  data.forEach((cells, idx) => {
    const n = idx + 2; // spreadsheet row number: the header is row 1
    const bad = (m: string) => { errors.push(`Row ${n}: ${m}`); };
    if (cells.length !== header.length) return bad(`has ${cells.length} cells but the header has ${header.length}`);
    const get = (f: Field) => (col.has(f) ? cells[col.get(f)!].trim() : '');
    const start = parseWhen(get('start'), timeZone); const end = parseWhen(get('end'), timeZone);
    if (typeof start === 'string') return bad(`start ${start}`);
    if (typeof end === 'string') return bad(`end ${end}`);
    if (start.dayOnly !== end.dayOnly) return bad('start and end must both be dates or both be date-times');
    if (Date.parse(end.iso) <= Date.parse(start.iso)) return bad('end must be after start');
    const out: NormalizedReservation = { external_uid: '', starts_at: start.iso, ends_at: end.iso, all_day: start.dayOnly };
    const status = get('status');
    if (status) { const s = STATUS[normHeader(status)]; if (!s) return bad(`status "${status.slice(0, 30)}" is not recognised (use confirmed or cancelled)`); out.status = s; }
    const kind = get('kind');
    if (kind) { const k = KIND[normHeader(kind)]; if (!k) return bad(`kind "${kind.slice(0, 30)}" is not recognised (use booking or block)`); out.kind = k; }
    const guests = get('guests');
    if (guests) { if (!/^\d{1,4}$/.test(guests)) return bad('guests must be a whole number'); out.guest_count = Number(guests); }
    const payout = get('payout'); const cents = get('payout_cents');
    if (payout && cents) return bad('give the payout once (payout or payout cents), not both');
    if (payout) { const p = parseMoney(payout); if (typeof p === 'string') return bad(`payout ${p}`); out.payout_cents = p; }
    if (cents) { if (!/^\d{1,12}$/.test(cents)) return bad('payout cents must be a whole number'); out.payout_cents = Number(cents); }
    const uid = get('uid');
    if (uid) {
      if (uid.length > 128 || /[\u0000-\u001f]/.test(uid)) return bad('uid is too long or has odd characters');
      if (seenUid.has(uid)) return bad(`uid "${uid.slice(0, 40)}" already appears on row ${seenUid.get(uid)}`);
      seenUid.set(uid, n); out.external_uid = uid;
    } else {
      const base = `${out.starts_at}|${out.ends_at}|${out.kind ?? ''}`;
      const k = (occurrence.get(base) ?? 0) + 1; occurrence.set(base, k);
      out.external_uid = `csv-${hash(`${base}|${k}`)}`;
    }
    rows.push(out);
  });
  if (errors.length) {
    const shown = errors.slice(0, MAX_REPORTED_ERRORS);
    if (errors.length > shown.length) shown.push(`...and ${errors.length - shown.length} more`);
    throw new ProviderError('parse_error', `Nothing was imported. ${errors.length} row${errors.length === 1 ? ' has a problem' : 's have problems'}: ${shown.slice(0, 3).join('; ')}${shown.length > 3 ? '; ...' : ''}`, shown);
  }
  return rows;
}

export const manualAdapter: ProviderAdapter = {
  key: 'manual',
  label: 'File import (CSV)',
  capabilities: { ...NO_CAPABILITIES, booking: 'L2' },
  limits: [
    'Importing a file is a one-time step you start yourself. It does not update by itself, and nothing is sent back to the site.',
    'Only dates, booking reference, status, guest count and payout are kept. Any other column in the file (names, emails, phone numbers) is ignored and not stored.',
    `Files can be up to 1 MB and ${MAX_ROWS} rows. If any row has a problem, nothing is imported.`,
  ],
  parseBookingFile: (file, ctx) => ({ rows: parseReservationsCsv(file.text, { timeZone: ctx?.timeZone }) }),
};

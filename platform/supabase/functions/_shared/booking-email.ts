import { reservationRange, validISODate } from './reservation-time.ts';

export const MAX_EMAIL_BYTES = 128 * 1024;
export type ReportedStatus = 'request' | 'confirmed' | 'cancelled' | 'unknown';

const MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function explicitDate(value: string): string | null {
  if (validISODate(value)) return value;
  const text = value.replace(/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?),?\s+/i, '');
  const monthFirst = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(text);
  const dayFirst = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/.exec(text);
  if (!monthFirst && !dayFirst) return null;
  const [, month, day, year] = monthFirst ?? ['', dayFirst![2], dayFirst![1], dayFirst![3]];
  const index = MONTH.indexOf(month.toLowerCase().slice(0, 3));
  if (index < 0 || !/^(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(tember)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)$/i.test(month)) return null;
  const iso = `${year}-${String(index + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
  return validISODate(iso) ? iso : null;
}

function explicitClock(value: string) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value);
  if (match && +match[1] >= 1 && +match[1] <= 12 && +match[2] < 60) {
    return `${String(+match[1] % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0)).padStart(2, '0')}:${match[2]}`;
  }
  return /^\d{2}:\d{2}(?::\d{2})?$/.test(value) ? value : null;
}

function reportedStatus(text: string): ReportedStatus {
  switch (text.toLowerCase().replace(/^(booking|reservation)\s+/, '')) {
    case 'request':
    case 'requested':
    case 'pending': return 'request';
    case 'confirmed':
    case 'confirmation': return 'confirmed';
    case 'cancelled':
    case 'canceled':
    case 'cancellation': return 'cancelled';
    default: return 'unknown';
  }
}

export function parseBookingEmail({ text, subject = '', timeZone }: { text: string; subject?: string; timeZone: string }) {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:>\s*)+/, '').trim());
  function values(labels: RegExp) {
    return [...new Set(lines.flatMap((line) => {
      const match = /^([^:]{1,45}):\s*(.{1,160})$/.exec(line);
      return match && labels.test(match[1].trim().toLowerCase()) ? [match[2].trim()] : [];
    }))];
  }

  const issues = new Set<string>();
  const value = (labels: RegExp) => {
    const matches = values(labels);
    if (matches.length > 1) issues.add('conflicting_details');
    return matches.length === 1 ? matches[0] : '';
  };
  const refText = value(/^(?:booking |reservation )?(?:reference|id|number|code)$|^confirmation (?:code|number|reference)$/);
  const reference = /^[\w.-]{1,120}$/.test(refText) ? refText : null;
  if (!reference) issues.add('reference_unverified');

  const statusLabels = values(/^(?:booking |reservation )?status$/);
  const subjects = [subject, ...values(/^subject$/)].map((line) => line.replace(/^(?:(?:fwd?|re):\s*)+/i, '').trim());
  const explicitStatuses = statusLabels.map(reportedStatus);
  const statuses = new Set((statusLabels.length ? explicitStatuses : subjects.map(reportedStatus)).filter((status) => status !== 'unknown'));
  const status = statuses.size === 1 && !explicitStatuses.includes('unknown') ? [...statuses][0] : 'unknown';
  if (status === 'unknown') issues.add('status_unverified');

  const start = value(/^(?:check[ -]?in(?: date)?|arrival(?: date)?|start(?: time| date)?)$/);
  const end = value(/^(?:check[ -]?out(?: date)?|departure(?: date)?|end(?: time| date)?)$/);
  const nightStart = explicitDate(start);
  const nightEnd = explicitDate(end);
  const allDay = Boolean(nightStart && nightEnd);
  const date = explicitDate(value(/^(?:booking |event |reservation )?date$/));
  const startClock = explicitClock(start);
  const endClock = explicitClock(end);
  const starts = (allDay ? nightStart : date && startClock ? `${date}T${startClock}` : start);
  const ends = (allDay ? nightEnd : date && endClock ? `${date}T${endClock}` : end);

  let range: { startsAt: string | null; endsAt: string | null } = { startsAt: null, endsAt: null };
  try {
    if (issues.has('conflicting_details')) throw new Error('Conflicting details');
    range = reservationRange(starts, ends, allDay, timeZone);
  } catch {
    issues.add('dates_unverified');
  }
  const countText = value(/^(?:units|quantity|spaces booked)$/);
  const count = countText === '' ? 1 : Number(countText);
  const units = /^\d+$/.test(countText || '1') && Number.isInteger(count) && count >= 1 && count <= 500 ? count : null;
  if (units === null) issues.add('units_unverified');
  if (!text.trim()) issues.add('plain_text_missing');

  return { ...range, allDay: range.startsAt ? allDay : null, status, reference, units, issues: [...issues] };
}

export function emailFingerprint(message: ReturnType<typeof parseBookingEmail>, content: string) {
  async function digest(value: string) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const text = content.replace(/\r\n/g, '\n').trim();
  const identity = message.reference && message.startsAt && message.endsAt && message.units !== null
    && message.status !== 'unknown' && !message.issues.includes('conflicting_details');
  return identity
    ? digest(JSON.stringify(['reservation', message.reference, message.startsAt, message.endsAt, message.allDay, message.units, message.status]))
    : digest(JSON.stringify(['message', text]));
}

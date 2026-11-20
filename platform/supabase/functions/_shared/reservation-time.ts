const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?$/;
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?$/i;

export function validISODate(value: string): boolean {
  const match = DAY.exec(value);
  if (!match || +match[1] < 1000) return false;
  const utc = Date.UTC(+match[1], +match[2] - 1, +match[3]);
  return new Date(utc).toISOString().slice(0, 10) === value;
}

function localInstant(day: string, time: string, timeZone: string): string {
  const [, year, month, date] = DAY.exec(day)!;
  const [, hour, minute, second = '0', fractional = '0'] = CLOCK.exec(time)!;
  const wall = Date.UTC(+year, +month - 1, +date, +hour, +minute, +second, Math.round(Number(fractional) * 1000));
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  function offset(at: number) {
    const entries = Object.fromEntries(formatter.formatToParts(at).map(({ type, value }) => [type, Number(value)]));
    return Date.UTC(entries.year, entries.month - 1, entries.day, entries.hour, entries.minute, entries.second)
      - Math.floor(at / 1000) * 1000;
  }
  // Probe either side of the local date so skipped and repeated hours are explicit.
  const offsets = new Set([-24, 0, 24].map((hours) => offset(wall + hours * 3_600_000)));
  const matches = [...offsets].map((delta) => wall - delta).filter((at) => at + offset(at) === wall);
  if (matches.length !== 1) throw new Error('This local time is skipped or repeated. Enter a time with its UTC offset.');
  return new Date(matches[0]).toISOString();
}

export function reservationInstant(value: unknown, allDay: boolean, timeZone: string): string {
  if (typeof value !== 'string') throw new Error('Enter a valid reservation date and time.');
  if (allDay) {
    if (!validISODate(value)) throw new Error('Enter a calendar date in YYYY-MM-DD format.');
    return localInstant(value, '00:00', timeZone);
  }
  const match = TIMESTAMP.exec(value);
  if (!match || !validISODate(match[1])) throw new Error('Enter a complete date and time.');
  const [, day, time, offset] = match;
  const clock = CLOCK.exec(time)!;
  if (+clock[1] > 23 || +clock[2] > 59 || +(clock[3] ?? 0) > 59) throw new Error('Enter a valid time of day.');
  if (!offset) return localInstant(day, time, timeZone);
  const epoch = Date.parse(`${day}T${time}${offset.toUpperCase()}`);
  if (!Number.isFinite(epoch)) throw new Error('Enter a valid UTC offset.');
  return new Date(epoch).toISOString();
}

export function reservationRange(start: unknown, end: unknown, allDay: boolean, timeZone: string) {
  const startsAt = reservationInstant(start, allDay, timeZone);
  const endsAt = reservationInstant(end, allDay, timeZone);
  if (endsAt <= startsAt) throw new Error('The end has to be after the start.');
  return { startsAt, endsAt };
}

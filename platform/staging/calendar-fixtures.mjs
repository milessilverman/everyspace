// Entirely synthetic calendar data shared by the local rehearsal and the hosted staging fixture.
export const NIGHT = '2037-07-14';
export const CHECKOUT = '2037-07-15';
export const POOL_DAY = '2037-07-16';

export function calendar(events = []) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

export function booked(id, start, end, { allDay = false, revision = 1, cancelled = false } = {}) {
  return ['BEGIN:VEVENT', 'UID:' + id, 'SEQUENCE:' + revision,
    (allDay ? 'DTSTART;VALUE=DATE:' : 'DTSTART:') + start,
    (allDay ? 'DTEND;VALUE=DATE:' : 'DTEND:') + end,
    'SUMMARY:Reserved', ...(cancelled ? ['STATUS:CANCELLED'] : []), 'END:VEVENT'];
}

export const houseCalendar = calendar([booked('fixture-home-1', '20370714', '20370715', { allDay: true })]);
export const defaultPool = calendar([booked('fixture-pool-1', '20370716T220000Z', '20370717T000000Z')]);
export const currentPool = calendar([booked('fixture-pool-1', '20370716T220000Z', '20370717T000000Z', { revision: 3 })]);
export const conflictingPoolCancellation = calendar([booked('fixture-pool-1', '20370716T220000Z', '20370717T000000Z', { revision: 3, cancelled: true })]);

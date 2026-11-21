// This handler is packaged separately for the synthetic project. It is not a provider connection.
import {
  booked, calendar, conflictingPoolCancellation, currentPool, defaultPool, houseCalendar, houseCheckoutCalendar,
} from './calendar-fixtures.mjs';

const token = Deno.env.get('STAGING_FIXTURE_TOKEN') ?? '';
const fixtures = new Map<string, [number, string]>([
  ['house', [200, houseCalendar]],
  ['house-checkout', [200, houseCheckoutCalendar]],
  ['pool', [200, currentPool]],
  ['pool-older', [200, defaultPool]],
  ['pool-ambiguous-cancel', [200, conflictingPoolCancellation]],
  ['pool-changed', [200, calendar([booked('fixture-pool-1', '20370716T223000Z', '20370717T003000Z', { revision: 4 })])]],
  ['pool-cancelled', [200, calendar([booked('fixture-pool-1', '20370716T223000Z', '20370717T003000Z', { revision: 5, cancelled: true })])]],
  ['missing', [200, calendar()]],
  ['partial', [206, 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT']],
  ['unavailable', [503, 'Synthetic calendar temporarily unavailable.']],
]);

Deno.serve((request) => {
  const url = new URL(request.url);
  const [supplied, scenario] = url.pathname.split('/').slice(-2);
  const fixture = fixtures.get(scenario);
  if (request.method !== 'GET' || token.length < 32 || supplied !== token || !fixture) {
    return new Response(null, { status: 404 });
  }
  return new Response(fixture[1], { status: fixture[0], headers: { 'content-type': 'text/calendar', 'cache-control': 'no-store' } });
});

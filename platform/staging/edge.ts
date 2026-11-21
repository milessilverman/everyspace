// Local test launcher for the real Edge handlers. The only substitute network destination is a synthetic calendar.
const base = Deno.env.get('SUPABASE_URL')!;
const fixtures = 'staging-calendars.example';
const networkFetch = globalThis.fetch;
const functions = new Map<string, Deno.ServeHandler>();
const serve = Deno.serve;
let importing = '';
Object.defineProperty(Deno, 'serve', {
  configurable: true,
  value: (handler: Deno.ServeHandler) => functions.set(importing, handler),
});
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === fixtures) return networkFetch(base + '/_staging/calendar' + url.pathname, init);
  if (url.origin !== base) throw new Error('Local staging rejected a non-fixture destination.');
  return networkFetch(input, init);
};

const code = Deno.env.get('EVERYSPACE_STAGING_CODE')!;
for (const name of ['booking-email', 'booking-guard', 'calendar-feed', 'calendar-sync', 'channel-reservations']) {
  importing = name;
  await import(code + '/platform/supabase/functions/' + name + '/index.ts');
}
serve({
  hostname: '127.0.0.1', port: 0,
  onListen: ({ port }) => console.log('STAGING_EDGE_PORT=' + port),
}, (request, info) => {
  const name = new URL(request.url).pathname.split('/')[3];
  return functions.get(name)?.(request, info) ?? new Response(null, { status: 404 });
});

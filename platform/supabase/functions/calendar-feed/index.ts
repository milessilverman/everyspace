// Public calendar feed: GET /functions/v1/calendar-feed?token=<64 hex chars>
//
// The host pastes this link into a site's "import calendar" setting once (Airbnb: Calendar → Availability → Connect
// another calendar). From then on, busy time from other sites is published for the receiving platform to fetch.
// The token is the only credential, so it is long and random, and the feed never includes guest names or prices.
// This function must be deployed with JWT verification off (see supabase/config.toml), since sites fetch it anonymously.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { buildIcs } from '../_shared/ical.ts';
import { CORS, preflight } from '../_shared/cors.ts';
import { feedEvents, type BusyRow } from '../_shared/sync.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const notFound = () => new Response('Calendar not found', { status: 404, headers: { ...CORS, 'content-type': 'text/plain' } });

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const url = new URL(req.url);
  const token = (url.searchParams.get('token') ?? url.pathname.split('/').pop() ?? '').replace(/\.ics$/i, '');
  if (!/^[0-9a-f]{64}$/.test(token)) return notFound();

  const { data: feed, error } = await admin.from('calendar_feeds')
    .select('id, for_channel, space_id, spaces!inner(id, title, parent_space_id, properties!inner(timezone))')
    .eq('token', token).maybeSingle();
  if (error) { console.error('feed lookup failed', error.message); return new Response('Try again shortly', { status: 503 }); }
  if (!feed) return notFound();
  // deno-lint-ignore no-explicit-any
  const space = (feed as any).spaces; const timeZone: string = space.properties.timezone;

  const { data: rows, error: rErr } = await admin.rpc('calendar_feed_reservations', { p_space: feed.space_id });
  if (rErr) { console.error('reservations lookup failed', rErr.message); return new Response('Try again shortly', { status: 503 }); }

  const ics = buildIcs({ name: `${space.title} · Everyspace`, events: feedEvents({ rows: (rows ?? []) as BusyRow[], forChannel: feed.for_channel, spaceId: feed.space_id, timeZone }) });
  admin.from('calendar_feeds').update({ last_fetched_at: new Date().toISOString() }).eq('id', feed.id).then(() => {});
  return new Response(req.method === 'HEAD' ? null : ics, {
    headers: { ...CORS, 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache, max-age=0', 'content-disposition': 'inline; filename="everyspace.ics"' },
  });
});

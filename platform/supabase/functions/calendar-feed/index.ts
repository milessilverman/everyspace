// Public calendar feed: GET /functions/v1/calendar-feed?token=<64 hex chars>
//
// The host pastes this link into a site's "import calendar" setting once (Airbnb: Calendar → Availability → Connect
// another calendar). From then on, anything booked on any *other* site, or on Everyspace, blocks those dates there.
// The token is the only credential, so it is long and random, and the feed never includes guest names or prices.
// This function must be deployed with JWT verification off (see supabase/config.toml), since sites fetch it anonymously.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { buildIcs } from '../_shared/ical.ts';
import { feedEvents, type BusyRow } from '../_shared/sync.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const notFound = () => new Response('Calendar not found', { status: 404, headers: { 'content-type': 'text/plain' } });

Deno.serve(async (req) => {
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

  // This space, the space it sits inside (whole house blocks the room) and spaces inside it (a booked room blocks the whole house).
  const { data: kids } = await admin.from('spaces').select('id').eq('parent_space_id', feed.space_id);
  const ids = [feed.space_id, space.parent_space_id, ...(kids ?? []).map((k) => k.id)].filter(Boolean);
  const { data: rows, error: rErr } = await admin.from('reservations')
    .select('id, space_id, channel, status, starts_at, ends_at, all_day')
    .in('space_id', ids).eq('status', 'confirmed').gte('ends_at', new Date(Date.now() - 86_400_000).toISOString());
  if (rErr) { console.error('reservations lookup failed', rErr.message); return new Response('Try again shortly', { status: 503 }); }

  const ics = buildIcs({ name: `${space.title} · Everyspace`, events: feedEvents({ rows: (rows ?? []) as BusyRow[], forChannel: feed.for_channel, spaceId: feed.space_id, timeZone }) });
  admin.from('calendar_feeds').update({ last_fetched_at: new Date().toISOString() }).eq('id', feed.id).then(() => {});
  return new Response(req.method === 'HEAD' ? null : ics, {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache, max-age=0', 'content-disposition': 'inline; filename="everyspace.ics"' },
  });
});

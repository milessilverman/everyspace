// Public calendar feed: GET /functions/v1/calendar-feed?token=<64 hex chars>
//
// The host pastes this link into a site's "import calendar" setting once (Airbnb: Calendar → Availability → Connect
// another calendar). From then on, anything booked on any *other* site, or on Everyspace, blocks those dates there.
// The token is the only credential, so it is long and random, and the feed never includes guest names or prices.
// This function must be deployed with JWT verification off (see supabase/config.toml), since sites fetch it anonymously.
import { CORS, preflight } from '../_shared/cors.ts';
import { adapterFor } from '../_shared/providers/index.ts';
import type { BusyRow } from '../_shared/sync.ts';

export type FeedInfo = { id: string; for_channel: string; space_id: string; title: string; timeZone: string };
export type FeedLookup = { status: 'ok'; feed: FeedInfo; rows: BusyRow[] } | { status: 'not_found' } | { status: 'error'; message: string };

export type FeedDeps = {
  now(): string;
  /** Finds the feed for a token, plus the busy reservations of its space, the space around it and the spaces inside it. */
  loadFeed(token: string, sinceIso: string): Promise<FeedLookup>;
  touch(feedId: string, nowIso: string): void;
};

const notFound = () => new Response('Calendar not found', { status: 404, headers: { ...CORS, 'content-type': 'text/plain' } });

export async function handle(req: Request, deps: FeedDeps): Promise<Response> {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  const url = new URL(req.url);
  const token = (url.searchParams.get('token') ?? url.pathname.split('/').pop() ?? '').replace(/\.ics$/i, '');
  if (!/^[0-9a-f]{64}$/.test(token)) return notFound();

  const now = deps.now();
  const found = await deps.loadFeed(token, new Date(Date.parse(now) - 86_400_000).toISOString());
  if (found.status === 'error') return new Response('Try again shortly', { status: 503 });
  if (found.status === 'not_found') return notFound();
  const { feed, rows } = found;

  const adapter = adapterFor(feed.for_channel, 'exportAvailability');
  if (!adapter) return notFound(); // no adapter can publish for this site
  const ics = adapter.exportAvailability({ rows, forChannel: feed.for_channel, spaceId: feed.space_id, timeZone: feed.timeZone, name: `${feed.title} · Everyspace`, now });
  deps.touch(feed.id, now);
  return new Response(req.method === 'HEAD' ? null : ics.body, {
    headers: { ...CORS, 'content-type': ics.contentType, 'cache-control': 'no-cache, max-age=0', 'content-disposition': 'inline; filename="everyspace.ics"' },
  });
}

// ---------------------------------------------------------------- production wiring (Deno only)

export function productionDeps(): FeedDeps {
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any).Deno;
  // deno-lint-ignore no-explicit-any
  let admin: Promise<any> | null = null;
  const client = () => admin ??= import('npm:@supabase/supabase-js@2.45.4').then(({ createClient }) =>
    createClient(D.env.get('SUPABASE_URL')!, D.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }));
  return {
    now: () => new Date().toISOString(),
    async loadFeed(token, sinceIso) {
      const db = await client();
      const { data: feed, error } = await db.from('calendar_feeds')
        .select('id, for_channel, space_id, spaces!inner(id, title, parent_space_id, properties!inner(timezone))')
        .eq('token', token).maybeSingle();
      if (error) { console.error('feed lookup failed', error.message); return { status: 'error', message: 'lookup' }; }
      if (!feed) return { status: 'not_found' };
      const space = feed.spaces;
      // This space, the space it sits inside (whole house blocks the room) and spaces inside it (a booked room blocks the whole house).
      const { data: kids } = await db.from('spaces').select('id').eq('parent_space_id', feed.space_id);
      const ids = [feed.space_id, space.parent_space_id, ...(kids ?? []).map((k: { id: string }) => k.id)].filter(Boolean);
      const { data: rows, error: rErr } = await db.from('reservations')
        .select('id, space_id, channel, status, starts_at, ends_at, all_day')
        .in('space_id', ids).eq('status', 'confirmed').gte('ends_at', sinceIso);
      if (rErr) { console.error('reservations lookup failed', rErr.message); return { status: 'error', message: 'reservations' }; }
      return { status: 'ok', feed: { id: feed.id, for_channel: feed.for_channel, space_id: feed.space_id, title: space.title, timeZone: space.properties.timezone }, rows: (rows ?? []) as BusyRow[] };
    },
    touch(feedId, nowIso) { client().then((db) => db.from('calendar_feeds').update({ last_fetched_at: nowIso }).eq('id', feedId)).catch(() => {}); },
  };
}

const deno = (globalThis as { Deno?: { serve?: (h: (r: Request) => Promise<Response>) => unknown } }).Deno;
if (typeof deno?.serve === 'function') { const deps = productionDeps(); deno.serve((req) => handle(req, deps)); }

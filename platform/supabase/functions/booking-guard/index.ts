// "Is it safe to accept this request?" — called by a signed-in host (or later, by the site's API on their behalf).
//
// POST /functions/v1/booking-guard
//   { "action": "hold",    "space_id", "channel", "start", "end", "all_day"?, "ref"?, "guest"? }  → hold the dates, then check
//   { "action": "check",   "hold_id" }                                                          → check again after closing dates
//   { "action": "release", "hold_id", "reason"? }                                               → the request was declined
// Answers { safe, step, message }. step: "accept" | "close_dates" | "connect_calendar" | "decline" | "retry".
//
// Which sites can prove dates are closed is not decided here: a site can only be checked if its provider adapter has
// `verifyClosed` (see _shared/providers). A calendar that could not be read recently is never reported as safe.
import { CORS, preflight } from '../_shared/cors.ts';
import { localDayToUtc } from '../_shared/ical.ts';
import type { FetchOptions } from '../_shared/fetch.ts';
import { adapterFor } from '../_shared/providers/index.ts';
import { describeDates, describeDays, describeNights, siteName, unreadableCalendarMessage } from '../_shared/guard.ts';

export type Verdict = { safe: boolean; step: 'accept' | 'close_dates' | 'connect_calendar' | 'decline' | 'retry'; message: string; hold_id?: string };
export type HoldRow = {
  id: string; space_id: string; channel: string; starts_at: string; ends_at: string; all_day: boolean;
  status: string; released_reason: string | null; title: string; timeZone: string;
};
type DbError = { message: string; hint?: string } | null;

export type GuardDeps = {
  now(): string;
  io?: FetchOptions;
  // Server-side reads and writes (service role).
  getHold(id: string): Promise<HoldRow | null>;
  doorListings(spaceId: string): Promise<{ space_id: string; channel: string }[]>;
  spaceTitle(spaceId: string): Promise<string | null>;
  importFor(spaceId: string, channel: string): Promise<{ url: string; last_ok_at: string | null; consecutive_failures: number | null } | null>;
  releaseTaken(holdId: string): Promise<void>;
  markSafe(holdId: string): Promise<boolean>;
  // Run with the caller's own JWT, so row-level security decides what they can touch.
  findSpace(auth: string, spaceId: string): Promise<{ id: string; timeZone: string } | null>;
  placeHold(auth: string, args: Record<string, unknown>): Promise<{ data: string | null; error: DbError }>;
  ownsHold(auth: string, holdId: string): Promise<boolean>;
  releaseHold(auth: string, holdId: string, reason: string): Promise<DbError>;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

export async function check(holdId: string, deps: GuardDeps): Promise<Verdict> {
  const h = await deps.getHold(holdId);
  if (!h) return { safe: false, step: 'decline', message: 'That request is no longer held.' };
  const timeZone = h.timeZone;
  const dates = describeDates(h.starts_at, h.ends_at, h.all_day, timeZone);
  if (h.status === 'safe' || h.status === 'confirmed') return { safe: true, step: 'accept', hold_id: h.id, message: `Safe to accept ${dates}.` };
  if (h.status === 'released') {
    return { safe: false, step: 'decline', hold_id: h.id, message: h.released_reason === 'taken' ? `Another booking took ${dates}. Decline this request.` : 'This hold was released. Start again if the request is still open.' };
  }

  for (const door of await deps.doorListings(h.space_id)) {
    if (door.channel === 'everyspace') continue; // Everyspace bookings live in this database and were checked under the lock.
    const site = siteName(door.channel);
    const where = (await deps.spaceTitle(door.space_id)) ?? h.title;
    const adapter = adapterFor(door.channel, 'verifyClosed');
    if (!adapter) {
      return { safe: false, step: 'connect_calendar', hold_id: h.id, message: `${site} takes instant bookings for "${where}", and its calendar link can't show whether dates are closed or booked. Switch ${site} to request-to-book, or connect it directly, before accepting.` };
    }
    const imp = await deps.importFor(door.space_id, door.channel);
    if (!imp) return { safe: false, step: 'connect_calendar', hold_id: h.id, message: `Add ${site}'s calendar link for "${where}" so Everyspace can check it. Don't accept yet.` };

    let result;
    try { result = await adapter.verifyClosed({ url: imp.url, hold: h, timeZone, io: deps.io }); } catch (e) {
      // No fresh read: never answer "safe". If the calendar has also been failing for a while, say so.
      const message = unreadableCalendarMessage({ site, state: { lastOkAt: imp.last_ok_at, consecutiveFailures: imp.consecutive_failures ?? 0 }, now: deps.now(), error: e instanceof Error ? e.message : 'error' });
      return { safe: false, step: 'retry', hold_id: h.id, message };
    }
    if (!result.ok && result.reason === 'taken') {
      await deps.releaseTaken(h.id);
      return { safe: false, step: 'decline', hold_id: h.id, message: `A guest booked ${dates} on ${site} first. Decline this request.` };
    }
    if (!result.ok) {
      return { safe: false, step: 'close_dates', hold_id: h.id, message: `On ${site}, close ${h.all_day ? describeNights(result.gapStart, result.gapEnd, timeZone) : `${describeDays(result.gapStart, result.gapEnd, timeZone)} (${site} closes whole days)`} for "${where}", then tap Check again. Everyspace is holding these dates for you meanwhile.` };
    }
  }
  return (await deps.markSafe(h.id))
    ? { safe: true, step: 'accept', hold_id: h.id, message: `Safe to accept ${dates} on ${siteName(h.channel)}. They're closed on every site that books instantly.` }
    : { safe: false, step: 'decline', hold_id: h.id, message: `Another booking took ${dates}. Decline this request.` };
}

export async function handle(req: Request, deps: GuardDeps): Promise<Response> {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+/i.test(auth)) return json({ error: 'Sign in first.' }, 401);
  const body = await req.json().catch(() => ({})) as Record<string, string | boolean | undefined>;

  if (body.action === 'hold') {
    // Row-level security: only finds the space if it is this host's.
    const sp = await deps.findSpace(auth, String(body.space_id ?? ''));
    if (!sp) return json({ error: 'Space not found' }, 404);
    const allDay = body.all_day !== false;
    let start: string; let end: string;
    try {
      start = allDay ? localDayToUtc(String(body.start), sp.timeZone) : new Date(String(body.start)).toISOString();
      end = allDay ? localDayToUtc(String(body.end), sp.timeZone) : new Date(String(body.end)).toISOString();
      if (Date.parse(end) <= Date.parse(start)) throw new Error('order');
    } catch { return json({ safe: false, step: 'decline', message: 'Those dates are not valid.' } satisfies Verdict, 400); }
    const { data: holdId, error } = await deps.placeHold(auth, { p_space: sp.id, p_channel: body.channel, p_start: start, p_end: end, p_all_day: allDay, p_ref: body.ref ?? null, p_guest: body.guest ?? null });
    if (error || !holdId) return json({ safe: false, step: 'decline', message: error?.message ?? 'Could not hold those dates.' } satisfies Verdict, error?.hint === 'DATES_TAKEN' ? 409 : 400);
    return json(await check(holdId, deps));
  }

  const holdId = String(body.hold_id ?? '');
  if (!(await deps.ownsHold(auth, holdId))) return json({ error: 'Request not found' }, 404);
  if (body.action === 'check') return json(await check(holdId, deps));
  if (body.action === 'release') {
    const error = await deps.releaseHold(auth, holdId, String(body.reason ?? 'declined'));
    return error ? json({ error: error.message }, 400) : json({ released: true });
  }
  return json({ error: 'Unknown action' }, 400);
}

// ---------------------------------------------------------------- production wiring (Deno only)

export function productionDeps(): GuardDeps {
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any).Deno;
  // deno-lint-ignore no-explicit-any
  let cached: Promise<{ admin: any; user: (auth: string) => any }> | null = null;
  const clients = () => cached ??= import('npm:@supabase/supabase-js@2.45.4').then(({ createClient }) => {
    const url = D.env.get('SUPABASE_URL')!; const anon = D.env.get('SUPABASE_ANON_KEY')!;
    return {
      admin: createClient(url, D.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } }),
      user: (auth: string) => createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: auth } } }),
    };
  });
  return {
    now: () => new Date().toISOString(),
    async getHold(id) {
      const { admin } = await clients();
      const { data: h } = await admin.from('booking_holds')
        .select('id, space_id, channel, starts_at, ends_at, all_day, status, released_reason, spaces!inner(title, properties!inner(timezone))').eq('id', id).single();
      return h ? { ...h, title: h.spaces.title, timeZone: h.spaces.properties.timezone } : null;
    },
    async doorListings(spaceId) { const { admin } = await clients(); return (await admin.rpc('door_listings', { p_space: spaceId })).data ?? []; },
    async spaceTitle(spaceId) { const { admin } = await clients(); return (await admin.from('spaces').select('title').eq('id', spaceId).single()).data?.title ?? null; },
    async importFor(spaceId, channel) {
      const { admin } = await clients();
      return (await admin.from('calendar_imports').select('url, last_ok_at, consecutive_failures').eq('space_id', spaceId).eq('channel', channel).maybeSingle()).data ?? null;
    },
    async releaseTaken(holdId) { const { admin } = await clients(); await admin.from('booking_holds').update({ status: 'released', released_reason: 'taken' }).eq('id', holdId); },
    async markSafe(holdId) { const { admin } = await clients(); return (await admin.rpc('mark_hold_safe', { p_hold: holdId })).data === true; },
    async findSpace(auth, spaceId) {
      const { user } = await clients();
      const { data } = await user(auth).from('spaces').select('id, properties!inner(timezone)').eq('id', spaceId).maybeSingle();
      return data ? { id: data.id, timeZone: data.properties.timezone } : null;
    },
    async placeHold(auth, args) { const { user } = await clients(); const r = await user(auth).rpc('place_hold', args); return { data: r.data, error: r.error }; },
    async ownsHold(auth, holdId) { const { user } = await clients(); return !!(await user(auth).from('booking_holds').select('id').eq('id', holdId).maybeSingle()).data; },
    async releaseHold(auth, holdId, reason) { const { user } = await clients(); return (await user(auth).rpc('release_hold', { p_hold: holdId, p_reason: reason })).error; },
  };
}

const deno = (globalThis as { Deno?: { serve?: (h: (r: Request) => Promise<Response>) => unknown } }).Deno;
if (typeof deno?.serve === 'function') { const deps = productionDeps(); deno.serve((req) => handle(req, deps)); }

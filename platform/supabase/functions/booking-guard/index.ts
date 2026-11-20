// "Is it safe to accept this request?" — called by a signed-in host (or later, by the site's API on their behalf).
//
// POST /functions/v1/booking-guard
//   { "action": "hold",    "space_id", "channel", "start", "end", "all_day"?, "ref"?, "guest"? }  → hold the dates, then check
//   { "action": "check",   "hold_id" }                                                          → check again after closing dates
//   { "action": "release", "hold_id", "reason"? }                                               → the request was declined
// Answers { safe, step, message }. step: "accept" | "close_dates" | "connect_calendar" | "decline" | "retry".
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { CORS, preflight } from '../_shared/cors.ts';
import { parseIcs, localDayToUtc } from '../_shared/ical.ts';
import { fetchCalendar } from '../_shared/fetch.ts';
import { checkDoor, describeDates, describeDays, describeNights, siteName, VERIFIABLE_BY_CALENDAR } from '../_shared/guard.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

type Verdict = { safe: boolean; step: 'accept' | 'booked' | 'expired' | 'close_dates' | 'connect_calendar' | 'decline' | 'retry'; message: string; hold_id?: string };

async function check(holdId: string): Promise<Verdict> {
  const { data: h } = await admin.from('booking_holds')
    .select('id, space_id, channel, starts_at, ends_at, all_day, status, released_reason, expires_at, spaces!inner(title, properties!inner(timezone))')
    .eq('id', holdId).single();
  if (!h) return { safe: false, step: 'decline', message: 'That request is no longer held.' };
  // deno-lint-ignore no-explicit-any
  const sp = (h as any).spaces; const timeZone: string = sp.properties.timezone;
  const dates = describeDates(h.starts_at, h.ends_at, h.all_day, timeZone);
  if (h.status === 'confirmed') return { safe: false, step: 'booked', hold_id: h.id, message: `Already booked for ${dates}.` };
  if (h.status === 'released') {
    return { safe: false, step: 'decline', hold_id: h.id, message: h.released_reason === 'taken' ? `Another booking took ${dates}. Decline this request.` : 'This hold was released. Start again if the request is still open.' };
  }
  if (Date.parse(h.expires_at) <= Date.now()) {
    return { safe: false, step: 'expired', hold_id: h.id, message: 'This hold has expired. Start a new request if it is still open.' };
  }

  const { data: doors, error: doorsError } = await admin.rpc('door_listings', { p_space: h.space_id });
  if (doorsError) {
    return { safe: false, step: 'retry', hold_id: h.id, message: 'Booking settings could not be checked. Try again before accepting.' };
  }
  for (const door of (doors ?? []) as { space_id: string; channel: string }[]) {
    if (door.channel === 'everyspace') continue; // Everyspace bookings live in this database and were checked under the lock.
    const site = siteName(door.channel);
    const { data: doorSpace } = await admin.from('spaces').select('title').eq('id', door.space_id).single();
    const where = doorSpace?.title ?? sp.title;
    if (!VERIFIABLE_BY_CALENDAR.has(door.channel)) {
      return { safe: false, step: 'connect_calendar', hold_id: h.id, message: `${site} takes instant bookings for "${where}", and its calendar link can't show whether dates are closed or booked. Switch ${site} to request-to-book, or connect it directly, before accepting.` };
    }
    const { data: imp } = await admin.from('calendar_imports').select('url').eq('space_id', door.space_id).eq('channel', door.channel).maybeSingle();
    if (!imp) return { safe: false, step: 'connect_calendar', hold_id: h.id, message: `Add ${site}'s calendar link for "${where}" so Everyspace can check it. Don't accept yet.` };

    let text: string;
    try { text = await fetchCalendar(imp.url); } catch (e) {
      return { safe: false, step: 'retry', hold_id: h.id, message: `Couldn't read ${site}'s calendar just now (${e instanceof Error ? e.message : 'error'}). Don't accept yet; try again in a minute.` };
    }
    const result = checkDoor({ hold: h, doorEvents: parseIcs(text, { defaultTimeZone: timeZone }), timeZone });
    if (!result.ok && result.reason === 'taken') {
      await admin.from('booking_holds').update({ status: 'released', released_reason: 'taken' }).eq('id', h.id);
      return { safe: false, step: 'decline', hold_id: h.id, message: `A guest booked ${dates} on ${site} first. Decline this request.` };
    }
    if (!result.ok) {
      return { safe: false, step: 'close_dates', hold_id: h.id, message: `On ${site}, close ${h.all_day ? describeNights(result.gapStart, result.gapEnd, timeZone) : `${describeDays(result.gapStart, result.gapEnd, timeZone)} (${site} closes whole days)`} for "${where}", then tap Check again. Everyspace is holding these dates for you meanwhile.` };
    }
  }
  const { data: ok } = await admin.rpc('mark_hold_safe', { p_hold: h.id });
  return ok
    ? { safe: true, step: 'accept', hold_id: h.id, message: `Safe to accept ${dates} on ${siteName(h.channel)}. They're closed on every site that books instantly.` }
    : { safe: false, step: 'decline', hold_id: h.id, message: `Another booking took ${dates}. Decline this request.` };
}

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const user = createClient(URL_, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const body = await req.json().catch(() => ({})) as Record<string, string | boolean | undefined>;

  if (body.action === 'hold') {
    // Row-level security: only finds the space if it is this host's.
    const { data: sp } = await user.from('spaces').select('id, properties!inner(timezone)').eq('id', String(body.space_id ?? '')).maybeSingle();
    if (!sp) return json({ error: 'Space not found' }, 404);
    // deno-lint-ignore no-explicit-any
    const tz: string = (sp as any).properties.timezone;
    const allDay = body.all_day !== false;
    const start = allDay ? localDayToUtc(String(body.start), tz) : new Date(String(body.start)).toISOString();
    const end = allDay ? localDayToUtc(String(body.end), tz) : new Date(String(body.end)).toISOString();
    const { data: holdId, error } = await user.rpc('place_hold', { p_space: sp.id, p_channel: body.channel, p_start: start, p_end: end, p_all_day: allDay, p_ref: body.ref ?? null, p_guest: body.guest ?? null });
    if (error) return json({ safe: false, step: 'decline', message: error.message } satisfies Verdict, error.hint === 'DATES_TAKEN' ? 409 : 400);
    return json(await check(holdId as string));
  }

  const holdId = String(body.hold_id ?? '');
  const { data: mine } = await user.from('booking_holds').select('id').eq('id', holdId).maybeSingle();
  if (!mine) return json({ error: 'Request not found' }, 404);
  if (body.action === 'check') return json(await check(holdId));
  if (body.action === 'release') {
    const { error } = await user.rpc('release_hold', { p_hold: holdId, p_reason: String(body.reason ?? 'declined') });
    return error ? json({ error: error.message }, 400) : json({ released: true });
  }
  return json({ error: 'Unknown action' }, 400);
});

// Signed-in host request checks and recording of verified external bookings.
//
// POST /functions/v1/booking-guard
//   { "action": "hold",    "space_id", "channel", "start", "end", "all_day"?, "ref"?, "guest"? }  → hold the dates, then check (accepts units and an optional email_id)
//   { "action": "check",   "hold_id" }                                                          → check again after closing dates
//   { "action": "release", "hold_id", "reason"? }                                               → the request was declined
//   { "action": "record", "space_id", "channel", "start", "end", "ref", "verified_on_provider", ... } → record an external confirmation
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { CORS, preflight } from '../_shared/cors.ts';
import { parseProviderCalendar } from '../_shared/ical.ts';
import { BodyLimitError, readBoundedBody } from '../_shared/request-body.ts';
import { reservationRange } from '../_shared/reservation-time.ts';
import { createCalendarFetcher } from '../_shared/fetch.ts';
import { checkDoor, describeDates, describeDays, describeNights, siteName, VERIFIABLE_BY_CALENDAR } from '../_shared/guard.ts';

const fetchCalendar = createCalendarFetcher(Deno.env.get('CALENDAR_FEED_HOST_ALLOWLIST'));
const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

type Verdict = {
  safe: boolean;
  step: 'accept' | 'host_review' | 'booked' | 'expired' | 'close_dates' | 'connect_calendar' | 'decline' | 'retry';
  message: string;
  hold_id?: string;
};
type GuardSnapshot = { time_zone: string; turnover: number; doors: { space_id: string; channel: string; url: string | null }[] };

async function check(holdId: string): Promise<Verdict> {
  const { data: h } = await admin.from('booking_holds')
    .select('id, space_id, channel, starts_at, ends_at, all_day, status, released_reason, expires_at')
    .eq('id', holdId).single();
  if (!h) return { safe: false, step: 'decline', message: 'That request is no longer held.' };
  const { data, error } = await admin.rpc('manual_guard_snapshot', { p_space: h.space_id });
  if (error || !data) {
    return { safe: false, step: 'retry', hold_id: h.id, message: 'Booking settings could not be checked. Try again before accepting.' };
  }
  const snapshot = data as GuardSnapshot;
  const { time_zone: timeZone, turnover, doors } = snapshot;
  const padded = { starts_at: h.starts_at, ends_at: new Date(Date.parse(h.ends_at) + turnover * 60_000).toISOString() };
  const dates = describeDates(h.starts_at, h.ends_at, h.all_day, timeZone);
  if (h.status === 'confirmed') return { safe: false, step: 'booked', hold_id: h.id, message: `Already booked for ${dates}.` };
  if (h.status === 'released') {
    return { safe: false, step: 'decline', hold_id: h.id, message: h.released_reason === 'taken' ? `Another booking took ${dates}. Decline this request.` : 'This hold was released. Start again if the request is still open.' };
  }
  if (Date.parse(h.expires_at) <= Date.now()) {
    return { safe: false, step: 'expired', hold_id: h.id, message: 'This hold has expired. Start a new request if it is still open.' };
  }

  for (const door of doors) {
    if (door.channel === 'everyspace') continue; // Everyspace bookings live in this database and were checked under the lock.
    const site = siteName(door.channel);
    const { data: doorSpace } = await admin.from('spaces').select('title').eq('id', door.space_id).single();
    const where = doorSpace?.title ?? 'this space';
    if (!VERIFIABLE_BY_CALENDAR.has(door.channel)) {
      return { safe: false, step: 'connect_calendar', hold_id: h.id, message: `${site} takes instant bookings for "${where}", and its calendar link can't show whether dates are closed or booked. Switch ${site} to request-to-book, or connect it directly, before accepting.` };
    }
    if (!door.url) return { safe: false, step: 'connect_calendar', hold_id: h.id, message: `Add ${site}'s calendar link for "${where}" so Everyspace can check it.` };

    let events;
    try {
      events = parseProviderCalendar(await fetchCalendar(door.url), timeZone, door.channel);
    } catch (e) {
      return { safe: false, step: 'retry', hold_id: h.id, message: `Couldn't read ${site}'s calendar just now (${e instanceof Error ? e.message : 'error'}). Don't accept yet; try again in a minute.` };
    }
    const result = checkDoor({ hold: padded, doorEvents: events, timeZone });
    if (!result.ok && result.reason === 'taken') {
      return { safe: false, step: 'retry', hold_id: h.id, message: `${site}'s calendar reports an overlapping booking for ${dates}. Check the provider directly before taking action.` };
    }
    if (!result.ok) {
      return { safe: false, step: 'close_dates', hold_id: h.id, message: `On ${site}, close ${h.all_day && !turnover ? describeNights(result.gapStart, result.gapEnd, timeZone) : `${describeDays(result.gapStart, result.gapEnd, timeZone)} (${site} closes whole days)`} for "${where}", then tap Check again. Everyspace is holding these dates for you meanwhile.` };
    }
  }
  const { data: ok, error: markError } = await admin.rpc('mark_hold_checked_snapshot', {
    p_hold: h.id, p_snapshot: snapshot,
  });
  if (markError || ok === null) return { safe: false, step: 'retry', hold_id: h.id, message: 'The hold could not be verified. Try again before accepting.' };
  if (!ok) return { safe: false, step: 'decline', hold_id: h.id, message: `Everyspace could not keep the hold for ${dates}. Check the request and current bookings before acting.` };
  return doors.some((door) => door.channel !== 'everyspace')
    ? { safe: true, step: 'accept', hold_id: h.id, message: `The instant listing’s feed showed these dates closed for ${dates}. Verify the current provider calendars before accepting.` }
    : { safe: false, step: 'host_review', hold_id: h.id, message: `Dates held for ${dates}. Check bookings and availability on each related provider before accepting.` };
}

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const user = createClient(URL_, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  if (!(await user.auth.getUser()).data.user) return json({ error: 'Sign in to manage a request.' }, 401);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBoundedBody(req, 8_192)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Invalid request.' }, 400);
  } catch (error) {
    return json({ error: 'Invalid request.' }, error instanceof BodyLimitError ? 413 : 400);
  }

  if (body.action === 'amend') {
    if (body.verified_on_provider !== true) return json({ error: 'Verify the changed booking on the provider first.' }, 400);
    const { data: booking } = await user.from('reservations')
      .select('id, spaces!inner(properties!inner(timezone))').eq('id', String(body.booking_id ?? '')).maybeSingle();
    if (!booking) return json({ error: 'Booking not found.' }, 404);
    const timeZone = (booking as unknown as { spaces: { properties: { timezone: string } } }).spaces.properties.timezone;
    const allDay = body.all_day !== false;
    try {
      const range = reservationRange(body.start, body.end, allDay, timeZone);
      const { data: amended, error } = await user.rpc('record_external_booking_change', {
        p_booking: booking.id, p_observed_updated_at: body.observed_updated_at,
        p_start: range.startsAt, p_end: range.endsAt, p_all_day: allDay, p_units: body.units,
      });
      if (error) return json({ error: error.message }, 409);
      return amended ? json({ amended: true }) : json({ error: 'This booking cannot be updated here.' }, 409);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Verify the booking dates.' }, 400);
    }
  }

  if (body.action === 'record') {
    if (body.verified_on_provider !== true) return json({ error: 'Verify this confirmation on the provider first.' }, 400);
    const { data: sp } = await user.from('spaces').select('id, properties!inner(timezone)')
      .eq('id', String(body.space_id ?? '')).maybeSingle();
    if (!sp) return json({ error: 'Space not found' }, 404);
    const tz = (sp as unknown as { properties: { timezone: string } }).properties.timezone;
    const allDay = body.all_day !== false;
    try {
      const range = reservationRange(body.start, body.end, allDay, tz);
      const { data, error } = await user.rpc('record_external_booking', {
        p_space: sp.id, p_channel: body.channel, p_start: range.startsAt, p_end: range.endsAt,
        p_all_day: allDay, p_units: body.units ?? 1, p_reference: body.ref, p_hold: body.hold_id ?? null,
      });
      return error ? json({ error: error.message }, 400) : json({ reservation_id: data });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Verify reservation dates.' }, 400);
    }
  }

  if (body.action === 'hold') {
    const { data: review } = body.email_id
      ? await user.from('booking_email_reviews').select('id, space_id, channel').eq('id', String(body.email_id)).maybeSingle()
      : { data: null };
    if (body.email_id && !review) return json({ error: 'Email review not found.' }, 404);

    // Row-level security restricts the lookup to the signed-in host's space.
    const { data: sp } = await user.from('spaces').select('id, properties!inner(timezone)')
      .eq('id', review?.space_id ?? String(body.space_id ?? '')).maybeSingle();
    if (!sp) return json({ error: 'Space not found' }, 404);
    const tz = (sp as unknown as { properties: { timezone: string } }).properties.timezone;
    const allDay = body.all_day !== false;
    let range;
    try {
      range = reservationRange(body.start, body.end, allDay, tz);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Verify reservation dates.' }, 400);
    }
    const dates = { p_start: range.startsAt, p_end: range.endsAt, p_all_day: allDay, p_units: body.units ?? 1 };
    const hold = { ...dates, p_space: sp.id, p_channel: body.channel, p_ref: body.ref ?? null, p_guest: body.guest ?? null };
    const { data: holdId, error } = review
      ? await user.rpc('review_booking_email', { ...dates, p_review: review.id, p_action: 'hold', p_reference: body.ref ?? null })
      : body.command_id
        ? await user.rpc('place_inventory_hold_once', { ...hold, p_command_id: body.command_id })
        : await user.rpc('place_inventory_hold', hold);
    if (error) return error.hint === 'DATES_TAKEN'
      ? json({ safe: false, step: 'decline', message: error.message } satisfies Verdict, 409)
      : json({ error: error.message }, 400);
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

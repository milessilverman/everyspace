// Scheduled reads and interactive refreshes use the same leases and atomic snapshot writer.
import { isServiceAuthorization, serviceClient, userClient } from '../_shared/supabase.ts';
import { collectCalendarObservation, IncompleteCalendarObservation } from '../_shared/calendar-observation.ts';
import { CORS, preflight } from '../_shared/cors.ts';
import { parseProviderCalendar, type CalendarEvent } from '../_shared/ical.ts';
import { calendarRows } from '../_shared/sync.ts';
import { CalendarFetchError, createCalendarFetcher } from '../_shared/fetch.ts';
import { readBoundedBody } from '../_shared/request-body.ts';
import { doorGaps, VERIFIABLE_BY_CALENDAR } from '../_shared/guard.ts';

const admin = serviceClient();
const fetchCalendar = createCalendarFetcher(Deno.env.get('CALENDAR_FEED_HOST_ALLOWLIST'));
const BATCH = 120;
const CONCURRENCY = 8;
const START_BUDGET_MS = 32_000;
const minAge = (scheduled: boolean) => scheduled ? 14 * 60 : 30;

type Import = { id: string; space_id: string; channel: string; url: string };
type Requirement = { kind: 'reservation' | 'hold'; id: string; starts_at: string; ends_at: string };
type SnapshotResult = { status: 'ok' | 'needs_review' | 'error' | 'superseded'; seen_at?: string; missing?: number; older?: number };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' },
});

async function recordAvailabilityWarnings(imp: Import, seenAt: string, events: CalendarEvent[], timeZone: string) {
  if (!VERIFIABLE_BY_CALENDAR.has(imp.channel)) return 0;
  const { data: listing, error: listingError } = await admin.from('channel_listings').select('booking_mode, status')
    .eq('space_id', imp.space_id).eq('channel', imp.channel).maybeSingle();
  if (listingError) throw new Error('listing_lookup');
  if (listing?.booking_mode !== 'instant' || !['pending', 'live'].includes(listing.status)) return 0;
  const { data, error } = await admin.rpc('door_requirements', { p_space: imp.space_id, p_channel: imp.channel });
  if (error) throw new Error('door_requirements');
  const required = (data ?? []) as Requirement[];
  const open = new Set(doorGaps({ required, doorEvents: events, timeZone }));
  const { data: count, error: saveError } = await admin.rpc('record_calendar_door_gaps', {
    p_import: imp.id, p_seen_at: seenAt,
    p_reservations: required.filter((r) => r.kind === 'reservation' && open.has(r.id)).map((r) => r.id),
    p_holds: required.filter((r) => r.kind === 'hold' && open.has(r.id)).map((r) => r.id),
  });
  if (saveError) throw new Error('door_gaps_write');
  return Number(count);
}

async function syncOne(imp: Import, scheduled: boolean) {
  const { data: lease, error: claimError } = await admin.rpc('claim_calendar_sync', {
    p_import: imp.id, p_url: imp.url, p_minimum_age_seconds: minAge(scheduled),
  });
  if (claimError) {
    console.error('calendar_sync_claim_failed');
    return { id: imp.id, status: 'error', error: 'Calendar sync is temporarily unavailable.' };
  }
  if (!lease) return { id: imp.id, status: 'deferred' };

  let events: CalendarEvent[] = [];
  let timeZone: string | null = null;
  let readError: string | null = null;
  let issue: 'incomplete_import' | 'fetch_failed' | null = null;
  try {
    const scope = await admin.from('spaces').select('properties!inner(timezone)').eq('id', imp.space_id).single();
    if (scope.error || !scope.data) throw new CalendarFetchError('The calendar listing could not be found.');
    const zone = (scope.data as unknown as { properties: { timezone: string } }).properties.timezone;
    timeZone = zone;
    events = await collectCalendarObservation(async () => ({
      events: parseProviderCalendar(await fetchCalendar(imp.url), zone, imp.channel),
      nextPage: null,
    }));
  } catch (error) {
    issue = error instanceof IncompleteCalendarObservation ? 'incomplete_import' : 'fetch_failed';
    readError = error instanceof CalendarFetchError || error instanceof IncompleteCalendarObservation
      ? error.message : 'The provider calendar could not be verified.';
  }

  const params = { p_import: imp.id, p_lease: lease, p_time_zone: timeZone };
  const { data, error } = await admin.rpc('apply_calendar_observation', {
    ...params, p_events: timeZone && !readError ? calendarRows(events, timeZone) : [], p_error: readError, p_issue: issue,
  });
  if (error) {
    console.error('calendar_sync_snapshot_failed');
    await admin.rpc('apply_calendar_observation', {
      ...params, p_events: [], p_error: 'The calendar update did not finish. Everyspace kept the previous bookings.', p_issue: 'write_failed',
    });
    return { id: imp.id, status: 'error', error: 'Could not save the calendar. The previous bookings were kept.' };
  }
  const result = data as SnapshotResult;
  let datesStillOpen = 0;
  if (result.seen_at && timeZone && !result.older) {
    try {
      datesStillOpen = await recordAvailabilityWarnings(imp, result.seen_at, events, timeZone);
    } catch {
      console.error('calendar_sync_availability_warning_failed');
      return { id: imp.id, ...result, status: 'needs_review', error: 'Calendar saved. Availability warnings could not be refreshed.' };
    }
  }
  return {
    id: imp.id, ...result, datesStillOpen,
    error: readError ?? (result.status === 'needs_review' ? 'Some events need review. Everyspace kept the previous bookings.'
      : result.status === 'error' ? 'Calendar settings changed during the read. Try again.' : undefined),
  };
}

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  let input: unknown;
  try { input = JSON.parse(new TextDecoder().decode(await readBoundedBody(req, 8192))); }
  catch { return json({ error: 'Invalid sync request.' }, 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'Invalid sync request.' }, 400);
  const { space_id } = input as { space_id?: string };
  if (space_id !== undefined && (typeof space_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(space_id))) {
    return json({ error: 'Invalid space.' }, 400);
  }

  const cronSecret = req.headers.get('x-cron-secret');
  let scheduled = isServiceAuthorization(auth);
  if (!scheduled && cronSecret && cronSecret.length <= 128) {
    scheduled = (await admin.rpc('check_cron_secret', { p_secret: cronSecret })).data === true;
  }
  const client = scheduled ? admin : userClient(auth);
  if (!scheduled && !(await client.auth.getUser()).data.user) return json({ error: 'Sign in to sync calendars.' }, 401);

  let query = client.from('calendar_imports').select('id, space_id, channel, url')
    .order('last_attempt_at', { ascending: true, nullsFirst: true }).order('id').limit(BATCH + 1);
  if (space_id) query = query.eq('space_id', space_id);
  const { data, error } = await query;
  if (error) {
    console.error('calendar_sync_list_failed');
    return json({ error: 'Calendar connections could not be loaded.' }, 503);
  }
  const all = (data ?? []) as Import[];
  const queue = all.slice(0, BATCH);
  const results: Awaited<ReturnType<typeof syncOne>>[] = [];
  const startedAt = Date.now();
  const stopAt = startedAt + START_BUDGET_MS;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && Date.now() < stopAt) {
      const calendar = queue.shift()!;
      try { results.push(await syncOne(calendar, scheduled)); }
      catch {
        console.error('calendar_sync_connection_failed');
        results.push({ id: calendar.id, status: 'error', error: 'Calendar sync did not finish. Try again.' });
      }
    }
  }));
  const skipped = queue.length + Math.max(0, all.length - BATCH)
    + results.filter((r) => r.status === 'deferred' || r.status === 'superseded').length;
  const synced = results.filter((r) => r.status === 'ok').length;
  const errors = results.filter((r) => r.status === 'error').length;
  const needsReview = results.filter((r) => r.status === 'needs_review').length;
  if (scheduled) console.info(JSON.stringify({
    event: 'calendar_sync_run', synced, errors, needs_review: needsReview, deferred: skipped, elapsed_ms: Date.now() - startedAt,
  }));
  return json({ synced, skipped, results });
});

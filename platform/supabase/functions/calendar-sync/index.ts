// Reads every connected site's calendar link and updates reservations.
//
// POST /functions/v1/calendar-sync            body: { "space_id"?: uuid }
// - Called every 15 minutes by pg_cron with a secret from Vault (all spaces), see supabase/cron/calendar_sync.sql.
// - Called by a signed-in host right after they paste a link ("Sync now"); then only their own calendars are read,
//   enforced by row-level security on calendar_imports.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { CORS, preflight } from '../_shared/cors.ts';
import { parseIcs } from '../_shared/ical.ts';
import { planImport } from '../_shared/sync.ts';
import { fetchCalendar } from '../_shared/fetch.ts';
import { doorGaps } from '../_shared/guard.ts';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const BATCH = 200;
const CONCURRENCY = 5;

type Import = { id: string; space_id: string; channel: string; url: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

async function syncOne(imp: Import) {
  const started = new Date().toISOString();
  try {
    const text = await fetchCalendar(imp.url);

    const { data: sp, error: spErr } = await admin.from('spaces').select('properties!inner(timezone)').eq('id', imp.space_id).single();
    if (spErr) throw new Error('Space not found');
    // deno-lint-ignore no-explicit-any
    const timeZone: string = (sp as any).properties.timezone;
    const events = parseIcs(text, { defaultTimeZone: timeZone });

    const { data: existing, error: exErr } = await admin.from('reservations').select('external_uid, status, ends_at')
      .eq('space_id', imp.space_id).eq('channel', imp.channel).eq('source', 'ical');
    if (exErr) throw new Error(exErr.message);
    const plan = planImport({ events, existing: (existing ?? []) as never, timeZone, now: started });

    if (plan.upserts.length) {
      const { error } = await admin.from('reservations').upsert(
        plan.upserts.map((r) => ({ ...r, space_id: imp.space_id, channel: imp.channel, source: 'ical', updated_at: started })),
        { onConflict: 'space_id,channel,external_uid' });
      if (error) throw new Error(error.message);
    }
    if (plan.cancelUids.length) {
      const { error } = await admin.from('reservations').update({ status: 'cancelled', updated_at: started })
        .eq('space_id', imp.space_id).eq('channel', imp.channel).eq('source', 'ical').in('external_uid', plan.cancelUids);
      if (error) throw new Error(error.message);
    }
    const { data: conflicts } = await admin.rpc('detect_conflicts', { p_space: imp.space_id });
    // No-double-booking guard: link holds to the bookings they became, flag requests accepted without the check…
    const { data: unchecked } = await admin.rpc('settle_holds', { p_space: imp.space_id });
    // …and if this site is the space's instant site, make sure it still shows every other booking as closed.
    const { data: listing } = await admin.from('channel_listings').select('booking_mode, status')
      .eq('space_id', imp.space_id).eq('channel', imp.channel).maybeSingle();
    let doorOpen = 0;
    if (listing?.booking_mode === 'instant' && ['pending', 'live'].includes(listing.status)) {
      const { data: reqs } = await admin.rpc('door_requirements', { p_space: imp.space_id, p_channel: imp.channel });
      const req = (reqs ?? []) as { kind: string; id: string; starts_at: string; ends_at: string }[];
      const open = new Set(doorGaps({ required: req, doorEvents: events, timeZone }));
      const { data: n } = await admin.rpc('record_door_gaps', {
        p_space: imp.space_id, p_channel: imp.channel,
        p_reservations: req.filter((r) => r.kind === 'reservation' && open.has(r.id)).map((r) => r.id),
        p_holds: req.filter((r) => r.kind === 'hold' && open.has(r.id)).map((r) => r.id),
      });
      doorOpen = (n as number) ?? 0;
    }
    await admin.from('calendar_imports').update({ last_synced_at: started, last_status: 'ok', last_error: null, event_count: events.length }).eq('id', imp.id);
    return { id: imp.id, ok: true, events: events.length, upserts: plan.upserts.length, cancelled: plan.cancelUids.length, newConflicts: conflicts ?? 0, uncheckedAccepts: unchecked ?? 0, datesStillOpen: doorOpen };
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 300) : 'Unknown error';
    await admin.from('calendar_imports').update({ last_synced_at: started, last_status: 'error', last_error: message }).eq('id', imp.id);
    return { id: imp.id, ok: false, error: message };
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  const body = await req.json().catch(() => ({})) as { space_id?: string };
  // The 15-minute schedule sends a secret from Vault; the service-role key also works when run by hand.
  const cronSecret = req.headers.get('x-cron-secret');
  let isService = auth === `Bearer ${SERVICE}`;
  if (!isService && cronSecret) isService = (await admin.rpc('check_cron_secret', { p_secret: cronSecret })).data === true;
  const client = isService ? admin : createClient(URL_, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: auth } } });

  let q = client.from('calendar_imports').select('id, space_id, channel, url').order('last_synced_at', { ascending: true, nullsFirst: true }).limit(BATCH);
  if (body.space_id) q = q.eq('space_id', body.space_id);
  const { data: imports, error } = await q;
  if (error) return json({ error: isService ? error.message : 'Sign in again to sync your calendars.' }, isService ? 500 : 401);

  const queue = [...(imports ?? [])] as Import[]; const results: unknown[] = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { for (let imp = queue.shift(); imp; imp = queue.shift()) results.push(await syncOne(imp)); }));
  return json({ synced: results.length, results });
});

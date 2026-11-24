// Reads every connected site's calendar link and updates reservations.
//
// POST /functions/v1/calendar-sync            body: { "space_id"?: uuid }
// - Called every 15 minutes by pg_cron with a secret from Vault (all spaces), see supabase/cron/calendar_sync.sql.
// - Called by a signed-in host right after they paste a link ("Sync now"); then only their own calendars are read,
//   enforced by row-level security on calendar_imports, and failure backoff is bypassed so a fixed link works at once.
//
// Resilience (pure rules in _shared/sync.ts):
// - a success records last_ok_at and resets consecutive_failures; a failure stores a short error code (never the URL),
//   adds one to consecutive_failures, and the import is left alone for min(15 min * 2^failures, 6 h);
// - a feed that had events and comes back empty changes nothing until the third empty read in a row.
import { CORS, preflight } from '../_shared/cors.ts';
import { adapterFor, ProviderError } from '../_shared/providers/index.ts';
import { doorGaps } from '../_shared/door.ts';
import type { FetchOptions } from '../_shared/fetch.ts';
import type { CalendarEvent } from '../_shared/ical.ts';
import {
  decideRead, emptyFeedPatch, errorCodeOf, failurePatch, planImport, shouldSkipImport, successPatch,
  type ExistingReservation, type ImportPatch, type ImportRecord,
} from '../_shared/sync.ts';

const BATCH = 200;
const CONCURRENCY = 5;

export type Import = ImportRecord & { id: string; space_id: string; channel: string; url: string };
export type AfterApply = { newConflicts: number; uncheckedAccepts: number; datesStillOpen: number };

/** Everything the handler needs from the outside world. Production wires Supabase; tests pass fakes. */
export type SyncDeps = {
  now(): string;
  io?: FetchOptions;
  /** Cron secret or service-role key (acts on every space) vs a signed-in host (their own spaces only). */
  isService(auth: string, cronSecret: string | null): Promise<boolean>;
  listImports(scope: { service: boolean; auth: string; spaceId?: string; limit: number }): Promise<{ data: Import[] | null; error: string | null }>;
  timeZoneOf(spaceId: string): Promise<string | null>;
  existing(spaceId: string, channel: string): Promise<ExistingReservation[]>;
  upsert(spaceId: string, channel: string, rows: unknown[], now: string): Promise<void>;
  cancel(spaceId: string, channel: string, uids: string[], now: string): Promise<void>;
  afterApply(imp: Import, events: CalendarEvent[], timeZone: string): Promise<AfterApply>;
  patch(importId: string, patch: ImportPatch): Promise<void>;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

export async function syncOne(imp: Import, deps: SyncDeps, started: string) {
  try {
    const adapter = adapterFor(imp.channel, 'importAvailability');
    if (!adapter) throw new ProviderError('unsupported', 'No calendar reader for this site.');
    const timeZone = await deps.timeZoneOf(imp.space_id);
    if (!timeZone) throw coded('space_not_found', 'Space not found');
    const { events } = await adapter.importAvailability({ url: imp.url, timeZone, now: started, io: deps.io });

    // Empty-feed guard: a feed that had events and is suddenly empty cancels nothing until it stays empty.
    const decision = decideRead(imp, events.length);
    if (decision.kind === 'hold_empty') {
      await deps.patch(imp.id, emptyFeedPatch(imp, decision.emptyReads, started));
      return { id: imp.id, ok: false, error: 'empty_feed', emptyReads: decision.emptyReads };
    }

    const existing = await deps.existing(imp.space_id, imp.channel);
    const plan = planImport({ events, existing, timeZone, now: started });
    if (plan.upserts.length) await deps.upsert(imp.space_id, imp.channel, plan.upserts, started);
    if (plan.cancelUids.length) await deps.cancel(imp.space_id, imp.channel, plan.cancelUids, started);
    const after = await deps.afterApply(imp, events, timeZone);
    await deps.patch(imp.id, successPatch(started, events.length));
    return { id: imp.id, ok: true, events: events.length, upserts: plan.upserts.length, cancelled: plan.cancelUids.length, ...after };
  } catch (e) {
    const code = errorCodeOf(e);
    await deps.patch(imp.id, failurePatch(imp, code, started)).catch(() => {});
    return { id: imp.id, ok: false, error: code };
  }
}

export async function handle(req: Request, deps: SyncDeps): Promise<Response> {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  const body = await req.json().catch(() => ({})) as { space_id?: string };
  const service = await deps.isService(auth, req.headers.get('x-cron-secret'));
  if (!service && !auth) return json({ error: 'Sign in to sync your calendars.' }, 401);

  const { data, error } = await deps.listImports({ service, auth, spaceId: body.space_id, limit: BATCH });
  if (error) return json({ error: service ? error : 'Sign in again to sync your calendars.' }, service ? 500 : 401);

  const started = deps.now();
  // Hosts pressing "Sync now" for a space skip the backoff; the schedule honours it.
  const honourBackoff = service || !body.space_id;
  const all = data ?? [];
  const queue = all.filter((imp) => !(honourBackoff && shouldSkipImport({ lastAttemptAt: imp.last_synced_at ?? null, consecutiveFailures: imp.consecutive_failures ?? 0 }, started)));
  const skipped = all.length - queue.length;
  const results: unknown[] = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { for (let imp = queue.shift(); imp; imp = queue.shift()) results.push(await syncOne(imp, deps, started)); }));
  return json({ synced: results.length, skipped, results });
}

// ---------------------------------------------------------------- production wiring (Deno only; never runs under Node tests)

export function productionDeps(): SyncDeps {
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any).Deno;
  let cached: Promise<{ admin: any; user: (auth: string) => any; service: string }> | null = null;
  const clients = () => cached ??= (async () => {
    const { createClient } = await import('npm:@supabase/supabase-js@2.45.4');
    const url = D.env.get('SUPABASE_URL')!; const service = D.env.get('SUPABASE_SERVICE_ROLE_KEY')!; const anon = D.env.get('SUPABASE_ANON_KEY')!;
    return {
      service,
      admin: createClient(url, service, { auth: { persistSession: false } }),
      user: (auth: string) => createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: auth } } }),
    };
  })();
  const fail = (e: { message: string } | null) => { if (e) throw new Error(e.message); };

  return {
    now: () => new Date().toISOString(),
    async isService(auth, cronSecret) {
      const { admin, service } = await clients();
      if (auth === `Bearer ${service}`) return true;
      return cronSecret ? (await admin.rpc('check_cron_secret', { p_secret: cronSecret })).data === true : false;
    },
    async listImports({ service, auth, spaceId, limit }) {
      const c = await clients();
      let q = (service ? c.admin : c.user(auth)).from('calendar_imports')
        .select('id, space_id, channel, url, last_synced_at, last_ok_at, consecutive_failures, last_error, event_count')
        .order('last_synced_at', { ascending: true, nullsFirst: true }).limit(limit);
      if (spaceId) q = q.eq('space_id', spaceId);
      const { data, error } = await q;
      return { data, error: error?.message ?? null };
    },
    async timeZoneOf(spaceId) {
      const { admin } = await clients();
      const { data, error } = await admin.from('spaces').select('properties!inner(timezone)').eq('id', spaceId).single();
      return error ? null : data.properties.timezone;
    },
    async existing(spaceId, channel) {
      const { admin } = await clients();
      const { data, error } = await admin.from('reservations').select('external_uid, status, ends_at').eq('space_id', spaceId).eq('channel', channel).eq('source', 'ical');
      fail(error); return data ?? [];
    },
    async upsert(spaceId, channel, rows, now) {
      const { admin } = await clients();
      const { error } = await admin.from('reservations').upsert(
        (rows as Record<string, unknown>[]).map((r) => ({ ...r, space_id: spaceId, channel, source: 'ical', updated_at: now })),
        { onConflict: 'space_id,channel,external_uid' });
      fail(error);
    },
    async cancel(spaceId, channel, uids, now) {
      const { admin } = await clients();
      const { error } = await admin.from('reservations').update({ status: 'cancelled', updated_at: now }).eq('space_id', spaceId).eq('channel', channel).in('external_uid', uids);
      fail(error);
    },
    async afterApply(imp, events, timeZone) {
      const { admin } = await clients();
      const { data: conflicts } = await admin.rpc('detect_conflicts', { p_space: imp.space_id });
      // No-double-booking guard: link holds to the bookings they became, flag requests accepted without the check…
      const { data: unchecked } = await admin.rpc('settle_holds', { p_space: imp.space_id });
      // …and if this site is the space's instant site, make sure it still shows every other booking as closed.
      const { data: listing } = await admin.from('channel_listings').select('booking_mode, status').eq('space_id', imp.space_id).eq('channel', imp.channel).maybeSingle();
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
      return { newConflicts: (conflicts as number) ?? 0, uncheckedAccepts: (unchecked as number) ?? 0, datesStillOpen: doorOpen };
    },
    async patch(importId, patch) {
      const { admin } = await clients();
      await admin.from('calendar_imports').update(patch).eq('id', importId);
    },
  };
}

const deno = (globalThis as { Deno?: { serve?: (h: (r: Request) => Promise<Response>) => unknown } }).Deno;
if (typeof deno?.serve === 'function') { const deps = productionDeps(); deno.serve((req) => handle(req, deps)); }

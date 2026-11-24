import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sync from '../supabase/functions/calendar-sync/index.ts';
import * as feed from '../supabase/functions/calendar-feed/index.ts';
import * as guard from '../supabase/functions/booking-guard/index.ts';
import * as bookingImport from '../supabase/functions/booking-import/index.ts';
import { successPatch } from '../supabase/functions/_shared/sync.ts';

const LA = 'America/Los_Angeles';
const NOW = '2026-11-24T12:00:00.000Z';
const SECRET = 'SECRETTOKEN123';
const TOKEN = 'a'.repeat(64);
const AUTH = 'Bearer user-jwt-abc';
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://fn.test/${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const bodyOf = async (r: Response) => JSON.parse(await r.text());
const ics = (...ev: string[]) => `BEGIN:VCALENDAR\n${ev.join('\n')}\nEND:VCALENDAR`;
const day = (uid: string, s: string, e: string, summary: string) => `BEGIN:VEVENT\nUID:${uid}\nDTSTART;VALUE=DATE:${s}\nDTEND;VALUE=DATE:${e}\nSUMMARY:${summary}\nEND:VEVENT`;
const io = (handler: () => Response | Promise<Response>, resolve = async () => ['93.184.216.34']) =>
  ({ fetch: (async () => handler()) as unknown as typeof fetch, resolve });

// ------------------------------------------------------------------ calendar-sync

type Imp = sync.Import;
function syncFake(imports: Imp[], feedBody: () => Response, existing: { external_uid: string; status: 'confirmed' | 'cancelled'; ends_at: string }[] = []) {
  const log = { patches: [] as [string, Record<string, unknown>][], upserts: [] as unknown[][], cancels: [] as string[][], applies: 0, listScope: null as unknown,
    applyError: null as Error | null };
  const deps: sync.SyncDeps = {
    now: () => NOW,
    io: io(feedBody),
    isService: async (auth, secret) => auth === 'Bearer SERVICE' || secret === 'cron-secret',
    listImports: async (scope) => { log.listScope = scope; return { data: imports.filter((i) => !scope.spaceId || i.space_id === scope.spaceId).map((i) => ({ ...i })), error: null }; },
    timeZoneOf: async () => LA,
    existing: async () => existing,
    // One call per successful read (sync_calendar_import in production); rows and cancellations travel together.
    apply: async (_s, _c, rows, uids) => {
      log.applies++;
      if (log.applyError) throw log.applyError;
      if (rows.length) log.upserts.push(rows);
      if (uids.length) log.cancels.push(uids);
      return { newConflicts: rows.length ? 1 : 0 };
    },
    afterApply: async () => ({ uncheckedAccepts: 0, datesStillOpen: 0 }),
    patch: async (id, p) => { log.patches.push([id, p as never]); const i = imports.find((x) => x.id === id)!; Object.assign(i, p); },
  };
  return { deps, log };
}
const imp = (over: Partial<Imp> = {}): Imp => ({ id: 'i1', space_id: 's1', channel: 'airbnb', url: `https://cal.example.com/a.ics?token=${SECRET}`, last_synced_at: null, last_ok_at: null, consecutive_failures: 0, last_error: null, event_count: null, ...over });
const SERVICE = { Authorization: 'Bearer SERVICE' };

test('calendar-sync: wrong method, preflight and missing auth', async () => {
  const { deps } = syncFake([imp()], () => new Response(ics()));
  assert.equal((await sync.handle(new Request('https://fn.test/x', { method: 'GET' }), deps)).status, 405);
  assert.equal((await sync.handle(new Request('https://fn.test/x', { method: 'OPTIONS' }), deps)).status, 204);
  assert.equal((await sync.handle(post('x', {}), deps)).status, 401);
});

test('calendar-sync: happy path upserts, records last_ok_at and resets failures', async () => {
  const { deps, log } = syncFake([imp({ consecutive_failures: 2, last_synced_at: '2026-11-24T01:00:00Z', last_error: 'timeout' })], () => new Response(ics(day('r1', '20261201', '20261204', 'Reserved'))));
  const res = await sync.handle(post('x', {}, SERVICE), deps);
  const out = await bodyOf(res);
  assert.equal(res.status, 200); assert.equal(out.synced, 1); assert.equal(out.results[0].ok, true);
  assert.equal(log.upserts[0].length, 1);
  assert.deepEqual(log.patches[0][1], successPatch(NOW, 1));
});

test('calendar-sync: a failed read stores a short code (never the URL), counts up, and does not touch reservations', async () => {
  const { deps, log } = syncFake([imp({ consecutive_failures: 1 })], () => new Response('', { status: 503 }));
  const out = await bodyOf(await sync.handle(post('x', {}, SERVICE), deps));
  assert.deepEqual(out.results[0], { id: 'i1', ok: false, error: 'fetch_failed' });
  const patch = log.patches[0][1];
  assert.equal(patch.last_error, 'fetch_failed'); assert.equal(patch.consecutive_failures, 2); assert.equal(patch.last_status, 'error');
  assert.ok(!('last_ok_at' in patch));
  assert.equal(log.upserts.length + log.cancels.length, 0);
  assert.equal(log.applies, 0);
  assert.ok(!JSON.stringify([out, log.patches]).includes(SECRET));
});

test('calendar-sync: writes go through one locked apply call per read, which also reports new conflicts', async () => {
  const gone = { external_uid: 'gone', status: 'confirmed' as const, ends_at: '2026-12-20T08:00:00Z' };
  const { deps, log } = syncFake([imp({ event_count: 1 })], () => new Response(ics(day('r1', '20261201', '20261204', 'Reserved'))), [gone]);
  const out = await bodyOf(await sync.handle(post('x', {}, SERVICE), deps));
  assert.equal(log.applies, 1);
  assert.deepEqual(log.cancels, [['gone']]);
  assert.equal(out.results[0].newConflicts, 1);
  // Nothing to change: still one apply (so conflicts are re-detected), with no rows and no cancellations.
  const idle = syncFake([imp()], () => new Response(ics()));
  await sync.handle(post('x', {}, SERVICE), idle.deps);
  assert.deepEqual([idle.log.applies, idle.log.upserts.length, idle.log.cancels.length], [1, 0, 0]);
  // A failed apply (e.g. the RPC refuses a row) is a failed sync: no success patch, failures count up.
  const bad = syncFake([imp({ consecutive_failures: 0 })], () => new Response(ics(day('r1', '20261201', '20261204', 'Reserved'))));
  bad.log.applyError = new Error('Row 1: "r1" is a booking made in Everyspace; an import cannot change it.');
  const res = (await bodyOf(await sync.handle(post('x', {}, SERVICE), bad.deps))).results[0];
  assert.equal(res.ok, false);
  assert.equal(bad.log.patches[0][1].last_status, 'error'); assert.equal(bad.log.patches[0][1].consecutive_failures, 1);
});

test('calendar-sync: pasted links to private addresses are refused and recorded as blocked_url', async () => {
  const { deps, log } = syncFake([imp({ url: 'https://169.254.169.254/latest/meta-data' })], () => { throw new Error('must not be fetched'); });
  const out = await bodyOf(await sync.handle(post('x', {}, SERVICE), deps));
  assert.equal(out.results[0].error, 'blocked_url'); assert.equal(log.patches[0][1].last_error, 'blocked_url');
  const dns = syncFake([imp()], () => { throw new Error('must not be fetched'); });
  dns.deps.io = io(() => new Response(''), async () => ['10.0.0.8']);
  assert.equal((await bodyOf(await sync.handle(post('x', {}, SERVICE), dns.deps))).results[0].error, 'blocked_url');
});

test('calendar-sync: imports in backoff are skipped on the schedule, but "Sync now" for a space bypasses it', async () => {
  const recent = imp({ consecutive_failures: 2, last_synced_at: '2026-11-24T11:30:00Z' }); // 30 min ago, needs 60
  const old = imp({ id: 'i2', space_id: 's2', consecutive_failures: 2, last_synced_at: '2026-11-24T10:30:00Z' }); // 90 min ago
  const { deps } = syncFake([recent, old], () => new Response(ics()));
  const sched = await bodyOf(await sync.handle(post('x', {}, SERVICE), deps));
  assert.equal(sched.synced, 1); assert.equal(sched.skipped, 1); assert.equal(sched.results[0].id, 'i2');
  const manual = syncFake([imp({ consecutive_failures: 2, last_synced_at: '2026-11-24T11:59:00Z' })], () => new Response(ics()));
  const now = await bodyOf(await sync.handle(post('x', { space_id: 's1' }, { Authorization: AUTH }), manual.deps));
  assert.equal(now.synced, 1); assert.equal(now.skipped, 0);
  assert.equal((manual.log.listScope as { service: boolean }).service, false); // a host sees only their own via their JWT
});

test('calendar-sync: the empty-feed guard over three runs (nothing cancelled until the third empty read)', async () => {
  const future = { external_uid: 'future', status: 'confirmed' as const, ends_at: '2026-12-20T08:00:00Z' };
  const i = imp({ event_count: 3, last_ok_at: '2026-11-24T11:45:00Z' });
  const { deps, log } = syncFake([i], () => new Response(ics()), [future]);
  const run = async () => (await bodyOf(await sync.handle(post('x', {}, SERVICE), deps))).results[0];
  const first = await run();
  assert.deepEqual([first.ok, first.error, first.emptyReads], [false, 'empty_feed', 1]);
  assert.equal(i.last_error, 'empty_feed:1'); assert.equal(i.event_count, 3); assert.equal(log.cancels.length, 0);
  i.last_synced_at = null; // (the 30-minute backoff would otherwise hold the next run; the schedule is exercised above)
  const second = await run();
  assert.equal(second.emptyReads, 2); assert.equal(i.last_error, 'empty_feed:2'); assert.equal(log.cancels.length, 0); assert.equal(i.last_ok_at, '2026-11-24T11:45:00Z');
  i.last_synced_at = null;
  const third = await run();
  assert.equal(third.ok, true); assert.deepEqual(log.cancels, [['future']]);
  assert.equal(i.event_count, 0); assert.equal(i.consecutive_failures, 0); assert.equal(i.last_error, null); assert.equal(i.last_ok_at, NOW);
});

// ------------------------------------------------------------------ calendar-feed

const busy = [
  { id: 'a', space_id: 's1', channel: 'airbnb', status: 'confirmed', starts_at: '2026-12-01T08:00:00Z', ends_at: '2026-12-03T08:00:00Z', all_day: true },
  { id: 'v', space_id: 's1', channel: 'vrbo', status: 'confirmed', starts_at: '2026-12-10T08:00:00Z', ends_at: '2026-12-12T08:00:00Z', all_day: true },
];
function feedDeps(lookup: feed.FeedLookup) {
  const touched: string[] = [];
  const deps: feed.FeedDeps = { now: () => NOW, loadFeed: async () => lookup, touch: (id) => { touched.push(id); } };
  return { deps, touched };
}
const okLookup = (channel = 'airbnb'): feed.FeedLookup => ({ status: 'ok', feed: { id: 'f1', for_channel: channel, space_id: 's1', title: 'Cabin', timeZone: LA }, rows: busy });
const get = (path: string, method = 'GET') => new Request(`https://fn.test/calendar-feed${path}`, { method });

test('calendar-feed: serves busy dates from other sites only, without guest details', async () => {
  const { deps, touched } = feedDeps(okLookup());
  const res = await feed.handle(get(`?token=${TOKEN}`), deps);
  const text = await res.text();
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type')!, /text\/calendar/);
  assert.match(text, /X-WR-CALNAME:Cabin · Everyspace|Cabin/); assert.match(text, /20261210/); assert.doesNotMatch(text, /20261201/);
  assert.deepEqual(touched, ['f1']);
  assert.equal((await feed.handle(get(`/${TOKEN}.ics`), deps)).status, 200); // token in the path works too
});

test('calendar-feed: bad token, unknown token, wrong method, lookup error, HEAD', async () => {
  const ok = feedDeps(okLookup()).deps;
  assert.equal((await feed.handle(get('?token=short'), ok)).status, 404);
  assert.equal((await feed.handle(get(`?token=${TOKEN}`, 'POST'), ok)).status, 405);
  assert.equal((await feed.handle(get(`?token=${TOKEN}`), feedDeps({ status: 'not_found' }).deps)).status, 404);
  assert.equal((await feed.handle(get(`?token=${TOKEN}`), feedDeps({ status: 'error', message: 'db' }).deps)).status, 503);
  const head = await feed.handle(get(`?token=${TOKEN}`, 'HEAD'), ok);
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await feed.handle(get(`?token=${TOKEN}`, 'OPTIONS'), ok)).status, 204);
});

test('calendar-feed: a channel with no adapter of its own is served by the generic calendar adapter', async () => {
  const res = await feed.handle(get(`?token=${TOKEN}`), feedDeps(okLookup('brand_new_site')).deps);
  assert.equal(res.status, 200); assert.match(await res.text(), /20261201/);
});

// ------------------------------------------------------------------ booking-guard

const HOLD: guard.HoldRow = { id: 'h1', space_id: 's1', channel: 'swimply', starts_at: '2026-12-01T08:00:00.000Z', ends_at: '2026-12-04T08:00:00.000Z', all_day: true, status: 'pending', released_reason: null, title: 'Cabin', timeZone: LA };
function guardFake(opts: { door?: string; calendar?: () => Response; imp?: { url: string; last_ok_at: string | null; consecutive_failures: number | null } | null; hold?: Partial<guard.HoldRow>; safe?: boolean } = {}) {
  const calls = { markSafe: 0, releaseTaken: 0, fetched: 0, placeHold: [] as unknown[], released: [] as unknown[], auths: [] as string[] };
  const imp = opts.imp === undefined ? { url: `https://cal.example.com/a.ics?token=${SECRET}`, last_ok_at: '2026-11-24T11:50:00Z', consecutive_failures: 0 } : opts.imp;
  const deps: guard.GuardDeps = {
    now: () => NOW,
    io: io(() => { calls.fetched++; return (opts.calendar ?? (() => new Response(ics())))(); }),
    getHold: async (id) => (id === 'h1' ? { ...HOLD, ...opts.hold } : null),
    doorListings: async () => [{ space_id: 's1', channel: opts.door ?? 'airbnb' }],
    spaceTitle: async () => 'Cabin',
    importFor: async () => imp,
    releaseTaken: async () => { calls.releaseTaken++; },
    markSafe: async () => { calls.markSafe++; return opts.safe ?? true; },
    findSpace: async (auth, id) => { calls.auths.push(auth); return id === 's1' ? { id: 's1', timeZone: LA } : null; },
    placeHold: async (auth, args) => { calls.auths.push(auth); calls.placeHold.push(args); return { data: 'h1', error: null }; },
    ownsHold: async (auth, id) => { calls.auths.push(auth); return id === 'h1'; },
    releaseHold: async (auth, id, reason) => { calls.released.push([id, reason]); return null; },
  };
  return { deps, calls };
}
const closed = () => new Response(ics(day('b', '20261201', '20261204', 'Airbnb (Not available)')));
const gpost = (body: unknown, headers: Record<string, string> = { Authorization: AUTH }) => post('booking-guard', body, headers);

test('booking-guard: rejects missing auth and wrong method', async () => {
  const { deps } = guardFake();
  assert.equal((await guard.handle(gpost({ action: 'check', hold_id: 'h1' }, {}), deps)).status, 401);
  assert.equal((await guard.handle(new Request('https://fn.test/x', { method: 'GET' }), deps)).status, 405);
  assert.equal((await guard.handle(gpost({ action: 'nope', hold_id: 'h1' }), deps)).status, 400);
  assert.equal((await guard.handle(gpost({ action: 'check', hold_id: 'missing' }), deps)).status, 404);
});

test('booking-guard: safe to accept only after the instant site is read live and shows the dates closed', async () => {
  const ok = guardFake({ calendar: closed });
  const v = await bodyOf(await guard.handle(gpost({ action: 'check', hold_id: 'h1' }), ok.deps));
  assert.deepEqual([v.safe, v.step], [true, 'accept']); assert.equal(ok.calls.markSafe, 1);
  const open = guardFake({ calendar: () => new Response(ics(day('b', '20261201', '20261203', 'Airbnb (Not available)'))) });
  const o = await bodyOf(await guard.handle(gpost({ action: 'check', hold_id: 'h1' }), open.deps));
  assert.deepEqual([o.safe, o.step], [false, 'close_dates']); assert.match(o.message, /Dec 3/); assert.equal(open.calls.markSafe, 0);
  const taken = guardFake({ calendar: () => new Response(ics(day('g', '20261202', '20261203', 'Reserved'))) });
  const t = await bodyOf(await guard.handle(gpost({ action: 'check', hold_id: 'h1' }), taken.deps));
  assert.deepEqual([t.safe, t.step], [false, 'decline']); assert.equal(taken.calls.releaseTaken, 1);
});

test('booking-guard: a site whose calendar cannot separate bookings from blocks is never "safe" (no fetch is made)', async () => {
  for (const door of ['booking_com', 'hipcamp', 'brand_new_site']) {
    const f = guardFake({ door });
    const v = await bodyOf(await guard.handle(gpost({ action: 'check', hold_id: 'h1' }), f.deps));
    assert.deepEqual([v.safe, v.step], [false, 'connect_calendar'], door);
    assert.equal(f.calls.fetched, 0); assert.equal(f.calls.markSafe, 0);
  }
  const none = guardFake({ imp: null });
  assert.equal((await bodyOf(await guard.handle(gpost({ action: 'check', hold_id: 'h1' }), none.deps))).step, 'connect_calendar');
});

test('booking-guard: refuses "safe" when the calendar cannot be read, and says so when it has been failing for a while', async () => {
  const fresh = guardFake({ calendar: () => new Response('', { status: 503 }) });
  const a = await bodyOf(await guard.handle(gpost({ action: 'check', hold_id: 'h1' }), fresh.deps));
  assert.deepEqual([a.safe, a.step], [false, 'retry']); assert.match(a.message, /just now/); assert.equal(fresh.calls.markSafe, 0);
  const stale = guardFake({ calendar: () => new Response('', { status: 503 }), imp: { url: `https://cal.example.com/a.ics?token=${SECRET}`, last_ok_at: '2026-11-24T05:00:00Z', consecutive_failures: 4 } });
  const b = await bodyOf(await guard.handle(gpost({ action: 'check', hold_id: 'h1' }), stale.deps));
  assert.deepEqual([b.safe, b.step], [false, 'retry']); assert.match(b.message, /could not read Airbnb's calendar recently/); assert.equal(stale.calls.markSafe, 0);
  const never = guardFake({ calendar: () => new Response('', { status: 500 }), imp: { url: 'https://cal.example.com/a.ics', last_ok_at: null, consecutive_failures: 0 } });
  assert.match((await bodyOf(await guard.handle(gpost({ action: 'check', hold_id: 'h1' }), never.deps))).message, /never been read successfully/);
  assert.ok(!JSON.stringify([a, b]).includes(SECRET));
});

test('booking-guard: a calendar link pointing at a private address is never "safe"', async () => {
  const f = guardFake({ imp: { url: 'https://10.0.0.5/a.ics', last_ok_at: NOW, consecutive_failures: 0 } });
  const v = await bodyOf(await guard.handle(gpost({ action: 'check', hold_id: 'h1' }), f.deps));
  assert.deepEqual([v.safe, v.step], [false, 'retry']); assert.equal(f.calls.fetched, 0);
});

test('booking-guard: hold places the hold as the caller, converts dates in the property zone, and maps DATES_TAKEN to 409', async () => {
  const f = guardFake({ calendar: closed });
  const res = await guard.handle(gpost({ action: 'hold', space_id: 's1', channel: 'swimply', start: '2026-12-01', end: '2026-12-04' }), f.deps);
  assert.equal(res.status, 200); assert.equal((await bodyOf(res)).safe, true);
  assert.deepEqual(f.calls.placeHold[0], { p_space: 's1', p_channel: 'swimply', p_start: '2026-12-01T08:00:00.000Z', p_end: '2026-12-04T08:00:00.000Z', p_all_day: true, p_ref: null, p_guest: null });
  assert.ok(f.calls.auths.every((a) => a === AUTH));
  assert.equal((await guard.handle(gpost({ action: 'hold', space_id: 'zzz', start: '2026-12-01', end: '2026-12-02' }), f.deps)).status, 404);
  assert.equal((await guard.handle(gpost({ action: 'hold', space_id: 's1', start: '2026-12-04', end: '2026-12-01' }), f.deps)).status, 400);
  f.deps.placeHold = async () => ({ data: null, error: { message: 'Those dates are taken', hint: 'DATES_TAKEN' } });
  const taken = await guard.handle(gpost({ action: 'hold', space_id: 's1', start: '2026-12-01', end: '2026-12-02' }), f.deps);
  assert.equal(taken.status, 409); assert.match((await bodyOf(taken)).message, /taken/);
});

test('booking-guard: release goes through the caller and reports RPC errors', async () => {
  const f = guardFake();
  assert.deepEqual(await bodyOf(await guard.handle(gpost({ action: 'release', hold_id: 'h1', reason: 'declined' }), f.deps)), { released: true });
  assert.deepEqual(f.calls.released, [['h1', 'declined']]);
  f.deps.releaseHold = async () => ({ message: 'not allowed' });
  const bad = await guard.handle(gpost({ action: 'release', hold_id: 'h1' }), f.deps);
  assert.equal(bad.status, 400); assert.equal((await bodyOf(bad)).error, 'not allowed');
});

// ------------------------------------------------------------------ booking-import

type RpcArgs = Parameters<bookingImport.ImportDeps['importReservations']>;
function importFake(rpc: () => Awaited<ReturnType<bookingImport.ImportDeps['importReservations']>> = () => ({ data: { inserted: 2, updated: 0, cancelled: 0, conflicts: 0 }, error: null })) {
  const calls = { rpc: [] as RpcArgs[], found: [] as string[] };
  const deps: bookingImport.ImportDeps = {
    findSpace: async (auth, id) => { calls.found.push(auth); return id === 's1' ? { id: 's1', timeZone: LA } : null; },
    importReservations: async (...a) => { calls.rpc.push(a); return rpc(); },
  };
  return { deps, calls };
}
const CSV = 'Guest Email,start,end,uid\njane@example.com,2026-12-01,2026-12-03,R1\nbob@example.com,2026-12-10,2026-12-12,R2\n';
const ipost = (body: unknown, headers: Record<string, string> = { Authorization: AUTH }) => post('booking-import', body, headers);

test('booking-import: needs auth and POST; answers preflight', async () => {
  const { deps, calls } = importFake();
  assert.equal((await bookingImport.handle(ipost({ space_id: 's1', channel: 'airbnb', csv: CSV }, {}), deps)).status, 401);
  assert.equal((await bookingImport.handle(new Request('https://fn.test/x', { method: 'GET' }), deps)).status, 405);
  assert.equal((await bookingImport.handle(new Request('https://fn.test/x', { method: 'OPTIONS' }), deps)).status, 204);
  assert.equal(calls.rpc.length, 0);
});

test('booking-import: CSV (JSON body) goes through the manual adapter and import_reservations is called with the CALLER\'s JWT', async () => {
  const { deps, calls } = importFake();
  const res = await bookingImport.handle(ipost({ space_id: 's1', channel: 'airbnb', csv: CSV }), deps);
  const out = await bodyOf(res);
  assert.equal(res.status, 200); assert.deepEqual(out, { inserted: 2, updated: 0, cancelled: 0, conflicts: 0, rows: 2 });
  const [auth, args] = calls.rpc[0];
  assert.equal(auth, AUTH); assert.deepEqual(calls.found, [AUTH]);
  assert.deepEqual([args.p_space, args.p_channel, args.p_source], ['s1', 'airbnb', 'manual']);
  assert.deepEqual(args.p_rows.map((r) => [r.external_uid, r.starts_at]), [['R1', '2026-12-01T08:00:00.000Z'], ['R2', '2026-12-10T08:00:00.000Z']]);
  assert.ok(!JSON.stringify(args).includes('example.com'), 'guest contact columns are not forwarded');
});

test('booking-import: multipart file upload works', async () => {
  const { deps, calls } = importFake();
  const fd = new FormData();
  fd.set('space_id', 's1'); fd.set('channel', 'other'); fd.set('file', new File([CSV], 'export.csv', { type: 'text/csv' }));
  const res = await bookingImport.handle(new Request('https://fn.test/booking-import', { method: 'POST', headers: { Authorization: AUTH }, body: fd }), deps);
  assert.equal(res.status, 200); assert.equal(calls.rpc[0][1].p_rows.length, 2); assert.equal(calls.rpc[0][1].p_channel, 'other');
});

test('booking-import: RPC errors are passed through to the host (permission errors as 403)', async () => {
  const a = importFake(() => ({ data: null, error: { message: 'new row violates row-level security policy' } }));
  const r1 = await bookingImport.handle(ipost({ space_id: 's1', channel: 'airbnb', csv: CSV }), a.deps);
  assert.equal(r1.status, 400); assert.equal((await bodyOf(r1)).error, 'new row violates row-level security policy');
  const b = importFake(() => ({ data: null, error: { message: 'not allowed', code: '42501' } }));
  assert.equal((await bookingImport.handle(ipost({ space_id: 's1', channel: 'airbnb', csv: CSV }), b.deps)).status, 403);
});

test('booking-import: a bad file is rejected whole with row numbers, and the RPC is never called', async () => {
  const { deps, calls } = importFake();
  const res = await bookingImport.handle(ipost({ space_id: 's1', channel: 'airbnb', csv: 'start,end\n2026-12-01,2026-12-03\nnope,2026-12-05\n' }), deps);
  const out = await bodyOf(res);
  assert.equal(res.status, 422); assert.equal(out.code, 'parse_error'); assert.match(out.details[0], /^Row 3:/);
  assert.equal(calls.rpc.length, 0);
});

test('booking-import: unknown space, bad channel, empty file, missing fields and oversize uploads', async () => {
  const { deps, calls } = importFake();
  assert.equal((await bookingImport.handle(ipost({ space_id: 'nope', channel: 'airbnb', csv: CSV }), deps)).status, 404);
  assert.equal((await bookingImport.handle(ipost({ space_id: 's1', channel: 'Air BnB!', csv: CSV }), deps)).status, 400);
  assert.equal((await bookingImport.handle(ipost({ space_id: 's1', channel: 'airbnb', csv: '  ' }), deps)).status, 400);
  assert.equal((await bookingImport.handle(ipost({ channel: 'airbnb', csv: CSV }), deps)).status, 400);
  assert.equal((await bookingImport.handle(new Request('https://fn.test/x', { method: 'POST', headers: { Authorization: AUTH, 'content-type': 'application/json' }, body: '{not json' }), deps)).status, 400);
  assert.equal((await bookingImport.handle(ipost({ space_id: 's1', channel: 'airbnb', csv: CSV }, { Authorization: AUTH, 'content-length': '99999999' }), deps)).status, 413);
  const big = await bookingImport.handle(ipost({ space_id: 's1', channel: 'airbnb', csv: `start,end,uid\n2026-12-01,2026-12-02,${'x'.repeat(1_100_000)}` }), deps);
  assert.equal(big.status, 413);
  assert.equal(calls.rpc.length, 0);
});

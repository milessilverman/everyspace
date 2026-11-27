import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fn from '../supabase/functions/property-profile/index.ts';
import * as L from '../supabase/functions/property-profile/logic.ts';

const ORIGIN = 'https://milessilverman.github.io';
const NOW = new Date('2026-11-27T12:00:00.000Z');
const RC = 'rc-SECRET-key-123';
const GS = 'gs-SECRET-key-456';
const DAY = 86_400_000;

type Calls = { cached: unknown[]; reserve: unknown[]; store: any[]; build: any[]; logs: unknown[] };
function setup(opts: { env?: Record<string, string>; cached?: any; budget?: Record<string, boolean>; providers?: any[]; build?: () => any; store?: () => any } = {}) {
  const calls: Calls = { cached: [], reserve: [], store: [], build: [], logs: [] };
  const env: Record<string, string> = { ...(opts.env ?? {}) };
  const deps: fn.Deps = {
    buildProfile: async (q, ctx) => {
      calls.build.push({ q, keys: { ...ctx.keys }, now: ctx.now });
      if (opts.build) return opts.build();
      return { address: q.address, lat: 34.05, lng: -118.25, apn: '5001-002-003', lot_sqft: 6000, county_fips: '06037', providers: opts.providers ?? [{ id: 'census-address', status: 'used', retentionDays: null }], warnings: [] };
    },
    db: {
      getCached: async (k, p) => { calls.cached.push([k, p]); return opts.cached ?? null; },
      reserve: async (p, cap) => { calls.reserve.push([p, cap]); return opts.budget?.[p] ?? true; },
      store: async (a) => { calls.store.push(a); if (opts.store) return opts.store(); return 'id-1'; },
    },
    now: () => NOW,
    env: (n) => env[n],
    fetch: (async () => new Response('{}')) as unknown as typeof fetch,
    log: (e) => calls.logs.push(e),
  };
  return { deps, calls };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://fn.test/property-profile', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const json = async (r: Response) => JSON.parse(await r.text());
const GOOD = { address: '123 Main St, Los Angeles, CA' };

// ---------------------------------------------------------------- methods and CORS
test('method handling: GET/PUT/DELETE are 405, OPTIONS is a 204 preflight', async () => {
  const { deps, calls } = setup();
  for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const r = await fn.handle(new Request('https://fn.test/x', { method: m, headers: { origin: ORIGIN } }), deps);
    assert.equal(r.status, 405, m);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  const pre = await fn.handle(new Request('https://fn.test/x', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } }), deps);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(pre.headers.get('access-control-allow-methods')!, /POST/);
  assert.equal(pre.headers.get('vary'), 'Origin');
  assert.equal(calls.cached.length + calls.build.length, 0);
});

test('CORS: only listed origins; never a wildcard; default origin; custom list; disallowed origin gets 403 with no allow header', async () => {
  const { deps, calls } = setup();
  const bad = await fn.handle(post(GOOD, { origin: 'https://evil.example' }), deps);
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  assert.equal(bad.headers.get('vary'), 'Origin');
  const badPre = await fn.handle(new Request('https://fn.test/x', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), deps);
  assert.equal(badPre.status, 403);
  assert.equal(badPre.headers.get('access-control-allow-origin'), null);
  assert.equal(calls.cached.length, 0, 'no work for a disallowed origin');
  const ok = await fn.handle(post(GOOD), deps);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.notEqual(ok.headers.get('access-control-allow-origin'), '*');
  const viaDomain = await fn.handle(post(GOOD, { origin: 'https://www.milessilverman.com' }), deps);
  assert.equal(viaDomain.headers.get('access-control-allow-origin'), 'https://www.milessilverman.com', 'the same pages under www.milessilverman.com/everyspace/ are allowed by default');

  const c = setup({ env: { ALLOWED_ORIGINS: 'https://a.example, https://b.example' } });
  assert.equal((await fn.handle(post(GOOD, { origin: 'https://b.example' }), c.deps)).headers.get('access-control-allow-origin'), 'https://b.example');
  assert.equal((await fn.handle(post(GOOD), c.deps)).status, 403, 'default origin no longer allowed once a list is set');
  const star = setup({ env: { ALLOWED_ORIGINS: '*' } });
  assert.equal((await fn.handle(post(GOOD, { origin: 'https://evil.example' }), star.deps)).status, 403, 'a wildcard in env is ignored');
  assert.equal((await fn.handle(post(GOOD), star.deps)).status, 200, 'falls back to the default origin');
});

// ---------------------------------------------------------------- validation
test('validation: every rule answers 400 with a fixed message and no builder call', async () => {
  const cases: [string, unknown][] = [
    ['not an object', '[1]'], ['null body', 'null'], ['not json', '{nope'], ['empty', ''],
    ['no address', {}], ['address number', { address: 12345678 }], ['too short', { address: '1 a' }], ['blank', { address: '        ' }],
    ['too long', { address: 'a'.repeat(201) }], ['newline', { address: '123 Main St\nLos Angeles' }], ['nul', { address: '123 Main St\u0000' }],
    ['tab', { address: '123\tMain St' }], ['unknown field', { ...GOOD, extra: 1 }], ['lat only', { ...GOOD, lat: 34 }],
    ['lat string', { ...GOOD, lat: '34', lng: -118 }], ['lat range', { ...GOOD, lat: 91, lng: 0 }], ['lng range', { ...GOOD, lat: 0, lng: -181 }],
    ['lat NaN-ish', { ...GOOD, lat: 1e999, lng: 0 }], ['place_id number', { ...GOOD, place_id: 5 }], ['place_id long', { ...GOOD, place_id: 'p'.repeat(301) }],
    ['place_id empty', { ...GOOD, place_id: '' }], ['place_id control', { ...GOOD, place_id: 'ab\ncd' }],
  ];
  for (const [label, body] of cases) {
    const { deps, calls } = setup();
    const r = await fn.handle(post(body), deps);
    assert.equal(r.status, 400, label);
    assert.equal(calls.cached.length + calls.build.length + calls.reserve.length, 0, label);
  }
});

test('validation: boundaries pass (5 and 200 characters, lat/lng limits, place_id 300, nulls)', async () => {
  for (const body of [{ address: '1 A B' }, { address: 'x'.repeat(200) }, { ...GOOD, lat: -90, lng: 180 }, { ...GOOD, lat: 90, lng: -180 },
    { ...GOOD, place_id: 'p'.repeat(300) }, { ...GOOD, place_id: null, lat: null, lng: null }]) {
    const { deps } = setup();
    assert.equal((await fn.handle(post(body), deps)).status, 200, JSON.stringify(body).slice(0, 40));
  }
});

test('error messages never echo the input', async () => {
  const evil = '<script>alert(1)</script>';
  for (const body of [{ address: evil.slice(0, 4) }, { ...GOOD, [evil]: 1 }, { ...GOOD, place_id: evil.repeat(20) }, { address: evil + '\n' }]) {
    const { deps } = setup();
    const r = await fn.handle(post(body), deps);
    assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes('script'));
  }
  const { deps } = setup();
  const r = await fn.handle(post('{' + evil), deps);
  assert.ok(!(await r.text()).includes('script'));
});

test('oversized body is rejected with 413 (declared and actual)', async () => {
  const { deps, calls } = setup();
  const big = JSON.stringify({ address: '123 Main St', place_id: 'p'.repeat(5000) });
  assert.equal((await fn.handle(post(big), deps)).status, 413);
  assert.equal((await fn.handle(post(big, { 'content-length': '99999' }), deps)).status, 413);
  // A lying content-length does not help: the real size is measured.
  assert.equal((await fn.handle(post(big, { 'content-length': '10' }), deps)).status, 413);
  assert.equal((await fn.handle(post('{"address":"' + 'é'.repeat(2100) + '"}'), deps)).status, 413, 'measured in bytes, not characters');
  assert.equal(calls.cached.length, 0);
});

// ---------------------------------------------------------------- cache
test('cache hit skips the builder and reserves no budget', async () => {
  const { deps, calls } = setup({ env: { RENTCAST_API_KEY: RC, RENTCAST_DAILY_CAP: '10' }, cached: { profile: { address: 'cached', lot_sqft: 1 }, expires_at: '2026-12-01T00:00:00Z' } });
  const r = await fn.handle(post({ address: '  123 MAIN St.,   Los Angeles ', place_id: 'pl-1' }), deps);
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.equal(b.cached, true);
  assert.equal(b.profile.address, 'cached');
  assert.deepEqual(calls.cached, [['123 main st, los angeles', 'pl-1']]);
  assert.equal(calls.build.length + calls.reserve.length + calls.store.length, 0);
});

test('address key normalisation', () => {
  assert.equal(L.addressKey('  123  Main St. ,Los Angeles,CA '), '123 main st, los angeles, ca');
  assert.equal(L.addressKey('123 MAIN ST'), L.addressKey('123 main  st'));
});

// ---------------------------------------------------------------- miss: expiry
test('miss stores with expires_at from the smallest retentionDays of providers used; no stated limit = 90 days', async () => {
  const cases: [any[], number][] = [
    [[{ id: 'google-solar', status: 'used', retentionDays: 30 }, { id: 'census-address', status: 'used', retentionDays: null }], 30],
    [[{ id: 'a', status: 'used', retentionDays: null }, { id: 'b', status: 'used' }], 90],
    [[{ id: 'a', status: 'used', retentionDays: 60 }, { id: 'b', status: 'used', retentionDays: 14 }, { id: 'c', status: 'used', retentionDays: null }], 14],
    // Providers that were skipped or failed do not shorten the retention.
    [[{ id: 'google-solar', status: 'skipped', retentionDays: 30 }, { id: 'x', status: 'failed', retentionDays: 1 }, { id: 'a', status: 'used', retentionDays: null }], 90],
    [[{ id: 'x', status: 'failed' }], 1],
  ];
  for (const [providers, days] of cases) {
    const { deps, calls } = setup({ providers });
    const r = await fn.handle(post(GOOD), deps);
    assert.equal(r.status, 200);
    const b = await json(r);
    assert.equal(b.cached, false);
    assert.equal(calls.store.length, 1);
    const a = calls.store[0];
    assert.equal(a.p_expires_at, new Date(NOW.getTime() + days * DAY).toISOString(), `${days} days`);
    assert.equal(b.expires_at, a.p_expires_at);
    assert.equal(a.p_address_key, '123 main st, los angeles, ca');
    assert.equal(a.p_apn, '5001-002-003');
    assert.equal(a.p_county_fips, '06037');
    assert.equal(a.p_model_version, fn.MODEL_VERSION);
    assert.equal(a.p_lat, 34.05);
  }
});

test('a provider with zero retention is never stored; a store failure still answers', async () => {
  const z = setup({ providers: [{ id: 'a', status: 'used', retentionDays: 0 }] });
  const r = await fn.handle(post(GOOD), z.deps);
  assert.equal(r.status, 200);
  assert.equal(z.calls.store.length, 0);
  const s = setup({ store: () => { throw new Error('db down at postgres://u:p@h/db'); } });
  const r2 = await fn.handle(post(GOOD), s.deps);
  assert.equal(r2.status, 200);
  assert.equal((await json(r2)).expires_at, null);
  assert.deepEqual(s.calls.logs, [{ fn: 'property-profile', code: 'store_failed' }]);
});

test('storeArgs coerces stray profile values so a table check cannot fail', () => {
  const a = L.storeArgs('k st', { address: 'k st', lat: 1, lng: 2, placeId: 'q' }, { address: 5, lat: 999, lng: 'x', apn: 'a'.repeat(101), county_fips: '6037', place_id: '' }, [], 'v', '2027-01-01T00:00:00Z');
  assert.deepEqual([a.p_address, a.p_lat, a.p_lng, a.p_apn, a.p_county_fips, a.p_place_id], ['k st', 1, 2, null, null, 'q']);
});

// ---------------------------------------------------------------- paid providers
const names = (r: any) => Object.fromEntries(r.profile.providers.filter((p: any) => p.status === 'skipped').map((p: any) => [p.id, p.reason]));

test('paid providers without a key, without a cap, or over the cap are skipped with the right reason; the builder never gets the key', async () => {
  // no keys at all
  let s = setup();
  let b = await json(await fn.handle(post(GOOD), s.deps));
  assert.deepEqual(names(b), { rentcast: 'no API key', 'google-solar': 'no API key' });
  assert.deepEqual(s.calls.build[0].keys, {});
  assert.equal(s.calls.reserve.length, 0, 'no budget is reserved without a key');

  // key but no cap / bad caps
  for (const cap of [undefined, '', '0', '-3', 'abc', '1.5', '10; drop', ' ']) {
    s = setup({ env: { RENTCAST_API_KEY: RC, GOOGLE_SOLAR_API_KEY: GS, ...(cap === undefined ? {} : { RENTCAST_DAILY_CAP: cap, GOOGLE_SOLAR_DAILY_CAP: cap }) } });
    b = await json(await fn.handle(post(GOOD), s.deps));
    assert.deepEqual(names(b), { rentcast: 'daily limit not set', 'google-solar': 'daily limit not set' }, String(cap));
    assert.deepEqual(s.calls.build[0].keys, {}, String(cap));
    assert.equal(s.calls.reserve.length, 0, String(cap));
  }

  // key and cap, budget exhausted for one provider only
  s = setup({ env: { RENTCAST_API_KEY: RC, RENTCAST_DAILY_CAP: '5', GOOGLE_SOLAR_API_KEY: GS, GOOGLE_SOLAR_DAILY_CAP: '7' }, budget: { rentcast: false } });
  b = await json(await fn.handle(post(GOOD), s.deps));
  assert.deepEqual(names(b), { rentcast: 'daily limit reached' });
  assert.deepEqual(s.calls.build[0].keys, { googleSolar: GS });
  assert.deepEqual(s.calls.reserve, [['rentcast', 5], ['google-solar', 7]]);

  // budget check itself failing is treated as no budget
  s = setup({ env: { RENTCAST_API_KEY: RC, RENTCAST_DAILY_CAP: '5' } });
  s.deps.db.reserve = async () => { throw new Error('boom'); };
  b = await json(await fn.handle(post(GOOD), s.deps));
  assert.equal(names(b).rentcast, 'daily limit reached');
  assert.deepEqual(s.calls.build[0].keys, {});
});

test('with key + positive cap + budget, the builder receives the key', async () => {
  const s = setup({ env: { RENTCAST_API_KEY: RC, RENTCAST_DAILY_CAP: ' 25 ', GOOGLE_SOLAR_API_KEY: GS, GOOGLE_SOLAR_DAILY_CAP: '3' } });
  const b = await json(await fn.handle(post(GOOD), s.deps));
  assert.deepEqual(s.calls.build[0].keys, { rentcast: RC, googleSolar: GS });
  assert.deepEqual(s.calls.reserve, [['rentcast', 25], ['google-solar', 3]]);
  assert.deepEqual(names(b), {});
  assert.equal(s.calls.build[0].now, NOW.toISOString());
});

test('a builder-written skip for a provider the handler skipped is replaced by the handler reason', async () => {
  const s = setup({ providers: [{ id: 'rentcast', status: 'skipped', reason: 'something else' }, { id: 'census-address', status: 'used', retentionDays: null }] });
  const b = await json(await fn.handle(post(GOOD), s.deps));
  assert.equal(b.profile.providers.filter((p: any) => p.id === 'rentcast').length, 1);
  assert.equal(names(b).rentcast, 'no API key');
});

// ---------------------------------------------------------------- failures and secrets
test('builder failure -> 502 generic, with a code and no detail', async () => {
  const s = setup({ env: { RENTCAST_API_KEY: RC, RENTCAST_DAILY_CAP: '5' }, build: () => { throw new Error(`fetch https://api.rentcast.io/v1/x?apiKey=${RC} failed\n    at secret.js:1`); } });
  const r = await fn.handle(post(GOOD), s.deps);
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { error: 'The property data service is unavailable right now.', code: 'upstream_failed' });
  assert.ok(!text.includes(RC) && !/rentcast\.io|at secret/.test(text));
  assert.ok(!JSON.stringify(s.calls.logs).includes(RC));
  assert.equal(s.calls.store.length, 0);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const bad = setup({ build: () => 'not an object' });
  assert.equal((await fn.handle(post(GOOD), bad.deps)).status, 502);
});

test('cache lookup failure -> 502 generic and no paid call', async () => {
  const s = setup({ env: { RENTCAST_API_KEY: RC, RENTCAST_DAILY_CAP: '5' } });
  s.deps.db.getCached = async () => { throw new Error(`connection to postgres://svc:${RC}@db failed`); };
  const r = await fn.handle(post(GOOD), s.deps);
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes(RC));
  assert.equal(s.calls.build.length + s.calls.reserve.length, 0);
});

test('responses and logs never contain keys, env values or URL query strings, even if the builder leaks them', async () => {
  const env = { RENTCAST_API_KEY: RC, RENTCAST_DAILY_CAP: '5', GOOGLE_SOLAR_API_KEY: GS, GOOGLE_SOLAR_DAILY_CAP: '5', ALLOWED_ORIGINS: ORIGIN };
  const leaky = () => ({ address: `123 Main ${RC}`, apn: '1', providers: [{ id: 'rentcast', status: 'used', retentionDays: null, url: `https://api.rentcast.io/v1/properties?address=x&apiKey=${RC}`, note: encodeURIComponent(GS) }],
    fields: { lot_sqft: { value: 1, source: `https://solar.googleapis.com/v1/buildingInsights:findClosest?key=${GS}&location=1` } }, warnings: [] });
  const s = setup({ env, build: leaky });
  const r = await fn.handle(post(GOOD), s.deps);
  const text = await r.text();
  assert.equal(r.status, 200);
  for (const secret of [RC, GS, encodeURIComponent(GS)]) assert.ok(!text.includes(secret), secret);
  assert.ok(!text.includes('apiKey=') && !text.includes('?key='), 'query strings removed');
  assert.ok(text.includes('https://api.rentcast.io/v1/properties'), 'the URL path stays');
  assert.ok(!text.includes('ALLOWED_ORIGINS') && !text.includes('DAILY_CAP'));
  assert.ok(!JSON.stringify(s.calls.logs).includes(RC) && !JSON.stringify(s.calls.logs).includes(GS));
  // The stored copy is the scrubbed-by-builder profile; the secret must not reach the database either way it was passed in.
  // (The builder contract redacts; this handler additionally scrubs everything it sends out to the visitor.)
  // A cached hit is scrubbed on the way out too.
  const c = setup({ env, cached: { profile: { note: `x ${GS}`, u: 'https://a.example/p?token=abc' } } });
  const t = await (await fn.handle(post(GOOD), c.deps)).text();
  assert.ok(!t.includes(GS) && !t.includes('token=abc'));
  // Every response carries no-store.
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('logs carry codes only', async () => {
  const s = setup();
  await fn.handle(post({ address: 'x' }), s.deps);
  await fn.handle(post(GOOD, { origin: 'https://evil.example' }), s.deps);
  for (const e of s.calls.logs as any[]) assert.deepEqual(Object.keys(e).sort(), ['code', 'fn']);
  assert.equal(s.calls.logs.length, 2);
});

test('logic helpers: positiveInt, retentionDays, scrub', () => {
  assert.deepEqual(['5', ' 7 ', '0', '-1', '1e3', '', undefined, '99999999999'].map(L.positiveInt), [5, 7, 0, 0, 0, 0, 0, 0]);
  assert.equal(L.retentionDays([]), 1);
  assert.equal(L.scrub('see https://x.test/a?b=c&d=e now', []), 'see https://x.test/a now');
  assert.equal(L.scrub('k=abcd1234', ['abcd1234']), 'k=[redacted]');
  assert.equal(L.scrub('k=ab', ['ab']), 'k=ab', 'very short secrets are not substituted');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPhotonAddress, photonAddress, suggestionFromFeature, PHOTON_URL, MIN_CHARS, MIN_INTERVAL_MS, ATTRIBUTION_TEXT, STATE_ABBR } from '../providers/photon-address.js';
import { createRegistry } from '../providers/registry.js';
import { suggestionSources, SUGGESTION_ATTRIBUTION } from '../providers/browser.js';

const REAL = JSON.parse(readFileSync(new URL('./fixtures/providers/photon-city-halls.json', import.meta.url), 'utf8'));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const feature = (props, coords = [-87.63, 41.88]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: coords }, properties: { countrycode: 'US', housenumber: '12', street: 'Main Street', city: 'Springfield', state: 'Illinois', postcode: '62701', ...props } });
/** A fake clock + sleep: sleeping advances the clock, nothing really waits. */
function clock() {
  const c = { t: 1000, sleeps: [] };
  c.nowMs = () => c.t;
  c.sleep = async (ms) => { c.sleeps.push(ms); c.t += ms; };
  return c;
}

test('REAL answers: only US results with a house number and street, formatted "123 Main St, City, ST 12345", with coordinates', async () => {
  const la = await createPhotonAddress().suggest('200 N Spring St, Los Angeles', { fetch: async () => json(REAL.la.body) });
  assert.equal(la.ok, true);
  assert.deepEqual(la.suggestions.map((s) => s.text), ['200 North Spring Street, Los Angeles, CA 90012']);
  assert.ok(Math.abs(la.suggestions[0].lat - 34.0536961) < 1e-6 && Math.abs(la.suggestions[0].lng + 118.2429212) < 1e-6, 'coordinates are returned with the suggestion');
  assert.equal(la.suggestions[0].precision, 'rooftop');
  const ch = await createPhotonAddress().suggest('121 N LaSalle St, Chicago', { fetch: async () => json(REAL.chicago.body) });
  assert.equal(ch.suggestions[0].text, '121 North LaSalle Street, Chicago, IL 60602');
  assert.ok(ch.suggestions.length >= 2 && ch.suggestions.length <= 5);
  assert.ok(ch.suggestions.every((s) => /^\d+ .+, .+, [A-Z]{2} \d{5}$/.test(s.text)));
  assert.equal(new Set(ch.suggestions.map((s) => s.text)).size, ch.suggestions.length, 'no duplicates');
});

test('suggestionFromFeature: US filter, house number and street required, state names become postal codes, bad coordinates refused', () => {
  assert.equal(suggestionFromFeature(feature({ countrycode: 'CA' })), null, 'not in the United States');
  assert.equal(suggestionFromFeature(feature({ countrycode: undefined })), null);
  assert.equal(suggestionFromFeature(feature({ housenumber: undefined })), null, 'no house number');
  assert.equal(suggestionFromFeature(feature({ street: undefined })), null, 'no street');
  assert.equal(suggestionFromFeature(feature({ state: 'Atlantis' })), null, 'unknown state: cannot format ST');
  assert.equal(suggestionFromFeature(feature({}, [999, 10])), null);
  assert.equal(suggestionFromFeature(feature({}, ['x', 'y'])), null);
  assert.equal(suggestionFromFeature(feature({})).text, '12 Main Street, Springfield, IL 62701');
  assert.equal(suggestionFromFeature(feature({ city: undefined, town: 'Smallville', postcode: undefined })).text, '12 Main Street, Smallville, IL');
  assert.equal(suggestionFromFeature(feature({ state: 'IL' })).text, '12 Main Street, Springfield, IL 62701', 'a postal code already');
  assert.equal(Object.keys(STATE_ABBR).length, 51);
});

test('the request: url, limit, lang; lat/lon only when a bias point is known; nothing for fewer than 4 characters', async () => {
  const seen = [];
  const f = async (u) => { seen.push(String(u)); return json({ features: [] }); };
  const c = clock();
  const p = createPhotonAddress();
  for (const t of ['', '  ', '12', '123', ' 1 2']) assert.deepEqual(await p.suggest(t, { fetch: f, ...c }), { ok: true, suggestions: [] });
  assert.equal(MIN_CHARS, 4); assert.equal(seen.length, 0, 'no request below 4 characters');
  await p.suggest('12 Main St', { fetch: f, ...c });
  const u1 = new URL(seen[0]);
  assert.equal(`${u1.origin}${u1.pathname}`, PHOTON_URL); assert.equal(u1.searchParams.get('q'), '12 Main St'); assert.equal(u1.searchParams.get('lang'), 'en'); assert.ok(Number(u1.searchParams.get('limit')) >= 5);
  assert.equal(u1.searchParams.has('lat'), false); assert.equal(u1.searchParams.has('lon'), false);
  assert.ok(!seen[0].includes('+'), 'spaces are %20');
  await p.suggest('12 Main St', { fetch: f, bias: { lat: 41.88, lng: -87.63 }, ...c });
  const u2 = new URL(seen[1]);
  assert.equal(u2.searchParams.get('lat'), '41.8800'); assert.equal(u2.searchParams.get('lon'), '-87.6300');
  await p.suggest('12 Main St', { fetch: f, bias: { lat: NaN, lng: 1 }, ...c });
  assert.equal(new URL(seen[2]).searchParams.has('lat'), false, 'a broken bias is ignored');
});

test('rate cap: one request start per 250 ms and never two in flight (a newer question aborts the older one first)', async () => {
  const c = clock();
  const starts = [];
  let inFlight = 0, maxInFlight = 0;
  const f = (u, init) => new Promise((resolve, reject) => {
    starts.push(c.t); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    const done = () => { inFlight--; };
    init.signal.addEventListener('abort', () => { done(); reject(new DOMException('aborted', 'AbortError')); });
    setTimeout(() => { if (!init.signal.aborted) { done(); resolve(json({ features: [feature({})] })); } }, 5);
  });
  const p = createPhotonAddress();
  const a = p.suggest('12 Main St', { fetch: f, ...c });
  const b = p.suggest('12 Main Str', { fetch: f, ...c }); // arrives while the first is in flight
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.ok, false, 'the older question was stopped'); assert.equal(rb.ok, true);
  const d = await p.suggest('12 Main Stre', { fetch: f, ...c });
  assert.equal(d.ok, true);
  assert.equal(maxInFlight, 1, 'at most one request in flight');
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= MIN_INTERVAL_MS, `starts ${starts[i - 1]} -> ${starts[i]} are at least ${MIN_INTERVAL_MS} ms apart`);
  assert.equal(MIN_INTERVAL_MS, 250);
});

test('rate cap with an old question still waiting for its gap: the newest keystroke wins and only it sends a request', async () => {
  const c = clock();
  const seen = [];
  const f = async (u) => { seen.push(new URL(String(u)).searchParams.get('q')); return json({ features: [] }); };
  const p = createPhotonAddress();
  await p.suggest('12 Main St', { fetch: f, ...c }); // sets the "last start" time
  const slow = { ...c, sleep: async (ms) => { c.sleeps.push(ms); await Promise.resolve(); await Promise.resolve(); } };
  const [x, y] = await Promise.all([p.suggest('34 Oak Av', { fetch: f, ...slow }), p.suggest('34 Oak Ave', { fetch: f, ...slow })]);
  assert.deepEqual(seen.filter((q) => q.startsWith('34')), ['34 Oak Ave']);
  assert.equal(x.ok, false); assert.equal(y.ok, true);
});

test('fails silent: network error, HTTP error, bad JSON, abort, no fetch never throw', async () => {
  const c = clock();
  const p = createPhotonAddress();
  assert.equal((await p.suggest('12 Main St', { fetch: async () => { throw new Error('offline'); }, ...c })).ok, false);
  const http = await p.suggest('12 Main St', { fetch: async () => json({}, 503), ...c });
  assert.deepEqual([http.ok, http.code], [false, 'http_error']);
  assert.equal((await p.suggest('12 Main St', { fetch: async () => new Response('<html>', { status: 200 }), ...c })).ok, false);
  assert.equal((await p.suggest('12 Main St', { fetch: async () => json({ nope: 1 }), ...c })).code, 'malformed_json');
  const ctl = new AbortController(); ctl.abort();
  assert.equal((await p.suggest('12 Main St', { fetch: async () => json({ features: [] }), signal: ctl.signal, ...c })).ok, false);
  assert.equal((await p.suggest('12 Main St', { ...c })).code, 'no_fetch');
});

test('markup in a name stays text: the suggestion keeps the characters, nothing builds HTML', () => {
  const s = suggestionFromFeature(feature({ street: '<img src=x onerror=alert(1)> Road', city: '<b>Town</b>' }));
  assert.equal(s.text, '12 <img src=x onerror=alert(1)> Road, <b>Town</b>, IL 62701');
});

test('contract: an address provider with no key, national coverage, and a resolve that never geocodes; registers; coordinates pass through resolve', async () => {
  const p = createPhotonAddress();
  assert.deepEqual([p.id, p.kind, p.needsKey, p.coverage], ['photon', 'address', false, { national: true }]);
  createRegistry().register(p);
  const ok = await p.resolve({ text: '12 Main Street, Springfield, IL 62701', lat: 39.8, lng: -89.6 });
  assert.deepEqual([ok.ok, ok.address, ok.lat, ok.lng], [true, '12 Main Street, Springfield, IL 62701', 39.8, -89.6]);
  assert.equal((await p.resolve('12 Main St')).ok, false, 'a plain string is not geocoded by Photon (no second request)');
  assert.ok(photonAddress.suggest);
});

test('browser registry: Photon is the one extra suggestion source, asked after the county source (the page does that); footer text', async () => {
  const src = suggestionSources();
  assert.deepEqual(src.map((s) => s.id), ['photon']);
  assert.equal(src[0].appliesTo('abc'), false); assert.equal(src[0].appliesTo('abcd'), true);
  assert.equal(SUGGESTION_ATTRIBUTION, 'Address suggestions © OpenStreetMap contributors (via Photon)');
  assert.equal(ATTRIBUTION_TEXT, SUGGESTION_ATTRIBUTION);
  const r = await src[0].suggest('121 N LaSalle St, Chicago', { fetch: async () => json(REAL.chicago.body), now: '2026-11-27T12:00:00Z' });
  assert.equal(r.ok, true); assert.equal(r.suggestions[0].text, '121 North LaSalle Street, Chicago, IL 60602');
});

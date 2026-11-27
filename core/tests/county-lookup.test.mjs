import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countyAt, FIPS_ST, FCC_AREA_URL, TIGERWEB_COUNTY_URL } from '../providers/county-lookup.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/providers/${n}`, import.meta.url), 'utf8'));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const PT = { lat: 34.05389, lng: -118.24349 };
/** fcc / tiger: functions returning a Response */
function net({ fcc, tiger }) {
  const calls = [];
  const f = async (url) => {
    url = String(url); calls.push(url);
    if (url.startsWith(FCC_AREA_URL)) return fcc();
    if (url.startsWith(TIGERWEB_COUNTY_URL)) return tiger();
    throw new Error('unexpected ' + url);
  };
  f.calls = calls;
  return f;
}
const LA_FCC = () => json(fx('fcc-county-la-city-hall.json'));
const LA_TIGER = () => json(fx('tigerweb-county-la-city-hall.json'));
const down = () => new Response('busy', { status: 502 });

test('FCC answers (recorded, Los Angeles City Hall): county, state and FIPS; TIGERweb is not asked', async () => {
  const f = net({ fcc: LA_FCC, tiger: () => { throw new Error('should not be asked'); } });
  const r = await countyAt(PT, { fetch: f });
  assert.deepEqual(r, { ok: true, state: 'CA', stateFips: '06', countyFips: '06037', county: 'Los Angeles County', source: 'FCC census-area API' });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /lat=34\.05389&lon=-118\.24349&censusYear=2020&format=json/);
});

test('FCC down -> TIGERweb answers (recorded): same county, labelled with its own source', async () => {
  for (const fcc of [down, () => { throw new Error('ECONNRESET'); }, () => new Response('<html>', { status: 200 }), () => json({ results: [] }), () => json({})]) {
    const r = await countyAt(PT, { fetch: net({ fcc, tiger: LA_TIGER }) });
    assert.deepEqual([r.ok, r.countyFips, r.state, r.county, r.source], [true, '06037', 'CA', 'Los Angeles County', 'Census TIGERweb State_County']);
  }
});

test('the real out-of-state recording (Chicago City Hall) gives Cook County, IL', async () => {
  const r = await countyAt({ lat: 41.88388, lng: -87.63227 }, { fetch: net({ fcc: () => json(fx('fcc-county-chicago-city-hall.json')), tiger: down }) });
  assert.deepEqual([r.ok, r.state, r.countyFips, r.county], [true, 'IL', '17031', 'Cook County']);
});

test('a point on a county line: FCC lists blocks of two counties -> not trusted, TIGERweb decides; both unavailable -> ambiguous', async () => {
  const two = () => json({ results: [{ county_fips: '06037', county_name: 'Los Angeles County', state_code: 'CA' }, { county_fips: '06059', county_name: 'Orange County', state_code: 'CA' }] });
  const r = await countyAt(PT, { fetch: net({ fcc: two, tiger: LA_TIGER }) });
  assert.equal(r.countyFips, '06037'); assert.equal(r.source, 'Census TIGERweb State_County');
  const amb = await countyAt(PT, { fetch: net({ fcc: two, tiger: down }) });
  assert.equal(amb.ok, false); assert.equal(amb.code, 'ambiguous'); assert.match(amb.reason, /2 counties/);
});

test('failures: both services down (code from the last), outside the US (no match), timeout, malformed, unknown state FIPS', async () => {
  const both = await countyAt(PT, { fetch: net({ fcc: down, tiger: down }) });
  assert.deepEqual([both.ok, both.code], [false, 'server_error']); assert.match(both.reason, /FCC: HTTP 502; TIGERweb: HTTP 502/);
  const none = await countyAt({ lat: 51.5, lng: -0.12 }, { fetch: net({ fcc: () => json({ results: [] }), tiger: () => json({ features: [] }) }) });
  assert.deepEqual([none.ok, none.code], [false, 'no_match']); assert.match(none.reason, /outside the US/);
  const t = await countyAt(PT, { fetch: hang, timeoutMs: 15 });
  assert.deepEqual([t.ok, t.code], [false, 'timeout']);
  const bad = await countyAt(PT, { fetch: net({ fcc: () => json({ nope: 1 }), tiger: () => json({ error: { code: 400, message: 'Invalid or missing input parameters.' } }) }) });
  assert.equal(bad.ok, false); assert.match(bad.reason, /Invalid or missing input parameters/);
  const odd = await countyAt(PT, { fetch: net({ fcc: () => json({ results: [{ county_fips: '99001', state_code: '' }] }), tiger: () => json({ features: [] }) }) });
  assert.equal(odd.ok, false); assert.match(odd.reason, /state FIPS 99/);
});

test('bad input is refused before any request', async () => {
  const f = net({ fcc: LA_FCC, tiger: LA_TIGER });
  for (const p of [null, {}, { lat: 'x', lng: 1 }, { lat: 95, lng: 0 }, { lat: 0, lng: 200 }]) assert.equal((await countyAt(p, { fetch: f })).code, 'bad_query');
  assert.equal(f.calls.length, 0);
  assert.equal((await countyAt(PT, {})).ok, false);
});

test('optional cache: the second call for the same 5-decimal point makes no request; failures are not cached', async () => {
  const cache = new Map();
  const f = net({ fcc: LA_FCC, tiger: down });
  const a = await countyAt(PT, { fetch: f, countyCache: cache });
  const b = await countyAt({ ...PT }, { fetch: f, countyCache: cache });
  assert.deepEqual(a, b); assert.equal(f.calls.length, 1);
  const c2 = new Map();
  await countyAt(PT, { fetch: net({ fcc: down, tiger: down }), countyCache: c2 });
  assert.equal(c2.size, 0);
});

test('deterministic, no mutation, and the state table covers 50 states plus DC', async () => {
  const pt = deepFreeze({ ...PT }), d = deepFreeze({ timeoutMs: 5000 });
  const a = await countyAt(pt, { ...d, fetch: net({ fcc: LA_FCC, tiger: down }) });
  const b = await countyAt(pt, { ...d, fetch: net({ fcc: LA_FCC, tiger: down }) });
  assert.deepEqual(a, b);
  assert.equal(Object.keys(FIPS_ST).length, 51); assert.equal(FIPS_ST['11'], 'DC'); assert.equal(FIPS_ST['06'], 'CA');
  assert.equal(new Set(Object.values(FIPS_ST)).size, 51);
});

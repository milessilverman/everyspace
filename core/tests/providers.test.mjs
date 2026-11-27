import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRegistry, createDefaultRegistry, covers } from '../providers/registry.js';
import { laAssessor, parseSitus, buildSitusWhere, summarizeImprovements } from '../providers/la-assessor.js';
import { lariacBuildings, toEsriRings } from '../providers/lariac-buildings.js';
import { laCamsAddress } from '../providers/la-cams-address.js';
import { censusAddress } from '../providers/census-address.js';
import { rentcast, mapRentcastProperty } from '../providers/rentcast.js';
import { googleSolar, parseBuildingInsights } from '../providers/google-solar.js';
import { normalizePlace } from '../providers/google-places.js';
import { compareValues, redact, callJson, qs } from '../providers/util.js';
import { polygonAreaSqft } from '../geometry.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/providers/${n}`, import.meta.url), 'utf8'));
const NOW = '2026-11-27T12:00:00Z';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Router: first [substring|fn, handler] whose matcher fits the URL. Records every call. */
function router(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [m, h] of routes) {
      if (typeof m === 'function' ? m(String(url), init) : String(url).includes(m)) return typeof h === 'function' ? h(String(url), init) : h.clone();
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  f.calls = calls;
  return f;
}
const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
const deps = (fetch, extra = {}) => ({ fetch, now: NOW, ...extra });
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

const SFR = '4321 Example Ave, Los Angeles, CA 90099';
const sfrParcel = () => fx('synthetic-assessor-sfr.json');

// ---- util -----------------------------------------------------------------------------------------------------------------

test('redact removes raw and url-encoded secrets; callJson classifies statuses and never echoes the secret', async () => {
  assert.equal(redact('GET ?key=abc/def+1 failed abc/def+1 and abc%2Fdef%2B1', ['abc/def+1']), 'GET ?key=[redacted] failed [redacted] and [redacted]');
  const key = 'SECRET-KEY-12345';
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [404, 'not_found'], [429, 'rate_limited'], [500, 'server_error'], [503, 'server_error'], [418, 'http_error']]) {
    const r = await callJson('https://x.test/?key=' + key, deps(router([['x.test', json({}, status)]])), {}, [key]);
    assert.equal(r.ok, false); assert.equal(r.code, code); assert.equal(r.status, status);
  }
  const net = await callJson('https://x.test/?key=' + key, deps(async (u) => { throw new Error(`connect ECONNREFUSED ${u}`); }), {}, [key]);
  assert.equal(net.code, 'network'); assert.ok(!net.reason.includes(key)); assert.match(net.reason, /redacted/);
  assert.equal((await callJson('https://x.test', deps(router([['x.test', new Response('<html>', { status: 200 })]])))).code, 'malformed_json');
  assert.equal((await callJson('https://x.test', deps(hang, { timeoutMs: 15 }))).code, 'timeout');
  assert.equal((await callJson('https://x.test', { now: NOW })).code, 'no_fetch');
  assert.equal(qs({ a: 'x y', b: '1+2' }), 'a=x%20y&b=1%2B2');
});

test('compareValues: exact and area tolerances (5% match, 15% minor)', () => {
  assert.equal(compareValues(3, 3, 'exact').agreement, 'match');
  assert.equal(compareValues(3, 4, 'exact').agreement, 'conflict');
  assert.equal(compareValues(1000, 1050, 'area').agreement, 'match');   // 4.76%
  assert.equal(compareValues(1000, 1100, 'area').agreement, 'minor');   // 9.09%
  assert.equal(compareValues(1000, 1150, 'area').agreement, 'minor');   // 13.04%
  assert.equal(compareValues(1000, 1250, 'area').agreement, 'conflict');// 20%
  const c = compareValues(1100, 1000, 'area');
  assert.deepEqual([c.difference, c.differencePct], [100, 10]);
  assert.equal(compareValues(5, 0, 'area').differencePct, null);
});

// ---- registry ------------------------------------------------------------------------------------------------------------------

const fake = (id, kind, extra = {}) => ({ id, label: id, kind, needsKey: false, coverage: { national: true }, retentionDays: null, licenseNote: 'x', [kind === 'address' ? 'resolve' : 'lookup']: async () => ({ ok: true }), ...extra });

test('registry: primaries before fallbacks, then priority, then registration order; coverage filters', () => {
  const r = createRegistry();
  r.register(fake('fb-late', 'records', { priority: 50 })).register(fake('fb-early', 'records', { priority: 5 })).register(fake('prim', 'records', { role: 'primary' }))
    .register(fake('tx-only', 'records', { coverage: { state: 'TX' } })).register(fake('la-only', 'records', { coverage: { state: 'CA', countyFips: '06037' } }))
    .register(fake('sf-only', 'records', { coverage: { state: 'CA', countyFips: '06075' } })).register(fake('other', 'footprint'));
  const ids = (x) => x.providers.map((p) => p.id);
  assert.deepEqual(ids(r.providersFor('records', { jurisdiction: { state: 'CA', countyFips: '06037' } })), ['prim', 'fb-early', 'fb-late', 'la-only']);
  assert.deepEqual(ids(r.providersFor('records')), ['prim', 'fb-early', 'fb-late', 'tx-only', 'la-only', 'sf-only']);
  assert.deepEqual(r.list('footprint').map((p) => p.id), ['other']);
  assert.equal(r.get('prim').id, 'prim'); assert.equal(r.get('nope'), null);
  assert.equal(covers({ state: 'CA' }, { state: 'ca', countyFips: '06037' }), true);
});

test('registry: a provider without its key is skipped (not an error); with the key it is used', () => {
  const r = createRegistry().register(fake('keyed', 'records', { needsKey: true, role: 'primary' })).register(fake('free', 'records'));
  const none = r.providersFor('records', { keys: {} });
  assert.deepEqual(none.providers.map((p) => p.id), ['free']);
  assert.deepEqual(none.skipped, [{ id: 'keyed', skipped: 'no API key' }]);
  assert.deepEqual(r.providersFor('records', { keys: { keyed: '' } }).skipped.length, 1);
  const withKey = r.providersFor('records', { keys: { keyed: 'k' } });
  assert.deepEqual(withKey.providers.map((p) => p.id), ['keyed', 'free']);
  assert.equal(withKey.skipped.length, 0);
});

test('registry: validation and duplicate ids', () => {
  const r = createRegistry();
  assert.throws(() => r.register(null), TypeError);
  assert.throws(() => r.register({ id: 'a', kind: 'weird', needsKey: false, coverage: { national: true } }), /kind/);
  assert.throws(() => r.register({ ...fake('a', 'records'), needsKey: 'no' }), /needsKey/);
  assert.throws(() => r.register({ ...fake('a', 'address'), resolve: undefined }), /resolve/);
  assert.throws(() => r.register({ ...fake('a', 'records'), coverage: {} }), /coverage/);
  r.register(fake('a', 'records'));
  assert.throws(() => r.register(fake('a', 'records')), /duplicate/);
});

test('registry: swapping in another vendor (ATTOM/Regrid-like) is one file + one register call', async () => {
  const r = await createDefaultRegistry();
  assert.deepEqual(r.providersFor('records', { jurisdiction: { state: 'CA', countyFips: '06037' }, keys: {} }).providers.map((p) => p.id), ['la-assessor']);
  const attomLike = { ...fake('attom-fake', 'records', { role: 'primary', needsKey: true }), lookup: async () => ({ ok: true, fields: {}, raw: { vendor: 'fake' } }) };
  r.register(attomLike);
  const got = r.providersFor('records', { jurisdiction: { state: 'CA', countyFips: '06037' }, keys: { 'attom-fake': 'k' } });
  assert.deepEqual(got.providers.map((p) => p.id), ['attom-fake', 'la-assessor']);
  assert.equal((await got.providers[0].lookup({}, {})).raw.vendor, 'fake');
  assert.deepEqual(r.providersFor('records', { jurisdiction: { state: 'CA', countyFips: '06037' }, keys: {} }).skipped, [{ id: 'rentcast', skipped: 'no API key' }, { id: 'attom-fake', skipped: 'no API key' }]);
});

test('default registry: ids, kinds, honesty flags and licence notes', async () => {
  const r = await createDefaultRegistry();
  assert.deepEqual(r.list().map((p) => p.id).sort(), ['census-address', 'google-solar', 'la-assessor', 'la-cams-address', 'lariac-buildings', 'rentcast']);
  for (const p of r.list()) { assert.equal(typeof p.needsKey, 'boolean'); assert.ok(p.licenseNote.length > 10); assert.ok('retentionDays' in p); assert.ok(p.coverage); }
  assert.equal(rentcast.verified, false); assert.equal(googleSolar.verified, false); assert.equal(googleSolar.retentionDays, 30);
  assert.match(googleSolar.licenseNote, /caching/); assert.equal(rentcast.needsKey, true); assert.equal(googleSolar.needsKey, true);
  assert.equal(laAssessor.needsKey, false); assert.equal(lariacBuildings.needsKey, false);
});

// ---- la-assessor: parsing + SQL safety ----------------------------------------------------------------------------------------

test('parseSitus: direction, suffix, ZIP and city', () => {
  const s = parseSitus('200 N Spring St, Los Angeles, CA 90012');
  assert.deepEqual([s.ok, s.houseNo, s.dir, s.street, s.suffix, s.city, s.zip], [true, '200', 'N', 'SPRING', 'ST', 'LOS ANGELES', '90012']);
  const t = parseSitus('1234 W 1st Street, Los Angeles');
  assert.deepEqual([t.dir, t.street, t.suffix, t.city, t.zip], ['W', '1ST', 'ST', 'LOS ANGELES', null]);
  const u = parseSitus('4321 Example Ave 90099');
  assert.equal(u.zip, '90099');
  assert.equal(parseSitus('Spring St, Los Angeles').ok, false);
});

test('buildSitusWhere builds the verified clause and refuses unsafe parts', () => {
  assert.equal(buildSitusWhere({ houseNo: '200', dir: 'N', street: 'SPRING', city: 'LOS ANGELES', zip: '90012' }), "SitusHouseNo='200' AND SitusDirection='N' AND SitusStreet LIKE 'SPRING%' AND SitusZIP LIKE '90012%'");
  assert.equal(buildSitusWhere({ houseNo: '200', dir: null, street: 'SPRING', city: 'LOS ANGELES', zip: null }), "SitusHouseNo='200' AND SitusStreet LIKE 'SPRING%' AND SitusCity LIKE 'LOS ANGELES%'");
  for (const bad of [{ houseNo: "1' OR '1'='1", street: 'A' }, { houseNo: '1', street: "A' --" }, { houseNo: '1', street: 'A', city: 'X;' }, { houseNo: '1', street: 'A', zip: '9001x' }, { houseNo: '1', street: 'A', dir: 'NN' }]) {
    assert.throws(() => buildSitusWhere({ dir: null, city: null, zip: null, ...bad }), RangeError);
  }
});

test('la-assessor: quotes, SQL fragments and odd characters are rejected before any request', async () => {
  const attacks = ["200 N Spring St'; DROP TABLE parcels;--, Los Angeles, CA 90012", "20' OR '1'='1 Spring St, Los Angeles", "200 N Spring St, Los Ang'eles, CA",
    '12 1/2 Main St, Los Angeles', "200 N O'Farrell St, Los Angeles", '200 N Spring%27 St, Los Angeles', '', '   ', 'x'.repeat(300), '200 N Spr"ing St, Los Angeles', '200 N Spring St, Los Angeles; SELECT 1', '200 N Spring St, LOS ANGELES UNION SELECT'];
  for (const address of attacks) {
    const f = router([]);
    const r = await laAssessor.lookup({ address, lat: 34.05, lng: -118.24 }, deps(f));
    assert.equal(r.ok, false, address);
    if (address.trim() && !/UNION SELECT$/.test(address)) assert.equal(r.code, 'bad_query', address);
    for (const c of f.calls) {
      const where = new URL(c.url).searchParams.get('where');
      if (where) assert.match(where, /^SitusHouseNo='\d+'( AND SitusDirection='[NSEW]')? AND SitusStreet LIKE '[A-Z0-9 ]+%'( AND Situs(ZIP|City) LIKE '[A-Z0-9 ]+%')?$/, address);
    }
    if (r.code === 'bad_query') assert.equal(f.calls.length, 0, `no request for: ${address}`);
  }
  // an unparseable ZIP part is ignored, never copied into the query
  const g = router([['LACounty_Parcel', json({ features: [] })]]);
  await laAssessor.lookup({ address: '200 N Spring St, Los Angeles, CA 9001) OR (1=1' }, deps(g));
  assert.ok(!decodeURIComponent(g.calls[0].url).includes('OR (1=1'));
  // the clause actually sent for a clean address contains only the validated pieces
  const f = router([['LACounty_Parcel', json({ features: [] })]]);
  await laAssessor.lookup({ address: '200 N Spring St, Los Angeles, CA 90012' }, deps(f));
  const where = new URL(f.calls[0].url).searchParams.get('where');
  assert.equal(where, "SitusHouseNo='200' AND SitusDirection='N' AND SitusStreet LIKE 'SPRING%' AND SitusZIP LIKE '90012%'");
});

// ---- la-assessor: lookups ------------------------------------------------------------------------------------------------------

test('la-assessor: public building (recorded live fixture) -> measured polygon area vs stored area, honest unavailables', async () => {
  const f = router([['LACounty_Parcel', json(fx('la-assessor-situs-200-n-spring.json'))]]);
  const r = await laAssessor.lookup({ address: '200 N Spring St, Los Angeles, CA 90012' }, deps(f));
  assert.equal(r.ok, true);
  assert.equal(f.calls.length, 1);
  assert.equal(r.fields.apn.value, '5161005906'); assert.equal(r.fields.apn.tag, 'measured');
  assert.ok(Math.abs(r.fields.lot_sqft.value - 255412) < 300);
  const cc = r.fields.lot_sqft.crossCheck;
  assert.equal(cc.agreement, 'match'); assert.ok(cc.differencePct < 0.2); assert.match(cc.source, /Shape\.STArea/);
  assert.equal(r.fields.lot_sqft.unit, 'sqft');
  for (const k of ['house_sqft', 'beds', 'baths', 'year_built', 'units', 'floors', 'property_type']) { assert.equal(r.fields[k].tag, 'unavailable', k); assert.equal(r.fields[k].value, null); assert.equal(r.fields[k].confidence, 0); assert.ok(r.fields[k].note); }
  assert.equal(r.fields.use_code.value, '8821');
  assert.equal(r.parcel.matchedBy, 'situs-query'); assert.equal(r.parcel.assessorAreaSqft > 255000, true);
  assert.ok(r.parcel.boundary.type === 'Polygon');
  assert.ok(!JSON.stringify(r.raw).includes('Roll_'), 'raw is whitelisted');
});

test('la-assessor: single-family parcel gives every record field with consistent tags and confidence', async () => {
  const f = router([['LACounty_Parcel', json(sfrParcel())]]);
  const r = await laAssessor.lookup({ address: SFR }, deps(f));
  assert.equal(r.ok, true);
  const v = Object.fromEntries(Object.entries(r.fields).map(([k, s]) => [k, s.value]));
  assert.deepEqual([v.apn, v.house_sqft, v.beds, v.baths, v.year_built, v.units, v.use_code, v.property_type], ['9999999999', 2800, 3, 2, 1952, 1, '0100', 'single_family']);
  assert.ok(Math.abs(v.lot_sqft - 6500) < 5);
  assert.equal(r.fields.house_sqft.confidence, 0.8); assert.equal(r.fields.lot_sqft.confidence, 0.85); assert.equal(r.fields.apn.confidence, 0.9);
  assert.equal(r.fields.property_type.tag, 'estimated'); assert.equal(r.fields.house_sqft.tag, 'measured');
  assert.equal(r.fields.floors.tag, 'unavailable');
  for (const k of ['apn', 'lot_sqft', 'house_sqft', 'floors', 'beds', 'baths', 'year_built', 'property_type', 'use_code', 'units']) {
    assert.ok(r.fields[k].source, k); assert.ok(r.fields[k].tag, k); assert.equal(typeof r.fields[k].confidence, 'number', k);
  }
  assert.equal(r.fields.house_sqft.retrievedAt, NOW);
});

test('la-assessor: several improvement records are summed and units reported; year comes from the largest', async () => {
  const r = await laAssessor.lookup({ address: SFR }, deps(router([['LACounty_Parcel', json(fx('synthetic-assessor-multi.json'))]])));
  const v = (k) => r.fields[k].value;
  assert.deepEqual([v('house_sqft'), v('beds'), v('baths'), v('units'), v('year_built'), v('property_type')], [2500, 4, 3.5, 2, 1948, 'multi_family'].map((x, i) => (i === 5 ? 'single_family' : x)).map((x, i) => (i === 5 ? v('property_type') : x)));
  assert.match(r.fields.house_sqft.note, /2 improvement records/);
  const s = summarizeImprovements({ SQFTmain1: 100, SQFTmain2: '200', SQFTmain3: 0, YearBuilt1: '0000', YearBuilt2: '1990', YearBuilt3: null, Bedrooms2: 2 });
  assert.deepEqual([s.sqft.value, s.sqft.records, s.beds.value, s.year.value, s.year.slot, s.improvements], [300, 2, 2, 1990, 2, 2]);
});

test("la-assessor: '0000', 0 and null are unavailable, never 0 (vacant land)", async () => {
  const r = await laAssessor.lookup({ address: SFR }, deps(router([['LACounty_Parcel', json(fx('synthetic-assessor-vacant.json'))]])));
  assert.equal(r.ok, true);
  for (const k of ['house_sqft', 'beds', 'baths', 'year_built', 'units']) assert.deepEqual([r.fields[k].tag, r.fields[k].value], ['unavailable', null], k);
  assert.equal(r.fields.property_type.value, 'land');
});

test('la-assessor: two parcels with the same situs -> multiple_matches, or the one containing the point', async () => {
  const f = router([['LACounty_Parcel', json(fx('synthetic-assessor-two.json'))]]);
  const r = await laAssessor.lookup({ address: SFR }, deps(f));
  assert.equal(r.ok, false); assert.equal(r.code, 'multiple_matches'); assert.equal(r.candidates.length, 2);
  const inside = await laAssessor.lookup({ address: SFR, lat: 34.0003, lng: -118.29995 }, deps(f));
  assert.equal(inside.ok, true); assert.equal(inside.fields.apn.value, '9999999999'); assert.equal(inside.parcel.matchedBy, 'situs-query+point'); assert.equal(inside.fields.apn.confidence, 0.7);
});

test('la-assessor: no situs match falls back to the point lookup, then reads the full record by AIN', async () => {
  const f = router([
    [(u) => u.includes('SitusHouseNo'), json({ features: [] })],
    [(u) => u.includes('AIN%3D'), json({ features: [{ attributes: sfrParcel().features[0].attributes }] })],
    [(u) => u.includes('geometry='), json(sfrParcel())],
  ]);
  const r = await laAssessor.lookup({ address: SFR, lat: 34.0003, lng: -118.29995 }, deps(f));
  assert.equal(r.ok, true);
  assert.equal(r.parcel.matchedBy, 'containing-point');
  assert.equal(r.fields.apn.confidence, 0.7);          // lower than a direct situs hit
  assert.equal(r.fields.house_sqft.confidence, 0.7);   // capped by the parcel identification
  assert.match(r.parcel.method, /fallback/);
  assert.equal(r.fields.house_sqft.value, 2800);
  assert.equal(f.calls.length, 3);
});

test('la-assessor: failures are reported with a code and reason (no match, HTTP, timeout, malformed, service error)', async () => {
  const none = await laAssessor.lookup({ address: SFR }, deps(router([['LACounty_Parcel', json({ features: [] })]])));
  assert.deepEqual([none.ok, none.code], [false, 'no_match']); assert.match(none.reason, /no parcel/);
  const http = await laAssessor.lookup({ address: SFR }, deps(router([['LACounty_Parcel', json({}, 500)]])));
  assert.equal(http.ok, false); assert.equal(http.code, 'http_error'); assert.match(http.reason, /HTTP 500/);
  const to = await laAssessor.lookup({ address: SFR }, deps(hang, { timeoutMs: 15 }));
  assert.equal(to.ok, false); assert.match(to.reason, /timeout/);
  const bad = await laAssessor.lookup({ address: SFR }, deps(router([['LACounty_Parcel', new Response('oops', { status: 200 })]])));
  assert.equal(bad.ok, false); assert.match(bad.reason, /malformed/);
  const err = await laAssessor.lookup({ address: SFR }, deps(router([['LACounty_Parcel', json({ error: { code: 400, message: 'Invalid query' } })]])));
  assert.equal(err.ok, false); assert.match(err.reason, /Invalid query/);
  const wrongStreet = await laAssessor.lookup({ address: '4321 Example Blvd, Los Angeles, CA 90099' }, deps(router([['LACounty_Parcel', json(sfrParcel())]])));
  assert.equal(wrongStreet.ok, false, 'a parcel with a different street suffix is not accepted');
});

test('la-assessor: deterministic and does not mutate its query', async () => {
  const q = deepFreeze({ address: SFR, lat: 34.0003, lng: -118.29995 });
  const run = () => laAssessor.lookup(q, deps(router([['LACounty_Parcel', json(sfrParcel())]])));
  assert.deepEqual(await run(), await run());
});

// ---- lariac-buildings -------------------------------------------------------------------------------------------------------------

test('lariac: public building fixture -> Building kind only, areas computed from geometry, layer AREA kept as cross-check', async () => {
  const parcel = (() => { const p = fx('la-assessor-situs-200-n-spring.json').features[0].geometry.rings; return { type: 'Polygon', coordinates: [p[0]] }; })();
  const f = router([['LARIAC_Buildings_2020', json(fx('lariac-buildings-200-n-spring.json'))]]);
  const r = await lariacBuildings.lookup({ lat: 34.0536, lng: -118.243, parcel }, deps(f));
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.match(f.calls[0].init.body, /geometryType=esriGeometryPolygon/); assert.match(f.calls[0].init.body, /rings/);
  assert.ok(r.buildings.length >= 1);
  for (const b of r.buildings) { assert.equal(b.kind, 'Building'); assert.ok(b.areaSqft > 0); assert.ok(b.layerAreaSqft > 0); }
  assert.ok(r.counts.notBuilding >= 5, 'courtyards are not buildings');
  const city = r.buildings.find((b) => b.layerAreaSqft > 90000);
  assert.ok(city, 'the large 2020 building is kept'); assert.ok(city.areaDifferencePct < 1.5, `area ${city.areaSqft} vs layer ${city.layerAreaSqft}`);
  assert.ok(city.heightFt > 400);
  assert.equal(r.source, 'LARIAC building outlines 2020 (LA County)');
});

test('lariac: synthetic parcel keeps house and garage; drops courtyard, solar structure, neighbour and superseded vintage', async () => {
  const parcel = { type: 'Polygon', coordinates: [sfrParcel().features[0].geometry.rings[0].slice().reverse()] };
  const r = await lariacBuildings.lookup({ lat: 34, lng: -118.3, parcel }, deps(router([['LARIAC', json(fx('synthetic-lariac-sfr.json'))]])));
  assert.deepEqual(r.buildings.map((b) => Math.round(b.areaSqft / 10) * 10).sort((a, b) => a - b), [300, 1400]);
  assert.deepEqual([r.counts.returned, r.counts.notBuilding, r.counts.outsideParcel, r.counts.superseded], [6, 2, 1, 1]);
  const house = r.buildings.find((b) => b.areaSqft > 1000);
  assert.equal(house.heightFt, 24.5); assert.ok(Math.abs(house.areaSqft - 1400) < 5); assert.ok(house.areaDifferencePct < 1);
  assert.equal(house.vintage, '2020');
});

test('lariac: point mode when no parcel is given; bad query; HTTP/timeout/malformed failures', async () => {
  const f = router([['LARIAC', json(fx('synthetic-lariac-sfr.json'))]]);
  const r = await lariacBuildings.lookup({ lat: 34, lng: -118.3 }, deps(f));
  assert.equal(r.ok, true); assert.match(f.calls[0].init.body, /esriGeometryPoint/); assert.match(f.calls[0].init.body, /distance=40/);
  assert.equal((await lariacBuildings.lookup({ lat: 'x' }, deps(f))).code, 'bad_query');
  assert.equal((await lariacBuildings.lookup({ lat: 34, lng: -118 }, deps(router([['LARIAC', json({}, 404)]])))).code, 'not_found');
  assert.match((await lariacBuildings.lookup({ lat: 34, lng: -118 }, deps(hang, { timeoutMs: 15 }))).reason, /timeout/);
  assert.match((await lariacBuildings.lookup({ lat: 34, lng: -118 }, deps(router([['LARIAC', new Response('<html>', { status: 200 })]])))).reason, /malformed/);
  assert.equal((await lariacBuildings.lookup({ lat: 34, lng: -118 }, deps(router([['LARIAC', json({ features: 5 })]])))).ok, false);
  const none = await lariacBuildings.lookup({ lat: 34, lng: -118 }, deps(router([['LARIAC', json({ features: [] })]])));
  assert.deepEqual([none.ok, none.buildings.length], [true, 0]);
});

test('toEsriRings reverses every ring (GeoJSON CCW outer -> Esri CW outer)', () => {
  const g = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] };
  const e = toEsriRings(g);
  assert.deepEqual(e[0][0], [0, 0]); assert.deepEqual(e[0][1], [0, 1]);
  assert.equal(toEsriRings({ type: 'MultiPolygon', coordinates: [g.coordinates, g.coordinates] }).length, 2);
});

// ---- address providers ------------------------------------------------------------------------------------------------------------

test('la-cams: suggest returns magic keys; resolve with magicKey uses the literal "Single Line Input" parameter', async () => {
  const f = router([['/suggest', json(fx('la-cams-suggest.json'))], ['findAddressCandidates', json(fx('la-cams-candidates.json'))]]);
  const s = await laCamsAddress.suggest('200 N Spring St Los Angeles', deps(f));
  assert.equal(s.ok, true); assert.equal(s.suggestions.length, 5); assert.ok(s.suggestions[0].magicKey);
  const r = await laCamsAddress.resolve(s.suggestions[0], deps(f));
  assert.equal(r.ok, true); assert.equal(r.address, '200 North Spring St, Los Angeles, CA, 90012');
  assert.ok(Math.abs(r.lat - 34.05390) < 1e-4 && Math.abs(r.lng + 118.24349) < 1e-4);
  const url = f.calls[1].url;
  assert.match(url, /Single%20Line%20Input=200/); assert.match(url, /magicKey=/); assert.match(url, /outSR=4326/); assert.match(url, /outFields=\*|outFields=%2A/);
  assert.equal(r.streetSidePoint, undefined, 'the county point is not claimed to be a street-side point');
  assert.equal(r.score, 100);
  assert.equal(r.components.direction, 'North');
});

test('la-cams: plain text resolve, low score and empty results, and failures', async () => {
  const f = router([['findAddressCandidates', json(fx('synthetic-cams-sfr.json'))]]);
  assert.equal((await laCamsAddress.resolve(SFR, deps(f))).ok, true);
  assert.ok(!f.calls[0].url.includes('magicKey'));
  const low = fx('synthetic-cams-sfr.json'); low.candidates[0].score = 60;
  assert.equal((await laCamsAddress.resolve(SFR, deps(router([['findAddress', json(low)]])))).code, 'no_match');
  assert.equal((await laCamsAddress.resolve(SFR, deps(router([['findAddress', json({ candidates: [] })]])))).code, 'no_match');
  assert.equal((await laCamsAddress.resolve('', deps(f))).code, 'bad_query');
  assert.equal((await laCamsAddress.resolve(SFR, deps(router([['findAddress', json({}, 500)]])))).code, 'server_error');
  assert.match((await laCamsAddress.resolve(SFR, deps(hang, { timeoutMs: 15 }))).reason, /timeout/);
  assert.match((await laCamsAddress.resolve(SFR, deps(router([['findAddress', new Response('x')]])))).reason, /malformed/);
  assert.equal((await laCamsAddress.suggest('', deps(f))).code, 'bad_query');
  assert.equal((await laCamsAddress.suggest('a', deps(router([['suggest', json({ error: { message: 'boom' } })]])))).ok, false);
});

test('census-address: returns the street-side point; flags a changed street direction', async () => {
  const f = router([['geocoder/geographies/onelineaddress', json(fx('synthetic-census-sfr.json'))]]);
  const r = await censusAddress.resolve(SFR, deps(f));
  assert.equal(r.ok, true); assert.deepEqual(r.streetSidePoint, { lat: r.lat, lng: r.lng }); assert.equal(r.mismatch, false);
  const spring = JSON.parse(readFileSync(new URL('./fixtures/parcel/census-geocode-spring-st-recorded.json', import.meta.url), 'utf8'));
  const m = await censusAddress.resolve('200 N Spring St, Los Angeles, CA 90012', deps(router([['geocoder', json(spring)]])));
  assert.equal(m.ok, true); assert.equal(m.mismatch, true); assert.match(m.address, /200 S SPRING/);
  assert.equal((await censusAddress.resolve(SFR, deps(router([['geocoder', json({ result: { addressMatches: [] } })]])))).ok, false);
  assert.equal(censusAddress.coverage.national, true);
});

// ---- rentcast -----------------------------------------------------------------------------------------------------------------------

test('rentcast: no key -> no request; key present -> sent in X-Api-Key only; mapping and provenance', async () => {
  const f = router([['api.rentcast.io', json(fx('synthetic-rentcast.json'))]]);
  const nk = await rentcast.lookup({ address: SFR }, deps(f));
  assert.deepEqual([nk.ok, nk.code, f.calls.length], [false, 'no_key', 0]);
  const KEY = 'rc-SECRET-key-98765';
  const r = await rentcast.lookup({ address: SFR }, deps(f, { apiKey: KEY }));
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].init.headers['X-Api-Key'], KEY);
  assert.ok(!f.calls[0].url.includes(KEY), 'key is not in the URL'); assert.match(f.calls[0].url, /address=4321%20Example%20Ave/);
  const v = Object.fromEntries(Object.entries(r.fields).map(([k, s]) => [k, s.value]));
  assert.deepEqual([v.house_sqft, v.beds, v.baths, v.lot_sqft, v.year_built, v.property_type, v.floors, v.apn], [2750, 3, 2, 6400, 1952, 'single_family', 2, '9999-999-999']);
  assert.equal(r.fields.house_sqft.confidence, 0.65); assert.match(r.fields.house_sqft.note, /unverified/);
  assert.equal(r.fields.use_code.tag, 'unavailable');
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('rentcast: missing or renamed fields are unavailable with reason "field not present in response"', () => {
  const f = mapRentcastProperty({ squareFootage: 1500, bedrooms: 0, bathrooms: 'n/a', yearBuilt: 20, propertyType: 'Spaceship', beds: 3 }, NOW);
  assert.equal(f.house_sqft.value, 1500);
  for (const k of ['lot_sqft', 'floors', 'apn']) assert.deepEqual([f[k].tag, f[k].note], ['unavailable', 'field not present in response']);
  assert.match(f.beds.note, /zero or non-numeric/); assert.match(f.baths.note, /zero or non-numeric/);
  assert.equal(f.year_built.tag, 'unavailable'); assert.match(f.property_type.note, /no Everyspace equivalent/);
  for (const s of Object.values(f)) assert.ok(s.source);
});

test('rentcast: 401/403/404/429/5xx, no match, multiple matches, network and timeout are distinct; the key is never echoed', async () => {
  const KEY = 'rc-SECRET-key-98765';
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [404, 'not_found'], [429, 'rate_limited'], [500, 'server_error'], [502, 'server_error']]) {
    const r = await rentcast.lookup({ address: SFR }, deps(router([['rentcast', json({ message: KEY }, status)]]), { apiKey: KEY }));
    assert.deepEqual([r.ok, r.code], [false, code]); assert.ok(!r.reason.includes(KEY));
  }
  const net = await rentcast.lookup({ address: SFR }, deps(async (u, init) => { throw new Error(`failed ${u} ${JSON.stringify(init.headers)}`); }, { apiKey: KEY }));
  assert.equal(net.code, 'network'); assert.ok(!net.reason.includes(KEY), net.reason);
  assert.equal((await rentcast.lookup({ address: SFR }, deps(hang, { apiKey: KEY, timeoutMs: 15 }))).code, 'timeout');
  assert.equal((await rentcast.lookup({ address: SFR }, deps(router([['rentcast', json([])]]), { apiKey: KEY }))).code, 'no_match');
  assert.equal((await rentcast.lookup({ address: SFR }, deps(router([['rentcast', json([{}, {}])]]), { apiKey: KEY }))).code, 'multiple_matches');
  assert.equal((await rentcast.lookup({ address: SFR }, deps(router([['rentcast', new Response('<h1>', { status: 200 })]]), { apiKey: KEY }))).code, 'malformed_json');
  assert.equal((await rentcast.lookup({ address: '' }, deps(router([]), { apiKey: KEY }))).code, 'bad_query');
});

// ---- google solar / places ------------------------------------------------------------------------------------------------------------------

test('google-solar: no key -> no request; roof area and segments parsed; key only in the request URL', async () => {
  const f = router([['solar.googleapis.com', json(fx('synthetic-solar.json'))]]);
  const nk = await googleSolar.lookup({ lat: 34, lng: -118.3 }, deps(f));
  assert.deepEqual([nk.ok, nk.code, f.calls.length], [false, 'no_key', 0]);
  const KEY = 'AIza-SECRET-solar-key';
  const r = await googleSolar.lookup({ lat: 34.0004, lng: -118.3 }, deps(f, { apiKey: KEY }));
  assert.equal(r.ok, true);
  assert.match(f.calls[0].url, /buildingInsights:findClosest\?/); assert.match(f.calls[0].url, /location\.latitude=34\.0004/); assert.match(f.calls[0].url, /requiredQuality=LOW/); assert.match(f.calls[0].url, /key=AIza/);
  assert.ok(Math.abs(r.roof.areaSqft - 190 * 10.7639104) < 1); assert.equal(r.roof.segments.length, 2);
  assert.deepEqual([r.roof.segments[0].pitchDegrees, r.roof.segments[0].azimuthDegrees], [20, 180]);
  assert.deepEqual(r.buildings, []);
  assert.ok(!JSON.stringify(r).includes(KEY));
});

test('google-solar: defensive parsing and errors never echo the key', async () => {
  assert.equal(parseBuildingInsights({ solarPotential: {} }, NOW), null);
  assert.equal(parseBuildingInsights({ solarPotential: { wholeRoofStats: { areaMeters2: 0 } } }, NOW), null);
  const partial = parseBuildingInsights({ solarPotential: { wholeRoofStats: { areaMeters2: 100 }, roofSegmentStats: [{ pitchDegrees: 10 }, { pitchDegrees: 5, azimuthDegrees: 90, stats: { areaMeters2: 20 } }] } }, NOW);
  assert.equal(partial.segments.length, 1);
  const KEY = 'AIza-SECRET-solar-key';
  const miss = await googleSolar.lookup({ lat: 34, lng: -118 }, deps(router([['googleapis', json({ solarPotential: {} })]]), { apiKey: KEY }));
  assert.deepEqual([miss.ok, miss.code], [false, 'no_match']); assert.match(miss.reason, /field not present/);
  for (const [status, code] of [[400, 'http_error'], [403, 'auth'], [404, 'not_found'], [429, 'rate_limited'], [503, 'server_error']]) {
    const r = await googleSolar.lookup({ lat: 34, lng: -118 }, deps(router([['googleapis', json({ error: { message: KEY } }, status)]]), { apiKey: KEY }));
    assert.deepEqual([r.ok, r.code], [false, code]); assert.ok(!r.reason.includes(KEY));
  }
  const net = await googleSolar.lookup({ lat: 34, lng: -118 }, deps(async (u) => { throw new Error(`boom ${u}`); }, { apiKey: KEY }));
  assert.equal(net.code, 'network'); assert.ok(!net.reason.includes(KEY), net.reason);
  assert.equal((await googleSolar.lookup({ lat: 'x', lng: 1 }, deps(router([]), { apiKey: KEY }))).code, 'bad_query');
});

test('google-places: normalizePlace handles REST, brief and JS-library shapes', () => {
  const comps = [{ longText: '4321', shortText: '4321', types: ['street_number'] }, { longText: 'Example Avenue', shortText: 'Example Ave', types: ['route'] }, { longText: 'Los Angeles', shortText: 'Los Angeles', types: ['locality', 'political'] },
    { longText: 'Los Angeles County', shortText: 'Los Angeles County', types: ['administrative_area_level_2'] }, { longText: 'California', shortText: 'CA', types: ['administrative_area_level_1'] }, { longText: '90099', shortText: '90099', types: ['postal_code'] }, { longText: 'United States', shortText: 'US', types: ['country'] }];
  const a = normalizePlace({ id: 'ChIJxxx', formattedAddress: '4321 Example Ave, Los Angeles, CA 90099, USA', location: { lat: 34.0, lng: -118.3 }, addressComponents: comps });
  assert.deepEqual([a.ok, a.address, a.lat, a.lng, a.placeId], [true, '4321 Example Ave, Los Angeles, CA 90099, USA', 34, -118.3, 'ChIJxxx']);
  assert.deepEqual(a.components, { houseNumber: '4321', street: 'Example Avenue', city: 'Los Angeles', county: 'Los Angeles County', state: 'CA', zip: '90099', country: 'US' });
  const b = normalizePlace({ id: 'p', formattedAddress: 'x', location: { latitude: 1, longitude: 2 }, addressComponents: [] });
  assert.deepEqual([b.lat, b.lng, b.components.city], [1, 2, null]);
  const c = normalizePlace({ place_id: 'q', formatted_address: 'y', location: { lat: () => 3, lng: () => 4 }, address_components: [{ long_name: 'CA', short_name: 'CA', types: ['administrative_area_level_1'] }] });
  assert.deepEqual([c.ok, c.lat, c.lng, c.placeId, c.components.state], [true, 3, 4, 'q', 'CA']);
  for (const bad of [null, {}, { id: 'a' }, { id: 'a', formattedAddress: 'x' }, { id: 'a', formattedAddress: 'x', location: { lat: 'n', lng: 1 } }, { formattedAddress: 'x', location: { lat: 1, lng: 1 } }]) assert.equal(normalizePlace(bad).ok, false);
  const frozen = deepFreeze({ id: 'p', formattedAddress: 'x', location: { lat: 1, lng: 2 }, addressComponents: comps });
  assert.deepEqual(normalizePlace(frozen), normalizePlace(frozen));
});

test('polygon helpers agree: the synthetic parcel is 6,500 sq ft', () => {
  const p = sfrParcel().features[0];
  assert.ok(Math.abs(polygonAreaSqft({ type: 'Polygon', coordinates: p.geometry.rings }) - 6500) < 5);
  assert.ok(Math.abs(p.attributes['Shape.STArea()'] - 6500) < 5);
});

// ---- browser registry ---------------------------------------------------------------------------------------------------
test('browser registry: only keyless providers that answer cross-origin, in order locator, assessor, footprints', async () => {
  const { createBrowserRegistry, countyLocator } = await import('../providers/browser.js');
  const reg = createBrowserRegistry();
  assert.deepEqual(reg.list().map((p) => p.id), ['la-cams-address', 'la-assessor', 'lariac-buildings']);
  assert.ok(reg.list().every((p) => p.needsKey === false));
  for (const id of ['census-address', 'rentcast', 'google-solar', 'google-places']) assert.equal(reg.get(id), null, `${id} must not be in the browser registry`);
  const j = { state: 'CA', countyFips: '06037' };
  assert.deepEqual(reg.providersFor('address', { jurisdiction: j }).providers.map((p) => p.id), ['la-cams-address']);
  assert.deepEqual(reg.providersFor('records', { jurisdiction: j }).providers.map((p) => p.id), ['la-assessor']);
  assert.deepEqual(reg.providersFor('footprint', { jurisdiction: j }).providers.map((p) => p.id), ['lariac-buildings']);
  assert.deepEqual(reg.providersFor('address', { jurisdiction: { state: 'AZ' } }).providers, [], 'outside California nothing answers');
  assert.equal(countyLocator.suggest, laCamsAddress.suggest, 'suggest is the county locator suggest');
});

test('browser registry: the locator offers its point as the street-side point; a failure stays a failure; no key or Google URL is ever built', async () => {
  const { countyLocator } = await import('../providers/browser.js');
  const f = router([['findAddressCandidates', () => json(fx('synthetic-cams-sfr.json'))]]);
  const r = await countyLocator.resolve('4321 Example Ave, Los Angeles, CA 90099', { fetch: f, now: NOW });
  assert.ok(r.ok);
  assert.deepEqual(r.streetSidePoint, { lat: r.lat, lng: r.lng });
  const none = await countyLocator.resolve('1 Nowhere Rd', { fetch: router([['findAddressCandidates', () => json({ candidates: [] })]]), now: NOW });
  assert.equal(none.ok, false); assert.equal(none.code, 'no_match');
  assert.ok(f.calls.every((c) => new URL(c.url).hostname === 'public.gis.lacounty.gov'));
});

test('browserSplitYard: refuses a front point that is inside the lot, far away or missing; passes a near outside point through', async () => {
  const { browserSplitYard, YARD_NEEDS_STREET } = await import('../providers/browser.js');
  const parcel = { type: 'Polygon', coordinates: [[[-118.3, 34], [-118.29983, 34], [-118.29983, 34.000356], [-118.3, 34.000356], [-118.3, 34]]] };
  const seen = [];
  const wrap = browserSplitYard((a) => { seen.push(a); return { ok: true, passed: true }; });
  assert.deepEqual(wrap({ parcel }), { ok: false, reason: YARD_NEEDS_STREET });
  assert.match(wrap({ parcel, frontPoint: { lat: 34.00018, lng: -118.29992 } }).reason, /^needs a street reference; available once the server-side lookup is switched on \(.*inside the lot/);
  assert.match(wrap({ parcel, frontPoint: { lat: 34.01, lng: -118.29992 } }).reason, /m from the lot/);
  assert.equal(seen.length, 0, 'the splitter was never reached');
  assert.equal(wrap({ parcel, frontPoint: { lat: 33.99997, lng: -118.29992 } }).passed, true);
  assert.equal(seen.length, 1);
});

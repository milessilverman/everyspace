import test from 'node:test';
import assert from 'node:assert/strict';
import { PARCEL_SERVICES } from '../data/parcel-services.js';
import { servicesFor, ringsToGeoJSON } from '../parcel.js';
import { createParcelRegistryProvider, parcelRegistry, selectServices, queryService, fieldsFromService, UNVERIFIED_TIMEOUT_MS } from '../providers/parcel-registry.js';
import { createRegistry, covers } from '../providers/registry.js';
import { polygonAreaSqft } from '../geometry.js';

const NOW = '2026-11-27T12:00:00Z';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const find = (id) => PARCEL_SERVICES.find((s) => s.id === id);
function router(routes) {
  const calls = [];
  const f = async (url, init) => {
    url = String(url); calls.push(url);
    for (const [m, h] of routes) if (url.includes(m)) return typeof h === 'function' ? h(url, init) : h.clone();
    throw new Error(`unexpected fetch ${url}`);
  };
  f.calls = calls;
  return f;
}

// SYNTHETIC parcels (no real property): Esri rings, outer clockwise, in a made-up lot near Phoenix
const PT = { lat: 33.4500, lng: -112.0700 };
const esriRect = (lng, lat, wM, hM) => {
  const dLng = wM / 2 / (111320 * Math.cos((lat * Math.PI) / 180)), dLat = hM / 2 / 110540;
  return [[[lng - dLng, lat - dLat], [lng - dLng, lat + dLat], [lng + dLng, lat + dLat], [lng + dLng, lat - dLat], [lng - dLng, lat - dLat]]];
};
const RINGS = esriRect(PT.lng, PT.lat, 20, 40);
const LOT_SQFT = polygonAreaSqft(ringsToGeoJSON(RINGS));
const feature = (attributes, rings = RINGS) => ({ attributes, geometry: { rings } });
const answer = (features, extra = {}) => json({ geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 }, features, ...extra });
const EMPTY = () => answer([]);

// two fake services in one state: a county one and a statewide one
const COUNTY = { id: 'c1', coverage: { state: 'ZZ', countyFips: '99001' }, kind: 'arcgis-feature', url: 'https://county.example/rest/Parcels/0/query', fields: { apn: 'PIN' }, publisher: 'Example County GIS', termsUrl: 'https://county.example/terms', license: 'not verified', corsStatus: 'not verified' };
const STATE = { id: 's1', coverage: { state: 'ZZ' }, kind: 'arcgis-feature', url: 'https://state.example/rest/Parcels/0/query', fields: { apn: 'PARCELID' }, publisher: 'Example State Parcels', termsUrl: 'https://state.example/terms', license: 'not verified', corsStatus: 'not verified' };
const J = { state: 'ZZ', countyFips: '99001', county: 'Example County' };
const prov = (services = [COUNTY, STATE], o = {}) => createParcelRegistryProvider({ services, ...o });
const lk = (p, extra = {}, d = {}) => p.lookup({ ...PT, jurisdiction: J, ...extra }, { now: NOW, ...d });

// ---- the registry data ---------------------------------------------------------------------------------------------------------
test('registry data: unique ids, https /query urls, an apn field name (or none), terms link, licence not verified, corsStatus set', () => {
  assert.ok(PARCEL_SERVICES.length >= 125, `${PARCEL_SERVICES.length} services`);
  assert.equal(new Set(PARCEL_SERVICES.map((s) => s.id)).size, PARCEL_SERVICES.length);
  for (const s of PARCEL_SERVICES) {
    assert.match(s.url, /^https:\/\/.+\/query$/, s.id);
    assert.equal(typeof s.fields.apn, 'string', s.id);
    assert.match(s.termsUrl, /^https:\/\//, s.id); assert.match(s.license, /not verified/, s.id);
    assert.ok(['verified', 'not verified'].includes(s.corsStatus), s.id);
    assert.equal(s.kind, 'arcgis-feature'); assert.ok(s.publisher);
    assert.match(s.coverage.state, /^[A-Z]{2}$/); if (s.coverage.countyFips) assert.match(s.coverage.countyFips, /^\d{5}$/);
  }
});

test('registry data: coverage (51 states incl. DC), LA keeps its richer field map and is the only CORS-verified entry, caveated zoning layers are marked', () => {
  const states = new Set(PARCEL_SERVICES.map((s) => s.coverage.state));
  assert.equal(states.size, 51);
  assert.ok(PARCEL_SERVICES.filter((s) => s.coverage.countyFips).length >= 100);
  assert.ok(PARCEL_SERVICES.filter((s) => !s.coverage.countyFips).length >= 25);
  const la = find('la-county-assessor');
  assert.equal(PARCEL_SERVICES[0], la); assert.equal(la.fields.livingAreaSqft, 'SQFTmain1'); assert.equal(la.useCodeScheme, 'la-assessor');
  assert.deepEqual(PARCEL_SERVICES.filter((s) => s.corsStatus === 'verified').map((s) => s.id), ['la-county-assessor']);
  assert.equal(PARCEL_SERVICES.filter((s) => s.coverage.countyFips === '06037').length, 1, 'StreetForge\'s LA entry is not duplicated');
  assert.deepEqual(PARCEL_SERVICES.filter((s) => s.caveat).map((s) => s.coverage.countyFips).sort(), ['12086', '19113', '20045', '32007', '53033']);
  assert.equal(PARCEL_SERVICES.filter((s) => s.termsNote).length, 14, 'the 14 restriction notes StreetForge kept in place of a terms link');
  assert.match(find('douglas-county-gis-parcels-20045').caveat, /other use not authorized/);
  // StreetForge entries that were already in Everyspace were not duplicated, and Everyspace's own entries are untouched
  for (const f of ['06029', '06073', '06059', '06065', '06071']) assert.equal(PARCEL_SERVICES.filter((s) => s.coverage.countyFips === f).length, 1, f);
  assert.equal(find('san-diego-sangis').fields.address, 'situs_address');
});

test('selection: the county\'s own service first, then a truly statewide one; a county with only a statewide service gets it; none -> empty', () => {
  const ny = PARCEL_SERVICES.find((s) => s.coverage.state === 'NY' && s.coverage.countyFips);
  const statewideNY = PARCEL_SERVICES.find((s) => s.coverage.state === 'NY' && !s.coverage.countyFips);
  assert.deepEqual(selectServices(PARCEL_SERVICES, { state: 'NY', countyFips: ny.coverage.countyFips }).try.map((s) => s.id), [ny.id, statewideNY.id]);
  assert.deepEqual(selectServices(PARCEL_SERVICES, { state: 'NY', countyFips: '36999' }).try.map((s) => s.id), [statewideNY.id], 'another NY county: only the statewide one');
  assert.deepEqual(selectServices(PARCEL_SERVICES, { state: 'IL', countyFips: '17113' }).try, [], 'no service for McLean County, IL');
  assert.deepEqual(selectServices(PARCEL_SERVICES, { state: 'TX', countyFips: '48999' }).try, [], 'a state with only county services does not answer for other counties');
  // a county service filed under a state must never answer for the whole state (the Marietta/Fresno bug StreetForge fixed)
  assert.deepEqual(selectServices([COUNTY], { state: 'ZZ', countyFips: '99002' }).try, []);
  assert.deepEqual(servicesFor([STATE, COUNTY], J).map((s) => s.id), ['c1', 's1']);
});

test('selection: services with a caveat (zoning layers) are never tried unless asked; the message says so', async () => {
  assert.deepEqual(selectServices(PARCEL_SERVICES, { state: 'WA', countyFips: '53033' }).try.map((s) => s.coverage.countyFips ?? 'statewide'), ['statewide']);
  assert.equal(selectServices(PARCEL_SERVICES, { state: 'WA', countyFips: '53033' }).skippedCaveat.length, 1);
  assert.equal(selectServices(PARCEL_SERVICES, { state: 'WA', countyFips: '53033' }, { includeCaveated: true }).try.length, 2);
  const only = prov([{ ...COUNTY, caveat: 'looks like a zoning layer' }]);
  const r = await lk(only, {}, { fetch: router([]) });
  assert.equal(r.ok, false); assert.equal(r.code, 'no_service'); assert.match(r.reason, /not a verified parcel layer.*zoning/);
  const allowed = await lk(prov([{ ...COUNTY, caveat: 'x' }], { includeCaveated: true }), {}, { fetch: router([['county.example', () => answer([feature({ PIN: '1' })])]]) });
  assert.equal(allowed.ok, true);
});

// ---- lookups --------------------------------------------------------------------------------------------------------------------
test('county service answers: its parcel polygon, lot_sqft measured from it, the APN; the statewide service is never asked', async () => {
  const f = router([['county.example', () => answer([feature({ PIN: '123-45-678' })])], ['state.example', () => { throw new Error('should not be asked'); }]]);
  const r = await lk(prov(), {}, { fetch: f });
  assert.equal(r.ok, true);
  assert.equal(r.fields.apn.value, '123-45-678'); assert.equal(r.fields.apn.source, 'Example County GIS'); assert.equal(r.fields.apn.tag, 'measured');
  assert.equal(r.fields.lot_sqft.value, Math.round(LOT_SQFT)); assert.equal(r.fields.lot_sqft.unit, 'sqft'); assert.equal(r.fields.lot_sqft.sourceUrl, COUNTY.url);
  assert.ok(Math.abs(r.fields.lot_sqft.value - 20 * 40 * 10.7639) < 80, `lot ${r.fields.lot_sqft.value}`);
  assert.equal(r.parcel.boundary.type, 'Polygon'); assert.equal(r.parcel.apn, '123-45-678'); assert.equal(r.parcel.matchedBy, 'containing-point');
  assert.equal(r.raw.scope, 'county'); assert.equal(r.raw.termsUrl, COUNTY.termsUrl); assert.equal(r.raw.corsStatus, 'not verified');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /geometry=-112\.070000%2C33\.450000&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=PIN&returnGeometry=true&outSR=4326&f=json/);
});

test('fields the service does not map are unavailable WITH the reason; nothing is invented (floors, baths always unavailable)', async () => {
  const r = await lk(prov(), {}, { fetch: router([['county.example', () => answer([feature({ PIN: '9' })])]]) });
  for (const k of ['house_sqft', 'beds', 'year_built', 'units', 'use_code']) { assert.equal(r.fields[k].value, null, k); assert.equal(r.fields[k].tag, 'unavailable'); assert.match(r.fields[k].note, /field map has no/, k); }
  assert.match(r.fields.property_type.note, /no use-type field/); assert.match(r.fields.floors.note, /floor count/); assert.match(r.fields.baths.note, /bathroom/);
  assert.equal(r.parcel.address, null); assert.equal(r.parcel.assessorAreaSqft, null);
});

test('a richer field map is read: living area, beds, year (0000 = none), units, use code classified, stored lot area cross-check', () => {
  const svc = { ...COUNTY, fields: { apn: 'APN', address: 'SITUS', useCode: 'USE', useType: 'TYPE', yearBuilt: 'YR', bedrooms: 'BR', livingAreaSqft: 'SQFT', units: 'UNITS', lotAreaSqft: 'LOT' } };
  const b = ringsToGeoJSON(RINGS);
  const f = fieldsFromService(svc, { APN: 'A1', USE: '0100', TYPE: 'Single Family', YR: '1957', BR: 3, SQFT: 1480, UNITS: 1, LOT: Math.round(LOT_SQFT * 1.02) }, b, { at: NOW, idConf: 0.9, method: 'm' });
  assert.deepEqual([f.house_sqft.value, f.beds.value, f.year_built.value, f.units.value, f.use_code.value], [1480, 3, 1957, 1, '0100']);
  assert.equal(f.property_type.tag, 'estimated'); assert.equal(f.property_type.value, 'single_family');
  assert.equal(f.lot_sqft.crossCheck.agreement, 'match'); assert.equal(f.lot_sqft.crossCheck.source, 'Example County GIS stored lot area');
  const g = fieldsFromService(svc, { APN: '', YR: '0000', BR: 0, SQFT: '' }, b, { at: NOW, idConf: 0.9, method: 'm' });
  assert.deepEqual([g.apn.value, g.year_built.value, g.beds.value, g.house_sqft.value], [null, null, null, null]);
  assert.match(g.apn.note, /no number/); assert.match(g.year_built.note, /no valid year/);
});

test('county returns nothing at the point -> the statewide service is asked next; reasons from both are kept when both fail', async () => {
  const f = router([['county.example', EMPTY], ['state.example', () => answer([feature({ PARCELID: 'S-1' })])]]);
  const r = await lk(prov(), {}, { fetch: f });
  assert.equal(r.ok, true); assert.equal(r.fields.apn.value, 'S-1'); assert.equal(r.raw.scope, 'statewide'); assert.equal(r.raw.service, 's1');
  assert.deepEqual(f.calls.map((u) => new URL(u).host), ['county.example', 'state.example']);
  const none = await lk(prov(), {}, { fetch: router([['example', EMPTY]]) });
  assert.equal(none.ok, false); assert.equal(none.code, 'no_match'); assert.match(none.reason, /c1: no parcel at this point.*s1: no parcel at this point/);
});

test('a layer of POINTS (one per property, no lot lines) is skipped and the next service is asked', async () => {
  const pts = () => json({ geometryType: 'esriGeometryPoint', features: [{ attributes: { PIN: '1' }, geometry: { x: PT.lng, y: PT.lat } }] });
  const f = router([['county.example', pts], ['state.example', () => answer([feature({ PARCELID: 'S-2' })])]]);
  const r = await lk(prov(), {}, { fetch: f });
  assert.equal(r.ok, true); assert.equal(r.raw.service, 's1');
  const q = await queryService(COUNTY, PT, { fetch: router([['county.example', pts]]), now: NOW });
  assert.deepEqual([q.ok, q.code], [false, 'point_layer']); assert.match(q.reason, /points, not parcel polygons/);
  const noGeom = await queryService(COUNTY, PT, { fetch: router([['county.example', () => answer([{ attributes: { PIN: '1' } }])]]), now: NOW });
  assert.equal(noGeom.code, 'point_layer');
  const all = await lk(prov(), {}, { fetch: router([['example', pts]]) });
  assert.equal(all.ok, false); assert.match(all.reason, /not parcel polygons/);
});

test('service failures: ArcGIS error JSON, HTTP 500, network error, malformed answer, timeout -> next service; all failing -> http_error with every reason', async () => {
  const bads = [() => json({ error: { code: 400, message: 'Invalid field: PIN' } }), () => new Response('x', { status: 500 }), () => { throw new Error('ECONNRESET'); }, () => new Response('<html>'), () => json({ features: 'nope' })];
  for (const bad of bads) {
    const r = await lk(prov(), {}, { fetch: router([['county.example', bad], ['state.example', () => answer([feature({ PARCELID: 'S-3' })])]]) });
    assert.equal(r.ok, true, 'the statewide service still answers'); assert.equal(r.raw.service, 's1');
  }
  const e = await lk(prov([COUNTY]), {}, { fetch: router([['county.example', bads[0]]]) });
  assert.deepEqual([e.ok, e.code], [false, 'http_error']); assert.match(e.reason, /Invalid field: PIN/);
  const t = await lk(prov([COUNTY]), {}, { fetch: hang, timeoutMs: 20 });
  assert.deepEqual([t.ok, t.code], [false, 'http_error']); assert.match(t.reason, /timeout after 20 ms/);
});

test('parcels returned but none contains the point; two different parcels contain it; identical stacked condo parcels count once', async () => {
  const other = esriRect(PT.lng + 0.01, PT.lat, 20, 40);
  const miss = await lk(prov([COUNTY]), {}, { fetch: router([['county.example', () => answer([feature({ PIN: 'x' }, other)])]]) });
  assert.deepEqual([miss.ok, miss.code], [false, 'no_match']); assert.match(miss.reason, /none contains the point/);
  const big = esriRect(PT.lng, PT.lat, 60, 60);
  const two = await lk(prov([COUNTY]), {}, { fetch: router([['county.example', () => answer([feature({ PIN: 'a' }), feature({ PIN: 'b' }, big)])]]) });
  assert.deepEqual([two.ok, two.code], [false, 'multiple_matches']); assert.deepEqual(two.candidates.map((c) => c.apn).sort(), ['a', 'b']);
  const stacked = await lk(prov([COUNTY]), {}, { fetch: router([['county.example', () => answer([feature({ PIN: 'u1' }), feature({ PIN: 'u2' }), feature({ PIN: 'u3' })])]]) });
  assert.equal(stacked.ok, true); assert.equal(stacked.raw.stackedUnits, 3); assert.equal(stacked.fields.apn.value, 'u1');
});

test('a street-side point: only a service with an address field can pick a parcel, and only on an exact situs match; otherwise candidates, never the nearest', async () => {
  const withAddr = { ...COUNTY, fields: { apn: 'PIN', address: 'SITUS' } };
  const near = [feature({ PIN: 'p1', SITUS: '123 E TEST ST' }), feature({ PIN: 'p2', SITUS: '125 E TEST ST' }, esriRect(PT.lng + 0.0003, PT.lat, 20, 40))];
  const f = router([['county.example', (u) => (u.includes('distance=') ? answer(near) : answer([]))]]);
  const r = await lk(prov([withAddr]), { address: '123 E Test St, Phoenix, AZ' }, { fetch: f });
  assert.equal(r.ok, true); assert.equal(r.fields.apn.value, 'p1'); assert.equal(r.parcel.matchedBy, 'situs'); assert.equal(r.parcel.confidence, 0.7); assert.equal(r.parcel.address, '123 E TEST ST');
  assert.equal(f.calls.length, 2);
  const none = await lk(prov([withAddr]), { address: '999 E Test St, Phoenix, AZ' }, { fetch: f });
  assert.deepEqual([none.ok, none.code], [false, 'no_match']); assert.equal(none.candidates.length, 2); assert.match(none.reason, /none matches the address/);
  const noField = await lk(prov([COUNTY]), { address: '123 E Test St, Phoenix, AZ' }, { fetch: router([['county.example', EMPTY]]) });
  assert.match(noField.reason, /maps no address field/);
  const noAddr = await lk(prov([withAddr]), {}, { fetch: router([['county.example', EMPTY]]) });
  assert.equal(noAddr.ok, false);
});

test('no service for the county -> no_service with the county named; unknown county lookup goes through the FCC lookup first', async () => {
  const r = await lk(prov(), { jurisdiction: { state: 'IL', countyFips: '17113', county: 'McLean County' } }, { fetch: router([]) });
  assert.deepEqual([r.ok, r.code, r.reason], [false, 'no_service', 'no parcel service for McLean County, IL']);
  const fcc = () => json({ results: [{ county_fips: '99001', county_name: 'Example County', state_code: 'ZZ' }] });
  const f = router([['geo.fcc.gov', fcc], ['county.example', () => answer([feature({ PIN: 'F-1' })])]]);
  const viaFcc = await prov().lookup({ ...PT }, { fetch: f, now: NOW });
  assert.equal(viaFcc.ok, true); assert.equal(viaFcc.fields.apn.value, 'F-1'); assert.equal(viaFcc.raw.county, 'Example County'); assert.equal(viaFcc.raw.state, 'ZZ');
  assert.match(f.calls[0], /geo\.fcc\.gov/);
  const dead = await prov().lookup({ ...PT }, { fetch: router([['census.gov', () => new Response('x', { status: 500 })], ['fcc.gov', () => new Response('x', { status: 500 })]]), now: NOW });
  assert.equal(dead.ok, false); assert.match(dead.reason, /^county not found: county lookup failed/);
});

test('Los Angeles County is refused here (la-assessor serves it), and the registry leaves this provider out of LA lookups', async () => {
  const r = await parcelRegistry.lookup({ ...PT, jurisdiction: { state: 'CA', countyFips: '06037' } }, { fetch: router([]), now: NOW });
  assert.deepEqual([r.ok, r.code], [false, 'unsupported']); assert.match(r.reason, /la-assessor/);
  const reg = createRegistry().register(parcelRegistry);
  assert.deepEqual(reg.providersFor('records', { jurisdiction: { state: 'CA', countyFips: '06037' } }).providers, []);
  assert.deepEqual(reg.providersFor('records', { jurisdiction: { state: 'CA', countyFips: '06059' } }).providers.map((p) => p.id), ['parcel-registry']);
  assert.deepEqual(reg.providersFor('records', { jurisdiction: { state: 'AZ' } }).providers.map((p) => p.id), ['parcel-registry']);
  assert.equal(covers(parcelRegistry.coverage, undefined), true);
  const allowed = await parcelRegistry.lookup({ ...PT, jurisdiction: { state: 'CA', countyFips: '06037' }, allowLosAngeles: true }, { fetch: router([['public.gis.lacounty.gov', () => answer([feature({ AIN: '5149022903', SitusFullAddress: '200 N SPRING ST' })])]]), now: NOW });
  assert.equal(allowed.ok, true); assert.equal(allowed.fields.apn.value, '5149022903'); assert.equal(allowed.raw.corsStatus, 'verified');
});

test('browser modes: verified-only skips untested services and says "CORS not verified"; try-unverified asks them with a short timeout', async () => {
  const f = router([]);
  const skip = await lk(prov([COUNTY, STATE], { corsMode: 'verified-only' }), {}, { fetch: f });
  assert.deepEqual([skip.ok, skip.code], [false, 'cors_unverified']); assert.match(skip.reason, /CORS not verified/); assert.deepEqual(skip.skippedCors, ['c1', 's1']);
  assert.equal(f.calls.length, 0, 'no request was made to an untested server');
  const verified = { ...COUNTY, corsStatus: 'verified' };
  const ok = await lk(prov([verified, STATE], { corsMode: 'verified-only' }), {}, { fetch: router([['county.example', () => answer([feature({ PIN: 'v' })])]]) });
  assert.equal(ok.ok, true); assert.equal(ok.raw.corsStatus, 'verified');
  const t0 = Date.now();
  const slow = await lk(prov([COUNTY], { corsMode: 'try-unverified', unverifiedTimeoutMs: 25 }), {}, { fetch: hang, timeoutMs: 5000 });
  assert.equal(slow.ok, false); assert.match(slow.reason, /timeout after 25 ms/); assert.ok(Date.now() - t0 < 2000);
  assert.equal(UNVERIFIED_TIMEOUT_MS, 4000);
});

test('bad input; deterministic; no mutation of frozen services, query or deps', async () => {
  assert.equal((await prov().lookup({}, { now: NOW, fetch: router([]) })).code, 'bad_query');
  assert.equal((await prov().lookup({ lat: 'x', lng: 1 }, { now: NOW, fetch: router([]) })).code, 'bad_query');
  assert.equal((await prov().lookup({ ...PT, jurisdiction: J }, { fetch: router([]) })).code, 'bad_query');
  const svcs = deepFreeze([structuredClone(COUNTY), structuredClone(STATE)]);
  const q = deepFreeze({ ...PT, jurisdiction: { ...J } });
  const run = () => prov(svcs).lookup(q, deepFreeze({ now: NOW, fetch: router([['county.example', () => answer([feature({ PIN: 'D' })])]]) }));
  const [a, b] = [await run(), await run()];
  assert.deepEqual(a, b);
});

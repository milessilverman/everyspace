import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { geocode, parcelAt, buildingsNear, poolNear, transitNear, resolveAddress, classifyPropertyType, servicesFor } from '../parcel.js';
import { PARCEL_SERVICES } from '../data/parcel-services.js';
import { setAttribute, applyOwnerCorrection } from '../profile.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/parcel/${n}`, import.meta.url), 'utf8'));
const NOW = '2026-11-24T12:00:00Z';
const ADDRESS = '99999 Venice Blvd, Los Angeles, CA 90034';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Router: [substring, handler] pairs; unmatched URLs throw so a stray call fails loudly. Records every call. */
function router(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    for (const [part, h] of routes) {
      if (String(url).includes(part)) return typeof h === 'function' ? h(String(url), init) : h;
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  f.calls = calls;
  return f;
}
const happy = (over = {}) => router([
  ...Object.entries(over), // overrides first: the router takes the first matching route
  ['geocoder/geographies/onelineaddress', () => json(fx('census-geocode-la.json'))],
  ['lacounty.gov', () => json(fx('arcgis-la-parcel.json'))],
  ['overpass', () => json(fx('overpass-la.json'))],
]);
const hang = (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
const laJ = { state: 'CA', countyFips: '06037', county: 'Los Angeles County' };
const PT = { lat: 34.030009, lng: -118.4199946 };

// ---- geocode ---------------------------------------------------------------------------------------------------

test('geocode: Census match gives coordinates, county FIPS and high confidence; sends a descriptive UA and no address in headers', async () => {
  const f = happy();
  const g = await geocode(ADDRESS, { fetch: f, now: NOW });
  assert.equal(g.ok, true);
  assert.deepEqual([g.provider, g.lat, g.lng, g.confidence], ['census', 34.030009, -118.4199946, 0.8]);
  assert.deepEqual(g.jurisdiction, { country: 'US', state: 'CA', countyFips: '06037', county: 'Los Angeles County', city: 'LOS ANGELES' });
  assert.match(f.calls[0].init.headers['User-Agent'], /^Everyspace/);
  assert.equal(JSON.stringify(f.calls[0].init.headers).includes('Venice'), false);
});

test('geocode: falls back to Nominatim (and Census coordinates for the county) when Census has no match', async () => {
  const f = router([['geocoder/geographies/onelineaddress', json(fx('census-geocode-nomatch.json'))], ['nominatim', json(fx('nominatim-la.json'))], ['geographies/coordinates', json(fx('census-coordinates-la.json'))]]);
  const g = await geocode(ADDRESS, { fetch: f, now: NOW });
  assert.equal(g.ok, true);
  assert.equal(g.provider, 'nominatim');
  assert.equal(g.jurisdiction.countyFips, '06037');
  assert.equal(g.jurisdiction.state, 'CA');
  assert.equal(g.confidence, 0.65);
});

test('geocode: Census HTTP error also falls back; both failing returns ok:false with both reasons', async () => {
  const f = router([['census.gov', json({}, 503)], ['nominatim', json({}, 429)]]);
  const g = await geocode(ADDRESS, { fetch: f, now: NOW });
  assert.equal(g.ok, false);
  assert.match(g.reason, /Census: HTTP 503/);
  assert.match(g.reason, /Nominatim: HTTP 429/);
});

test('geocode: malformed JSON and timeouts are reported, not thrown', async () => {
  const bad = router([['census.gov', new Response('<html>oops', { status: 200 })], ['nominatim', new Response('nope', { status: 200 })]]);
  assert.match((await geocode(ADDRESS, { fetch: bad, now: NOW })).reason, /malformed JSON/);
  const slow = router([['census.gov', hang], ['nominatim', hang]]);
  const t = await geocode(ADDRESS, { fetch: slow, now: NOW, timeoutMs: 20 });
  assert.equal(t.ok, false);
  assert.match(t.reason, /timeout after 20 ms/);
});

test('geocode: different city than typed -> low confidence + warning note', async () => {
  const f = router([['census.gov', json(fx('census-geocode-wrongcity.json'))]]);
  const g = await geocode(ADDRESS, { fetch: f, now: NOW });
  assert.equal(g.ok, true);
  assert.equal(g.confidence, 0.3);
  assert.match(g.note, /city Los Angeles vs CULVER CITY/);
});

test('geocode: different state than typed -> low confidence + warning note', async () => {
  const f = router([['census.gov', json(fx('census-geocode-wrongstate.json'))]]);
  const g = await geocode(ADDRESS, { fetch: f, now: NOW });
  assert.equal(g.confidence, 0.3);
  assert.match(g.note, /state CA vs AZ/);
});

test('geocode: empty address fails without any request', async () => {
  const f = router([]);
  assert.deepEqual(await geocode('   ', { fetch: f, now: NOW }), { ok: false, reason: 'empty address' });
  assert.equal(f.calls.length, 0);
});

// ---- parcelAt --------------------------------------------------------------------------------------------------

test('parcelAt: queries the LA service with the exact field list, returns apn, boundary and assessor fields', async () => {
  const f = happy();
  const p = await parcelAt({ ...PT, jurisdiction: laJ }, { fetch: f, now: NOW });
  assert.equal(p.ok, true);
  const u = f.calls[0].url;
  assert.ok(u.startsWith('https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0/query?'));
  assert.match(u, /outFields=AIN,SitusFullAddress,UseCode,UseType,UseDescription,SQFTmain1,Units1,YearBuilt1,Bedrooms1&/);
  assert.equal(p.apn, '9999-999-001');
  assert.equal(p.boundary.type, 'Polygon');
  assert.equal(p.assessor.livingAreaSqft, 1450);
});

test('parcelAt: no service for the county/state -> ok:false with the named reason', async () => {
  const r = await parcelAt({ ...PT, jurisdiction: { state: 'IL', countyFips: '17031', county: 'Cook County' } }, { fetch: router([]), now: NOW });
  assert.deepEqual(r, { ok: false, reason: 'no parcel service for Cook County, IL' });
});

test('parcelAt: zero matches, HTTP error, service error, malformed JSON and timeout all fail with a reason', async () => {
  const cases = [
    [json(fx('arcgis-empty.json')), /no parcel at this point/],
    [json({}, 500), /HTTP 500/],
    [json(fx('arcgis-error.json')), /service error: Unable to complete/],
    [new Response('{not json', { status: 200 }), /malformed JSON/],
  ];
  for (const [res, re] of cases) {
    const r = await parcelAt({ ...PT, jurisdiction: laJ }, { fetch: router([['lacounty', res]]), now: NOW });
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
  }
  const t = await parcelAt({ ...PT, jurisdiction: laJ }, { fetch: router([['lacounty', hang]]), now: NOW, timeoutMs: 15 });
  assert.match(t.reason, /timeout after 15 ms/);
});

test('parcelAt: several parcels -> picks the one containing the point; none contains -> fail', async () => {
  const multi = await parcelAt({ ...PT, jurisdiction: laJ }, { fetch: router([['lacounty', json(fx('arcgis-la-parcel-multi.json'))]]), now: NOW });
  assert.equal(multi.ok, true);
  assert.equal(multi.apn, '9999-999-001');
  assert.equal(multi.multipleCandidates, true);
  const none = await parcelAt({ ...PT, jurisdiction: laJ }, { fetch: router([['lacounty', json(fx('arcgis-la-parcel-none-contain.json'))]]), now: NOW });
  assert.equal(none.ok, false);
  assert.match(none.reason, /2 parcels returned but none contains the point/);
});

test('registry: county service is tried before statewide, then falls through on failure', async () => {
  const services = [
    { ...PARCEL_SERVICES[0], id: 'statewide', coverage: { state: 'CA' }, url: 'https://state.example/query' },
    { ...PARCEL_SERVICES[0], id: 'county' },
  ];
  assert.deepEqual(servicesFor(services, laJ).map((s) => s.id), ['county', 'statewide']);
  const f = router([['lacounty', json({}, 500)], ['state.example', json(fx('arcgis-la-parcel.json'))]]);
  const r = await parcelAt({ ...PT, jurisdiction: laJ }, { fetch: f, now: NOW, services });
  assert.equal(r.ok, true);
  assert.equal(r.service.id, 'statewide');
  assert.match(f.calls[0].url, /lacounty/);
});

test('registry extension: a new jurisdiction works by adding a data entry only', async () => {
  const entry = {
    id: 'example-county', coverage: { state: 'ZZ', countyFips: '99001' }, kind: 'arcgis-feature', url: 'https://gis.example.test/Parcels/0/query',
    fields: { apn: 'PARCEL_NO', address: 'SITE', useType: 'LANDUSE', livingAreaSqft: 'BLDG_SF', lotAreaSqft: 'LOT_SF' },
    publisher: 'Example County GIS', termsUrl: 'https://gis.example.test/terms', license: 'not verified 2026-11-24',
  };
  const f = router([['gis.example.test', json({ features: [{ attributes: { PARCEL_NO: 'X-1', SITE: '1 Test Rd', LANDUSE: 'Single Family Residential', BLDG_SF: 1800, LOT_SF: 7200 },
    geometry: { rings: [fx('arcgis-la-parcel.json').features[0].geometry.rings[0]] } }] })], ['geocoder/geographies/onelineaddress', () => json({ result: { addressMatches: [{ matchedAddress: '1 TEST RD, EXAMPLEVILLE, ZZ, 00001', coordinates: { x: PT.lng, y: PT.lat },
    addressComponents: { city: 'EXAMPLEVILLE', state: 'ZZ' }, geographies: { Counties: [{ GEOID: '99001', NAME: 'Example County' }] } }] } })], ['overpass', json(fx('overpass-no-features.json'))]]);
  const r = await resolveAddress('1 Test Rd, Exampleville, ZZ', { fetch: f, now: NOW, services: [...PARCEL_SERVICES, entry] });
  assert.equal(r.steps.find((s) => s.step === 'parcel').ok, true);
  assert.equal(r.profile.attributes.parcel_id.value, 'X-1');
  assert.equal(r.profile.attributes.use_type.value, 'Single Family Residential');
  assert.equal(r.profile.attributes.property_type.value, 'single_family');
  assert.equal(r.profile.history.lot_area_sqft.length, 2, 'polygon area and assessor lot size are both kept');
  assert.equal(r.profile.attributes.year_built.tag, 'unavailable', 'a field the service lacks is unavailable, not guessed');
});

// ---- OSM -------------------------------------------------------------------------------------------------------

test('buildingsNear / poolNear / transitNear parse one Overpass response; pools filtered to the parcel', async () => {
  const f = router([['overpass', json(fx('overpass-la.json'))]]);
  const deps = { fetch: f, now: NOW };
  const b = await buildingsNear(PT, deps, { radiusM: 60 });
  assert.equal(b.ok, true);
  assert.equal(b.buildings.length, 3);
  assert.equal(b.source.license, 'ODbL 1.0');
  const osm = { ok: true, elements: fx('overpass-la.json').elements, source: b.source, retrievedAt: NOW };
  const before = f.calls.length;
  const parcel = (await parcelAt({ ...PT, jurisdiction: laJ }, { fetch: happy(), now: NOW })).boundary;
  const pool = await poolNear(PT, deps, { osm, parcel });
  const transit = await transitNear(PT, deps, { osm });
  assert.equal(f.calls.length, before, 'prefetched result is reused: no extra request');
  assert.equal(pool.pools.length, 1);
  assert.equal(transit.nearest.name, 'Fictional Bus Stop');
  assert.ok(Math.abs(transit.nearest.distanceM - 268) < 5, `got ${transit.nearest.distanceM}`);
  assert.equal(transit.stops.length, 2);
});

test('Overpass: HTTP error on every endpoint, remark-only timeout, malformed JSON all give ok:false', async () => {
  const deps = { now: NOW };
  assert.match((await buildingsNear(PT, { ...deps, fetch: router([['overpass', json({}, 504)]]) })).reason, /HTTP 504/);
  assert.match((await poolNear(PT, { ...deps, fetch: router([['overpass', json(fx('overpass-remark.json'))]]) })).reason, /Query timed out/);
  assert.match((await transitNear(PT, { ...deps, fetch: router([['overpass', new Response('x')]]) })).reason, /malformed JSON/);
});

test('Overpass: second endpoint is tried when the first fails', async () => {
  const f = router([['overpass-api.de', json({}, 429)], ['kumi', json(fx('overpass-la.json'))]]);
  assert.equal((await transitNear(PT, { fetch: f, now: NOW })).ok, true);
  assert.equal(f.calls.length, 2);
});

// ---- classification --------------------------------------------------------------------------------------------

test('classifyPropertyType ports the LA rules (same cases as tests/domain.test.mjs)', () => {
  const la = { codeScheme: 'la-assessor', hasSqftField: true };
  assert.equal(classifyPropertyType({ useCode: '010V', useType: 'Residential' }, la), 'land');
  assert.equal(classifyPropertyType({ useCode: '0100', useType: 'Residential', livingAreaSqft: 1500, units: 1 }, la), 'single_family');
  assert.equal(classifyPropertyType({ useCode: '1100', useType: 'Commercial' }, la), 'commercial');
  assert.equal(classifyPropertyType({ useCode: '0100', useType: 'Residential', livingAreaSqft: 900, units: 6 }, la), 'multi_family');
  assert.equal(classifyPropertyType({ useCode: '0100', useType: 'Residential' }, la), 'land', 'original rule: residential with no building area is land');
  assert.equal(classifyPropertyType({ useType: 'Single Family Residential' }), 'single_family');
  assert.equal(classifyPropertyType({ useType: 'Something odd' }), 'unknown');
});

// ---- resolveAddress --------------------------------------------------------------------------------------------

test('happy path: every attribute carries the right tag, source, licence and confidence', async () => {
  const r = await resolveAddress(ADDRESS, { fetch: happy(), now: NOW });
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['geocode', true], ['parcel', true], ['buildings', true], ['pool', true], ['transit', true]]);
  const a = r.profile.attributes;
  const want = (key, tag, conf) => { assert.equal(a[key].tag, tag, key); if (conf !== undefined) assert.equal(a[key].confidence, conf, key); assert.equal(a[key].retrievedAt === NOW || a[key].tag === 'unavailable', true, `${key} retrievedAt`); };
  want('address', 'measured', 0.8);
  assert.equal(a.address.value, '99999 VENICE BLVD, LOS ANGELES, CA, 90034');
  assert.equal(a.address.source, 'US Census Geocoder');
  want('location', 'measured', 0.8);
  want('jurisdiction', 'measured', 0.8);
  assert.equal(a.jurisdiction.value.countyFips, '06037');
  want('parcel_id', 'measured', 0.9);
  assert.equal(a.parcel_id.value, '9999-999-001');
  assert.equal(a.parcel_id.source, 'LA County Assessor (via LA County GIS)');
  assert.equal(a.parcel_id.license, 'not verified 2026-11-24');
  want('parcel_boundary', 'measured', 0.9);
  want('lot_area_sqft', 'measured', 0.85);
  assert.ok(Math.abs(a.lot_area_sqft.value - 10764) < 30, `lot ${a.lot_area_sqft.value}`);
  assert.equal(a.lot_area_sqft.unit, 'sqft');
  want('use_type', 'measured', 0.8);
  assert.equal(a.use_type.value, 'Residential');
  want('property_type', 'estimated', 0.6);
  assert.equal(a.property_type.value, 'single_family');
  assert.equal(a.year_built.value, 1948);
  assert.equal(a.bedrooms.value, 3);
  assert.equal(a.living_area_sqft.value, 1450);
  assert.equal(a.units.value, 1);
  for (const k of ['year_built', 'bedrooms', 'living_area_sqft', 'units']) want(k, 'measured', 0.8);
  // OSM-derived
  for (const k of ['buildings', 'building_footprint_sqft', 'yard_area_sqft', 'pool_present', 'transit_distance_m']) {
    assert.equal(a[k].tag, 'estimated', k);
    assert.equal(a[k].license, 'ODbL 1.0', k);
    assert.match(a[k].note, /© OpenStreetMap contributors/, k);
    assert.equal(a[k].source, 'OpenStreetMap contributors via Overpass API', k);
  }
  assert.equal(a.buildings.value.length, 2, 'house and shed are on the parcel; the neighbour garage is not');
  assert.ok(Math.abs(a.building_footprint_sqft.value - 1787) < 1787 * 0.005, `footprint ${a.building_footprint_sqft.value}`); // 150 m2 + 16 m2 = 1,787 sqft by the 111,320 m/deg fixture convention
  assert.ok(Math.abs(a.yard_area_sqft.value - (a.lot_area_sqft.value - a.building_footprint_sqft.value)) < 3, `yard ${a.yard_area_sqft.value}`);
  assert.equal(a.pool_present.value, true);
  assert.equal(a.pool_present.confidence, 0.6);
  assert.ok(Math.abs(a.transit_distance_m.value - 268) < 5);
  assert.equal(a.transit_distance_m.unit, 'm');
});

test('always-unavailable attributes are recorded as unavailable with a reason (never 0 or false)', async () => {
  const { profile } = await resolveAddress(ADDRESS, { fetch: happy(), now: NOW });
  for (const k of ['driveway_area_sqft', 'parking_spaces', 'garage_present', 'adu_present', 'zoning', 'roof_area_sqft', 'demand_generators']) {
    const s = profile.attributes[k];
    assert.deepEqual([s.tag, s.value, s.confidence], ['unavailable', null, 0], k);
    assert.ok(s.note.length > 10, k);
  }
  assert.match(profile.attributes.roof_area_sqft.note, /footprint is available separately/);
});

test('every attribute key is present after resolveAddress; nothing is mutated across runs', async () => {
  const r1 = await resolveAddress(ADDRESS, { fetch: happy(), now: NOW });
  const r2 = await resolveAddress(ADDRESS, { fetch: happy(), now: NOW });
  assert.equal(Object.keys(r1.profile.attributes).length, 24);
  assert.deepEqual(r1.profile, r2.profile, 'deterministic with the same inputs');
});

test('pool not mapped -> unavailable with the caveat, never false', async () => {
  const els = fx('overpass-la.json').elements.filter((e) => e.tags?.leisure !== 'swimming_pool');
  const r = await resolveAddress(ADDRESS, { fetch: happy({ overpass: json({ elements: els }) }), now: NOW });
  const s = r.profile.attributes.pool_present;
  assert.deepEqual([s.tag, s.value], ['unavailable', null]);
  assert.match(s.note, /not mapped is not proof of absence/);
  assert.equal(r.steps.find((x) => x.step === 'pool').ok, true, 'the lookup itself succeeded');
});

test('partial failure: Overpass down -> parcel data kept, OSM steps reported, OSM attributes unavailable', async () => {
  const r = await resolveAddress(ADDRESS, { fetch: happy({ overpass: json({}, 503) }), now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.profile.attributes.parcel_id.value, '9999-999-001');
  for (const s of ['buildings', 'pool', 'transit']) {
    const st = r.steps.find((x) => x.step === s);
    assert.equal(st.ok, false);
    assert.match(st.reason, /HTTP 503/);
  }
  for (const k of ['buildings', 'building_footprint_sqft', 'yard_area_sqft', 'pool_present', 'transit_distance_m']) assert.equal(r.profile.attributes[k].tag, 'unavailable', k);
});

test('parcel failure: no parcel -> ok:false, parcel attributes unavailable with the reason, geocode data kept', async () => {
  const r = await resolveAddress(ADDRESS, { fetch: happy({ lacounty: json(fx('arcgis-empty.json')) }), now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.step === 'parcel').ok, false);
  assert.equal(r.profile.attributes.address.tag, 'measured');
  assert.equal(r.profile.attributes.lot_area_sqft.tag, 'unavailable');
  assert.match(r.profile.attributes.parcel_id.note, /no parcel at this point/);
  assert.equal(r.profile.attributes.buildings.tag, 'unavailable');
});

test('jurisdiction without a service: reason names the county and state', async () => {
  const f = router([['census.gov', json({ result: { addressMatches: [{ matchedAddress: '1 TEST RD, CHICAGO, IL, 60601', coordinates: { x: -87.6, y: 41.9 }, addressComponents: { city: 'CHICAGO', state: 'IL' },
    geographies: { Counties: [{ GEOID: '17031', NAME: 'Cook County' }] } }] } })], ['overpass', json(fx('overpass-no-features.json'))]]);
  const r = await resolveAddress('1 Test Rd, Chicago, IL 60601', { fetch: f, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.step === 'parcel').reason, 'no parcel service for Cook County, IL');
});

test('geocode failure: ok:false, location unavailable, no parcel or OSM requests made', async () => {
  const f = router([['census.gov', json({}, 500)], ['nominatim', json([])]]);
  const r = await resolveAddress(ADDRESS, { fetch: f, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.profile.attributes.location.tag, 'unavailable');
  assert.equal(f.calls.some((c) => /overpass|lacounty/.test(c.url)), false);
});

test('mismatched geocode flows into the profile as low confidence with the warning note', async () => {
  const r = await resolveAddress(ADDRESS, { fetch: happy({ 'geocoder/geographies/onelineaddress': json(fx('census-geocode-wrongcity.json')) }), now: NOW });
  assert.equal(r.profile.attributes.address.confidence, 0.3);
  assert.match(r.profile.attributes.address.note, /different place/);
});

test('owner corrections survive a re-run of resolveAddress merged into the same profile', async () => {
  const first = await resolveAddress(ADDRESS, { fetch: happy(), now: NOW });
  let p = applyOwnerCorrection(first.profile, 'bedrooms', 4, '2026-11-25T00:00:00Z');
  const refresh = await resolveAddress(ADDRESS, { fetch: happy(), now: '2026-12-01T00:00:00Z' });
  for (const [k, hist] of Object.entries(refresh.profile.history)) for (const s of hist) p = setAttribute(p, k, s);
  assert.equal(p.attributes.bedrooms.value, 4);
  assert.equal(p.attributes.bedrooms.tag, 'owner-confirmed');
});

test('inputs are not mutated and `now` is required', async () => {
  const services = JSON.parse(JSON.stringify(PARCEL_SERVICES));
  const snap = JSON.stringify(services);
  await resolveAddress(ADDRESS, { fetch: happy(), now: NOW, services });
  assert.equal(JSON.stringify(services), snap);
  await assert.rejects(resolveAddress(ADDRESS, { fetch: happy() }), /now/);
});

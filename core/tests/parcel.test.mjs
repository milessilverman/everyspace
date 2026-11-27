import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { geocode, parcelAt, buildingsNear, poolNear, transitNear, overpassNear, resolveAddress, classifyPropertyType, servicesFor, addressMismatch, situsMatchesAddress,
  BROWSER_GEOCODERS, GEOCODERS_SERVER, CONFIDENCE } from '../parcel.js';
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

test('geocode: Census match gives coordinates, county FIPS and high confidence; sends only Accept by default and no address in headers', async () => {
  const f = happy();
  const g = await geocode(ADDRESS, { fetch: f, now: NOW });
  assert.equal(g.ok, true);
  assert.deepEqual([g.provider, g.lat, g.lng, g.confidence], ['census', 34.030009, -118.4199946, 0.8]);
  assert.deepEqual(g.jurisdiction, { country: 'US', state: 'CA', countyFips: '06037', county: 'Los Angeles County', city: 'LOS ANGELES' });
  for (const c of f.calls) assert.deepEqual(c.init.headers, { Accept: 'application/json' }, 'default requests carry no custom headers');
  const f2 = happy();
  await geocode(ADDRESS, { fetch: f2, now: NOW, userAgent: 'Everyspace-server/1.0' });
  assert.equal(f2.calls[0].init.headers['User-Agent'], 'Everyspace-server/1.0');
  assert.equal(JSON.stringify(f2.calls[0].init.headers).includes('Venice'), false);
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

// ---- Live-check regressions (2026-11-24): geocoded point in the street, buffered parcel search, mismatch gate ---------

const STREET_PT = { lat: 34.03045, lng: -118.4199946 };
const isBuffered = (url) => url.includes('distance=');
/** LA service: exact query -> `exact` body, buffered query -> `buffer` body. */
const la = (exact, buffer) => (url) => json(isBuffered(url) ? buffer : exact);
const streetHappy = (buffer = fx('arcgis-la-buffer.json'), over = {}) => router([
  ...Object.entries(over),
  ['geocoder/geographies/onelineaddress', () => json(fx('census-geocode-la-street.json'))],
  ['lacounty.gov', la(fx('arcgis-empty.json'), buffer)],
  ['overpass', () => json(fx('overpass-la.json'))],
]);
const SPRING = '200 N Spring St, Los Angeles, CA 90012'; // the live check: Census matches 200 S SPRING ST
const springRouter = (over = {}) => router([
  ...Object.entries(over),
  ['geocoder/geographies/onelineaddress', () => json(fx('census-geocode-spring-st-recorded.json'))],
  ['lacounty.gov', la(fx('arcgis-empty.json'), fx('arcgis-la-buffer-spring-st-recorded.json'))],
  ['overpass', () => json(fx('overpass-no-features.json'))],
]);

test('exact hit still wins: a point inside the parcel makes no buffered request, confidence 0.9, matchedBy containing-point', async () => {
  const f = happy();
  const p = await parcelAt({ ...PT, jurisdiction: laJ }, { fetch: f, now: NOW }, { matchedAddress: '99999 VENICE BLVD, LOS ANGELES, CA, 90034' });
  assert.equal(p.ok, true);
  assert.equal(p.matchedBy, 'containing-point');
  assert.equal(f.calls.filter((c) => isBuffered(c.url)).length, 0, 'no buffered query needed');
  const r = await resolveAddress(ADDRESS, { fetch: happy(), now: NOW });
  assert.equal(r.profile.attributes.parcel_id.confidence, CONFIDENCE.parcelId);
  assert.equal(r.steps[0].matchedAddress, '99999 VENICE BLVD, LOS ANGELES, CA, 90034');
});

test('buffered: point in the street, exactly one situs match -> used, lower confidence, method recorded', async () => {
  const f = streetHappy();
  const r = await resolveAddress(ADDRESS, { fetch: f, now: NOW });
  assert.equal(r.ok, true);
  const urls = f.calls.map((c) => c.url).filter((u) => u.includes('lacounty'));
  assert.equal(urls.length, 2);
  assert.match(urls[1], /distance=40&units=esriSRUnit_Meter/);
  const id = r.profile.attributes.parcel_id;
  assert.equal(id.value, '9999-999-001', 'not 99999 W WASHINGTON, not the blank-situs parcels, not 99997');
  assert.equal(id.method, 'matched by situs address within 40 m of the geocoded point');
  assert.equal(id.confidence, CONFIDENCE.parcelBySitus);
  assert.ok(CONFIDENCE.parcelBySitus < CONFIDENCE.parcelId);
  assert.ok(r.profile.attributes.parcel_boundary.confidence < CONFIDENCE.parcelId);
  assert.equal(r.profile.attributes.year_built.value, 1948, 'YearBuilt1 arrives as the string "1948"');
});

test('situs matching normalises suffixes and compares the directional only when both sides have one', () => {
  assert.equal(situsMatchesAddress('145 S SPRING STREET, LOS ANGELES, CA', '145 S SPRING ST LOS ANGELES CA 90012'), true);
  assert.equal(situsMatchesAddress('99999 Venice Boulevard, Los Angeles, CA 90034', '99999 VENICE BLVD LOS ANGELES CA 90034'), true);
  assert.equal(situsMatchesAddress('145 SPRING ST, LOS ANGELES', '145 S SPRING ST LOS ANGELES CA 90012'), true, 'directional missing on one side: not compared');
  assert.equal(situsMatchesAddress('145 N SPRING ST, LOS ANGELES', '145 S SPRING ST LOS ANGELES CA 90012'), false, 'N vs S');
  assert.equal(situsMatchesAddress('145 S SPRING ST, LOS ANGELES', '146 S SPRING ST LOS ANGELES CA 90012'), false, 'house number');
  assert.equal(situsMatchesAddress('145 S SPRING ST, LOS ANGELES', '145 S MAIN ST LOS ANGELES CA 90012'), false, 'street name');
  assert.equal(situsMatchesAddress('145 S SPRING ST, LOS ANGELES', '145 S SPRING PL LOS ANGELES CA 90012'), false, 'suffix');
  assert.equal(situsMatchesAddress('100 W 1st St, Los Angeles', '100 W 1ST ST LOS ANGELES CA 90012'), true);
  assert.equal(situsMatchesAddress('145 S SPRING ST, LOS ANGELES', ''), false, 'empty situs never matches');
  assert.equal(situsMatchesAddress('145 S SPRING ST, LOS ANGELES', null), false);
});

test('buffered: zero situs match -> ok:false, counts the nearby parcels, lists candidates (apn + address only, max 10), never the nearest', async () => {
  const f = springRouter();
  const g = await geocode(SPRING, { fetch: f, now: NOW });
  const p = await parcelAt({ lat: g.lat, lng: g.lng, jurisdiction: g.jurisdiction }, { fetch: f, now: NOW }, { matchedAddress: g.matchedAddress });
  assert.equal(p.ok, false);
  assert.match(p.reason, /no parcel at this point/);
  assert.match(p.reason, /10 parcels within 40 m of the geocoded point, but none matches the address "200 S SPRING ST, LOS ANGELES, CA, 90012"/);
  assert.equal(p.candidates.length, 10);
  assert.deepEqual(Object.keys(p.candidates[0]).sort(), ['address', 'apn']);
  assert.deepEqual(p.candidates[0], { apn: '5149001003', address: '145 S SPRING ST LOS ANGELES CA 90012' });
  assert.equal(p.candidates.filter((c) => c.address).length, 4, 'addressed parcels first');
  assert.equal(p.boundary, undefined);
});

test('buffered: several situs matches -> ok:false saying more than one matched, candidates are the matching parcels', async () => {
  const p = await parcelAt({ ...STREET_PT, jurisdiction: laJ }, { fetch: router([['lacounty', la(fx('arcgis-empty.json'), fx('arcgis-la-buffer-ambiguous.json'))]]), now: NOW },
    { matchedAddress: '99999 VENICE BLVD, LOS ANGELES, CA, 90034' });
  assert.equal(p.ok, false);
  assert.match(p.reason, /2 of 3 parcels within 40 m match the address .*more than one, so none was chosen/);
  assert.deepEqual(p.candidates.map((c) => c.apn), ['9999-999-001', '9999-999-008']);
});

test('buffered: blank situs addresses are never an address match', async () => {
  const p = await parcelAt({ ...STREET_PT, jurisdiction: laJ }, { fetch: router([['lacounty', la(fx('arcgis-empty.json'), fx('arcgis-la-buffer-nomatch.json'))]]), now: NOW },
    { matchedAddress: '99999 VENICE BLVD, LOS ANGELES, CA, 90034' });
  assert.equal(p.ok, false);
  assert.match(p.reason, /2 parcels within 40 m .* none matches/);
  assert.deepEqual(p.candidates.map((c) => c.address), ['99997 VENICE BLVD LOS ANGELES CA 90034', null]);
});

test('buffered: radius comes from the registry entry (searchRadiusM), default 40; a failed buffered query reports its reason', async () => {
  const svc = { ...PARCEL_SERVICES[0], searchRadiusM: 25 };
  const f = router([['lacounty', la(fx('arcgis-empty.json'), fx('arcgis-la-buffer.json'))]]);
  const p = await parcelAt({ ...STREET_PT, jurisdiction: laJ }, { fetch: f, now: NOW, services: [svc] }, { matchedAddress: '99999 VENICE BLVD, LOS ANGELES' });
  assert.equal(p.ok, true);
  assert.match(f.calls[1].url, /distance=25&units=esriSRUnit_Meter/);
  assert.equal(PARCEL_SERVICES[0].searchRadiusM, 40);
  const bad = router([['lacounty', (u) => (isBuffered(u) ? json({}, 500) : json(fx('arcgis-empty.json')))]]);
  const r = await parcelAt({ ...STREET_PT, jurisdiction: laJ }, { fetch: bad, now: NOW }, { matchedAddress: '99999 VENICE BLVD, LOS ANGELES' });
  assert.match(r.reason, /search within 40 m failed: HTTP 500/);
  assert.equal(r.candidates, undefined);
});

test('mismatch: N vs S directional (recorded response) -> needsConfirmation, geocode-only profile, no parcel request', async () => {
  const f = springRouter();
  const r = await resolveAddress(SPRING, { fetch: f, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'address matched a different location');
  assert.equal(r.needsConfirmation, true);
  assert.equal(r.matchedAddress, '200 S SPRING ST, LOS ANGELES, CA, 90012');
  assert.equal(r.steps[0].matchedAddress, '200 S SPRING ST, LOS ANGELES, CA, 90012');
  assert.deepEqual(Object.keys(r.profile.attributes).sort(), ['address', 'jurisdiction', 'location']);
  assert.equal(r.profile.attributes.address.confidence, CONFIDENCE.mismatch);
  assert.match(r.profile.attributes.address.note, /street direction N vs S/);
  assert.equal(f.calls.some((c) => /lacounty|overpass/.test(c.url)), false);
});

test('mismatch: house number and street name differences need confirmation; city-only differences do not', async () => {
  assert.match(addressMismatch('200 N Spring St, Los Angeles', '200 S SPRING ST, LOS ANGELES, CA, 90012'), /direction N vs S/);
  assert.match(addressMismatch('202 S Spring St', '200 S SPRING ST, LOS ANGELES'), /house number 202 vs 200/);
  assert.match(addressMismatch('200 S Main St, Los Angeles', '200 S SPRING ST, LOS ANGELES'), /street MAIN ST vs SPRING ST/);
  assert.equal(addressMismatch('99999 Venice Boulevard, LA', '99999 VENICE BLVD, LOS ANGELES, CA, 90034'), null);
  const name = await resolveAddress('99999 Washington Blvd, Los Angeles, CA 90034', { fetch: happy(), now: NOW });
  assert.equal(name.needsConfirmation, true);
  const city = await resolveAddress(ADDRESS, { fetch: happy({ 'geocoder/geographies/onelineaddress': json(fx('census-geocode-wrongcity.json')) }), now: NOW });
  assert.equal(city.needsConfirmation, undefined, "city-only difference keeps today's behaviour");
  assert.equal(city.ok, true);
});

test('confirmMatchedAddress: continues past the mismatch; no situs match for the matched address -> candidates returned', async () => {
  const r = await resolveAddress(SPRING, { fetch: springRouter(), now: NOW, confirmMatchedAddress: true });
  assert.equal(r.needsConfirmation, undefined);
  assert.equal(r.ok, false, 'no parcel could be chosen by address');
  assert.equal(r.steps.find((s) => s.step === 'parcel').ok, false);
  assert.equal(r.candidates.length, 10);
  assert.deepEqual(r.steps.find((s) => s.step === 'parcel').candidates, r.candidates);
  assert.match(r.profile.attributes.parcel_id.note, /none matches the address "200 S SPRING ST/);
  assert.equal(r.profile.attributes.address.confidence, CONFIDENCE.mismatch, 'still low confidence');
});

test('parcelApn: the owner-picked candidate is resolved from the buffer and parcel_id is owner-confirmed (one parcel request)', async () => {
  const f = springRouter();
  const r = await resolveAddress(SPRING, { fetch: f, now: NOW, confirmMatchedAddress: true, parcelApn: '5149007006' });
  assert.equal(r.ok, true);
  const id = r.profile.attributes.parcel_id;
  assert.deepEqual([id.value, id.tag, id.confidence], ['5149007006', 'owner-confirmed', 1]);
  assert.match(id.method, /chosen by the owner/);
  assert.equal(f.calls.filter((c) => c.url.includes('lacounty')).length, 1, 'only the buffered query');
  assert.equal(r.profile.attributes.use_type.value, 'Commercial');
  assert.equal(r.profile.attributes.property_type.value, 'commercial');
  assert.equal(r.profile.attributes.year_built.value, 1905);
  assert.equal(r.profile.attributes.living_area_sqft.value, 23089);
  assert.equal(r.profile.attributes.parcel_boundary.tag, 'measured');
  const bad = await resolveAddress(SPRING, { fetch: springRouter(), now: NOW, confirmMatchedAddress: true, parcelApn: '0000000000' });
  assert.equal(bad.ok, false);
  assert.match(bad.steps.find((s) => s.step === 'parcel').reason, /parcel 0000000000 is not among the 10 parcels/);
});

test('field hygiene: year "0000", zero bedrooms/units and null fields are unavailable ("not recorded by the assessor"), never 0', async () => {
  const r = await resolveAddress(SPRING, { fetch: springRouter(), now: NOW, confirmMatchedAddress: true, parcelApn: '5149007005' });
  const a = r.profile.attributes;
  assert.equal(a.parcel_id.value, '5149007005');
  for (const k of ['year_built', 'bedrooms', 'units']) { assert.deepEqual([a[k].tag, a[k].value, a[k].confidence], ['unavailable', null, 0], k); assert.equal(a[k].note, 'not recorded by the assessor', k); }
  assert.equal(a.living_area_sqft.value, 12710);
  const lot = await resolveAddress(SPRING, { fetch: springRouter(), now: NOW, confirmMatchedAddress: true, parcelApn: '5149008092' }); // blank situs, all-null attributes
  for (const k of ['year_built', 'bedrooms', 'units', 'living_area_sqft']) assert.equal(lot.profile.attributes[k].tag, 'unavailable', k);
  assert.equal(lot.profile.attributes.use_type.value, 'Commercial');
  const str = await parcelAt({ ...STREET_PT, jurisdiction: laJ }, { fetch: router([['lacounty', json(fx('arcgis-la-parcel.json'))]]), now: NOW });
  assert.equal(str.assessor.yearBuilt, 1948, 'string year parsed');
});

test('field hygiene: a residential parcel with Bedrooms1 = 0 and YearBuilt1 "0000" records both as unavailable', async () => {
  const body = fx('arcgis-la-parcel.json');
  body.features[0].attributes.Bedrooms1 = 0;
  body.features[0].attributes.YearBuilt1 = '0000';
  const r = await resolveAddress(ADDRESS, { fetch: happy({ lacounty: json(body) }), now: NOW });
  assert.equal(r.profile.attributes.bedrooms.tag, 'unavailable');
  assert.equal(r.profile.attributes.year_built.tag, 'unavailable');
  assert.equal(r.profile.attributes.living_area_sqft.value, 1450);
});

test('geocoder order: default census then nominatim; `geocoders` overrides it; BROWSER_GEOCODERS never calls Census', async () => {
  assert.deepEqual(GEOCODERS_SERVER, ['census', 'nominatim']);
  assert.deepEqual(BROWSER_GEOCODERS, ['nominatim']);
  const f = router([['nominatim', json(fx('nominatim-la.json'))], ['lacounty.gov', json(fx('arcgis-la-parcel.json'))], ['overpass', json(fx('overpass-no-features.json'))]]);
  const r = await resolveAddress(ADDRESS, { fetch: f, now: NOW, geocoders: BROWSER_GEOCODERS });
  assert.equal(f.calls.some((c) => c.url.includes('census.gov')), false, 'Census has no CORS header: no request at all, not even for the county');
  assert.equal(r.steps[0].provider, 'nominatim');
  assert.equal(r.steps[0].matchedAddress, '99999 Venice Boulevard, Los Angeles, CA 90034');
  assert.equal(r.profile.attributes.jurisdiction.value.countyFips, undefined);
  assert.equal(r.profile.attributes.jurisdiction.value.county, 'Los Angeles County');
  assert.equal(r.ok, true, 'the LA service is found by county name when there is no FIPS');
  assert.equal(r.profile.attributes.parcel_id.value, '9999-999-001');
  const both = router([['nominatim', json(fx('nominatim-la.json'))], ['geographies/coordinates', json(fx('census-coordinates-la.json'))]]);
  const g = await geocode(ADDRESS, { fetch: both, now: NOW, geocoders: ['nominatim', 'census'] });
  assert.equal(g.provider, 'nominatim');
  assert.equal(g.jurisdiction.countyFips, '06037');
  assert.match(both.calls[0].url, /nominatim/, 'order respected');
  assert.deepEqual(await geocode(ADDRESS, { fetch: both, now: NOW, geocoders: [] }), { ok: false, reason: 'no geocoder configured' });
  assert.deepEqual(servicesFor(PARCEL_SERVICES, { state: 'CA', county: 'Los Angeles County' }).map((s) => s.id), ['la-county-assessor']);
  assert.deepEqual(servicesFor(PARCEL_SERVICES, { state: 'AZ', county: 'Los Angeles County' }), []);
});

test('Nominatim spacing: calls through one resolver are >= 1000 ms apart via the injected sleep; no real timers', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const f = router([['nominatim', () => json(fx('nominatim-la.json'))]]);
  const deps = { fetch: f, now: NOW, geocoders: BROWSER_GEOCODERS, sleep };
  await geocode(ADDRESS, deps);
  assert.deepEqual(sleeps, [], 'first call goes straight out');
  await geocode(ADDRESS, deps);
  assert.deepEqual(sleeps, [1000]);
  await geocode(ADDRESS, deps);
  assert.deepEqual(sleeps, [1000, 2000], 'a third call queues behind the second');
  // time passing is honoured: 1500 ms later no wait is needed
  let clock = Date.parse(NOW) + 10000;
  const d2 = { fetch: router([['nominatim', () => json(fx('nominatim-la.json'))]]), now: NOW, geocoders: BROWSER_GEOCODERS, sleep, nowMs: () => clock };
  sleeps.length = 0;
  await geocode(ADDRESS, d2); clock += 1500; await geocode(ADDRESS, d2);
  assert.deepEqual(sleeps, []);
  clock += 200; await geocode(ADDRESS, d2);
  assert.deepEqual(sleeps, [800]);
  // injectable interval; another resolver instance (another fetch) is independent
  const d3 = { fetch: router([['nominatim', () => json(fx('nominatim-la.json'))]]), now: NOW, geocoders: BROWSER_GEOCODERS, sleep, nominatimMinIntervalMs: 250 };
  sleeps.length = 0;
  await geocode(ADDRESS, d3); await geocode(ADDRESS, d3);
  assert.deepEqual(sleeps, [250]);
  const d4 = { ...d3, fetch: router([['nominatim', () => json(fx('nominatim-la.json'))]]) };
  sleeps.length = 0;
  await geocode(ADDRESS, d4);
  assert.deepEqual(sleeps, []);
});

test("the geocoder's matched address is surfaced in steps[0] (recorded response) and no parcel is invented", async () => {
  const r = await resolveAddress(SPRING, { fetch: springRouter(), now: NOW, confirmMatchedAddress: true });
  assert.equal(r.steps[0].step, 'geocode');
  assert.equal(r.steps[0].matchedAddress, '200 S SPRING ST, LOS ANGELES, CA, 90012');
  assert.equal(r.profile.attributes.parcel_id.tag, 'unavailable');
});

test('overpassNear: a missing, NaN or negative radius falls back to the default and never reaches the query', async () => {
  for (const bad of [NaN, undefined, -5, Infinity, 'x']) {
    const seen = [];
    const f = async (url) => { seen.push(decodeURIComponent(String(url))); return new Response(JSON.stringify({ elements: [] }), { status: 200 }); };
    const r = await overpassNear({ lat: 34.05, lng: -118.24 }, { buildingRadiusM: /** @type {any} */ (bad) }, { fetch: f, now: '2026-11-27T00:00:00Z' });
    assert.equal(r.ok, true);
    assert.match(seen[0], /\(around:60,34\.05,-118\.24\)/);
    assert.doesNotMatch(seen[0], /NaN|undefined|Infinity/);
  }
});

test('overpassNear: no valid map location means no request at all', async () => {
  let calls = 0;
  const f = async () => { calls++; return new Response('{}'); };
  for (const point of [null, { lat: NaN, lng: -118 }, { lat: 34 }]) {
    const r = await overpassNear(/** @type {any} */ (point), {}, { fetch: f, now: '2026-11-27T00:00:00Z' });
    assert.equal(r.ok, false);
  }
  assert.equal(calls, 0);
});

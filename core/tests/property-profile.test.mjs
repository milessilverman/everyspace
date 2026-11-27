import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPropertyProfile, toSourcedProfile, PROFILE_FIELDS, distanceToPolygonM } from '../property-profile.js';
import { createRegistry, createDefaultRegistry } from '../providers/registry.js';
import { getAttribute, summarize } from '../profile.js';
import { missingEvidence, defaultResourceCapacity } from '../opportunities.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/providers/${n}`, import.meta.url), 'utf8'));
const NOW = '2026-11-27T12:00:00Z';
const SFR = '4321 Example Ave, Los Angeles, CA 90099';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

/** Router with fixture responses for every service; `over` replaces routes by key. */
function world(over = {}) {
  const base = {
    cams: () => json(fx('synthetic-cams-sfr.json')),
    census: () => json(fx('synthetic-census-sfr.json')),
    parcel: () => json(fx('synthetic-assessor-sfr.json')),
    lariac: () => json(fx('synthetic-lariac-sfr.json')),
    rentcast: () => json(fx('synthetic-rentcast.json')),
    solar: () => json(fx('synthetic-solar.json')),
    ...over,
  };
  const calls = [];
  const f = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const key = u.includes('CAMS_Locator') ? 'cams' : u.includes('geocoding.geo.census.gov') ? 'census' : u.includes('LACounty_Parcel') ? 'parcel' : u.includes('LARIAC') ? 'lariac'
      : u.includes('rentcast') ? 'rentcast' : u.includes('solar.googleapis') ? 'solar' : null;
    if (!key) throw new Error(`unexpected fetch ${u}`);
    return base[key](u, init);
  };
  f.calls = calls;
  return f;
}
const yardOk = (over = {}) => {
  const fn = (args) => { fn.calls.push(args); return { ok: true, lotSqft: 6500, buildingSqft: 1700, openSqft: 4800, frontYardSqft: 1200, backYardSqft: 2600, sideYardSqft: 1000, frontEdge: 'south', method: 'fake split', confidence: 0.5, warnings: [], ...over }; };
  fn.calls = [];
  return fn;
};
async function run({ keys = {}, over = {}, splitYard = yardOk(), query = { address: SFR }, registry } = {}) {
  const fetch = world(over);
  const reg = registry ?? (await createDefaultRegistry());
  const profile = await buildPropertyProfile(query, { registry: reg, fetch, now: NOW, keys, splitYard });
  return { profile, fetch, splitYard };
}
const noWarn = (p) => assert.deepEqual(p.warnings, []);

test('keyless profile: every top-level field has value, source, tag and confidence; providers are reported', async () => {
  const { profile: p, splitYard } = await run();
  for (const k of PROFILE_FIELDS) {
    const f = p.fields[k];
    assert.ok(f, k);
    for (const prop of ['value', 'unit', 'tag', 'source', 'confidence', 'confidence_label', 'retrieved_at']) assert.ok(prop in f, `${k}.${prop}`);
    assert.ok(f.source && typeof f.confidence === 'number', k);
    assert.equal(p[k], f.value, `flat ${k}`);
  }
  assert.equal(p.address, '4321 Example Ave, Los Angeles, CA, 90099');
  assert.deepEqual([p.apn, p.house_sqft, p.beds, p.baths, p.year_built, p.property_type], ['9999999999', 2800, 3, 2, 1952, 'single_family']);
  assert.ok(Math.abs(p.lot_sqft - 6500) < 5);
  assert.deepEqual([p.floors, p.fields.floors.tag, p.fields.floors.confidence <= 0.3], [2, 'estimated', true]);
  assert.match(p.fields.floors.note, /24\.5 ft/);
  assert.equal(p.roof_sqft, 1400); assert.equal(p.fields.roof_sqft.tag, 'estimated'); assert.equal(p.fields.roof_sqft.method, 'building footprint plan area; roof pitch not applied'); assert.ok(p.fields.roof_sqft.confidence <= 0.3);
  assert.deepEqual([p.front_yard_sqft, p.back_yard_sqft, p.side_yard_sqft], [1200, 2600, 1000]);
  assert.equal(p.fields.front_yard_sqft.tag, 'estimated'); assert.ok(p.fields.front_yard_sqft.confidence <= 0.4);
  assert.equal(p.place_id, null); assert.equal(p.fields.place_id.tag, 'unavailable'); assert.match(p.fields.place_id.note, /Places/);
  const st = Object.fromEntries(p.providers.map((x) => [x.id, x.status]));
  assert.deepEqual(st, { rentcast: 'skipped', 'google-solar': 'skipped', 'la-cams-address': 'used', 'census-address': 'used', 'la-assessor': 'used', 'lariac-buildings': 'used' });
  assert.equal(p.providers.find((x) => x.id === 'rentcast').reason, 'no API key');
  assert.equal(p.fields.house_sqft.cross_check, undefined);
  assert.match(p.fields.house_sqft.note, /Single source/);
  assert.equal(p.fields.lot_sqft.cross_check.agreement, 'match'); assert.match(p.fields.lot_sqft.cross_check.source, /Shape\.STArea/);
  noWarn(p);
  // the yard splitter got the parcel, both footprints, the street-side point and the main building
  const a = splitYard.calls[0];
  assert.equal(a.buildings.length, 2); assert.equal(a.mainBuildingIndex, 0); assert.equal(a.streetName, 'EXAMPLE AVE'); assert.ok(a.parcel.type);
  assert.ok(a.frontPoint.lat < 34.0 && Math.abs(a.frontPoint.lat - 33.99994) < 1e-4, 'Census street-side point, south of the parcel');
  assert.ok(distanceToPolygonM(a.frontPoint, a.parcel) < 20);
  assert.equal(p.details.yard.openSqft, 4800);
});

test('RentCast key: primary value, assessor cross-check with match/minor tolerances; the key never appears in output', async () => {
  const KEY = 'rc-SECRET-123456';
  const { profile: p, fetch } = await run({ keys: { rentcast: KEY } });
  assert.equal(p.house_sqft, 2750); assert.equal(p.fields.house_sqft.source, 'RentCast property records');
  assert.deepEqual([p.fields.house_sqft.cross_check.agreement, p.fields.house_sqft.cross_check.value, p.fields.house_sqft.cross_check.difference], ['match', 2800, -50]);
  assert.match(p.fields.house_sqft.cross_check.source, /Assessor/);
  assert.equal(p.fields.lot_sqft.value, 6400); assert.equal(p.fields.lot_sqft.cross_check.agreement, 'match');
  for (const k of ['beds', 'baths', 'year_built', 'property_type']) assert.equal(p.fields[k].cross_check.agreement, 'match', k);
  assert.equal(p.fields.apn.cross_check.agreement, 'match', 'APN compared without punctuation');
  assert.equal(p.floors, 2); assert.equal(p.fields.floors.tag, 'measured', 'provider floors are used when present');
  assert.equal(p.providers.find((x) => x.id === 'rentcast').status, 'used');
  assert.ok(!JSON.stringify(p).includes(KEY));
  assert.ok(fetch.calls.some((c) => c.init?.headers?.['X-Api-Key'] === KEY));
  assert.ok(fetch.calls.every((c) => !c.url.includes(KEY)));
  noWarn(p);
});

test('cross-check agreement: minor keeps the value; conflict keeps the primary, lowers confidence, warns, never averages', async () => {
  const mk = (patch) => ({ rentcast: () => json([{ ...fx('synthetic-rentcast.json')[0], ...patch }]) });
  const minor = (await run({ keys: { rentcast: 'k-123456' }, over: mk({ squareFootage: 2400 }) })).profile;
  assert.equal(minor.house_sqft, 2400); assert.equal(minor.fields.house_sqft.cross_check.agreement, 'minor'); assert.equal(minor.fields.house_sqft.confidence, 0.65);
  assert.ok(!minor.warnings.some((w) => w.startsWith('house_sqft')));
  const bad = (await run({ keys: { rentcast: 'k-123456' }, over: mk({ squareFootage: 4000, bedrooms: 5 }) })).profile;
  assert.equal(bad.house_sqft, 4000, 'primary kept, not averaged');
  assert.equal(bad.fields.house_sqft.cross_check.agreement, 'conflict'); assert.equal(bad.fields.house_sqft.cross_check.value, 2800);
  assert.ok(bad.fields.house_sqft.confidence < 0.65 && bad.fields.house_sqft.confidence === 0.33);
  assert.equal(bad.fields.beds.cross_check.agreement, 'conflict'); assert.equal(bad.beds, 5);
  assert.ok(bad.warnings.some((w) => /house_sqft.*RentCast.*Assessor/.test(w)));
  assert.ok(bad.warnings.some((w) => /^beds:/.test(w)));
});

test('fallback chain: primary fails (429) or lacks a field -> assessor value, "no independent cross-check", failure is reported', async () => {
  const KEY = 'rc-SECRET-123456';
  const f429 = (await run({ keys: { rentcast: KEY }, over: { rentcast: () => json({}, 429) } })).profile;
  assert.equal(f429.house_sqft, 2800); assert.equal(f429.fields.house_sqft.source, 'LA County Assessor (via LA County GIS)');
  assert.match(f429.fields.house_sqft.note, /no independent cross-check/i);
  const rc = f429.providers.find((x) => x.id === 'rentcast');
  assert.equal(rc.status, 'failed'); assert.match(rc.reason, /HTTP 429/); assert.ok(!JSON.stringify(f429).includes(KEY));
  assert.ok(f429.warnings.some((w) => w.startsWith('rentcast:')));
  const partial = (await run({ keys: { rentcast: KEY }, over: { rentcast: () => json([{ squareFootage: 2750, propertyType: 'Single Family' }]) } })).profile;
  assert.equal(partial.house_sqft, 2750); assert.equal(partial.beds, 3); assert.equal(partial.fields.beds.source, 'LA County Assessor (via LA County GIS)');
  assert.match(partial.fields.beds.note, /Single source/); assert.equal(partial.fields.beds.cross_check, undefined);
});

test('address fallback: county locator fails -> Census; both fail -> location from the parcel centroid; typed address still reaches the assessor', async () => {
  const noCams = (await run({ over: { cams: () => json({}, 500) } })).profile;
  assert.equal(noCams.providers.find((x) => x.id === 'la-cams-address').status, 'failed');
  assert.equal(noCams.providers.find((x) => x.id === 'census-address').status, 'used');
  assert.equal(noCams.address, '4321 EXAMPLE AVE, LOS ANGELES, CA, 90099'); assert.equal(noCams.apn, '9999999999');
  const none = (await run({ over: { cams: () => json({}, 500), census: () => json({}, 500) } })).profile;
  assert.equal(none.fields.address.tag, 'unavailable'); assert.match(none.fields.address.note, /could not be geocoded/);
  assert.equal(none.apn, '9999999999'); assert.equal(none.fields.lat.method, 'centroid of the assessor parcel polygon'); assert.ok(Math.abs(none.lat - 34.0003) < 2e-4);
  assert.ok(none.warnings.includes('address could not be geocoded by any provider'));
  assert.equal(none.front_yard_sqft, 1200, 'no street reference: split still runs, with a warning');
  assert.ok(none.warnings.some((w) => /no street reference/.test(w)));
});

test('geocoder returned a different street direction: warning, low address confidence, parcel centroid replaces a far point', async () => {
  const spring = JSON.parse(readFileSync(new URL('./fixtures/parcel/census-geocode-spring-st-recorded.json', import.meta.url), 'utf8'));
  const { profile: p } = await run({ query: { address: '200 N Spring St, Los Angeles, CA 90012' }, over: { cams: () => json({}, 500), census: () => json(spring), parcel: () => json(fx('la-assessor-situs-200-n-spring.json')), lariac: () => json(fx('lariac-buildings-200-n-spring.json')) } });
  assert.equal(p.apn, '5161005906', 'the assessor was asked with the typed address, so the right parcel was found');
  assert.equal(p.fields.address.confidence, 0.3);
  assert.ok(p.warnings.some((w) => /matched a different address/.test(w)));
  assert.ok(p.warnings.some((w) => /m from the matched parcel/.test(w)));
  assert.equal(p.fields.lat.method, 'centroid of the assessor parcel polygon');
  assert.ok(p.warnings.some((w) => /street-side point.*not used/.test(w)), 'the S Spring street-side point is far from the N Spring parcel');
});

test('street-side point far from the parcel is dropped with a warning', async () => {
  const far = fx('synthetic-census-sfr.json'); far.result.addressMatches[0].coordinates.y += 0.01;
  const { profile: p, splitYard } = await run({ over: { cams: () => json({}, 500), census: () => json(far) } });
  assert.ok(p.warnings.some((w) => /not used as the front reference/.test(w)));
  assert.equal(splitYard.calls[0].frontPoint, undefined);
});

test('roof: Google Solar area when a key is present (measured); footprint plan area otherwise (estimated)', async () => {
  const { profile: p } = await run({ keys: { 'google-solar': 'AIza-SECRET-1234' } });
  assert.ok(Math.abs(p.roof_sqft - 2045) < 2); assert.equal(p.fields.roof_sqft.tag, 'measured'); assert.equal(p.fields.roof_sqft.source, 'Google Solar API (roof area)');
  assert.equal(p.providers.find((x) => x.id === 'google-solar').status, 'used');
  assert.ok(!JSON.stringify(p).includes('AIza-SECRET'));
  const fail = (await run({ keys: { 'google-solar': 'AIza-SECRET-1234' }, over: { solar: () => json({}, 403) } })).profile;
  assert.equal(fail.fields.roof_sqft.tag, 'estimated'); assert.equal(fail.providers.find((x) => x.id === 'google-solar').status, 'failed');
});

test('floors estimate rules: ratio rounding, 1..4 clamp, > 4.5 unavailable, low confidence, unavailable without inputs', async () => {
  const withSqft = (n) => ({ parcel: () => { const d = fx('synthetic-assessor-sfr.json'); d.features[0].attributes.SQFTmain1 = n; return json(d); } });
  for (const [sqft, floors] of [[1400, 1], [2200, 2], [4200, 3], [5600, 4], [700, 1]]) {
    const p = (await run({ over: withSqft(sqft) })).profile;
    assert.equal(p.floors, floors, `${sqft} sq ft`); assert.equal(p.fields.floors.tag, 'estimated'); assert.ok(p.fields.floors.confidence <= 0.3);
  }
  const clean = (await run({ over: withSqft(2800) })).profile, ambiguous = (await run({ over: withSqft(2200) })).profile;
  assert.ok(clean.fields.floors.confidence > ambiguous.fields.floors.confidence);
  const huge = (await run({ over: withSqft(9000) })).profile;
  assert.equal(huge.floors, null); assert.match(huge.fields.floors.note, /too high/); assert.ok(huge.warnings.some((w) => /4\.5x/.test(w)));
  const noBuilding = (await run({ over: { lariac: () => json({ features: [] }) } })).profile;
  assert.equal(noBuilding.floors, null); assert.match(noBuilding.fields.floors.note, /no main building footprint/);
  assert.equal(noBuilding.roof_sqft, null); assert.equal(noBuilding.fields.roof_sqft.tag, 'unavailable');
  assert.match(noBuilding.fields.front_yard_sqft.note, /no building footprint/);
  const noLiving = (await run({ over: { parcel: () => json(fx('synthetic-assessor-vacant.json')) } })).profile;
  assert.equal(noLiving.floors, null); assert.match(noLiving.fields.floors.note, /no living area/);
});

test('yard: unavailable without a splitter, on {ok:false} and on a throw; warnings and confidence cap carry through', async () => {
  const none = (await run({ splitYard: null })).profile;
  for (const k of ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft']) { assert.equal(none[k], null); assert.match(none.fields[k].note, /not provided/); assert.equal(none.fields[k].confidence, 0); }
  const notOk = (await run({ splitYard: () => ({ ok: false, reason: 'parcel too irregular' }) })).profile;
  assert.match(notOk.fields.back_yard_sqft.note, /parcel too irregular/);
  const thrower = (await run({ splitYard: () => { throw new Error('boom'); } })).profile;
  assert.match(thrower.fields.side_yard_sqft.note, /boom/);
  const warned = (await run({ splitYard: yardOk({ warnings: ['building touches the front lot line'], confidence: 0.2 }) })).profile;
  assert.ok(warned.warnings.includes('yard: building touches the front lot line')); assert.equal(warned.fields.front_yard_sqft.confidence, 0.2);
  assert.match(warned.fields.front_yard_sqft.note, /touches the front lot line/);
  const label = (await run({ splitYard: yardOk({ confidence: 'high' }) })).profile;
  assert.equal(label.fields.front_yard_sqft.confidence, 0.4);
});

test('provider failures never throw: assessor and footprint down -> unavailable fields with reasons', async () => {
  const { profile: p } = await run({ over: { parcel: () => json({}, 500), lariac: () => json({}, 500) } });
  assert.equal(p.apn, null); assert.equal(p.fields.apn.tag, 'unavailable'); assert.match(p.fields.apn.note, /la-assessor/);
  for (const k of PROFILE_FIELDS) { assert.ok(p.fields[k].source); assert.equal(typeof p.fields[k].confidence, 'number'); }
  assert.equal(p.providers.find((x) => x.id === 'la-assessor').status, 'failed');
  assert.ok(p.warnings.some((w) => w.startsWith('la-assessor:')));
  assert.ok(Math.abs(p.lat - 34) < 1e-3, 'geocoder point still present');
  const empty = await buildPropertyProfile({ address: '' }, { registry: await createDefaultRegistry(), fetch: world(), now: NOW });
  assert.ok(empty.warnings.includes('empty address'));
  for (const k of PROFILE_FIELDS) assert.equal(empty.fields[k].tag, 'unavailable', k);
});

test('swapping the primary: a fake vendor registered with one call becomes the primary source', async () => {
  const reg = await createDefaultRegistry();
  const vendor = { id: 'fake-vendor', label: 'Fake Vendor', kind: 'records', needsKey: true, role: 'primary', priority: 1, coverage: { national: true }, retentionDays: 90, licenseNote: 'test',
    async lookup(q, deps) { const mk = (v, u) => ({ value: v, tag: 'measured', source: 'Fake Vendor', retrievedAt: deps.now, confidence: 0.9, ...(u ? { unit: u } : {}) }); return { ok: true, fields: { house_sqft: mk(2810, 'sqft') } }; } };
  reg.register(vendor);
  const { profile: p } = await run({ registry: reg, keys: { 'fake-vendor': 'k-1234' } });
  assert.equal(p.house_sqft, 2810); assert.equal(p.fields.house_sqft.source, 'Fake Vendor'); assert.equal(p.fields.house_sqft.cross_check.agreement, 'match');
  assert.equal(p.beds, 3, 'fields the vendor lacks come from the assessor');
  assert.equal(p.providers.find((x) => x.id === 'fake-vendor').status, 'used');
});

test('deterministic, and inputs are not mutated', async () => {
  const query = deepFreeze({ address: SFR }), keys = deepFreeze({ rentcast: 'rc-key-123456' });
  const reg = await createDefaultRegistry();
  const go = () => buildPropertyProfile(query, { registry: reg, fetch: world(), now: NOW, keys, splitYard: yardOk() });
  assert.deepEqual(await go(), await go());
  await assert.rejects(buildPropertyProfile(query, { registry: reg, fetch: world(), now: undefined }), /now/);
});

test('toSourcedProfile feeds the existing profile model and estimator helpers', async () => {
  const { profile: pj } = await run();
  const sp = toSourcedProfile(pj);
  assert.equal(getAttribute(sp, 'living_area_sqft').value, 2800); assert.equal(getAttribute(sp, 'bedrooms').value, 3);
  assert.equal(getAttribute(sp, 'lot_area_sqft').unit, 'sqft'); assert.equal(getAttribute(sp, 'parcel_id').value, '9999999999');
  assert.equal(getAttribute(sp, 'yard_area_sqft').value, 4800); assert.equal(getAttribute(sp, 'yard_area_sqft').tag, 'estimated');
  assert.equal(getAttribute(sp, 'building_footprint_sqft').value, 1400); assert.equal(getAttribute(sp, 'parcel_boundary').value.type, 'Polygon');
  assert.deepEqual(Object.keys(getAttribute(sp, 'location').value), ['lat', 'lng']);
  assert.equal(getAttribute(sp, 'jurisdiction').value.countyFips, '06037');
  assert.equal(getAttribute(sp, 'place_id').tag, 'unavailable'); assert.equal(getAttribute(sp, 'living_area_sqft').source, pj.fields.house_sqft.source);
  assert.ok(summarize(sp).length > 15);
  assert.ok(missingEvidence(sp) !== undefined); assert.ok(defaultResourceCapacity(sp) !== undefined);
  const vacant = toSourcedProfile((await run({ over: { parcel: () => json(fx('synthetic-assessor-vacant.json')) } })).profile);
  assert.equal(getAttribute(vacant, 'living_area_sqft').tag, 'unavailable');
});

test('distanceToPolygonM: zero inside, metres outside', () => {
  const sq = { type: 'Polygon', coordinates: [[[-118.3, 34], [-118.2999, 34], [-118.2999, 34.0001], [-118.3, 34.0001], [-118.3, 34]]] };
  assert.equal(distanceToPolygonM({ lat: 34.00005, lng: -118.29995 }, sq), 0);
  const d = distanceToPolygonM({ lat: 33.9999, lng: -118.29995 }, sq);
  assert.ok(d > 10 && d < 12, String(d));
});

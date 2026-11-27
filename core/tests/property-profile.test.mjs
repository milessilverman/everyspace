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
  // roof now follows City Pretty's roof-area method: 1,400 sq ft outline, built 1952 -> typical 4.5:12 pitch -> 1400 x 1.068 x 1.05 = 1570 (was the plan area, 1400)
  assert.equal(p.roof_sqft, 1570); assert.equal(p.fields.roof_sqft.tag, 'estimated'); assert.match(p.fields.roof_sqft.method, /slope factor 1\.068 \(pitch 4\.5:12/); assert.ok(p.fields.roof_sqft.confidence <= 0.3); assert.match(p.fields.roof_sqft.note, /typical value/); assert.equal(p.details.roof.pitchRise, 4.5);
  assert.deepEqual([p.front_yard_sqft, p.back_yard_sqft, p.side_yard_sqft], [1200, 2600, 1000]);
  assert.equal(p.fields.front_yard_sqft.tag, 'estimated'); assert.ok(p.fields.front_yard_sqft.confidence <= 0.4);
  assert.equal(p.place_id, null); assert.equal(p.fields.place_id.tag, 'unavailable'); assert.match(p.fields.place_id.note, /Places/);
  const st = Object.fromEntries(p.providers.map((x) => [x.id, x.status]));
  assert.deepEqual(st, { rentcast: 'skipped', 'google-solar': 'skipped', 'la-cams-address': 'used', 'census-address': 'used', 'la-assessor': 'used', 'lariac-buildings': 'used', 'overture-roads': 'failed', 'naip-aerial': 'failed' }); // AERIAL: the mocked world serves no road tiles or photos, so both fail silently
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

test('browser registry end to end: new rows have sources; yard rows have values with a street-side point and the stated reason without one', async () => {
  const { createBrowserRegistry, browserSplitYard, YARD_NEEDS_STREET } = await import('../providers/browser.js');
  const { splitYard } = await import('../yard.js');
  const fetch = world({ census: () => { throw new Error('census must not be called from a browser'); }, rentcast: () => { throw new Error('no key: RentCast must not be called'); }, solar: () => { throw new Error('no key'); } });
  const ok = await buildPropertyProfile(SFR, { registry: createBrowserRegistry(), fetch, now: NOW, keys: {}, splitYard: browserSplitYard(splitYard) });
  // AERIAL: the browser registry now also asks the Overture road tiles and the NAIP photo (unanswered in this mocked world)
  assert.ok(fetch.calls.every((c) => ['public.gis.lacounty.gov', 'stac.overturemaps.org', 'planetarycomputer.microsoft.com'].includes(new URL(c.url).hostname)));
  for (const k of ['floors', 'baths', 'roof_sqft', 'front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft']) {
    const f = ok.fields[k];
    assert.ok(f.value !== null && f.source && f.retrieved_at, k);
  }
  assert.equal(ok.fields.roof_sqft.tag, 'estimated'); assert.equal(ok.fields.floors.tag, 'estimated');
  assert.equal(ok.fields.front_yard_sqft.tag, 'estimated');
  assert.ok(Math.abs(ok.fields.front_yard_sqft.value + ok.fields.back_yard_sqft.value + ok.fields.side_yard_sqft.value - ok.details.yard.openSqft) <= 2);
  // the locator's point inside the lot: no front is guessed
  const inside = JSON.parse(JSON.stringify(fx('synthetic-cams-sfr.json')));
  inside.candidates[0].location = { x: -118.29992, y: 34.00018 };
  const none = await buildPropertyProfile(SFR, { registry: createBrowserRegistry(), fetch: world({ cams: () => json(inside) }), now: NOW, keys: {}, splitYard: browserSplitYard(splitYard) });
  for (const k of ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft']) {
    assert.equal(none.fields[k].tag, 'unavailable', k);
    assert.ok(none.fields[k].note.includes(YARD_NEEDS_STREET), none.fields[k].note);
  }
  assert.ok(none.fields.roof_sqft.value > 0, 'everything else still answers');
});

test('roof: owner pitch raises confidence and changes the area; Google Solar stays preferred; details.roof carries the intermediate numbers', async () => {
  const dflt = (await run()).profile, own = (await run({ query: { address: SFR, roofPitchRise: 6 } })).profile;
  assert.equal(own.roof_sqft, 1643); assert.ok(own.fields.roof_sqft.confidence > dflt.fields.roof_sqft.confidence); assert.match(own.fields.roof_sqft.method, /owner-supplied pitch/);
  assert.deepEqual([dflt.details.roof.slopeFactor, dflt.details.roof.pitchSource.startsWith('typical pitch')], [1.068, true]);
  const solar = (await run({ keys: { 'google-solar': 'AIza-SECRET-1234' } })).profile;
  assert.equal(solar.fields.roof_sqft.tag, 'measured'); assert.equal(solar.details.roof, undefined);
});

test('transit: not looked up by default; ctx.osm summarises stops; ctx.transit asks Overpass once; a failure is unavailable with the reason', async () => {
  const off = (await run()).profile;
  for (const k of ['transit_distance_m', 'transit_stops_nearby', 'rail_station_nearby']) { assert.equal(off.fields[k].tag, 'unavailable'); assert.match(off.fields[k].note, /not looked up/); }
  const { profile: base } = await run();
  const P = { lat: base.lat, lng: base.lng };
  const els = [{ type: 'node', id: 1, lat: P.lat + 0.0018, lon: P.lng, tags: { highway: 'bus_stop', name: 'Example & 1st' } }, { type: 'node', id: 2, lat: P.lat + 0.005, lon: P.lng, tags: { railway: 'station', station: 'light_rail', name: 'Example Station' } }];
  const withOsm = await buildPropertyProfile({ address: SFR }, { registry: await createDefaultRegistry(), fetch: world(), now: NOW, osm: { ok: true, elements: els, source: { name: 'OpenStreetMap via Overpass API', publisher: 'OpenStreetMap contributors', url: 'https://overpass.example', license: 'ODbL 1.0' }, retrievedAt: NOW } });
  assert.ok(withOsm.transit_distance_m > 100 && withOsm.transit_distance_m < 400);
  assert.deepEqual([withOsm.fields.transit_stops_nearby.value, withOsm.fields.rail_station_nearby.value], [2, true]);
  assert.equal(withOsm.fields.transit_distance_m.tag, 'estimated'); assert.match(withOsm.fields.transit_distance_m.source, /OpenStreetMap/); assert.equal(withOsm.fields.transit_distance_m.confidence, 0.5);
  // live path with an injected fetch: exactly one Overpass call
  const w = world(); const calls = [];
  const f = async (u, init) => { if (String(u).includes('overpass')) { calls.push(String(u)); return json({ elements: els }); } return w(u, init); };
  const live = await buildPropertyProfile({ address: SFR }, { registry: await createDefaultRegistry(), fetch: f, now: NOW, transit: true });
  assert.equal(calls.length, 1); assert.equal(live.fields.transit_stops_nearby.value, 2); assert.equal(live.providers.find((x) => x.id === 'overpass-transit').status, 'used');
  const bad = async (u, init) => (String(u).includes('overpass') ? json({}, 502) : w(u, init));
  const down = await buildPropertyProfile({ address: SFR }, { registry: await createDefaultRegistry(), fetch: bad, now: NOW, transit: true });
  assert.equal(down.fields.transit_distance_m.tag, 'unavailable'); assert.match(down.fields.transit_distance_m.note, /transit lookup failed.*502/); assert.equal(down.providers.find((x) => x.id === 'overpass-transit').status, 'failed');
  const sp = toSourcedProfile(withOsm);
  assert.equal(getAttribute(sp, 'transit_distance_m').value, withOsm.transit_distance_m);
});

test('floors: building:levels from a footprint provider wins over the ratio', async () => {
  const reg = await createDefaultRegistry();
  const orig = reg.providersFor.bind(reg);
  reg.providersFor = (kind, o) => { const r = orig(kind, o); if (kind !== 'footprint') return r; return { ...r, providers: r.providers.map((p) => ({ ...p, lookup: async (a, d) => { const x = await p.lookup(a, d); return x.ok ? { ...x, buildings: x.buildings.map((b) => ({ ...b, levels: 3 })) } : x; } })) }; };
  const p = (await run({ registry: reg })).profile;
  assert.equal(p.floors, 3); assert.match(p.fields.floors.source, /building:levels/);
});

// ======================================================================================================================================
// Any US address: jurisdiction from the point, parallel providers, progressive results, attribution, floors from the footprint, non-LA path
// ======================================================================================================================================
const { sourced, unavailable } = await import('../provenance.js');
const { overtureServer, OVERTURE_REAL, CATALOG_URL, FILE_URL } = await import('./fixtures/providers/overture-mock.mjs');
const { clearOvertureCache } = await import('../providers/overture-buildings.js');
const { polygonAreaSqft, pointInPolygon } = await import('../geometry.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const box = (lat, lng, wM, hM) => {
  const dLng = wM / 2 / (111320 * Math.cos((lat * Math.PI) / 180)), dLat = hM / 2 / 110540;
  return { type: 'Polygon', coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]] };
};
const RECORD_FIELD_KEYS = ['apn', 'lot_sqft', 'house_sqft', 'floors', 'beds', 'baths', 'year_built', 'property_type', 'use_code', 'units'];
const recFields = (have = {}) => Object.fromEntries(RECORD_FIELD_KEYS.map((k) => [k, k in have ? sourced(have[k], { tag: 'measured', source: 'Fake county', confidence: 0.8, retrievedAt: NOW, ...(k === 'lot_sqft' ? { unit: 'sqft' } : {}) }) : unavailable('fake: not mapped', 'Fake county')]));
const base = { needsKey: false, coverage: { national: true }, retentionDays: null, licenseNote: 'test' };
const PT = { lat: 41.88388, lng: -87.63227 }; // Chicago City Hall
const LOT = box(PT.lat, PT.lng, 90, 70);
const BLD = box(PT.lat, PT.lng, 40, 30);
const fakeRecords = (over = {}) => ({ ...base, id: 'fake-records', label: 'Fake records', kind: 'records', delay: 0, ...over,
  async lookup(q, d) { over.seen?.push(q); await sleep(over.delay ?? 0); return { ok: true, fields: recFields({ apn: '1-2-3', lot_sqft: 6300 }), parcel: { boundary: LOT, apn: '1-2-3', address: null, assessorAreaSqft: null, matchedBy: 'containing-point', method: 'fake', confidence: 0.9 }, ...(over.attribution ? { attribution: over.attribution } : {}) }; } });
const fakeFootprint = (over = {}) => ({ ...base, id: 'fake-footprint', label: 'Fake footprints', kind: 'footprint', ...over,
  async lookup(q, d) { over.seen?.push(q); await sleep(over.delay ?? 0); return { ok: true, buildings: [{ polygon: BLD, areaSqft: 1300, kind: 'house', ...(over.building ?? {}) }], source: over.source ?? 'Fake outlines', ...(over.attribution ? { attribution: over.attribution } : {}), ...(over.extra ?? {}) }; } });
const fakeStreet = (over = {}) => ({ ...base, id: 'fake-street', label: 'Fake streets', kind: 'street', ...over, async lookup() { await sleep(over.delay ?? 0); return { ok: true, streets: [] }; } });
const reg = (...ps) => ps.reduce((r, p) => r.register(p), createRegistry());
const NOFETCH = async (u) => { throw new Error(`unexpected fetch ${u}`); };
const IL = { state: 'IL', countyFips: '17031', county: 'Cook County' };

test('jurisdiction: asked of countyAt from the query point (FCC), handed to the registry; skipped when the caller supplies it; LA providers are not asked in Cook County', async () => {
  const seen = [];
  const la = fakeRecords({ id: 'la-only', coverage: { state: 'CA', countyFips: '06037' } });
  const il = fakeRecords({ id: 'il-only', coverage: { state: 'IL' } });
  const registry = reg(la, il, fakeFootprint());
  const spy = { ...registry, providersFor: (k, o) => { seen.push([k, o.jurisdiction]); return registry.providersFor(k, o); } };
  const calls = [];
  const fetch = async (u) => { calls.push(String(u)); if (String(u).includes('geo.fcc.gov')) return json(fx('fcc-county-chicago-city-hall.json')); throw new Error(`unexpected ${u}`); };
  const p = await buildPropertyProfile({ address: '121 N LaSalle St, Chicago, IL 60602', ...PT }, { registry: spy, fetch, now: NOW });
  assert.equal(calls.length, 1); assert.match(calls[0], /geo\.fcc\.gov.*lat=41\.88388.*lon=-87\.63227/);
  assert.deepEqual(p.details.county, IL);
  assert.deepEqual(seen.find(([k]) => k === 'records')[1], { state: 'IL', countyFips: '17031', county: 'Cook County' });
  assert.deepEqual(p.providers.map((x) => [x.id, x.status]).sort(), [['county-lookup', 'used'], ['fake-footprint', 'used'], ['il-only', 'used']]);
  assert.equal(p.apn, '1-2-3'); assert.equal(p.details.jurisdiction.countyFips, '17031'); assert.equal(p.details.jurisdiction.country, 'US');
  // the caller already knows the county: no county request at all
  calls.length = 0; seen.length = 0;
  const q2 = await buildPropertyProfile({ address: '121 N LaSalle St, Chicago, IL 60602', ...PT }, { registry: spy, fetch, now: NOW, jurisdiction: IL });
  assert.equal(calls.length, 0); assert.deepEqual(seen.find(([k]) => k === 'records')[1], IL);
  assert.equal(q2.providers.some((x) => x.id === 'county-lookup'), false);
  // the query itself may carry it
  const q3 = await buildPropertyProfile({ address: 'x, Chicago, IL', ...PT, jurisdiction: IL }, { registry: spy, fetch, now: NOW });
  assert.equal(calls.length, 0); assert.equal(q3.details.county.countyFips, '17031');
});

test('jurisdiction: a county-level address provider (the LA locator) already says the county, so no county request; a failed lookup falls back to the typed state and never throws', async () => {
  const { profile: p, fetch } = await run();
  assert.equal(fetch.calls.some((c) => c.url.includes('fcc.gov') || c.url.includes('tigerweb')), false);
  assert.deepEqual(p.details.county, { state: 'CA', countyFips: '06037', county: 'Los Angeles County' });
  const calls = [];
  const down = async (u) => { calls.push(String(u)); return json({}, 503); };
  const la = fakeRecords({ id: 'la-only', coverage: { state: 'CA', countyFips: '06037' } });
  const il = fakeRecords({ id: 'il-only', coverage: { state: 'IL' } });
  const q = await buildPropertyProfile({ address: '121 N LaSalle St, Chicago, IL 60602', ...PT }, { registry: reg(la, il, fakeFootprint()), fetch: down, now: NOW });
  assert.equal(q.providers.find((x) => x.id === 'county-lookup').status, 'failed');
  assert.ok(q.providers.some((x) => x.id === 'il-only' && x.status === 'used'), 'the typed state still selects state providers');
  assert.equal(q.providers.some((x) => x.id === 'la-only'), false);
  assert.ok(q.warnings.some((w) => /county could not be determined/.test(w)));
  assert.equal(q.details.county, undefined);
  const noState = await buildPropertyProfile({ address: '121 LaSalle', ...PT }, { registry: reg(la, il, fakeFootprint({ id: 'nat' })), fetch: down, now: NOW });
  assert.deepEqual(noState.providers.filter((x) => x.status === 'used').map((x) => x.id), ['nat'], 'no county and no state: only providers with national coverage');
});

test('parallel: records, footprints and street run together (total ~ the slowest, not the sum); a footprint provider that needs the parcel waits for it', async () => {
  const mk = (extra = {}) => reg(fakeRecords({ delay: 300 }), fakeFootprint({ delay: 300, ...extra }), fakeStreet({ delay: 300 }));
  const ctx = { fetch: NOFETCH, now: NOW, jurisdiction: IL };
  let t = Date.now();
  const par = await buildPropertyProfile({ address: '121 N LaSalle St, Chicago, IL 60602', ...PT }, { ...ctx, registry: mk() });
  const parallel = Date.now() - t;
  assert.ok(parallel >= 290 && parallel < 520, `three 300 ms calls took ${parallel} ms (sum would be 900)`);
  assert.equal(par.apn, '1-2-3'); assert.equal(par.fields.building_footprint_sqft.value, 1300);
  t = Date.now();
  await buildPropertyProfile({ address: '121 N LaSalle St, Chicago, IL 60602', ...PT }, { ...ctx, registry: mk({ needsParcel: true }) });
  const dependent = Date.now() - t;
  assert.ok(dependent >= 580 && dependent < 820, `a parcel-dependent footprint follows the records: ${dependent} ms`);
});

test('parallel: several records providers also run together', async () => {
  const t = Date.now();
  const p = await buildPropertyProfile({ address: 'x, Chicago, IL', ...PT }, { registry: reg(fakeRecords({ id: 'r1', delay: 250 }), fakeRecords({ id: 'r2', delay: 250 }), fakeRecords({ id: 'r3', delay: 250 })), fetch: NOFETCH, now: NOW, jurisdiction: IL });
  assert.ok(Date.now() - t < 450, `${Date.now() - t} ms`);
  assert.deepEqual(p.providers.map((x) => x.id), ['r1', 'r2', 'r3'], 'reported in launch order, not completion order');
});

test('progressive: onPartial gets address -> records/footprints -> final; the last one equals the returned result; the same run without it is identical', async () => {
  const mk = () => reg(fakeRecords({ delay: 120, attribution: 'Parcels: Fake county' }), fakeFootprint({ delay: 240, attribution: 'Outlines: Fake' }));
  const q = { address: '121 N LaSalle St, Chicago, IL 60602', ...PT };
  const got = [];
  const withCb = await buildPropertyProfile(q, { registry: mk(), fetch: NOFETCH, now: NOW, jurisdiction: IL, splitYard: yardOk(), onPartial: (pj, info) => got.push({ stage: info.stage, pj, at: Date.now() }) });
  const stages = got.map((g) => g.stage);
  assert.deepEqual(stages, ['address', 'records', 'footprints', 'final']);
  assert.deepEqual(got.at(-1).pj, withCb); assert.equal(got.at(-1).pj, withCb, 'the very same object');
  // what had arrived at each step
  const [a, r, f] = got;
  assert.equal(a.pj.address, '121 N LaSalle St, Chicago, IL 60602'); assert.equal(a.pj.apn, null); assert.equal(a.pj.building_footprint_sqft, null);
  assert.equal(r.pj.apn, '1-2-3'); assert.equal(r.pj.lot_sqft, 6300); assert.equal(r.pj.building_footprint_sqft, null);
  assert.equal(f.pj.building_footprint_sqft, 1300); assert.ok(f.pj.roof_sqft > 1300); assert.ok(f.pj.front_yard_sqft !== null);
  assert.ok(r.at < f.at, 'records are shown before the slower footprints');
  assert.ok(a.pj.fields.apn.note.length > 0 && !/fail|error/i.test(a.pj.fields.apn.note), 'a field still to come says so plainly');
  const plain = await buildPropertyProfile(q, { registry: mk(), fetch: NOFETCH, now: NOW, jurisdiction: IL, splitYard: yardOk() });
  assert.deepEqual(plain, withCb, 'with and without onPartial the result is identical');
  // a callback that throws, or a provider that throws, never breaks the builder
  const boom = await buildPropertyProfile(q, { registry: reg({ ...fakeRecords(), lookup: async () => { throw new Error('records exploded'); } }, { ...fakeFootprint(), lookup: async () => { throw new Error('footprints exploded'); } }), fetch: NOFETCH, now: NOW, jurisdiction: IL, onPartial: () => { throw new Error('page bug'); } });
  assert.deepEqual(boom.providers.map((x) => [x.id, x.status]), [['fake-records', 'failed'], ['fake-footprint', 'failed']]);
  assert.equal(boom.apn, null); assert.ok(boom.warnings.some((w) => /records exploded/.test(w)));
});

test('attribution: strings from the providers that supplied data are carried and de-duplicated', async () => {
  const q = { address: 'x, Chicago, IL', ...PT };
  const p = await buildPropertyProfile(q, { registry: reg(fakeRecords({ attribution: 'Drafted buildings: Overture Maps Foundation (ODbL)' }), fakeFootprint({ attribution: 'Drafted buildings: Overture Maps Foundation (ODbL)' }), fakeFootprint({ id: 'second', attribution: 'Second source' })), fetch: NOFETCH, now: NOW, jurisdiction: IL });
  assert.deepEqual(p.attributions, ['Drafted buildings: Overture Maps Foundation (ODbL)']);
  const none = await buildPropertyProfile(q, { registry: reg(fakeRecords(), fakeFootprint()), fetch: NOFETCH, now: NOW, jurisdiction: IL });
  assert.deepEqual(none.attributions, []);
  const la = (await run()).profile;
  assert.deepEqual(la.attributions, [], 'the LA county providers carry no attribution string');
});

test('the "outlines date from 2008-2020 imagery" note appears only when LARIAC supplied the outline', async () => {
  const q = { address: 'x, Los Angeles, CA', lat: 34.05, lng: -118.24 };
  const J = { state: 'CA', countyFips: '06037', county: 'Los Angeles County' };
  const note = async (over) => (await buildPropertyProfile(q, { registry: reg(fakeRecords(), fakeFootprint(over)), fetch: NOFETCH, now: NOW, jurisdiction: J })).fields.building_footprint_sqft.note ?? '';
  assert.match(await note({ id: 'lariac-buildings' }), /2008-2020/);
  assert.doesNotMatch(await note({ id: 'lariac-buildings', extra: { fallbackFrom: 'lariac-buildings' } }), /2008-2020/, 'LARIAC found nothing and Overture answered inside the wrapper');
  assert.doesNotMatch(await note({ id: 'overture-buildings' }), /2008-2020/);
  const real = (await run()).profile.fields.building_footprint_sqft.note;
  assert.match(real, /2008-2020/, 'the LA flow still says it');
});

test('floors: records first, then the footprint provider\'s floor count, then its height (not LARIAC\'s), then living area / footprint', async () => {
  const q = { address: 'x, Chicago, IL', ...PT };
  const go = (rec, fp) => buildPropertyProfile(q, { registry: reg(fakeRecords(rec), fakeFootprint(fp)), fetch: NOFETCH, now: NOW, jurisdiction: IL });
  const h = await go({}, { building: { heightFt: 30 } });
  assert.equal(h.floors, 3); assert.equal(h.fields.floors.tag, 'estimated'); assert.match(h.fields.floors.method, /height 30 ft/); assert.match(h.fields.floors.note, /Height from Fake outlines/);
  const n = await go({}, { building: { heightFt: 30, floors: 4 } });
  assert.equal(n.floors, 4); assert.equal(n.fields.floors.source, 'Fake outlines floor count'); assert.ok(n.fields.floors.confidence <= 0.5);
  const lariac = await go({}, { id: 'lariac-buildings', building: { heightFt: 30 } });
  assert.equal(lariac.fields.floors.tag, 'unavailable', 'LARIAC height (unit unverified) is only a note, never a floor count');
  const recFloors = await buildPropertyProfile(q, { registry: reg({ ...fakeRecords(), async lookup() { return { ok: true, fields: recFields({ apn: '9', lot_sqft: 6000, floors: 2 }), parcel: { boundary: LOT, apn: '9', matchedBy: 'x', method: 'x', confidence: 0.9 } }; } }, fakeFootprint({ building: { heightFt: 60, floors: 5 } })), fetch: NOFETCH, now: NOW, jurisdiction: IL });
  assert.equal(recFloors.floors, 2, 'the records provider wins');
  const ratio = await buildPropertyProfile(q, { registry: reg({ ...fakeRecords(), async lookup() { return { ok: true, fields: recFields({ apn: '9', lot_sqft: 6000, house_sqft: 2600 }), parcel: { boundary: LOT, apn: '9', matchedBy: 'x', method: 'x', confidence: 0.9 } }; } }, fakeFootprint()), fetch: NOFETCH, now: NOW, jurisdiction: IL });
  assert.equal(ratio.floors, 2, 'living area / footprint when nothing else');
});

test('roof, yard: derived from a point-only footprint with the state of the county; yard uses the best street reference and stays empty with none', async () => {
  const seen = [];
  const q = { address: '121 N LaSalle St, Chicago, IL 60602', ...PT };
  const fp = fakeFootprint({ seen });
  const p = await buildPropertyProfile(q, { registry: reg(fakeRecords(), fp), fetch: NOFETCH, now: NOW, jurisdiction: IL, splitYard: yardOk() });
  assert.equal(seen[0].parcel, undefined, 'an Overture-style provider is asked from the point, before the parcel is known');
  assert.ok(p.roof_sqft > 1300); assert.match(p.fields.roof_sqft.method, /pitch/);
  assert.equal(p.front_yard_sqft, 1200);
  const { browserSplitYard } = await import('../providers/browser.js');
  const none = await buildPropertyProfile(q, { registry: reg(fakeRecords(), fakeFootprint()), fetch: NOFETCH, now: NOW, jurisdiction: IL, splitYard: browserSplitYard(yardOk()) });
  assert.equal(none.fields.front_yard_sqft.tag, 'unavailable'); assert.equal(none.front_yard_sqft, null);
  assert.ok(none.roof_sqft > 0 && none.building_footprint_sqft === 1300, 'everything else still answers');
});

test('a point-only footprint search keeps the building the address is on, and with a parcel the buildings on it', async () => {
  const neighbour = box(PT.lat + 0.0004, PT.lng, 30, 20);
  const two = { extra: {}, source: 'Fake outlines' };
  const fpTwo = { ...fakeFootprint(), async lookup() { return { ok: true, buildings: [{ polygon: neighbour, areaSqft: 9000, kind: 'house' }, { polygon: BLD, areaSqft: 1300, kind: 'house' }], source: 'Fake outlines' }; } };
  const q = { address: 'x, Chicago, IL', ...PT };
  const noParcel = await buildPropertyProfile(q, { registry: reg(fpTwo), fetch: NOFETCH, now: NOW, jurisdiction: IL });
  assert.equal(noParcel.building_footprint_sqft, 1300, 'not the larger neighbour');
  assert.equal(noParcel.details.buildings.length, 1); assert.match(noParcel.fields.building_footprint_sqft.note, /not confirmed to be on this lot/);
  const withParcel = await buildPropertyProfile(q, { registry: reg(fakeRecords(), fpTwo), fetch: NOFETCH, now: NOW, jurisdiction: IL });
  assert.equal(withParcel.building_footprint_sqft, 1300); assert.equal(withParcel.details.buildings.length, 1);
  assert.doesNotMatch(withParcel.fields.building_footprint_sqft.note ?? '', /not confirmed/);
  void two;
});

// ---- the nationwide path on the real browser registry: Chicago City Hall (public building), every host mocked ----------------------------------
/** A fetch for Chicago: FCC county, Overture (recorded), and a Cook County parcel service that answers only for points inside LOT. */
function chicagoWorld({ parcel = 'answer', parcelDelay = 0 } = {}) {
  const ov = overtureServer('chicago');
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, range: init.headers?.Range ?? null, at: Date.now() });
    const h = new URL(u).hostname;
    if (h === 'geo.fcc.gov') return json(fx('fcc-county-chicago-city-hall.json'));
    const o = ov.answer(u, init.headers?.Range ?? null);
    if (o) return new Response(o.body, { status: o.status, headers: { 'content-type': o.type } });
    if (h === 'gis.cookcountyil.gov') {
      if (parcel === 'never') return new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
      if (parcelDelay) await sleep(parcelDelay);
      const [x, y] = decodeURIComponent(new URL(u).searchParams.get('geometry')).split(',').map(Number);
      const inside = pointInPolygon({ lat: y, lng: x }, LOT);
      return json({ geometryType: 'esriGeometryPolygon', features: inside ? [{ attributes: { PIN14: '17-09-999-001' }, geometry: { rings: LOT.coordinates.map((r) => [...r].reverse()) } }] : [] });
    }
    throw new Error(`unmocked host ${h}`);
  };
  f.calls = calls; f.overture = ov;
  return f;
}
const chicagoQuery = { address: '121 N LaSalle St, Chicago, IL 60602', ...OVERTURE_REAL.chicago.point };
const nationwide = async (fetch, query = chicagoQuery, extra = {}) => {
  clearOvertureCache();
  const { createBrowserRegistry, browserSplitYard } = await import('../providers/browser.js');
  const { splitYard } = await import('../yard.js');
  return buildPropertyProfile(query, { registry: createBrowserRegistry({ tryUnverifiedParcelServices: true }), fetch, now: NOW, splitYard: browserSplitYard(splitYard), timeoutMs: 1500, ...extra });
};

test('non-LA (Chicago City Hall, mocked): county from FCC, footprint from Overture, roof and floors derived, lot from the county parcel service; no LA providers; Overture attribution', async () => {
  const f = chicagoWorld();
  const p = await nationwide(f, { ...chicagoQuery, pointPrecision: 'rooftop' });
  assert.deepEqual(p.details.county, IL);
  const st = Object.fromEntries(p.providers.map((x) => [x.id, x.status]));
  assert.equal(st['county-lookup'], 'used'); assert.equal(st['overture-buildings'], 'used'); assert.equal(st['parcel-registry'], 'used');
  assert.equal(st['la-assessor'], undefined); assert.equal(st['lariac-buildings'], undefined);
  assert.ok(p.building_footprint_sqft > 10000, `City Hall footprint ${p.building_footprint_sqft}`);
  assert.equal(p.fields.building_footprint_sqft.source, 'Overture Maps buildings (Overture Maps Foundation, ODbL)');
  assert.doesNotMatch(p.fields.building_footprint_sqft.note ?? '', /2008-2020/);
  assert.ok(p.roof_sqft > p.building_footprint_sqft * 0.9);
  assert.ok(p.floors >= 1, `floors ${p.floors}`); assert.match(p.fields.floors.source + p.fields.floors.method, /Overture|height/);
  assert.equal(p.apn, '17-09-999-001'); assert.equal(p.lot_sqft, Math.round(polygonAreaSqft(LOT)));
  assert.ok(p.attributions.includes('Drafted buildings: Overture Maps Foundation (ODbL)'));
  assert.equal(p.fields.front_yard_sqft.tag, 'unavailable', 'no street reference outside LA: a front is never guessed');
  assert.ok(f.calls.every((c) => ['geo.fcc.gov', 'stac.overturemaps.org', 'overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com', 'gis.cookcountyil.gov', 'planetarycomputer.microsoft.com'].includes(new URL(c.url).hostname))); // AERIAL: + the NAIP photo host
  assert.ok(f.calls.filter((c) => c.range).every((c) => /^bytes=\d+-\d+$/.test(c.range)), 'Overture is read by range requests only');
});

test('non-LA: a rooftop point asks the parcel service at once (in parallel with Overture); otherwise the building centroid nearest the point is used', async () => {
  const roof = chicagoWorld({ parcelDelay: 200 });
  await nationwide(roof, { ...chicagoQuery, pointPrecision: 'rooftop' });
  const fcc = roof.calls.find((c) => c.url.includes('fcc.gov')), firstParcel = roof.calls.find((c) => c.url.includes('cookcountyil')), firstTile = roof.calls.find((c) => c.url.includes('amazonaws'));
  assert.ok(firstParcel.at - fcc.at < 150 && Math.abs(firstParcel.at - firstTile.at) < 150, 'the parcel request starts with the Overture requests, not after them');
  // a street-side geocode (outside the lot): the registry gets the centroid of the nearest building, which is inside the lot
  const street = chicagoWorld();
  const streetPoint = { lat: PT.lat - 0.0004, lng: PT.lng }; // about 45 m south: outside the 70 m deep lot, within 60 m of City Hall
  const p = await nationwide(street, { address: chicagoQuery.address, ...streetPoint });
  const parcelCalls = street.calls.filter((c) => c.url.includes('cookcountyil'));
  assert.equal(parcelCalls.length, 1, 'asked once, after the footprints');
  const [x, y] = decodeURIComponent(new URL(parcelCalls[0].url).searchParams.get('geometry')).split(',').map(Number);
  assert.ok(pointInPolygon({ lat: y, lng: x }, LOT), 'the point sent is the building centroid, inside the parcel');
  assert.ok(Math.abs(y - streetPoint.lat) > 0.0003, 'and it is not the geocoded point');
  assert.equal(p.apn, '17-09-999-001');
  const lastTile = Math.max(...street.calls.filter((c) => c.url.includes('amazonaws')).map((c) => c.at));
  assert.ok(parcelCalls[0].at >= lastTile - 5, 'the parcel request followed the footprints');
});

test('non-LA: a rooftop point that falls outside every parcel is retried once from the building centroid', async () => {
  const f = chicagoWorld();
  const off = { ...chicagoQuery, lat: PT.lat - 0.0004, pointPrecision: 'rooftop' };
  const p = await nationwide(f, off);
  assert.equal(f.calls.filter((c) => c.url.includes('cookcountyil')).length, 2);
  assert.equal(p.apn, '17-09-999-001');
});

test('non-LA: a parcel service that never answers costs nothing visible: footprint, roof and floors are filled, lot size stays empty, no failure text, no throw', async () => {
  const f = chicagoWorld({ parcel: 'never' });
  const t = Date.now();
  const got = [];
  const p = await nationwide(f, { ...chicagoQuery, pointPrecision: 'rooftop' }, { onPartial: (pj, i) => got.push([i.stage, Date.now() - t, pj.building_footprint_sqft, pj.lot_sqft]) });
  assert.ok(p.building_footprint_sqft > 10000 && p.roof_sqft > 0); assert.equal(p.lot_sqft, null); assert.equal(p.apn, null);
  assert.equal(p.providers.find((x) => x.id === 'parcel-registry').status, 'failed');
  const fpStage = got.find(([s]) => s === 'footprints');
  assert.ok(fpStage[2] > 10000 && fpStage[1] < 1400, `the footprint group arrived at ${fpStage[1]} ms, before the 1.5 s parcel timeout`);
  const shown = JSON.stringify(Object.values(p.fields).map((x) => x.value));
  assert.doesNotMatch(shown, /fail|error|unavailable|not found/i);
});

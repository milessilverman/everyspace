// Condos and apartment buildings (docs/condos-and-buildings.md): units in addresses, what is owned, several records at one address, the condo and
// building profiles, earning options, quantities. SYNTHETIC fixtures only (invented addresses; each has a `_fixture_note`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAddress, stripUnit, normalizeUnit, unitsMatch, compareUnits, cleanUnit, classifyPropertyType, condoBasis } from '../parcel.js';
import { laAssessor, classifyRecord } from '../providers/la-assessor.js';
import { buildPropertyProfile, toSourcedProfile, SHARED_WHY } from '../property-profile.js';
import { createDefaultRegistry } from '../providers/registry.js';
import { applyOwnerCorrection, getAttribute } from '../profile.js';
import { identifyOpportunities, missingEvidence, defaultResourceCapacity, CONDO_OWNER_KEYS, BUILDING_OWNER_KEYS, OWNER_ATTRIBUTE_KEYS } from '../opportunities.js';
import { estimateRoof } from '../roof.js';
import { checkFeasibility, HOA_NO_SUMMARY, HOA_CHECK_REQUIREMENT } from '../regulatory.js';
import { defaultInputs, withOverrides, estimateOpportunity, summarize } from '../revenue.js';
import { optimize } from '../optimizer.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/providers/${n}`, import.meta.url), 'utf8'));
const NOW = '2026-11-27T12:00:00Z';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

// ============================================================================================================================================
// 1. unit in the address
// ============================================================================================================================================

test('parseAddress: every designator form gives the unit and leaves the street alone', () => {
  const forms = [
    ['123 Main St Apt 4, Los Angeles, CA 90012', '4'], ['123 Main St Apt. 4, Los Angeles, CA 90012', '4'], ['123 Main St Apartment 4', '4'], ['123 Main St #4', '4'], ['123 Main St # 4', '4'],
    ['123 Main St Unit 4B', '4B'], ['123 Main St UNIT 4b', '4B'], ['123 Main St No 18', '18'], ['123 Main St No. 18', '18'], ['123 Main St Number 18', '18'], ['123 Main St Ste 200', '200'], ['123 Main St Suite 200', '200'],
    ['123 Main St - 4', '4'], ['123 Main St, Apt 4, Los Angeles, CA', '4'], ['123 Main St, #4, Los Angeles, CA', '4'], ['123 Main St Apt# 4', '4'], ['123 Main St Apt.4', '4'], ['123 Main St #K-303', 'K-303'],
    ['123 Main St Spc 12', '12'], ['123 Main St Rm 3', '3'], ['123 Main St Unit A', 'A'], ['123 Main St Unit PH1', 'PH1'],
  ];
  for (const [text, unit] of forms) {
    const p = parseAddress(text);
    assert.equal(p.unit, unit, text);
    assert.equal(p.houseNumber, '123', text); assert.equal(p.street, 'MAIN ST', text); assert.equal(p.direction, null, text);
    assert.doesNotMatch(stripUnit(text).address, /apt|unit|ste|suite|no\.?\s|#|number|spc|rm|\s-\s/i, `${text} -> ${stripUnit(text).address}`);
  }
  const full = parseAddress('123 N Spring St Unit 4B, Los Angeles, CA 90012');
  assert.deepEqual(full, { houseNumber: '123', direction: 'N', street: 'SPRING ST', unit: '4B', city: 'Los Angeles', state: 'CA', zip: '90012' });
  assert.equal(stripUnit('123 N Spring St Unit 4B, Los Angeles, CA 90012').address, '123 N Spring St, Los Angeles, CA 90012');
  assert.equal(stripUnit('123 Main St, Apt 4, Los Angeles, CA').address, '123 Main St, Los Angeles, CA');
  assert.deepEqual(parseAddress('123 Main St'), { houseNumber: '123', direction: null, street: 'MAIN ST', unit: null, city: null, state: null, zip: null });
});

test('parseAddress: a street whose name has "Unit" or "No" as a word is not a unit; a trailing ZIP is never a unit', () => {
  for (const [t, street] of [['100 No Name Rd', 'NO NAME RD'], ['123 Unit St', 'UNIT ST'], ['5 Grand No Rd', 'GRAND NO RD'], ['9 Suite Ave', 'SUITE AVE'], ['12 Apt Ln', 'APT LN']]) {
    const p = parseAddress(t);
    assert.equal(p.unit, null, t); assert.equal(p.street, street, t); assert.equal(stripUnit(t).address, t, t);
  }
  assert.equal(parseAddress('5 Unit Dr Apt 3').unit, '3');
  assert.equal(parseAddress('5 Unit Dr Apt 3').street, 'UNIT DR');
  assert.equal(parseAddress('1 N No Street Unit 2').street, 'NO ST'); assert.equal(parseAddress('1 N No Street Unit 2').unit, '2');
  for (const t of ['123 Main St 90012', '123 Main St - 90012', '123 Main St Apt Los Angeles', '123 Main St Unit']) assert.equal(parseAddress(t).unit, null, t);
  assert.equal(parseAddress('123 Main St 90012').zip, '90012');
  assert.equal(parseAddress('123 Main St Apt 4 Los Angeles CA 90012').unit, '4');
  assert.equal(parseAddress('123 Main St Apt 4 Los Angeles CA 90012').zip, '90012');
  assert.equal(parseAddress('123 Main Apt 4').unit, '4'); // no street suffix: the unit still comes after at least one street word
});

test('normalizeUnit / unitsMatch: NO 18 = 18 = #18 = Unit 18; letters and zeros; natural order', () => {
  for (const a of ['NO 18', '18', '#18', 'Unit 18', 'UNIT   18', 'apt 18', 'Apt. #18', '018', ' 18 ']) assert.equal(normalizeUnit(a), '18', a);
  assert.equal(normalizeUnit('UNIT   1F-1'), '1F1'); assert.ok(unitsMatch('1F-1', 'unit 1f1'));
  assert.ok(unitsMatch('4 B', '4b')); assert.ok(unitsMatch('NO 18', '#18')); assert.ok(unitsMatch('Unit A', 'a'));
  assert.ok(!unitsMatch('4B', '4')); assert.ok(!unitsMatch('18', '180')); assert.ok(!unitsMatch('', '')); assert.ok(!unitsMatch(null, '4')); assert.ok(!unitsMatch(' ', ' '));
  assert.equal(normalizeUnit('NO'), 'NO', 'a unit literally named NO stays'); assert.equal(normalizeUnit(null), null);
  assert.equal(cleanUnit('UNIT   1F-1'), '1F-1'); assert.equal(cleanUnit('NO   101'), '101'); assert.equal(cleanUnit('REAR'), 'REAR'); assert.equal(cleanUnit('  '), null);
  assert.deepEqual(['NO 10', 'NO 2', 'A', '1B', '1A', '101', 'REAR'].sort(compareUnits), ['1A', '1B', 'NO 2', 'NO 10', '101', 'A', 'REAR']);
});

// ============================================================================================================================================
// 2. what is owned: classification from the use code (tags as before: estimated)
// ============================================================================================================================================

test('classification from LA use codes: condo code, unit counts, vacant, and the codes whose meaning is NOT known', () => {
  const la = { codeScheme: 'la-assessor', hasSqftField: true };
  const c = (a) => classifyPropertyType({ useType: 'Residential', livingAreaSqft: 1000, units: 1, ...a }, la);
  assert.equal(c({ useCode: '010C', useDescription: 'Single' }), 'condo');
  assert.equal(c({ useCode: '012C', useDescription: 'Single' }), 'condo');
  assert.equal(c({ useCode: '01HC', useDescription: 'Single' }), 'condo');
  assert.equal(c({ useCode: '0100', useDescription: 'Single' }), 'single_family');
  assert.equal(c({ useCode: '0101', useDescription: 'Single' }), 'single_family');
  assert.equal(c({ useCode: '0200', useDescription: 'Two Units', units: 2 }), 'multi_family');
  assert.equal(c({ useCode: '0300', useDescription: 'Three Units (Any Combination)', units: 3 }), 'multi_family');
  assert.equal(c({ useCode: '0400', useDescription: 'Four Units (Any Combination)', units: 4 }), 'multi_family');
  assert.equal(c({ useCode: '0500', useDescription: 'Five or more apartments', units: 20 }), 'multi_family');
  assert.equal(c({ useCode: '0200', useDescription: 'Two Units', units: null }), 'multi_family', 'the use alone says more than one unit; the count is a separate field');
  assert.equal(c({ useCode: '020C', useDescription: 'Two Units', units: 2 }), 'multi_family', 'a C on a two-unit code is not read as a condo (mixed in the data)');
  // E, D and H are NOT read as condo from the code alone (their meaning is not confirmed) ...
  for (const code of ['010E', '010D', '010H', '010G']) assert.equal(c({ useCode: code, useDescription: 'Single' }), 'single_family', code);
  // ... unless the assessor's own legal description names a condominium AND the record has a unit number
  assert.equal(c({ useCode: '010E', useDescription: 'Single', legalDescription: '*TR=99999 LOT 1 CONDOMINIUM*UNIT 5', unit: 'NO 101' }), 'condo');
  assert.equal(c({ useCode: '010E', useDescription: 'Single', legalDescription: '*TR=99999 LOT 1 CONDOMINIUM*UNIT 5', unit: ' ' }), 'single_family');
  assert.equal(c({ useCode: '010E', useDescription: 'Single', legalDescription: 'TR=99999*ENCINO OAKS CO-OP*APT D-9', unit: 'NO D-9' }), 'single_family', 'a co-op is not named a condominium');
  assert.equal(condoBasis({ useCode: '010C' }), 'use code'); assert.equal(condoBasis({ useCode: '0100' }), null);
  // vacant: a V code with no recorded building is land; with a recorded building it is not (869 of 89,184 "010V" records had one when checked)
  assert.equal(classifyPropertyType({ useCode: '010V', useType: 'Residential' }, la), 'land');
  assert.equal(classifyPropertyType({ useCode: '010V', useType: 'Residential', livingAreaSqft: 0 }, la), 'land');
  assert.equal(classifyPropertyType({ useCode: '010V', useType: 'Residential', livingAreaSqft: 1780, units: 1 }, la), 'single_family');
  assert.equal(classifyPropertyType({ useCode: '1100', useType: 'Commercial' }, la), 'commercial');
});

test('the assessor provider tags property_type as estimated and says why; units are the recorded count or unavailable', async () => {
  const run = async (file) => (await laAssessor.lookup({ address: '8800 Fixture Way, Los Angeles, CA' }, { fetch: async () => json(fx(file)), now: NOW })).fields;
  const apt = await run('synthetic-assessor-apartments.json');
  assert.equal(apt.property_type.value, 'multi_family'); assert.equal(apt.property_type.tag, 'estimated'); assert.match(apt.property_type.method, /more than one dwelling unit/);
  assert.equal(apt.units.value, 8); assert.equal(apt.units.tag, 'measured'); assert.match(apt.house_sqft.note, /Building total/);
  assert.equal(apt.complex_unit_count.tag, 'unavailable'); assert.equal(apt.unit_label.tag, 'unavailable');
  const two = await run('synthetic-assessor-apartments-nocount.json');
  assert.equal(two.property_type.value, 'multi_family'); assert.equal(two.units.value, null); assert.equal(two.units.tag, 'unavailable'); assert.match(two.units.note, /no unit count/);
  const three = await run('synthetic-assessor-threeunits.json');
  assert.equal(three.units.value, 2, 'Units1..5 summed (1 + 1 + 0)'); assert.match(three.units.note, /says 3 units but the unit counts add up to 2/);
  assert.equal(classifyRecord(fx('synthetic-assessor-condo-single.json').features[0].attributes).basis, 'use code');
});

// ============================================================================================================================================
// 3. several records at one address (la-assessor provider)
// ============================================================================================================================================

const COMPLEX = 'synthetic-assessor-condo-complex.json';
const lookup = (query, file = COMPLEX) => { const calls = []; const f = async (u) => { calls.push(String(u)); return json(fx(file)); }; return laAssessor.lookup({ address: '7700 Sample Ct, Los Angeles, CA 90098', ...query }, { fetch: f, now: NOW }).then((r) => ({ r, calls })); };

test('condo complex + a typed unit that matches exactly one record -> that unit\'s record (any spelling of the unit)', async () => {
  for (const unit of ['NO 18', '18', '#18', 'Unit 18', 'apt 18']) {
    const { r, calls } = await lookup({ unit });
    assert.equal(r.ok, true, unit); assert.equal(calls.length, 1, 'one county query');
    assert.equal(r.fields.unit_label.value, '18'); assert.equal(r.fields.house_sqft.value, 980); assert.equal(r.fields.beds.value, 1); assert.equal(r.fields.baths.value, 1);
    assert.equal(r.fields.property_type.value, 'condo'); assert.equal(r.fields.year_built.value, 1982);
    assert.equal(r.fields.complex_unit_count.value, 12); assert.equal(r.fields.units.tag, 'unavailable');
    assert.match(r.fields.apn.value, /^99900000/);
  }
  const { r } = await lookup({ unit: '2B' }); assert.equal(r.fields.house_sqft.value, 1180);
  assert.equal((await lookup({ unit: '2' })).r.fields.house_sqft.value, 1150, 'unit 2 is not unit 2B');
});

test('condo complex + no unit (or no match) -> needs_unit with a sorted list, no building data, ONE request', async () => {
  for (const q of [{}, { unit: '99' }, { unit: '   ' }]) {
    const { r, calls } = await lookup(q);
    assert.equal(r.ok, false); assert.equal(r.code, 'needs_unit'); assert.equal(r.needsUnit, true); assert.equal(calls.length, 1);
    assert.deepEqual(r.units.map((u) => u.unit), ['1', '2', '2B', '3', '4', '5', '6', '7', '9', '10', '11', '18']);
    assert.deepEqual(r.units.slice(0, 3).map((u) => u.label), ['Unit 1', 'Unit 2', 'Unit 2B']); assert.equal(r.units.at(-1).label, 'Unit 18');
    assert.deepEqual(r.complex, { address: '7700 SAMPLE CT', unitCount: 12 }, 'the REAR common-area record is not a unit');
    assert.equal(r.fields, undefined);
  }
  assert.match((await lookup({ unit: '99' })).r.reason, /no unit 99/);
});

test('needs_unit lists at most 400 units, sorted naturally, and says the list was cut', async () => {
  const base = fx(COMPLEX); const proto = base.features[0];
  const many = Array.from({ length: 450 }, (_, i) => ({ ...proto, attributes: { ...proto.attributes, AIN: `98${String(i).padStart(8, '0')}`, SitusUnit: `UNIT   ${450 - i}` } }));
  const f = async () => json({ ...base, features: many });
  const r = await laAssessor.lookup({ address: '7700 Sample Ct, Los Angeles, CA 90098' }, { fetch: f, now: NOW });
  assert.equal(r.units.length, 400); assert.equal(r.units[0].unit, '1'); assert.equal(r.units[399].unit, '400'); assert.equal(r.complex.unitCount, 450); assert.equal(r.unitsTruncated, true);
});

test('ownsWholeBuilding on a condo complex: one multi-unit building; sums of the unit records; the shared lot', async () => {
  const { r } = await lookup({ ownsWholeBuilding: true });
  assert.equal(r.ok, true); assert.equal(r.wholeBuilding, true);
  const f = r.fields;
  assert.equal(f.property_type.value, 'multi_family'); assert.equal(f.units.value, 12);
  assert.equal(f.house_sqft.value, 1020 + 1150 + 1310 + 1310 + 980 + 1180 + 1240 + 1240 + 905 + 1005 + 1100 + 1425);
  assert.equal(f.beds.value, 2 + 2 + 3 + 3 + 1 + 2 + 2 + 2 + 1 + 2 + 2 + 3); assert.equal(f.baths.value, 2 + 2 + 2 + 2 + 1 + 2 + 2 + 2 + 1 + 2 + 2 + 3);
  assert.match(f.house_sqft.note, /sum of 12 of the 12 unit records/i); assert.match(f.house_sqft.note, /Building total/);
  assert.equal(f.year_built.value, 1982); assert.equal(f.unit_label.tag, 'unavailable'); assert.equal(f.apn.tag, 'unavailable'); assert.equal(f.complex_unit_count.value, 12);
  assert.ok(Math.abs(f.lot_sqft.value - 25957) < 30, 'the shared lot'); assert.ok(r.parcel.boundary);
  // the whole-building answer wins over a typed unit
  assert.equal((await lookup({ ownsWholeBuilding: true, unit: '18' })).r.fields.units.value, 12);
});

test('records that are not a condo complex (lot split into parcels, units on their own lots) keep the candidates behaviour', async () => {
  const sfr = fx('synthetic-assessor-sfr.json'); const f0 = sfr.features[0];
  const two = { ...sfr, features: [f0, { ...f0, attributes: { ...f0.attributes, AIN: '9999999998', SitusUnit: ' ' } }] };
  const r = await laAssessor.lookup({ address: '4321 Example Ave, Los Angeles, CA 90099', unit: '2' }, { fetch: async () => json(two), now: NOW });
  assert.equal(r.ok, false); assert.equal(r.code, 'multiple_matches'); assert.equal(r.candidates.length, 2); assert.equal(r.needsUnit, undefined);
  const own = await lookup({ address: '7720 Sample Ct, Los Angeles, CA 90098' }, 'synthetic-assessor-own-lots.json');
  assert.equal(own.r.code, 'multiple_matches', '010D units each on their own lot are not read as condos');
  // only one condo record at the address: that unit's record, with the complex size unknown
  const one = await lookup({}, 'synthetic-assessor-condo-single.json');
  assert.equal(one.r.ok, true); assert.equal(one.r.fields.property_type.value, 'condo'); assert.equal(one.r.fields.complex_unit_count.tag, 'unavailable');
});

test('a condo whose use code ends in E is read as a condo only through the legal description; the unit then must be named', async () => {
  const { r } = await lookup({ address: '7710 Sample Ct, Los Angeles, CA 90098' }, 'synthetic-assessor-condo-legal.json');
  assert.equal(r.code, 'needs_unit'); assert.deepEqual(r.units.map((u) => u.unit), ['101', '102', '103']);
  const picked = await lookup({ address: '7710 Sample Ct, Los Angeles, CA 90098', unit: '#102' }, 'synthetic-assessor-condo-legal.json');
  assert.match(picked.r.fields.property_type.method, /legal description/);
});

test('the situs query never carries the unit; parseSitus takes it out first', async () => {
  const { r, calls } = await lookup({ address: '7700 Sample Ct Unit 18, Los Angeles, CA 90098' });
  assert.equal(r.ok, false); // the unit in the address is not the query.unit: the builder passes it as query.unit
  assert.equal(calls.length, 1); assert.doesNotMatch(decodeURIComponent(calls[0]), /UNIT|APT|\b18\b/i);
  assert.match(decodeURIComponent(calls[0]), /SitusHouseNo='7700'/); assert.match(decodeURIComponent(calls[0]), /SitusStreet LIKE 'SAMPLE%'/);
});

// ============================================================================================================================================
// builder: world, helpers
// ============================================================================================================================================

function world(kind = 'condo', over = {}) {
  const files = kind === 'condo' ? { cams: 'synthetic-cams-condo.json', parcel: COMPLEX, lariac: 'synthetic-lariac-condo.json' } : { cams: 'synthetic-cams-apartments.json', parcel: 'synthetic-assessor-apartments.json', lariac: 'synthetic-lariac-apartments.json' };
  const base = { cams: () => json(fx(files.cams)), census: () => json(fx('synthetic-census-sfr.json')), parcel: () => json(fx(files.parcel)), lariac: () => json(fx(files.lariac)), ...over };
  const calls = [];
  const f = async (url, init) => {
    const u = String(url); calls.push(u);
    const key = u.includes('CAMS_Locator') ? 'cams' : u.includes('geocoding.geo.census.gov') ? 'census' : u.includes('LACounty_Parcel') ? 'parcel' : u.includes('LARIAC') ? 'lariac' : null;
    if (!key) throw new Error(`unexpected fetch ${u}`);
    return base[key](u, init);
  };
  f.calls = calls;
  return f;
}
const yardSpy = () => { const fn = (a) => { fn.calls.push(a); return { ok: true, lotSqft: 6500, buildingSqft: 1700, openSqft: 4800, frontYardSqft: 1200, backYardSqft: 2600, sideYardSqft: 1000, frontEdge: 'south', method: 'fake split', confidence: 0.5, warnings: [] }; }; fn.calls = []; return fn; };
async function build(query, { kind = 'condo', over, splitYard = yardSpy() } = {}) {
  const fetch = world(kind, over);
  const profile = await buildPropertyProfile(query, { registry: await createDefaultRegistry(), fetch, now: NOW, splitYard });
  return { profile, fetch, splitYard };
}
const CONDO_ADDR = '7700 Sample Ct, Los Angeles, CA 90098';
const BLDG_ADDR = '8800 Fixture Way, Los Angeles, CA 90097';
const heavy = (c) => /planetarycomputer|imagery\.nationalmap|overturemaps|tiles/i.test(c.url ?? c);

test('builder: several unit records and no unit -> returns early with needsUnit and asks for nothing but the locator and the county record', async () => {
  const { profile: p, fetch, splitYard } = await build({ address: CONDO_ADDR });
  assert.equal(p.ok, false); assert.equal(p.needsUnit, true);
  assert.equal(p.units.length, 12); assert.equal(p.units[0].label, 'Unit 1'); assert.deepEqual(p.complex, { address: '7700 SAMPLE CT', unitCount: 12 });
  assert.equal(fetch.calls.length, 2, fetch.calls.join('\n'));
  assert.match(fetch.calls[0], /CAMS_Locator/); assert.match(fetch.calls[1], /LACounty_Parcel/);
  assert.equal(splitYard.calls.length, 0);
  assert.equal(p.fields, undefined);
  // the caller then re-runs with the unit (a typed unit in the address works too, and the locator never sees it)
  const again = await build({ address: CONDO_ADDR, unit: 'No 18' });
  assert.equal(again.profile.ok !== false, true); assert.equal(again.profile.unit_label, '18');
  const typed = await build({ address: '7700 Sample Ct Apt 18, Los Angeles, CA 90098' });
  assert.equal(typed.profile.unit_label, '18'); assert.equal(typed.profile.living_area_sqft ?? typed.profile.house_sqft, 980);
  for (const c of typed.fetch.calls.filter((u) => /CAMS_Locator|LACounty_Parcel/.test(u))) assert.doesNotMatch(decodeURIComponent(c), /\bapt\b|\bunit\b/i, 'the unit is not sent to the locator or the county query');
  const own = await build({ address: CONDO_ADDR, ownsWholeBuilding: true });
  assert.equal(own.profile.property_type, 'multi_family'); assert.equal(own.profile.units, 12);
});

// ============================================================================================================================================
// 4. condo profile
// ============================================================================================================================================

test('condo profile: the unit\'s own facts; building facts separate; nothing shared presented as the owner\'s; no lot lookups', async () => {
  const { profile: p, fetch, splitYard } = await build({ address: CONDO_ADDR, unit: '#18' });
  assert.equal(p.property_type, 'condo'); assert.equal(p.fields.property_type.tag, 'estimated'); assert.match(p.fields.property_type.method, /use code ends in C/);
  assert.equal(p.ownership.kind, 'unit'); assert.equal(p.ownership.property_type, 'condo'); assert.equal(p.ownership.unit_label, '18'); assert.equal(p.ownership.complex_unit_count, 12); assert.equal(p.ownership.shared_lot, true); assert.equal(p.ownership.source, 'record');
  assert.deepEqual([p.house_sqft, p.beds, p.baths, p.year_built, p.unit_label, p.complex_unit_count], [980, 1, 1, 1982, '18', 12]);
  assert.match(p.apn, /^99900000/);
  // the unit record is the owner's; the lot is the building's
  assert.equal(p.fields.complex_lot_sqft.tag, 'measured'); assert.ok(Math.abs(p.complex_lot_sqft - 25957) < 30); assert.match(p.fields.complex_lot_sqft.note, /Shared by all owners in the building/);
  assert.equal(p.fields.complex_unit_count.tag, 'measured');
  // every shared fact is unavailable with the stated reason
  for (const k of ['lot_sqft', 'front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft', 'usable_yard_sqft', 'usable_front_yard_sqft', 'usable_back_yard_sqft', 'driveway_area_sqft', 'roof_sqft',
    'building_footprint_sqft', 'garage_present', 'adu_present', 'green_area_sqft', 'paved_area_sqft', 'tree_cover_sqft', 'pool_area_sqft', 'floors']) {
    assert.equal(p.fields[k].tag, 'unavailable', k); assert.equal(p.fields[k].value, null, k); assert.equal(p.fields[k].note, SHARED_WHY, k);
  }
  assert.equal(SHARED_WHY, 'shared with the building');
  // geometry: the shared lot (from the record), the building outlines as context, nothing else
  const g = p.geometry;
  assert.equal(g.shared, true); assert.equal(g.parcelSource, 'record'); assert.ok(g.parcel); assert.equal(g.buildings.length, 2); assert.ok(g.buildings.every((b) => b.main === false));
  assert.equal(g.driveway, null); assert.equal(g.zones, null); assert.equal(g.frontEdge, null); assert.deepEqual(g.streets, []); assert.equal(g.image, null);
  // the lookups that only serve a lot were not made
  assert.equal(splitYard.calls.length, 0, 'no yard split');
  assert.equal(fetch.calls.filter(heavy).length, 0, fetch.calls.filter(heavy).join('\n'));
  assert.ok(!fetch.calls.some((c) => /census/.test(c)), 'no street-side point for a condo');
  assert.ok(p.providers.some((x) => x.id === 'naip-aerial' && x.status === 'skipped')); assert.ok(p.providers.some((x) => x.id === 'overture-roads' && x.status === 'skipped'));
  assert.deepEqual(p.warnings, []);
  // the sourced profile says the same
  const sp = toSourcedProfile(p);
  assert.equal(sp.attributes.property_type.value, 'condo'); assert.equal(sp.attributes.unit_label.value, '18'); assert.equal(sp.attributes.complex_unit_count.value, 12); assert.ok(sp.attributes.complex_lot_area_sqft.value > 25000);
  for (const k of ['lot_area_sqft', 'yard_area_sqft', 'roof_area_sqft', 'driveway_area_sqft', 'garage_present', 'building_footprint_sqft']) { assert.equal(sp.attributes[k].tag, 'unavailable', k); assert.match(sp.attributes[k].note, /shared with the building/, k); }
});

test('a house is not touched: the same lookups, lot and yard as before, geometry.shared false, ownership house', async () => {
  const fetch = (() => { const calls = []; const f = async (u) => { calls.push(String(u)); const s = String(u); if (s.includes('CAMS_Locator')) return json(fx('synthetic-cams-sfr.json')); if (s.includes('census')) return json(fx('synthetic-census-sfr.json')); if (s.includes('LACounty_Parcel')) return json(fx('synthetic-assessor-sfr.json')); if (s.includes('LARIAC')) return json(fx('synthetic-lariac-sfr.json')); throw new Error('unexpected ' + s); }; f.calls = calls; return f; })();
  const sy = yardSpy();
  const p = await buildPropertyProfile({ address: '4321 Example Ave, Los Angeles, CA 90099' }, { registry: await createDefaultRegistry(), fetch, now: NOW, splitYard: sy });
  assert.equal(p.property_type, 'single_family'); assert.equal(p.ownership.kind, 'house'); assert.equal(p.geometry.shared, false); assert.equal(sy.calls.length, 1); assert.ok(p.lot_sqft > 6000); assert.equal(p.unit_label, null);
});

test('condo owner-supplied facts exist as questions with types; an unanswered condo gets only the unit', () => {
  assert.deepEqual(CONDO_OWNER_KEYS.map((k) => [k.key, k.type]), [['assigned_parking_spaces', 'number'], ['storage_unit_present', 'yesno'], ['balcony_present', 'yesno'], ['hoa_allows_rentals', 'choice']]);
  assert.deepEqual(CONDO_OWNER_KEYS.find((k) => k.key === 'hoa_allows_rentals').choices, ['yes', 'no', 'unsure']);
  assert.deepEqual(BUILDING_OWNER_KEYS.map((k) => k.key), ['units_available_to_rent', 'parking_spaces', 'laundry_room_present', 'roof_access_present']);
  for (const k of [...CONDO_OWNER_KEYS, ...BUILDING_OWNER_KEYS]) { assert.ok(k.question.length > 15 && k.question.endsWith('?'), k.key); assert.ok(['number', 'yesno', 'choice'].includes(k.type)); }
  assert.ok(Object.isFrozen(CONDO_OWNER_KEYS));
});

// ============================================================================================================================================
// 5. building profile
// ============================================================================================================================================

test('building profile: everything a house gets, plus units and building totals; roof only with an owner roof type', async () => {
  const { profile: p, splitYard, fetch } = await build({ address: BLDG_ADDR }, { kind: 'building' });
  assert.equal(p.property_type, 'multi_family'); assert.equal(p.ownership.kind, 'building'); assert.equal(p.ownership.units, 8); assert.equal(p.units, 8);
  assert.equal(p.geometry.shared, false); assert.ok(p.lot_sqft > 21000); assert.equal(splitYard.calls.length, 1); assert.equal(p.geometry.buildings.length, 2);
  assert.equal(p.fields.building_footprint_sqft.tag, 'measured'); assert.equal(p.house_sqft, 7200); assert.match(p.fields.house_sqft.note, /Building total/);
  assert.ok(p.fields.front_yard_sqft.value !== null);
  assert.equal(fetch.calls.some((c) => /census/.test(c)), true, 'a building gets the street-side point like a house');
  // roof: no owner roof type -> unavailable with the reason; apartment roofs are not assumed flat
  assert.equal(p.fields.roof_sqft.tag, 'unavailable'); assert.match(p.fields.roof_sqft.note, /tell us the roof type/i);
  // flat: flat factor 1.01, no pitch
  const flat = (await build({ address: BLDG_ADDR, roofType: 'flat' }, { kind: 'building' })).profile;
  const fp = flat.fields.building_footprint_sqft.value;
  assert.equal(flat.roof_sqft, Math.round(fp * 1 * 1.01)); assert.equal(flat.details.roof.slopeFactor, 1); assert.equal(flat.details.roof.shapeMultiplier, 1.01); assert.equal(flat.details.roof.pitchRise, 0); assert.equal(flat.fields.roof_sqft.tag, 'estimated');
  assert.match(flat.fields.roof_sqft.note, /2 buildings are on the lot/);
  const gable = (await build({ address: BLDG_ADDR, roofType: 'gable' }, { kind: 'building' })).profile;
  assert.ok(gable.roof_sqft > flat.roof_sqft); assert.match(gable.fields.roof_sqft.method, /house rule of thumb|typical pitch for houses/); assert.ok(gable.fields.roof_sqft.confidence <= 0.3);
  // estimateRoof directly
  assert.equal(estimateRoof({ footprintSqft: 4000, propertyType: 'multi_family' }).ok, false);
  assert.equal(estimateRoof({ footprintSqft: 4000, propertyType: 'multi_family', roofType: 'complex' }).ok, false, 'only flat, gable or hip');
  assert.equal(estimateRoof({ footprintSqft: 4000, propertyType: 'multi_family', roofType: 'hip' }).ok, true);
  assert.equal(estimateRoof({ footprintSqft: 4000, propertyType: 'condo', roofType: 'flat' }).ok, false);
  assert.match(estimateRoof({ footprintSqft: 4000, propertyType: 'condo', roofType: 'flat' }).roof.note, /shared with the building/);
});

// ============================================================================================================================================
// 7. ownerPropertyType outside LA / by the owner
// ============================================================================================================================================

test('ownerPropertyType is honoured (owner-confirmed) and brings the condo / building rules; a typed unit is kept', async () => {
  const mk = () => ({ registry: null });
  const sfr = (over = {}) => build({ address: '4321 Example Ave, Los Angeles, CA 90099', ...over }, { over: {} });
  // a self-declared condo on a record that reads as a house
  const fetch = (() => { const calls = []; const f = async (u) => { calls.push(String(u)); const s = String(u); if (s.includes('CAMS_Locator')) return json(fx('synthetic-cams-sfr.json')); if (s.includes('census')) return json(fx('synthetic-census-sfr.json')); if (s.includes('LACounty_Parcel')) return json(fx('synthetic-assessor-sfr.json')); if (s.includes('LARIAC')) return json(fx('synthetic-lariac-sfr.json')); throw new Error('unexpected ' + s); }; f.calls = calls; return f; })();
  const sy = yardSpy();
  const p = await buildPropertyProfile({ address: '4321 Example Ave Apt 7, Los Angeles, CA 90099', ownerPropertyType: 'condo' }, { registry: await createDefaultRegistry(), fetch, now: NOW, splitYard: sy });
  assert.equal(p.property_type, 'condo'); assert.equal(p.fields.property_type.tag, 'owner-confirmed'); assert.equal(p.ownership.source, 'owner'); assert.equal(p.ownership.kind, 'unit');
  assert.equal(p.unit_label, '7'); assert.equal(p.fields.unit_label.tag, 'owner-confirmed');
  assert.equal(p.fields.lot_sqft.note, SHARED_WHY); assert.equal(p.fields.roof_sqft.note, SHARED_WHY); assert.equal(sy.calls.length, 0); assert.equal(p.geometry.shared, true);
  assert.ok(p.warnings.some((w) => /you said condo; the county record .* single-family/.test(w)));
  assert.equal(fetch.calls.filter(heavy).length, 0);
  // a self-declared building on a house record
  const b = await buildPropertyProfile({ address: '4321 Example Ave, Los Angeles, CA 90099', ownerPropertyType: 'multi_family', roofType: 'flat' }, { registry: await createDefaultRegistry(), fetch: (() => { const f = async (u) => { const s = String(u); if (s.includes('CAMS_Locator')) return json(fx('synthetic-cams-sfr.json')); if (s.includes('LACounty_Parcel')) return json(fx('synthetic-assessor-sfr.json')); if (s.includes('LARIAC')) return json(fx('synthetic-lariac-sfr.json')); throw new Error('unexpected'); }; return f; })(), now: NOW, splitYard: yardSpy() });
  assert.equal(b.property_type, 'multi_family'); assert.equal(b.ownership.kind, 'building'); assert.ok(b.roof_sqft > 0); assert.match(b.fields.house_sqft.note, /Building total/);
  // invalid ownerPropertyType is ignored
  const bad = await buildPropertyProfile({ address: '4321 Example Ave, Los Angeles, CA 90099', ownerPropertyType: 'castle' }, { registry: await createDefaultRegistry(), fetch: (() => { const f = async (u) => { const s = String(u); if (s.includes('CAMS_Locator')) return json(fx('synthetic-cams-sfr.json')); if (s.includes('LACounty_Parcel')) return json(fx('synthetic-assessor-sfr.json')); if (s.includes('LARIAC')) return json(fx('synthetic-lariac-sfr.json')); throw new Error('unexpected'); }; return f; })(), now: NOW });
  assert.equal(bad.property_type, 'single_family');
  void mk; void sfr;
});

test('outside LA the type stays unknown until the owner says; ownerPropertyType then applies the condo rules (no yard, no roof)', async () => {
  const { createRegistry } = await import('../providers/registry.js');
  const BASE = { needsKey: false, coverage: { national: true }, retentionDays: null, licenseNote: 'test' };
  const LOT = { type: 'Polygon', coordinates: [[[-87.6325, 41.8835], [-87.6325, 41.8842], [-87.6317, 41.8842], [-87.6317, 41.8835], [-87.6325, 41.8835]]] };
  const { sourced, unavailable } = await import('../provenance.js');
  const rec = { ...BASE, id: 'fake-records', label: 'Fake records', kind: 'records', async lookup() {
    const m = (v, o = {}) => sourced(v, { tag: 'measured', source: 'Fake county', confidence: 0.8, retrievedAt: NOW, ...o });
    return { ok: true, fields: { apn: m('1-2-3'), lot_sqft: m(5800, { unit: 'sqft' }), house_sqft: m(1100, { unit: 'sqft' }), beds: m(2), baths: m(2), year_built: m(1999), property_type: unavailable('the county does not state a use', 'Fake county'), floors: unavailable('x', 'Fake county'), units: unavailable('x', 'Fake county'), use_code: unavailable('x', 'Fake county'), remodeled_year: unavailable('x', 'Fake county') },
      parcel: { boundary: LOT, apn: '1-2-3', address: null, assessorAreaSqft: null, matchedBy: 'containing-point', method: 'fake', confidence: 0.9 } }; } };
  const reg = createRegistry().register(rec);
  const IL = { state: 'IL', countyFips: '17031', county: 'Cook County' };
  const nofetch = async (u) => { throw new Error(`unexpected fetch ${u}`); };
  const sy = yardSpy();
  const none = await buildPropertyProfile({ address: '121 N LaSalle St Unit 12, Chicago, IL 60602', lat: 41.8838, lng: -87.6321 }, { registry: reg, fetch: nofetch, now: NOW, jurisdiction: IL, splitYard: sy });
  assert.equal(none.property_type, null); assert.equal(none.fields.property_type.tag, 'unavailable'); assert.equal(none.ownership.property_type, 'unknown'); assert.equal(none.ownership.kind, 'unknown');
  assert.equal(none.unit_label, '12', 'a typed unit is kept');
  const condo = await buildPropertyProfile({ address: '121 N LaSalle St Unit 12, Chicago, IL 60602', lat: 41.8838, lng: -87.6321, ownerPropertyType: 'condo' }, { registry: reg, fetch: nofetch, now: NOW, jurisdiction: IL, splitYard: sy });
  assert.equal(condo.property_type, 'condo'); assert.equal(condo.unit_label, '12'); assert.equal(condo.lot_sqft, null); assert.equal(condo.fields.lot_sqft.note, SHARED_WHY); assert.ok(condo.complex_lot_sqft > 5000);
  assert.equal(condo.fields.complex_unit_count.tag, 'unavailable'); assert.equal(condo.fields.front_yard_sqft.note, SHARED_WHY);
  assert.equal(sy.calls.length, 0, 'the unit-less record path never splits a yard for a condo');
});

// ============================================================================================================================================
// 6. earning options
// ============================================================================================================================================

const S = (value, tag = 'measured', confidence = 0.9) => ({ value, tag, source: 'test', retrievedAt: null, confidence });
const OWN = (value) => S(value, 'owner-confirmed', 1);
const LA = { country: 'US', state: 'CA', county: 'Los Angeles', countyFips: '06037', city: 'Los Angeles' };
const profile = (attrs) => ({ attributes: attrs, history: {} });
const condo = (extra = {}) => profile({ property_type: S('condo', 'estimated', 0.6), jurisdiction: S(LA), bedrooms: S(2), living_area_sqft: S(1000), ...extra });
const ids = (list) => list.map((o) => o.id);
const by = (list, id) => list.find((o) => o.id === id);

test('condo options: the unit and a private room; never yard, pool, driveway, roof, garage or ADU; parking and storage only when the owner confirms them', () => {
  const noisy = condo({ yard_area_sqft: S(500), pool_present: S(true), roof_area_sqft: S(800), building_footprint_sqft: S(4000), driveway_area_sqft: S(300), garage_present: S(true), adu_present: S(true), parking_spaces: S(2, 'owner-confirmed', 1), lot_area_sqft: S(20000) });
  assert.deepEqual(ids(identifyOpportunities(noisy, { now: NOW })), ['entire_home', 'private_room']);
  assert.deepEqual(ids(identifyOpportunities(noisy, { now: NOW, includeInvestmentIdeas: true })).filter((x) => ['adu', 'backyard', 'pool', 'rooftop_solar', 'garage_storage'].includes(x)), [], 'no ADU idea or lot option for a condo');
  const withParking = condo({ assigned_parking_spaces: OWN(2) });
  const o = identifyOpportunities(withParking, { now: NOW });
  assert.deepEqual(ids(o), ['entire_home', 'parking_spot', 'private_room']); assert.equal(by(o, 'parking_spot').quantity, 2); assert.deepEqual(by(o, 'parking_spot').evidence.filter((k) => k !== 'property_type'), ['assigned_parking_spaces']);
  assert.ok(!ids(identifyOpportunities(condo({ assigned_parking_spaces: S(2, 'estimated', 0.3) }), { now: NOW })).includes('parking_spot'), 'not owner-confirmed');
  assert.ok(!ids(identifyOpportunities(condo({ assigned_parking_spaces: OWN(0) }), { now: NOW })).includes('parking_spot'));
  assert.deepEqual(by(identifyOpportunities(condo({ storage_unit_present: OWN(true) }), { now: NOW }), 'basement_storage')?.evidence.filter((k) => k !== 'property_type'), ['storage_unit_present']);
  assert.ok(!ids(identifyOpportunities(condo({ storage_unit_present: OWN(false) }), { now: NOW })).includes('basement_storage'));
  assert.ok(!ids(identifyOpportunities(condo({ storage_unit_present: S(true, 'estimated', 0.3) }), { now: NOW })).includes('basement_storage'));
  // the question asked for the missing owner facts is the condo question, not the house one
  const q = missingEvidence(condo(), {});
  assert.match(q.find((x) => x.categoryKey === 'parking_spot').question, /assigned to your unit/); assert.match(q.find((x) => x.categoryKey === 'basement_storage').question, /storage unit or locker/);
  assert.ok(!q.some((x) => ['backyard', 'pool', 'rooftop_solar', 'garage_storage', 'adu'].includes(x.categoryKey)));
  // capacity: a condo owner has exactly the assigned spaces
  assert.equal(defaultResourceCapacity(condo({ assigned_parking_spaces: OWN(2), driveway_area_sqft: S(300) })).parking, 2);
  assert.equal(defaultResourceCapacity(condo({ driveway_area_sqft: S(300), parking_spaces: S(3, 'owner-confirmed', 1) })).parking, 0);
  assert.ok(OWNER_ATTRIBUTE_KEYS.includes('storage_unit_present'));
});

test('condo + hoa_allows_rentals: "no" prohibits guest and renter uses; unsure or unanswered adds a checklist item; "yes" adds nothing', () => {
  const guestUses = ['entire_home', 'private_room'];
  const get = (hoa) => identifyOpportunities(condo({ assigned_parking_spaces: OWN(1), ...(hoa ? { hoa_allows_rentals: OWN(hoa) } : {}) }), { now: NOW });
  const no = get('no');
  for (const id of guestUses) {
    const f = by(no, id).feasibility;
    assert.equal(f.status, 'prohibited', id); assert.equal(f.rules[0].summary, 'Your HOA does not allow this (you told us)'); assert.equal(f.rules[0].summary, HOA_NO_SUMMARY); assert.equal(f.rules[0].effect, 'prohibit'); assert.equal(f.rules[0].source, 'owner');
  }
  assert.notEqual(by(no, 'parking_spot').feasibility.status, 'prohibited', 'a parking space is not a guest in the unit');
  for (const v of ['unsure', null]) {
    const o = get(v);
    for (const id of guestUses) {
      const f = by(o, id).feasibility;
      assert.ok(f.requirements.includes("Check your HOA's rental rules"), `${id}/${v}`); assert.equal(f.requirements.filter((r) => r === HOA_CHECK_REQUIREMENT).length, 1);
      const r = f.rules.find((x) => x.ruleId === 'everyspace/checklist/hoa-rental-rules');
      assert.equal(r.verified, false); assert.equal(r.effect, 'require'); assert.match(r.sourceRef, /Everyspace checklist item/); assert.notEqual(f.status, 'prohibited');
    }
    assert.ok(!by(o, 'parking_spot').feasibility.requirements.includes(HOA_CHECK_REQUIREMENT));
  }
  const yes = get('yes');
  for (const id of guestUses) { const f = by(yes, id).feasibility; assert.ok(!f.requirements.includes(HOA_CHECK_REQUIREMENT)); assert.ok(!f.rules.some((r) => /hoa/i.test(r.ruleId))); }
  // an answer that is not owner-confirmed is not taken as "no"
  const guess = identifyOpportunities(condo({ hoa_allows_rentals: S('no', 'estimated', 0.3) }), { now: NOW });
  assert.notEqual(by(guess, 'entire_home').feasibility.status, 'prohibited');
  // only a condo: a house with the same attribute is untouched
  const house = identifyOpportunities(profile({ property_type: S('single_family'), jurisdiction: S(LA), bedrooms: S(3), hoa_allows_rentals: OWN('no') }), { now: NOW });
  assert.notEqual(by(house, 'entire_home').feasibility.status, 'prohibited');
  // checkFeasibility directly, with a category list that has no people-in data: nothing is added
  const bare = checkFeasibility('entire_home', condo({ hoa_allows_rentals: OWN('no') }), { now: NOW, categories: [{ key: 'entire_home', group: 'living' }] });
  assert.notEqual(bare.status, 'prohibited'); assert.ok(!bare.rules.some((r) => /hoa/i.test(r.ruleId)));
  // the optimizer says why
  const opps = [by(no, 'entire_home')];
  const ests = { entire_home: estimateOpportunity(opps[0], defaultInputs(opps[0], null)) };
  const res = optimize(opps, ests, { goal: 'max_net_income', constraints: { allowUnknownRegulatory: true, includeInvestments: true } });
  assert.match(res.rejected.find((x) => x.id === 'entire_home').reason, /Your HOA does not allow this/);
});

const BUILDING = (extra = {}) => profile({ property_type: S('multi_family', 'estimated', 0.6), jurisdiction: S(LA), units: S(8), bedrooms: S(12), yard_area_sqft: S(2000, 'estimated', 0.3), ...extra });

test('multi-family options: apartment_unit with the owner\'s quantity (or listed as needing the answer); parking with parking_spaces; roof only with access or an owner roof type', () => {
  const none = identifyOpportunities(BUILDING(), { now: NOW });
  const a0 = by(none, 'apartment_unit');
  assert.ok(a0); assert.equal(a0.quantity, undefined); assert.equal(a0.quantityNeeded.key, 'units_available_to_rent'); assert.match(a0.quantityNeeded.question, /how many of the units/i); assert.ok(a0.notes.some((n) => /no number is assumed/.test(n)));
  assert.ok(!ids(none).includes('rooftop_solar'), 'no roof access and no roof type: no roof option');
  assert.ok(ids(none).includes('backyard'), 'yard-based options as for a house');
  const a = (n) => by(identifyOpportunities(BUILDING({ units_available_to_rent: OWN(n) }), { now: NOW }), 'apartment_unit');
  assert.equal(a(3).quantity, 3); assert.equal(a(3).quantityNeeded, undefined); assert.equal(a(8).quantity, 8);
  assert.equal(a(12).quantity, 8); assert.ok(a(12).notes.some((n) => /building has 8/.test(n)));
  assert.equal(a(0), undefined, 'none available: not offered');
  assert.equal(by(identifyOpportunities(BUILDING({ units_available_to_rent: S(3, 'estimated', 0.3) }), { now: NOW }), 'apartment_unit').quantity, undefined, 'an estimate is not the owner\'s answer');
  assert.ok(!ids(identifyOpportunities(BUILDING({ units: S(1) }), { now: NOW })).includes('apartment_unit'), 'needs units >= 2');
  const park = (extra) => by(identifyOpportunities(BUILDING(extra), { now: NOW }), 'parking_spot');
  assert.equal(park({ parking_spaces: OWN(10) }).quantity, 10); assert.equal(park({ parking_spaces: S(10, 'estimated', 0.3) }).quantity, undefined); assert.equal(park({ driveway_area_sqft: S(900) }).quantity, undefined);
  assert.ok(ids(identifyOpportunities(BUILDING({ roof_access_present: OWN(true) }), { now: NOW })).includes('rooftop_solar'));
  assert.ok(!ids(identifyOpportunities(BUILDING({ roof_access_present: OWN(false) }), { now: NOW })).includes('rooftop_solar'));
  assert.ok(!ids(identifyOpportunities(BUILDING({ roof_access_present: S(true, 'estimated', 0.3), building_footprint_sqft: S(3000) }), { now: NOW })).includes('rooftop_solar'), 'a footprint alone is not roof access');
  assert.ok(ids(identifyOpportunities(BUILDING({ roof_area_sqft: S(3100, 'estimated', 0.5) }), { now: NOW })).includes('rooftop_solar'), 'a roof area that came from an owner roof type');
  // a house is unchanged: footprint still evidences solar
  assert.ok(ids(identifyOpportunities(profile({ property_type: S('single_family'), jurisdiction: S(LA), building_footprint_sqft: S(1400) }), { now: NOW })).includes('rooftop_solar'));
  // capacity: as many dwellings as units
  assert.equal(defaultResourceCapacity(BUILDING()).home_interior, 8); assert.equal(defaultResourceCapacity(BUILDING({ units: S(null, 'unavailable', 0) })).home_interior, 1);
});

// ============================================================================================================================================
// quantity in the money
// ============================================================================================================================================

const opp = (over = {}) => ({ id: 'apartment_unit', categoryKey: 'apartment_unit', label: 'Apartment / unit', basis: 'existing', unit: 'night', evidence: ['units'], evidenceConfidence: 0.8,
  feasibility: { status: 'feasible', rules: [{ ruleId: 'r', summary: 's', effect: 'allow', verified: true }], confidence: 0.8, requirements: [] }, conflictsWith: [], resourceUse: { home_interior: 1 }, effort: 4, privacyImpact: 3, strangersInHome: true, notes: [], ...over });
const fullInputs = (o) => withOverrides(defaultInputs(o, null), { priceCents: 12000, unitsPerMonth: 15, bookingsPerMonth: 5, platformFeeRate: 0.1, cleaningCentsPerBooking: 4500, utilitiesCentsPerMonth: 7000, insuranceCentsPerMonth: 2500, taxRate: 0.12, permitCentsPerYear: 24000, upfrontCents: 300000 }, NOW);

test('quantity scales gross, per-booking and per-unit fixed costs exactly; perUnit keeps one unit; ratios stay', () => {
  const base = opp(); const inputs = fullInputs(base);
  const one = estimateOpportunity(base, inputs);
  for (const q of [2, 3, 7, 40]) {
    const e = estimateOpportunity(opp({ quantity: q }), inputs);
    assert.equal(e.quantity, q);
    for (const sc of ['conservative', 'baseline', 'optimistic']) {
      const u = e.perUnit[sc], t = e.scenarios[sc], o1 = one.scenarios[sc];
      assert.deepEqual(u, o1, 'perUnit is the one-unit estimate');
      for (const k of ['grossCentsPerMonth', 'platformFeeCentsPerMonth', 'cleaningCentsPerMonth', 'utilitiesCentsPerMonth', 'insuranceCentsPerMonth', 'taxAndPermitCentsPerMonth', 'noiCentsPerMonth', 'grossCentsPerYear', 'noiCentsPerYear', 'upfrontCents']) assert.equal(t[k], o1[k] * q, `${sc}.${k}`);
      assert.deepEqual(t.noiCentsByMonth, o1.noiCentsByMonth.map((v) => v * q));
      for (const k of ['occupancy', 'roi', 'paybackMonths']) assert.equal(t[k], o1[k], k);
    }
    assert.equal(e.confidence, one.confidence); assert.ok(e.assumptions.some((a) => a.key === 'quantity' && /no vacancy correlation or market saturation/.test(a.text)));
  }
  for (const bad of [0, -1, 1.5, '2', NaN]) assert.throws(() => estimateOpportunity(opp({ quantity: bad }), inputs), /integer >= 1/, String(bad));
});

test('summarize and the optimizer scale by quantity, count shared resources by quantity, and report per-unit and total', () => {
  const base = opp({ quantity: 4 }); const inputs = fullInputs(base);
  const e4 = estimateOpportunity(base, inputs); const e1 = estimateOpportunity(opp(), inputs);
  const s4 = summarize([e4], ['apartment_unit'], 'baseline'), s1 = summarize([e1], ['apartment_unit'], 'baseline');
  assert.equal(s4.noiCentsPerYear, s1.noiCentsPerYear * 4); assert.equal(s4.grossCentsPerYear, s1.grossCentsPerYear * 4); assert.equal(s4.upfrontCents, s1.upfrontCents * 4);
  assert.deepEqual(s4.lines, [{ id: 'apartment_unit', quantity: 4, perUnit: { grossCentsPerYear: s1.grossCentsPerYear, noiCentsPerYear: s1.noiCentsPerYear, upfrontCents: s1.upfrontCents }, total: { grossCentsPerYear: s4.grossCentsPerYear, noiCentsPerYear: s4.noiCentsPerYear, upfrontCents: s4.upfrontCents } }]);
  assert.equal(s4.paybackMonths, s1.paybackMonths);
  const run = (o, e, cap) => optimize([o], { [o.id]: e }, { goal: 'max_net_income', constraints: { allowUnknownRegulatory: true, resourceCapacity: cap } });
  const r = run(base, e4, { home_interior: 8 });
  assert.deepEqual(r.selected, ['apartment_unit']); assert.equal(r.totals.noiCentsPerYear, s4.noiCentsPerYear); assert.equal(r.lines[0].quantity, 4); assert.equal(r.lines[0].perUnit.noiCentsPerYear, s1.noiCentsPerYear);
  const tight = run(base, e4, { home_interior: 3 });
  assert.deepEqual(tight.selected, []); assert.match(tight.rejected[0].reason, /Needs 4 home_interior but only 3 available/);
  assert.deepEqual(run(base, e4, { home_interior: 4 }).selected, ['apartment_unit']);
  // two quantity-bearing options share the resource by quantity
  const p1 = opp({ id: 'pa', categoryKey: 'pa', quantity: 3, resourceUse: { parking: 1 } }), p2 = opp({ id: 'pb', categoryKey: 'pb', quantity: 3, resourceUse: { parking: 1 } });
  const two = optimize([p1, p2], { pa: estimateOpportunity(p1, inputs), pb: estimateOpportunity(p2, inputs) }, { goal: 'max_net_income', constraints: { allowUnknownRegulatory: true, resourceCapacity: { parking: 5 } } });
  assert.equal(two.selected.length, 1); assert.match(two.rejected[0].reason, /Not enough parking: 5 available and the selected \w+ use 3/);
  // a quantity that is still needed from the owner is never totalled
  const need = opp({ quantityNeeded: { key: 'units_available_to_rent', question: 'How many?' } });
  const rn = run(need, e1, { home_interior: 8 });
  assert.deepEqual(rn.selected, []); assert.match(rn.rejected[0].reason, /Needs your answer first: How many\?/);
  // an estimate made for another quantity is not mixed in
  assert.match(run(opp({ quantity: 2 }), e4, { home_interior: 8 }).rejected[0].reason, /estimate was made for 4 unit/);
});

// ---- the quantity-1 invariance -------------------------------------------------------------------------------------------------------------

test('quantity 1 changes no number: 80 frozen estimates from the code before this change are reproduced exactly', () => {
  const g = JSON.parse(readFileSync(new URL('./fixtures/revenue-golden.json', import.meta.url), 'utf8'));
  assert.equal(g.cases.length, 80);
  for (const c of g.cases) {
    const once = estimateOpportunity(c.opportunity, c.inputs);
    const explicit = estimateOpportunity({ ...c.opportunity, quantity: 1 }, c.inputs);
    for (const e of [once, explicit]) {
      assert.deepEqual(e.scenarios, c.estimate.scenarios, c.opportunity.id);
      assert.deepEqual(e.perUnit, c.estimate.scenarios);
      for (const k of ['available', 'confidence', 'confidenceLabel', 'missing', 'assumptions', 'inputs', 'notIncluded', 'opportunityId']) assert.deepEqual(e[k], c.estimate[k], `${c.opportunity.id}.${k}`);
    }
  }
});

test('property-based: for 300 generated opportunities, quantity q gives exactly q times the one-unit figure and 1 gives the same as none', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const cats = [['entire_home', 'night'], ['private_room', 'night'], ['parking_spot', 'day'], ['garage_storage', 'month'], ['pool', 'hour'], ['apartment_unit', 'night']];
  for (let i = 0; i < 300; i++) {
    const [cat, unit] = cats[Math.floor(rnd() * cats.length)];
    const o = opp({ id: `p${i}`, categoryKey: cat, unit, evidenceConfidence: rnd() });
    let inp = defaultInputs(o, null);
    const ov = {};
    if (rnd() < 0.7) ov.priceCents = Math.floor(rnd() * 50000) + 100; if (rnd() < 0.7) ov.unitsPerMonth = Math.round(rnd() * 200) / 10; if (rnd() < 0.5) ov.bookingsPerMonth = Math.floor(rnd() * 9) + 1;
    if (rnd() < 0.5) ov.cleaningCentsPerBooking = Math.floor(rnd() * 8000); if (rnd() < 0.5) ov.utilitiesCentsPerMonth = Math.floor(rnd() * 9000); if (rnd() < 0.5) ov.taxRate = Math.round(rnd() * 150) / 1000;
    if (rnd() < 0.5) ov.permitCentsPerYear = Math.floor(rnd() * 40000); if (rnd() < 0.5) ov.upfrontCents = Math.floor(rnd() * 400000);
    if (Object.keys(ov).length) inp = withOverrides(inp, ov, NOW);
    const none = estimateOpportunity(o, inp), q1 = estimateOpportunity({ ...o, quantity: 1 }, inp);
    assert.deepEqual(q1.scenarios, none.scenarios);
    const q = Math.floor(rnd() * 30) + 2, eq = estimateOpportunity({ ...o, quantity: q }, inp);
    assert.deepEqual(eq.perUnit, none.scenarios);
    for (const sc of ['conservative', 'baseline', 'optimistic']) {
      for (const k of ['grossCentsPerYear', 'noiCentsPerYear', 'upfrontCents', 'noiCentsPerMonth', 'grossCentsPerMonth']) assert.equal(eq.scenarios[sc][k], none.scenarios[sc][k] * q, `${i}.${sc}.${k}`);
      assert.deepEqual(eq.scenarios[sc].noiCentsByMonth, none.scenarios[sc].noiCentsByMonth.map((v) => v * q));
    }
  }
});

// ---- determinism, no mutation ---------------------------------------------------------------------------------------------------------------

test('deterministic and non-mutating: the same input twice gives the same output; frozen inputs are accepted', async () => {
  const frozen = deepFreeze(BUILDING({ units_available_to_rent: OWN(3), parking_spaces: OWN(5) }));
  const a = identifyOpportunities(frozen, { now: NOW }), b = identifyOpportunities(frozen, { now: NOW });
  assert.deepEqual(a, b);
  const c = deepFreeze(condo({ hoa_allows_rentals: OWN('no'), assigned_parking_spaces: OWN(1) }));
  assert.deepEqual(identifyOpportunities(c, { now: NOW }), identifyOpportunities(c, { now: NOW }));
  assert.deepEqual(missingEvidence(frozen), missingEvidence(frozen)); assert.deepEqual(defaultResourceCapacity(frozen), defaultResourceCapacity(frozen));
  const x = await build({ address: CONDO_ADDR, unit: '18' }), y = await build({ address: CONDO_ADDR, unit: '18' });
  assert.deepEqual(x.profile, y.profile);
  const query = deepFreeze({ address: '7700 Sample Ct Apt 18, Los Angeles, CA 90098', ownerPropertyType: 'condo' });
  const z = await buildPropertyProfile(query, { registry: await createDefaultRegistry(), fetch: world('condo'), now: NOW, splitYard: yardSpy() });
  assert.equal(z.property_type, 'condo');
  assert.deepEqual(parseAddress(Object.freeze('123 Main St Apt 4')), parseAddress('123 Main St Apt 4'));
  const e = deepFreeze(opp({ quantity: 3 })); const inp = deepFreeze(fullInputs(opp()));
  assert.deepEqual(estimateOpportunity(e, inp), estimateOpportunity(e, inp));
});

test('end to end: a condo owner who confirms HOA "yes", 2 assigned spaces and a storage unit gets four options; the money scales the parking by 2', async () => {
  const { profile: p } = await build({ address: CONDO_ADDR, unit: '18' });
  let prof = toSourcedProfile(p);
  prof = applyOwnerCorrection(prof, 'hoa_allows_rentals', 'yes', NOW); prof = applyOwnerCorrection(prof, 'assigned_parking_spaces', 2, NOW); prof = applyOwnerCorrection(prof, 'storage_unit_present', true, NOW);
  const opps = identifyOpportunities(prof, { now: NOW });
  assert.deepEqual(ids(opps), ['basement_storage', 'entire_home', 'parking_spot', 'private_room']);
  assert.equal(by(opps, 'parking_spot').quantity, 2);
  const pk = by(opps, 'parking_spot');
  const e = estimateOpportunity(pk, withOverrides(defaultInputs(pk, prof), { priceCents: 600, unitsPerMonth: 200 }, NOW)); // the owner's own price and hours
  assert.equal(e.quantity, 2); assert.equal(e.scenarios.baseline.noiCentsPerYear, e.perUnit.baseline.noiCentsPerYear * 2);
  assert.equal(getAttribute(prof, 'lot_area_sqft').tag, 'unavailable'); assert.ok(!ids(opps).includes('backyard'));
});

test('the county locator is asked without the unit; a condo unit keeps its own remodeled year', async () => {
  const { laCamsAddress } = await import('../providers/la-cams-address.js');
  const urls = [];
  const r = await laCamsAddress.resolve('7700 Sample Ct Unit 18, Los Angeles, CA 90098', { fetch: async (u) => { urls.push(String(u)); return json(fx('synthetic-cams-condo.json')); }, now: NOW });
  assert.equal(r.ok, true); assert.equal(urls.length, 1); assert.doesNotMatch(decodeURIComponent(urls[0]), /unit|18/i); assert.match(decodeURIComponent(urls[0]), /7700 Sample Ct, Los Angeles/);
  const u1 = await lookup({ unit: 'Unit 1' });
  assert.equal(u1.r.fields.remodeled_year.value, 1998); assert.equal(u1.r.fields.remodeled_year.tag, 'estimated');
  assert.equal((await lookup({ unit: '3' })).r.fields.remodeled_year.value, null);
});

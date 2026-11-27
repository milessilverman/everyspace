import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyOpportunities, missingEvidence, evaluateRule, defaultResourceCapacity, OWNER_ATTRIBUTE_KEYS } from '../opportunities.js';
import { CATEGORIES } from '../data/categories.js';
import { JURISDICTIONS } from '../data/jurisdictions.js';

const NOW = '2026-11-24T00:00:00Z';
const S = (value, tag = 'measured', confidence = 0.9) => ({ value, tag, source: 'test', retrievedAt: null, confidence });
const UNAV = { value: null, tag: 'unavailable', source: 'test', retrievedAt: null, confidence: 0, note: 'not found' };
const LA = { country: 'US', state: 'CA', county: 'Los Angeles', city: 'Los Angeles' };
const profile = (attrs) => ({ attributes: attrs, history: {} });
const sfh = (extra = {}) => profile({
  property_type: S('single_family'), jurisdiction: S(LA), bedrooms: S(3), yard_area_sqft: S(1800, 'estimated', 0.5),
  pool_present: S(true, 'measured', 0.8), parking_spaces: S(2, 'owner-confirmed', 1), ...extra,
});
const ids = (opps) => opps.map((o) => o.id);
const by = (opps, id) => opps.find((o) => o.id === id);

test('single-family LA profile with pool + yard evidenced', () => {
  const o = identifyOpportunities(sfh(), { now: NOW });
  // CHANGED: yard_campsite removed (owner-only now; a yard is not evidence of a campsite).
  for (const id of ['entire_home', 'private_room', 'backyard', 'pool', 'parking_spot', 'garden_plot']) assert.ok(ids(o).includes(id), id);
  assert.ok(!ids(o).includes('yard_campsite'));
  const pool = by(o, 'pool');
  assert.deepEqual(pool.evidence, ['pool_present', 'property_type']);
  assert.equal(pool.evidenceConfidence, 0.8);
  assert.equal(pool.unit, 'hour');
  assert.equal(pool.basis, 'setup');
  assert.equal(by(o, 'entire_home').feasibility.status, 'restricted');
  assert.equal(by(o, 'entire_home').basis, 'permit');
  assert.equal(by(o, 'entire_home').strangersInHome, true);
  assert.equal(by(o, 'entire_home').unit, 'night');
});

test('evidenceConfidence is the min over evidence and notes mention estimated evidence', () => {
  const b = by(identifyOpportunities(sfh(), { now: NOW }), 'backyard');
  assert.equal(b.evidenceConfidence, 0.5);
  assert.ok(b.notes.some((n) => /estimated/.test(n)));
});

test('pool unavailable: no pool opportunity, listed in missingEvidence; owner-confirmed unlocks it', () => {
  const unav = sfh({ pool_present: UNAV });
  assert.ok(!ids(identifyOpportunities(unav, { now: NOW })).includes('pool'));
  const m = missingEvidence(unav).find((x) => x.categoryKey === 'pool');
  assert.deepEqual(m.needs, ['pool_present']);
  assert.match(m.question, /pool/i);
  const confirmed = sfh({ pool_present: S(true, 'owner-confirmed', 1) });
  const pool = by(identifyOpportunities(confirmed, { now: NOW }), 'pool');
  assert.ok(pool);
  assert.equal(pool.evidenceConfidence, 0.9);
  assert.ok(!missingEvidence(confirmed).some((x) => x.categoryKey === 'pool'));
});

test('a measured pool_present=false means no opportunity and no question', () => {
  const p = sfh({ pool_present: S(false) });
  assert.ok(!ids(identifyOpportunities(p, { now: NOW })).includes('pool'));
  assert.ok(!missingEvidence(p).some((x) => x.categoryKey === 'pool'));
});

test('absent attribute behaves like unavailable', () => {
  const p = profile({ property_type: S('single_family') });
  assert.ok(!ids(identifyOpportunities(p, { now: NOW })).includes('backyard'));
  assert.ok(missingEvidence(p).some((x) => x.categoryKey === 'backyard' && x.needs.includes('yard_area_sqft')));
});

test('driveway question asks how many cars fit', () => {
  const p = profile({ property_type: S('single_family') });
  const m = missingEvidence(p).find((x) => x.categoryKey === 'parking_spot');
  assert.ok(m.needs.includes('driveway_area_sqft'));
  assert.match(m.question, /driveway/i);
  assert.match(m.question, /cars/i);
});

test('zero area or zero spaces is evidenced "no", not unknown', () => {
  const p = sfh({ yard_area_sqft: S(0), parking_spaces: S(0) });
  assert.ok(!ids(identifyOpportunities(p, { now: NOW })).includes('backyard'));
  assert.ok(!missingEvidence(p).some((x) => x.categoryKey === 'backyard'));
});

test('condo gets only what a condo can offer', () => {
  const p = profile({ property_type: S('condo'), jurisdiction: S(LA), bedrooms: S(2), parking_spaces: S(1), yard_area_sqft: S(500), pool_present: S(true), roof_area_sqft: S(800) });
  const got = ids(identifyOpportunities(p, { now: NOW }));
  // CHANGED: ev_charging removed (owner-only).
  // CHANGED 2026-11-27 (condos and buildings): a condo owner has no driveway or parking of their own, so `parking_spaces` no longer evidences a parking
  // spot; only the owner-confirmed `assigned_parking_spaces` does (see tests/condo-building.test.mjs).
  assert.deepEqual(got, ['entire_home', 'private_room']);
  for (const no of ['backyard', 'pool', 'rooftop_solar', 'adu']) assert.ok(!got.includes(no));
});

test('bare land: only land categories, no home or roof categories', () => {
  const p = profile({ property_type: S('land'), jurisdiction: S(LA), lot_area_sqft: S(20000), roof_area_sqft: UNAV });
  const got = ids(identifyOpportunities(p, { now: NOW }));
  // CHANGED: bare land evidences nothing automatically (garden_plot needs yard_area_sqft; pasture/rv/sport_court/campsite are owner-only).
  assert.deepEqual(got, []);
  assert.ok(missingEvidence(p).some((x) => x.categoryKey === 'pasture'));
  assert.ok(!missingEvidence(p).some((x) => x.categoryKey === 'rooftop_solar'));
});

test('property_type unknown/unavailable: nothing emitted, property type asked', () => {
  const p = profile({ property_type: S('unknown', 'estimated', 0.1), yard_area_sqft: S(1000) });
  assert.deepEqual(identifyOpportunities(p, { now: NOW }), []);
  assert.ok(missingEvidence(p).some((x) => x.needs.includes('property_type')));
});

test('unknown jurisdiction: opportunities still listed with unknown feasibility', () => {
  const p = sfh(); delete p.attributes.jurisdiction;
  const o = identifyOpportunities(p, { now: NOW });
  assert.equal(by(o, 'entire_home').feasibility.status, 'unknown');
  assert.equal(by(o, 'entire_home').feasibility.confidence, 0);
});

test('ADU: construction when absent, permit when adu_present true', () => {
  // CHANGED: an absent ADU is emitted only as an investment idea.
  assert.ok(!by(identifyOpportunities(sfh({ lot_area_sqft: S(6000), adu_present: S(false) }), { now: NOW }), 'adu'));
  const absent = by(identifyOpportunities(sfh({ lot_area_sqft: S(6000), adu_present: S(false) }), { now: NOW, includeInvestmentIdeas: true }), 'adu');
  assert.equal(absent.basis, 'construction');
  const present = by(identifyOpportunities(sfh({ adu_present: S(true) }), { now: NOW }), 'adu');
  assert.equal(present.basis, 'permit');
  assert.equal(present.strangersInHome, false);
});

test('conflicts are symmetric and filtered to present opportunities', () => {
  const o = identifyOpportunities(sfh(), { now: NOW });
  for (const a of o) for (const b of a.conflictsWith) {
    assert.ok(ids(o).includes(b), `${a.id} -> absent ${b}`);
    assert.ok(by(o, b).conflictsWith.includes(a.id), `${b} missing ${a.id}`);
  }
  assert.ok(by(o, 'entire_home').conflictsWith.includes('private_room'));
  assert.ok(by(o, 'entire_home').conflictsWith.includes('pool'));
  assert.ok(by(o, 'entire_home').conflictsWith.includes('backyard'));
  assert.ok(!by(o, 'parking_spot').conflictsWith.includes('entire_home'));
});

test('conflict with an absent opportunity is dropped', () => {
  const p = profile({ property_type: S('single_family'), bedrooms: S(3) });
  const o = identifyOpportunities(p, { now: NOW });
  assert.deepEqual(by(o, 'entire_home').conflictsWith, ['private_room']);
});

test('independent assets have no conflicts and shared resources are reported', () => {
  // CHANGED: telecom_site and lot_parking are owner-only, so the owner confirms them first.
  const p = profile({ property_type: S('commercial'), roof_area_sqft: S(4000), parking_spaces: S(30), lot_area_sqft: S(9000),
    telecom_site_available: S(true, 'owner-confirmed', 1), lot_parking_available: S(true, 'owner-confirmed', 1) });
  const o = identifyOpportunities(p, { now: NOW });
  assert.deepEqual(by(o, 'rooftop_solar').conflictsWith, ['telecom_site']);
  const lot = by(o, 'lot_parking');
  assert.deepEqual(lot.resourceUse, { parking: 1 });
  assert.deepEqual(lot.conflictsWith, []); // parking is capacity-based (defaultResourceCapacity), not a fixed-1 conflict
  assert.deepEqual(by(identifyOpportunities(sfh({ driveway_area_sqft: S(300) }), { now: NOW }), 'parking_spot').resourceUse, { parking: 1 });
});

test('output is sorted by id and independent of attribute insertion order', () => {
  const a = identifyOpportunities(sfh(), { now: NOW });
  const attrs = Object.fromEntries(Object.entries(sfh().attributes).reverse());
  const b = identifyOpportunities(profile(attrs), { now: NOW });
  assert.deepEqual(a, b);
  assert.deepEqual(ids(a), [...ids(a)].sort());
  const m = missingEvidence(profile({ property_type: S('single_family') })).map((x) => x.categoryKey);
  assert.deepEqual(m, [...m].sort());
});

test('does not mutate the profile or shared data', () => {
  const p = sfh();
  const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
  deepFreeze(p);
  const snapC = JSON.stringify(CATEGORIES), snapJ = JSON.stringify(JURISDICTIONS);
  const o = identifyOpportunities(p, { now: NOW });
  missingEvidence(p);
  o[0].resourceUse.hack = 1; o[0].conflictsWith.push('x');
  assert.equal(JSON.stringify(CATEGORIES), snapC);
  assert.equal(JSON.stringify(JURISDICTIONS), snapJ);
  const again = identifyOpportunities(p, { now: NOW });
  assert.ok(!('hack' in again[0].resourceUse));
  assert.ok(!again[0].conflictsWith.includes('x'));
});

test('gear needs equipment_owned; owner confirmation unlocks it', () => {
  const p = sfh();
  assert.ok(!ids(identifyOpportunities(p, { now: NOW })).includes('kayak'));
  assert.ok(missingEvidence(p).some((x) => x.categoryKey === 'kayak'));
  const q = sfh({ equipment_owned: S(['kayak', 'ebike'], 'owner-confirmed', 1) });
  const got = ids(identifyOpportunities(q, { now: NOW }));
  assert.ok(got.includes('kayak') && got.includes('ebike') && !got.includes('atv'));
});

test('evaluateRule operators', () => {
  const p = profile({ n: S(5), s: S('a'), z: S(0), arr: S(['x']) });
  const st = (r) => evaluateRule(r, p).state;
  assert.equal(st({ attr: 'n', min: 5 }), 'yes');
  assert.equal(st({ attr: 'n', min: 6 }), 'no');
  assert.equal(st({ attr: 's', in: ['a', 'b'] }), 'yes');
  assert.equal(st({ attr: 's', notIn: ['a'] }), 'no');
  assert.equal(st({ attr: 'z' }), 'no');
  assert.equal(st({ attr: 'arr', includes: 'x' }), 'yes');
  assert.equal(st({ attr: 'missing' }), 'unknown');
  assert.equal(st({ all: [{ attr: 'missing' }, { attr: 'z' }] }), 'no');
  assert.equal(st({ any: [{ attr: 'missing' }, { attr: 'n' }] }), 'yes');
  assert.equal(st({ never: true }), 'no');
});

test('data: every category has all fields and valid enums', () => {
  assert.equal(CATEGORIES.length, 39);
  const keys = new Set();
  for (const c of CATEGORIES) {
    assert.match(c.key, /^[a-z]+(_[a-z]+)*$/);
    assert.ok(!keys.has(c.key)); keys.add(c.key);
    assert.ok(c.label && c.group);
    assert.ok(['hour', 'day', 'night', 'week', 'month'].includes(c.unit), c.key);
    assert.ok(Number.isInteger(c.effort) && c.effort >= 1 && c.effort <= 5, c.key);
    assert.ok(Number.isInteger(c.privacyImpact) && c.privacyImpact >= 0 && c.privacyImpact <= 3, c.key);
    assert.equal(typeof c.strangersInHome, 'boolean');
    assert.ok(['existing', 'setup', 'permit', 'construction'].includes(c.basisDefault), c.key);
    assert.ok(c.requires && typeof c.requires === 'object');
    assert.ok(Array.isArray(c.conflictsWith));
    for (const v of Object.values(c.resourceUse)) assert.ok(Number.isInteger(v) && v > 0);
    assert.match(c.sourceRef, /^everyspace-demo index\.html:\d+$/);
  }
});

test('data: every conflictsWith key exists, no self-conflict, stored symmetric', () => {
  const m = new Map(CATEGORIES.map((c) => [c.key, c]));
  for (const c of CATEGORIES) for (const o of c.conflictsWith) {
    assert.ok(m.has(o), `${c.key} -> ${o}`);
    assert.notEqual(o, c.key);
    assert.ok(m.get(o).conflictsWith.includes(c.key), `${o} lacks ${c.key}`);
  }
});

test('data: category sourceRef lines are positive integers (the demo file now lives in everyspace-demo)', () => {
  for (const c of CATEGORIES) assert.ok(Number(c.sourceRef.split(':')[1]) > 0, c.key);
});

test('adding a category as data works without code changes', () => {
  const extra = { key: 'rooftop_garden', label: 'Rooftop garden', group: 'land', unit: 'month', effort: 2, privacyImpact: 1, strangersInHome: false,
    basisDefault: 'setup', requires: { all: [{ attr: 'roof_area_sqft', min: 100 }] }, conflictsWith: ['rooftop_solar'], resourceUse: { roof: 1 }, sourceRef: 'test' };
  const p = profile({ property_type: S('commercial'), roof_area_sqft: S(4000) });
  const o = identifyOpportunities(p, { now: NOW, categories: [...CATEGORIES, extra] });
  assert.ok(ids(o).includes('rooftop_garden'));
  assert.ok(by(o, 'rooftop_solar').conflictsWith.includes('rooftop_garden'));
});

test('adding a jurisdiction as data changes feasibility without code changes', () => {
  const p = sfh({ jurisdiction: S({ country: 'US', state: 'OR', city: 'Bend' }) });
  const rules = [...JURISDICTIONS, { id: 'or-bend/pool', jurisdiction: { state: 'OR', city: 'Bend' }, categoryKeys: ['pool'], effect: 'prohibit', summary: 'test rule',
    requirements: [], params: {}, verified: false, verifiedAt: null, sourceUrl: null, sourceRef: 'test' }];
  const o = identifyOpportunities(p, { now: NOW, jurisdictions: rules });
  assert.equal(by(o, 'pool').feasibility.status, 'prohibited');
  assert.equal(by(o, 'backyard').feasibility.status, 'unknown');
});

test('building container is never an opportunity', () => {
  const p = profile({ property_type: S('commercial'), building_footprint_sqft: S(5000), buildings: S([{ footprintSqft: 5000 }]) });
  assert.ok(!ids(identifyOpportunities(p, { now: NOW })).includes('building'));
  assert.ok(!missingEvidence(p).some((x) => x.categoryKey === 'building'));
});

// ---- evidence classes, shared resources (FIX-OPP) ----

const LA_CENSUS = { country: 'US', state: 'CA', countyFips: '06037', county: 'Los Angeles County', city: 'LOS ANGELES' };
const laFixture = (extra = {}) => profile({
  property_type: S('single_family'), bedrooms: S(3), lot_area_sqft: S(10743), yard_area_sqft: S(8961, 'estimated', 0.4),
  pool_present: S(true, 'estimated', 0.7), jurisdiction: S(LA_CENSUS),
  driveway_area_sqft: UNAV, parking_spaces: UNAV, garage_present: UNAV, adu_present: UNAV, zoning: UNAV, ...extra,
});
const NOT_FROM_YARD = ['sport_court', 'pasture', 'beehive_site', 'film_location', 'kitchen', 'rv_parking', 'yard_campsite', 'battery_site', 'apartment_unit', 'ev_charging', 'workspace'];

test('LA fixture yields exactly the auto-evidenced set', () => {
  const o = identifyOpportunities(laFixture(), { now: NOW });
  assert.deepEqual(ids(o), ['backyard', 'entire_home', 'garden_plot', 'pool', 'private_room']);
  for (const id of NOT_FROM_YARD) assert.ok(!ids(o).includes(id), id);
  assert.ok(o.every((x) => x.basis !== 'existing'), 'estimated yard/pool never produce an existing-basis rv/court/etc.');
});

test('LA fixture: Census-style jurisdiction gives entire_home a real (restricted) status', () => {
  const eh = by(identifyOpportunities(laFixture(), { now: NOW }), 'entire_home');
  assert.equal(eh.feasibility.status, 'restricted');
  assert.ok(eh.feasibility.confidence > 0 && eh.feasibility.confidence <= 0.3);
  const pool = by(identifyOpportunities(laFixture(), { now: NOW }), 'pool');
  assert.equal(pool.feasibility.status, 'unknown');
});

test('owner confirming sport_court_available makes it appear with basis existing', () => {
  const p = laFixture({ sport_court_available: S(true, 'owner-confirmed', 1) });
  const sc = by(identifyOpportunities(p, { now: NOW }), 'sport_court');
  assert.ok(sc);
  assert.equal(sc.basis, 'existing');
  assert.deepEqual(sc.evidence, ['property_type', 'sport_court_available']);
  assert.ok(!missingEvidence(p).some((x) => x.categoryKey === 'sport_court'));
});

test('an owner attribute that is not owner-confirmed does not emit and is still asked', () => {
  const p = laFixture({ pasture_available: S(true, 'estimated', 0.9) });
  assert.ok(!ids(identifyOpportunities(p, { now: NOW })).includes('pasture'));
  assert.ok(missingEvidence(p).some((x) => x.categoryKey === 'pasture'));
  const no = laFixture({ pasture_available: S(false, 'owner-confirmed', 1) });
  assert.ok(!missingEvidence(no).some((x) => x.categoryKey === 'pasture'));
});

test('includeInvestmentIdeas adds adu as construction, never existing, with a cost-unknown note', () => {
  const base = ids(identifyOpportunities(laFixture(), { now: NOW }));
  assert.ok(!base.includes('adu'));
  const o = identifyOpportunities(laFixture(), { now: NOW, includeInvestmentIdeas: true });
  const adu = by(o, 'adu');
  assert.equal(adu.basis, 'construction');
  assert.ok(adu.notes.some((n) => /unknown/.test(n)));
  assert.ok(o.every((x) => x.id !== 'ev_charging'), 'no parking evidence, so no charger idea');
  const withPark = identifyOpportunities(laFixture({ parking_spaces: S(2, 'owner-confirmed', 1) }), { now: NOW, includeInvestmentIdeas: true });
  assert.equal(by(withPark, 'ev_charging').basis, 'construction');
  // an existing ADU is the auto 'permit' opportunity, not an idea
  const existing = by(identifyOpportunities(laFixture({ adu_present: S(true) }), { now: NOW, includeInvestmentIdeas: true }), 'adu');
  assert.equal(existing.basis, 'permit');
});

test('missingEvidence lists every owner category with its own question', () => {
  const m = missingEvidence(laFixture());
  const sc = m.find((x) => x.categoryKey === 'sport_court');
  assert.deepEqual(sc.needs, ['sport_court_available']);
  assert.match(sc.question, /sport court/i);
  assert.equal(sc.evidenceClass, 'owner');
  for (const k of ['pasture', 'beehive_site', 'film_location', 'kitchen', 'rv_parking', 'yard_campsite', 'ev_charging', 'workspace', 'kayak'])
    assert.ok(m.some((x) => x.categoryKey === k && x.evidenceClass === 'owner' && x.question.length > 10), k);
  assert.ok(m.some((x) => x.categoryKey === 'parking_spot' && x.evidenceClass === 'auto'));
  const keys = m.map((x) => x.categoryKey);
  assert.deepEqual(keys, [...keys].sort());
  assert.deepEqual(m, missingEvidence(laFixture()));
});

test('data: every category has a valid evidence policy; owner keys are exported', () => {
  for (const c of CATEGORIES) {
    assert.ok(['auto', 'owner', 'none'].includes(c.evidence?.class), c.key);
    if (c.evidence.class === 'owner') {
      assert.ok(c.evidence.ownerKeys.length && c.evidence.question.length > 10, c.key);
      for (const k of c.evidence.ownerKeys) assert.ok(OWNER_ATTRIBUTE_KEYS.includes(k), k);
      assert.ok(JSON.stringify(c.requires).includes('"ownerOnly":true'), c.key);
    }
    if (c.evidence.class === 'auto') assert.ok(!JSON.stringify(c.requires).includes('ownerOnly'), c.key);
    if (c.evidence.investment) assert.ok(['construction', 'permit'].includes(c.evidence.investment.basis));
  }
  assert.deepEqual(OWNER_ATTRIBUTE_KEYS, [...OWNER_ATTRIBUTE_KEYS].sort());
  for (const k of ['sport_court_available', 'equipment_owned', 'attic_present', 'waterfront_access']) assert.ok(OWNER_ATTRIBUTE_KEYS.includes(k), k);
  const auto = CATEGORIES.filter((c) => c.evidence.class === 'auto').map((c) => c.key).sort();
  assert.deepEqual(auto, ['adu', 'apartment_unit', 'backyard', 'entire_home', 'garage_storage', 'garden_plot', 'parking_spot', 'pool', 'private_room', 'rooftop_solar']);
});

test('resourceUse is present and valid on every category, shared consistently', () => {
  const VALID = new Set(['home_interior', 'yard', 'pool', 'garage', 'roof', 'parking']);
  for (const c of CATEGORIES) for (const [k, v] of Object.entries(c.resourceUse)) { assert.ok(VALID.has(k), `${c.key}:${k}`); assert.ok(Number.isInteger(v) && v > 0); }
  const use = (k) => CATEGORIES.find((c) => c.key === k).resourceUse;
  for (const k of ['entire_home', 'apartment_unit', 'private_room', 'film_location', 'kitchen', 'workspace', 'meeting_room']) assert.deepEqual(use(k), { home_interior: 1 }, k);
  for (const k of ['backyard', 'garden_plot', 'pasture', 'yard_campsite', 'sport_court', 'beehive_site']) assert.deepEqual(use(k), { yard: 1 }, k);
  assert.deepEqual(use('pool'), { yard: 1, pool: 1 });
  for (const k of ['parking_spot', 'rv_parking', 'ev_charging', 'fleet_parking', 'lot_parking']) assert.deepEqual(use(k), { parking: 1 }, k);
  assert.deepEqual(use('garage_storage'), { garage: 1 });
  assert.deepEqual(use('rooftop_solar'), { roof: 1 });
});

test('uses of the same yard or interior conflict, so they cannot be added up', () => {
  const p = laFixture({ beehive_site_available: S(true, 'owner-confirmed', 1), pasture_available: S(true, 'owner-confirmed', 1), kitchen_available: S(true, 'owner-confirmed', 1) });
  const o = identifyOpportunities(p, { now: NOW });
  assert.ok(by(o, 'beehive_site').conflictsWith.includes('backyard'));
  assert.ok(by(o, 'beehive_site').conflictsWith.includes('pasture'));
  assert.ok(by(o, 'pool').conflictsWith.includes('beehive_site'));
  assert.ok(by(o, 'kitchen').conflictsWith.includes('private_room'));
  assert.ok(by(o, 'entire_home').conflictsWith.includes('kitchen'));
  for (const a of o) for (const b of a.conflictsWith) assert.ok(by(o, b).conflictsWith.includes(a.id), `${a.id}/${b}`);
});

test('entire_home conflicts with garage storage (whole-property assumption)', () => {
  const o = identifyOpportunities(laFixture({ garage_present: S(true) }), { now: NOW });
  assert.ok(by(o, 'entire_home').conflictsWith.includes('garage_storage'));
  assert.ok(by(o, 'garage_storage').conflictsWith.includes('entire_home'));
});

test('defaultResourceCapacity for 0, 1 and 2 parking spaces and when unknown', () => {
  const cap = (extra) => defaultResourceCapacity(laFixture(extra));
  assert.deepEqual(cap({}), { home_interior: 1, yard: 1, pool: 1, garage: 1, roof: 1, parking: 0 });
  assert.equal(cap({ parking_spaces: S(0, 'owner-confirmed', 1) }).parking, 0);
  assert.equal(cap({ parking_spaces: S(1, 'measured') }).parking, 1);
  assert.equal(cap({ parking_spaces: S(2, 'owner-confirmed', 1) }).parking, 2);
  assert.equal(cap({ parking_spaces: S(3, 'estimated', 0.3) }).parking, 1, 'an estimated count only says parking exists');
  assert.equal(cap({ driveway_area_sqft: S(400, 'estimated', 0.5) }).parking, 1);
});

test('existing basis needs the asset itself: estimated driveway area alone is only setup', () => {
  const est = by(identifyOpportunities(laFixture({ driveway_area_sqft: S(400, 'estimated', 0.5) }), { now: NOW }), 'parking_spot');
  assert.equal(est.basis, 'setup');
  const meas = by(identifyOpportunities(laFixture({ parking_spaces: S(2, 'measured') }), { now: NOW }), 'parking_spot');
  assert.equal(meas.basis, 'existing');
  const garage = by(identifyOpportunities(laFixture({ garage_present: S(true, 'estimated', 0.6) }), { now: NOW }), 'garage_storage');
  assert.equal(garage.basis, 'existing', 'an observed (mapped) garage is the asset itself');
});

test('a yard alone evidences only backyard and garden_plot', () => {
  const p = profile({ property_type: S('single_family'), yard_area_sqft: S(5000, 'measured'), lot_area_sqft: S(9000) });
  assert.deepEqual(ids(identifyOpportunities(p, { now: NOW })), ['backyard', 'entire_home', 'garden_plot']); // entire_home needs only property_type
  for (const id of NOT_FROM_YARD) assert.ok(!ids(identifyOpportunities(p, { now: NOW })).includes(id), id);
});

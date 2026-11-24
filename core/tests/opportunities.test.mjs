import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyOpportunities, missingEvidence, evaluateRule } from '../opportunities.js';
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
  for (const id of ['entire_home', 'private_room', 'backyard', 'pool', 'parking_spot', 'yard_campsite', 'garden_plot']) assert.ok(ids(o).includes(id), id);
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
  assert.deepEqual(got, ['entire_home', 'ev_charging', 'parking_spot', 'private_room']);
  for (const no of ['backyard', 'pool', 'rooftop_solar', 'adu']) assert.ok(!got.includes(no));
});

test('bare land: only land categories, no home or roof categories', () => {
  const p = profile({ property_type: S('land'), jurisdiction: S(LA), lot_area_sqft: S(20000), roof_area_sqft: UNAV });
  const got = ids(identifyOpportunities(p, { now: NOW }));
  assert.deepEqual(got, ['garden_plot', 'parking_spot', 'pasture', 'rv_parking', 'sport_court', 'yard_campsite']);
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
  const absent = by(identifyOpportunities(sfh({ lot_area_sqft: S(6000), adu_present: S(false) }), { now: NOW }), 'adu');
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
  const p = profile({ property_type: S('commercial'), roof_area_sqft: S(4000), parking_spaces: S(30), lot_area_sqft: S(9000) });
  const o = identifyOpportunities(p, { now: NOW });
  assert.deepEqual(by(o, 'rooftop_solar').conflictsWith, ['telecom_site']);
  const lot = by(o, 'lot_parking');
  assert.deepEqual(lot.resourceUse, { parking: 1 });
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
    assert.match(c.sourceRef, /^index\.html:\d+$/);
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

test('data: category keys match index.html CATEGORIES key lines', async () => {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').split('\n');
  for (const c of CATEGORIES) {
    const n = Number(c.sourceRef.split(':')[1]);
    assert.ok(lines[n - 1].startsWith(`  ${c.key}: c(`), `${c.key} @ ${n}`);
  }
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

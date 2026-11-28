import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerQuestions, evaluateAskWhen, heldBack, missingEvidence, identifyOpportunities, OWNER_ATTRIBUTE_KEYS } from '../opportunities.js';
import { QUESTION_DEFS, ASK_CUTOFFS, SIZE_INPUTS, CATEGORIES, GEAR_CHOICES } from '../data/categories.js';
import { INPUT_KEYS, defaultInputs } from '../revenue.js';

const NOW = '2026-11-27T00:00:00Z';
const S = (value, tag = 'measured', confidence = 0.9) => ({ value, tag, source: 'test', retrievedAt: null, confidence });
const OWN = (v) => S(v, 'owner-confirmed', 1);
const profile = (attrs) => ({ attributes: attrs, history: {} });
const house = (extra = {}, lot = 5200) => profile({ property_type: S('single_family'), lot_area_sqft: S(lot), bedrooms: S(3), ...extra });
const keys = (list) => list.map((q) => q.key);

test('evaluateAskWhen: every leaf and the combinators; an unknown lot is never large; a missing attribute is never true', () => {
  const p = house({ pool_present: S(true) }, 30000);
  assert.equal(evaluateAskWhen(undefined, p), true, 'no rule: asked');
  assert.equal(evaluateAskWhen({ propertyType: ['single_family'] }, p), true);
  assert.equal(evaluateAskWhen({ propertyType: ['condo'] }, p), false);
  assert.equal(evaluateAskWhen({ lotAtLeast: 'smallLand' }, p), true);
  assert.equal(evaluateAskWhen({ lotAtLeast: 'pasture' }, p), false, 'under two acres');
  assert.equal(evaluateAskWhen({ lotAtLeast: 'smallLand' }, house({}, ASK_CUTOFFS.smallLand)), true, 'exactly the cut-off counts');
  assert.equal(evaluateAskWhen({ lotAtLeast: 'smallLand' }, house({}, ASK_CUTOFFS.smallLand - 1)), false);
  const noLot = profile({ property_type: S('single_family') });
  assert.equal(evaluateAskWhen({ lotAtLeast: 'smallLand' }, noLot), false, 'unknown lot size: not asked');
  assert.equal(evaluateAskWhen({ lotAtLeast: 'nonsense' }, p), false, 'an unknown cut-off name never asks');
  assert.equal(evaluateAskWhen({ attrTrue: 'water_nearby' }, p), false, 'no water fact: not relevant');
  assert.equal(evaluateAskWhen({ attrTrue: 'water_nearby' }, house({ water_nearby: S(true) })), true);
  assert.equal(evaluateAskWhen({ attrTrue: 'pool_present' }, p), true);
  assert.equal(evaluateAskWhen({ attrKnown: 'pool_present' }, p), true);
  assert.equal(evaluateAskWhen({ attrUnknown: 'pool_present' }, p), false);
  assert.equal(evaluateAskWhen({ all: [{ attrKnown: 'pool_present' }, { propertyType: ['condo'] }] }, p), false);
  assert.equal(evaluateAskWhen({ any: [{ attrKnown: 'pool_present' }, { propertyType: ['condo'] }] }, p), true);
  assert.equal(evaluateAskWhen({ not: { propertyType: ['condo'] } }, p), true);
  assert.equal(evaluateAskWhen({ never: true }, p), false);
  assert.ok(ASK_CUTOFFS.smallLand > 0 && ASK_CUTOFFS.pasture > ASK_CUTOFFS.smallLand, 'named, conservative cut-offs');
});

test('nothing is asked until the property type is known', () => {
  for (const p of [profile({}), profile({ property_type: S('unknown') }), profile({ property_type: { value: null, tag: 'unavailable', source: 't', retrievedAt: null, confidence: 0 } })]) {
    assert.deepEqual(ownerQuestions(p), { ask: [], lessCommon: [], answered: [], unknown: [] });
  }
});

test('a city house is asked the everyday questions, not water, pasture, beehives or camping; those wait under "less common"', () => {
  const r = ownerQuestions(house());
  const ask = keys(r.ask), less = keys(r.lessCommon);
  for (const k of ['pool_present', 'garage_present', 'attic_present', 'basement_present', 'shed_present', 'workspace_available', 'equipment_owned']) assert.ok(ask.includes(k), `${k} asked`);
  for (const k of ['waterfront_access', 'pasture_available', 'beehive_site_available', 'yard_campsite_available']) { assert.ok(!ask.includes(k), `${k} not asked`); assert.ok(less.includes(k), `${k} reachable`); }
  for (const k of ['telecom_site_available', 'parcel_locker_available', 'kitchen_available']) assert.ok(!ask.includes(k), `${k} is a business-style idea, not asked of a house`);
  assert.deepEqual(ask, [...ask].sort((a, b) => QUESTION_DEFS.find((d) => d.key === a).order - QUESTION_DEFS.find((d) => d.key === b).order), 'in flow order');
  assert.ok(!ask.includes('hoa_allows_rentals') && !ask.includes('units_available_to_rent'), 'no condo or building questions for a house');
});

test('a large lot is asked the land questions; an unknown lot size is not; water only with a water fact', () => {
  const big = keys(ownerQuestions(house({}, 90000)).ask);
  for (const k of ['pasture_available', 'beehive_site_available', 'yard_campsite_available']) assert.ok(big.includes(k), k);
  const mid = keys(ownerQuestions(house({}, 30000)).ask);
  assert.ok(mid.includes('beehive_site_available') && mid.includes('yard_campsite_available') && !mid.includes('pasture_available'));
  const none = ownerQuestions(profile({ property_type: S('single_family') }));
  for (const k of ['pasture_available', 'beehive_site_available', 'yard_campsite_available']) { assert.ok(!keys(none.ask).includes(k)); assert.ok(keys(none.lessCommon).includes(k), `${k} still reachable`); }
  assert.ok(!keys(ownerQuestions(house({}, 90000)).ask).includes('waterfront_access'));
  assert.ok(keys(ownerQuestions(house({ water_nearby: S(true) })).ask).includes('waterfront_access'));
});

test('evidence already in the profile: a known pool or garage is not asked; condo and building questions follow what is owned', () => {
  const known = keys(ownerQuestions(house({ pool_present: S(true, 'estimated', 0.5), garage_present: S(false) })).ask);
  assert.ok(!known.includes('pool_present') && !known.includes('garage_present'));
  const condo = ownerQuestions(profile({ property_type: S('condo'), lot_area_sqft: S(40000) }));
  assert.deepEqual(keys(condo.ask).filter((k) => ['hoa_allows_rentals', 'assigned_parking_spaces', 'storage_unit_present', 'balcony_present'].includes(k)), ['hoa_allows_rentals', 'assigned_parking_spaces', 'storage_unit_present', 'balcony_present']);
  for (const k of ['pool_present', 'garage_present', 'attic_present', 'basement_present', 'shed_present', 'yard_area_sqft', 'adu_present', 'parking_spaces', 'units_available_to_rent', 'pasture_available']) assert.ok(![...condo.ask, ...condo.lessCommon].some((q) => q.key === k), `${k} never for a condo`);
  const bld = ownerQuestions(profile({ property_type: S('multi_family'), lot_area_sqft: S(8000), units: S(12) }));
  assert.deepEqual(keys(bld.ask).slice(0, 5), ['units_available_to_rent', 'parking_spaces', 'laundry_room_present', 'roof_access_present', 'roof_type']);
  assert.equal(bld.ask.find((q) => q.key === 'parking_spaces').question, 'How many parking spaces does the building have?');
  assert.ok(keys(bld.lessCommon).includes('kitchen_available') === false && keys(bld.ask).includes('kitchen_available'), 'business-style ideas are asked of buildings');
  const land = ownerQuestions(profile({ property_type: S('land'), lot_area_sqft: S(120000) }));
  for (const k of ['attic_present', 'basement_present', 'shed_present', 'garage_present', 'pool_present', 'hoa_allows_rentals']) assert.ok(![...land.ask, ...land.lessCommon].some((q) => q.key === k), `${k} never for land`);
  for (const k of ['pasture_available', 'yard_campsite_available']) assert.ok(keys(land.ask).includes(k), k);
});

test('basement and shed are two separate questions; answering one never sets or implies the other', () => {
  const b = QUESTION_DEFS.find((d) => d.key === 'basement_present'), s = QUESTION_DEFS.find((d) => d.key === 'shed_present');
  assert.notEqual(b.question, s.question);
  assert.match(b.question, /basement/i); assert.doesNotMatch(b.question, /shed/i);
  assert.match(s.question, /shed/i); assert.doesNotMatch(s.question, /basement/i);
  const cat = CATEGORIES.find((c) => c.key === 'basement_storage');
  assert.equal(cat.evidence.questions.basement_present, b.question);
  assert.equal(cat.evidence.questions.shed_present, s.question);
  // a Yes to the basement leaves the shed to be asked; a No to the basement does not answer the shed
  for (const v of [true, false]) {
    const r = ownerQuestions(house({ basement_present: OWN(v) }));
    assert.ok(keys(r.ask).includes('shed_present'), `shed still asked after basement=${v}`);
    assert.ok(r.answered.some((q) => q.key === 'basement_present') && !r.answered.some((q) => q.key === 'shed_present'));
  }
  // either one unlocks the storage option (unchanged logic)
  const ids = (p) => identifyOpportunities(p, { now: NOW }).map((o) => o.id);
  assert.ok(ids(house({ basement_present: OWN(true) })).includes('basement_storage'));
  assert.ok(ids(house({ shed_present: OWN(true) })).includes('basement_storage'));
  assert.ok(!ids(house({ basement_present: OWN(false) })).includes('basement_storage'));
  // the owner-facing text of the missing evidence has one question per key
  const m = missingEvidence(house()).find((x) => x.categoryKey === 'basement_storage');
  assert.match(m.question, /basement/); assert.match(m.question, /shed/);
  assert.ok(m.question.split('?').filter(Boolean).length >= 2, 'two questions, not one');
});

test('"I don\'t know": the key is not asked again, is listed as unknown, and holds back its option with one plain line', () => {
  const p = house();
  const r = ownerQuestions(p, { asked: ['attic_present'] });
  assert.ok(!keys(r.ask).includes('attic_present') && !keys(r.lessCommon).includes('attic_present'));
  assert.deepEqual(keys(r.unknown), ['attic_present']);
  assert.ok(!r.answered.some((q) => q.key === 'attic_present'), 'not an answer');
  assert.ok(!identifyOpportunities(p, { now: NOW }).some((o) => o.id === 'attic_storage'), 'never treated as Yes');
  assert.ok(!missingEvidence(p, { asked: ['attic_present'] }).some((x) => x.needs.includes('attic_present')), 'missingEvidence skips it');
  assert.ok(missingEvidence(p).some((x) => x.needs.includes('attic_present')));
  const held = heldBack(p, ['attic_present']);
  assert.deepEqual(held.map((h) => h.key), ['attic_present']);
  assert.equal(held[0].line, 'Tell us if you have an attic to see storage income');
  assert.deepEqual(held[0].labels, ['Attic storage']);
  assert.deepEqual(heldBack(p, []), []);
  assert.deepEqual(heldBack(house({ attic_present: OWN(false) }), ['attic_present']), [], 'an answered question holds nothing back');
  const gear = heldBack(p, ['equipment_owned']);
  assert.equal(gear.length, 1, 'all the gear options share one line');
  assert.ok(gear[0].labels.length >= 7);
});

test('size follow-ups: after a Yes, right after the parent, for spaces whose value depends on size; never for the others', () => {
  const r = ownerQuestions(house({ attic_present: OWN(true) }));
  const ask = keys(r.ask);
  assert.equal(ask[ask.indexOf('attic_area_sqft') - 1] ?? 'first', ask[ask.indexOf('attic_area_sqft') - 1], 'present');
  assert.ok(ask.includes('attic_area_sqft') && !ask.includes('attic_present'));
  const f = r.ask.find((q) => q.key === 'attic_area_sqft');
  assert.deepEqual([f.type, f.unit, f.parent, f.question], ['number', 'sq ft', 'attic_present', 'About how big is the attic?']);
  assert.equal(r.ask.find((q) => q.key === 'basement_present').order > f.order, true, 'before the next parent');
  assert.ok(!ask.includes('basement_area_sqft') && !ask.includes('shed_area_sqft'), 'no basement size without a basement Yes');
  // answered size: listed as answered, not asked again; "I don't know" to the size: not asked again
  const done = ownerQuestions(house({ attic_present: OWN(true), attic_area_sqft: OWN(300) }));
  assert.ok(!keys(done.ask).includes('attic_area_sqft'));
  assert.ok(done.answered.some((q) => q.key === 'attic_area_sqft' && q.value === 300));
  assert.deepEqual(keys(ownerQuestions(house({ attic_present: OWN(true) }), { asked: ['attic_area_sqft'] }).unknown), ['attic_area_sqft']);
  // a garage the picture already shows, with no size from the lookup, is asked its size; with a size it is not
  assert.ok(keys(ownerQuestions(house({ garage_present: S(true) })).ask).includes('garage_area_sqft'));
  assert.ok(!keys(ownerQuestions(house({ garage_present: S(true), garage_area_sqft: S(400) })).ask).includes('garage_area_sqft'));
  assert.ok(!keys(ownerQuestions(house({ garage_present: S(false) })).ask).includes('garage_area_sqft'));
  // every size key can be stored as an owner answer
  for (const d of QUESTION_DEFS.filter((x) => x.size)) assert.ok(OWNER_ATTRIBUTE_KEYS.includes(d.size.key), d.size.key);
  assert.deepEqual(OWNER_ATTRIBUTE_KEYS, [...OWNER_ATTRIBUTE_KEYS].sort());
});

test('a size only feeds an input that exists: today none does, so estimates are identical and the option says so', () => {
  for (const [cat, m] of Object.entries(SIZE_INPUTS)) { assert.ok(CATEGORIES.some((c) => c.key === cat)); assert.ok(INPUT_KEYS.includes(m.input), `${cat} -> ${m.input} is a real revenue input`); }
  assert.deepEqual(Object.keys(SIZE_INPUTS), [], 'the revenue model has no size-dependent input yet');
  const base = house({ attic_present: OWN(true) });
  const sized = house({ attic_present: OWN(true), attic_area_sqft: OWN(900) });
  const oa = identifyOpportunities(base, { now: NOW }).find((o) => o.id === 'attic_storage');
  const ob = identifyOpportunities(sized, { now: NOW }).find((o) => o.id === 'attic_storage');
  assert.deepEqual(defaultInputs(ob, sized), defaultInputs(oa, base), 'the inputs do not change with the size');
  assert.ok(ob.notes.some((n) => /900 sq ft.*not yet used in this estimate/.test(n)), 'said honestly');
  assert.ok(!oa.notes.some((n) => /not yet used/.test(n)));
  // a size from a lookup (not the owner's) adds no note
  const looked = identifyOpportunities(house({ garage_present: S(true), garage_area_sqft: S(400) }), { now: NOW }).find((o) => o.id === 'garage_storage');
  assert.ok(!looked.notes.some((n) => /not yet used/.test(n)));
});

test('gear is one question with a tick-list, not seven; question texts are short, plain and one idea each', () => {
  const r = ownerQuestions(house());
  assert.equal(r.ask.filter((q) => q.type === 'gear').length, 1);
  assert.equal(r.ask.find((q) => q.type === 'gear').question, 'Do you own any gear you would rent out?');
  assert.deepEqual(GEAR_CHOICES.map((g) => g[0]), ['atv', 'snowmobile', 'kayak', 'boat', 'jet_ski', 'ebike', 'camper']);
  for (const k of GEAR_CHOICES) assert.ok(CATEGORIES.some((c) => c.key === k[0]), `${k[0]} is a gear category`);
  for (const d of QUESTION_DEFS) {
    assert.ok(d.question.split(/\s+/).length <= 13, `short: ${d.question}`);
    assert.ok(d.question.endsWith('?'), d.question);
    assert.ok(!/ or .* or /.test(d.question) && !/basement or shed/i.test(d.question), `one idea: ${d.question}`);
    assert.ok(d.hold && d.hold.length > 10, `${d.key} has a hold line`);
  }
  for (const c of CATEGORIES) assert.doesNotMatch(c.evidence?.question ?? '', /\ba (ATV|e-bike)\b/, 'no "a ATV"');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfile, setAttribute, applyOwnerCorrection, getAttribute, summarize } from '../profile.js';
import { sourced, unavailable } from '../provenance.js';

const auto = (v, t = '2026-01-01T00:00:00Z', c = 0.8) => sourced(v, { tag: 'measured', source: 'Assessor', confidence: c, retrievedAt: t, unit: 'sqft' });

test('createProfile is empty and each call is distinct', () => {
  const a = createProfile(), b = createProfile();
  assert.deepEqual(a, { attributes: {}, history: {} });
  assert.notEqual(a, b);
});

test('setAttribute returns a new profile and never mutates the old one', () => {
  const p0 = createProfile();
  const snap = JSON.stringify(p0);
  const p1 = setAttribute(p0, 'lot_area_sqft', auto(5000));
  assert.equal(JSON.stringify(p0), snap);
  assert.notEqual(p0, p1);
  assert.equal(p1.attributes.lot_area_sqft.value, 5000);
  const snap1 = JSON.stringify(p1);
  const p2 = setAttribute(p1, 'lot_area_sqft', auto(5100, '2026-02-01T00:00:00Z'));
  assert.equal(JSON.stringify(p1), snap1);
  assert.equal(p1.history.lot_area_sqft.length, 1);
  assert.equal(p2.history.lot_area_sqft.length, 2);
});

test('history keeps every value and attributes[key] equals resolve(history[key])', () => {
  let p = createProfile();
  p = setAttribute(p, 'bedrooms', auto(3, '2026-01-01T00:00:00Z', 0.5));
  p = setAttribute(p, 'bedrooms', auto(4, '2026-02-01T00:00:00Z', 0.9));
  p = setAttribute(p, 'bedrooms', unavailable('later lookup failed'));
  assert.deepEqual(p.history.bedrooms.map((s) => s.value), [3, 4, null]);
  assert.equal(p.attributes.bedrooms.value, 4, 'an unavailable refresh never hides a real value');
});

test('owner correction overrides the automated value', () => {
  let p = setAttribute(createProfile(), 'living_area_sqft', auto(1450));
  p = applyOwnerCorrection(p, 'living_area_sqft', 1600, '2026-03-01T00:00:00Z', 'sqft');
  const a = getAttribute(p, 'living_area_sqft');
  assert.deepEqual([a.value, a.tag, a.unit, a.confidence], [1600, 'owner-confirmed', 'sqft', 1]);
});

test('an automated refresh arriving AFTER an owner correction does not override it', () => {
  let p = setAttribute(createProfile(), 'living_area_sqft', auto(1450));
  p = applyOwnerCorrection(p, 'living_area_sqft', 1600, '2026-03-01T00:00:00Z', 'sqft');
  p = setAttribute(p, 'living_area_sqft', auto(1475, '2026-09-01T00:00:00Z', 0.99));
  assert.equal(p.attributes.living_area_sqft.value, 1600);
  assert.equal(p.history.living_area_sqft.length, 3);
});

test('owner can correct false and a later correction wins', () => {
  let p = applyOwnerCorrection(createProfile(), 'pool_present', true, '2026-01-01T00:00:00Z');
  p = applyOwnerCorrection(p, 'pool_present', false, '2026-02-01T00:00:00Z');
  assert.equal(p.attributes.pool_present.value, false);
});

test('getAttribute on a missing key is unavailable, not a guess', () => {
  const a = getAttribute(createProfile(), 'zoning');
  assert.deepEqual([a.tag, a.value], ['unavailable', null]);
});

test('setAttribute rejects a bare value', () => {
  assert.throws(() => setAttribute(createProfile(), 'bedrooms', 3), /Sourced/);
});

test('summarize returns display rows', () => {
  let p = setAttribute(createProfile(), 'lot_area_sqft', auto(5000));
  p = setAttribute(p, 'zoning', unavailable('none integrated', 'Everyspace'));
  assert.deepEqual(summarize(p), [
    { key: 'lot_area_sqft', value: 5000, unit: 'sqft', tag: 'measured', source: 'Assessor', confidence: 0.8, confidenceLabel: 'high', retrievedAt: '2026-01-01T00:00:00Z' },
    { key: 'zoning', value: null, unit: undefined, tag: 'unavailable', source: 'Everyspace', confidence: 0, confidenceLabel: 'low', retrievedAt: null },
  ]);
});

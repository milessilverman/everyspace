import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateRoof, defaultPitchRise, DEFAULT_PITCH_RISE } from '../roof.js';

const NOW = '2026-11-27T12:00:00Z';
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

// City Pretty tests/unit/safetyRules.test.ts:17-21 — no recorded inputs gives no estimate
test('no footprint and no living area -> unavailable with a reason (City Pretty safetyRules case)', () => {
  for (const inp of [{}, { stories: 1 }, { footprintSqft: 150 }, { footprintSqft: null, livingSqft: null }]) {
    const r = estimateRoof(inp, { now: NOW });
    assert.equal(r.ok, false); assert.equal(r.roof.tag, 'unavailable'); assert.equal(r.roof.value, null); assert.match(r.roof.note, /no building footprint/);
  }
  assert.equal(estimateRoof(undefined).ok, false);
});

// City Pretty tests/e2e/site.spec.ts:1911-1923 — unknown year is not assumed; 1960 gets the 1945-78 pitch; an outline gives more than its plan area
test('default pitch by era and state (City Pretty roofAreaEngine.js:10-28)', () => {
  assert.equal(defaultPitchRise(null, 'TX').rise, 5.5);
  assert.equal(defaultPitchRise(1960, 'TX').rise, 4.5);
  assert.equal(defaultPitchRise(1939, 'CA').rise, 7.5); assert.equal(defaultPitchRise(1940, 'CA').rise, 5.5); assert.equal(defaultPitchRise(1944, 'CA').rise, 5.5);
  assert.equal(defaultPitchRise(1945, 'CA').rise, 4.5); assert.equal(defaultPitchRise(1978, 'CA').rise, 4.5); assert.equal(defaultPitchRise(1979, 'CA').rise, 5.5);
  assert.equal(defaultPitchRise(1990, 'az').rise, 3.5); assert.equal(defaultPitchRise(1900, 'MN').rise, 8.0); assert.equal(defaultPitchRise(1990, 'MN').rise, 7.0);
  assert.equal(defaultPitchRise(1960).rise, 4.5, 'state defaults to CA');
  assert.ok(estimateRoof({ footprintSqft: 1800, stateCode: 'TX' }, { now: NOW }).roof.value > 1800);
});

test('hand-computed: 1,400 sq ft outline built 1952 -> 4.5:12 gable -> 1400 x 1.068 x 1.05 = 1570', () => {
  const r = estimateRoof({ footprintSqft: 1400, yearBuilt: 1952 }, { now: NOW });
  assert.equal(r.ok, true); assert.equal(r.roof.value, 1570); assert.equal(r.roof.tag, 'estimated'); assert.equal(r.roof.unit, 'sqft'); assert.equal(r.roof.retrievedAt, NOW);
  assert.deepEqual([r.planAreaSqft, r.slopeFactor, r.pitchRise, r.pitchDegrees, r.roofShape, r.shapeMultiplier, r.eavesSqft, r.garageSqft], [1400, 1.068, 4.5, 20.6, 'gable', 1.05, 0, 0]);
  assert.ok(r.roof.confidence <= 0.3, 'default pitch stays low confidence');
  assert.match(r.roof.method, /typical pitch for homes built 1952/); assert.match(r.roof.note, /typical value/); assert.match(r.roof.note, /rule of thumb/);
});

test('hand-computed: no outline -> living area / stories, 380 sq ft garage and 18 in eaves are added (City Pretty lines 82-98)', () => {
  const r = estimateRoof({ livingSqft: 1800, yearBuilt: 1990 }, { now: NOW });
  // plan 1800 + garage 380 + eaves 267 = 2447; slope sqrt(144+5.5^2)/12 = 1.1; x 1.05 gable
  assert.deepEqual([r.footprintSqft, r.garageSqft, r.eavesSqft, r.planAreaSqft, r.slopeFactor, r.roof.value], [1800, 380, 267, 2447, 1.1, 2826]);
  assert.equal(estimateRoof({ livingSqft: 3000, stories: 2, yearBuilt: 1990 }, { now: NOW }).garageSqft, 400);
});

test('owner-supplied pitch is used and raises confidence; degrees and rise agree', () => {
  const d = estimateRoof({ footprintSqft: 1400, yearBuilt: 1952 }, { now: NOW });
  const o = estimateRoof({ footprintSqft: 1400, yearBuilt: 1952, pitchRise: 6 }, { now: NOW });
  assert.equal(o.roof.value, 1643); assert.equal(o.pitchRise, 6); assert.ok(o.roof.confidence > d.roof.confidence); assert.match(o.roof.method, /owner-supplied pitch/); assert.match(o.roof.note, /pitch you gave/);
  const deg = estimateRoof({ footprintSqft: 1400, pitchDegrees: 30 }, { now: NOW });
  assert.equal(deg.slopeFactor, 1.1547); assert.equal(deg.roof.value, 1697);
  assert.equal(estimateRoof({ footprintSqft: 1400, pitchRise: 99 }, { now: NOW }).pitchRise, 18, 'clamped to City Pretty 0.5..18');
});

test('roof type: shape multipliers 1.01 / 1.05 / 1.08 / 1.16; owner "flat" -> 0.5:12', () => {
  const v = (roofType) => estimateRoof({ footprintSqft: 1400, pitchRise: 6, roofType }, { now: NOW });
  assert.deepEqual(['flat', 'gable', 'hip', 'complex'].map((t) => v(t).shapeMultiplier), [1.01, 1.05, 1.08, 1.16]);
  assert.ok(v('hip').roof.value > v('gable').roof.value && v('complex').roof.value > v('hip').roof.value);
  const f = estimateRoof({ footprintSqft: 1400, roofType: 'flat' }, { now: NOW });
  assert.equal(f.roof.value, 1415); assert.equal(f.pitchRise, 0.5);
});

test('monotonic: steeper pitch -> larger roof; larger footprint -> larger roof', () => {
  let prev = 0; for (const rise of [0.5, 2, 4, 6, 8, 12, 18]) { const v = estimateRoof({ footprintSqft: 1500, pitchRise: rise, roofType: 'gable' }, { now: NOW }).roof.value; assert.ok(v > prev, `rise ${rise}`); prev = v; }
  prev = 0; for (const fp of [300, 900, 1500, 2500]) { const v = estimateRoof({ footprintSqft: fp, yearBuilt: 1960 }, { now: NOW }).roof.value; assert.ok(v > prev); prev = v; }
});

test('condo and multi-family are unavailable; deterministic; inputs not mutated; no clock', () => {
  assert.match(estimateRoof({ footprintSqft: 9000, propertyType: 'condo' }).roof.note, /not one unit/);
  assert.equal(estimateRoof({ footprintSqft: 9000, propertyType: 'multi_family' }).ok, false);
  const inp = deepFreeze({ footprintSqft: 1400, yearBuilt: 1952, stories: 1 });
  const a = estimateRoof(inp, { now: NOW }), b = estimateRoof(inp, { now: NOW });
  assert.deepEqual(a, b);
  assert.equal(estimateRoof(inp).roof.retrievedAt, null, 'no hidden clock');
  assert.ok(Object.isFrozen(DEFAULT_PITCH_RISE));
});

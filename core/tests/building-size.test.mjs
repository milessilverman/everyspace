import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateFloors } from '../building-size.js';

const NOW = '2026-11-27T12:00:00Z';

test('building:levels is used first (StreetForge streetforge2d.html:14177 `b.levels || ...`)', () => {
  const r = estimateFloors({ levelsTag: '3', heightFt: 100, livingAreaSqft: 1000, footprintSqft: 1000 }, { now: NOW });
  assert.equal(r.floors.value, 3); assert.equal(r.floors.tag, 'estimated'); assert.match(r.floors.source, /building:levels/);
  assert.equal(estimateFloors({ levelsTag: 2 }).floors.value, 2);
  assert.equal(estimateFloors({ levelsTag: 'abc' }).ok, false); assert.equal(estimateFloors({ levelsTag: 0 }).ok, false); assert.equal(estimateFloors({ levelsTag: 1.5 }).ok, false);
});

test('height -> floors with StreetForge 3.4 m per storey, min 1, max 60 (streetforge2d.html:14384)', () => {
  const f = (h) => estimateFloors({ heightFt: h }, { now: NOW }).floors.value;
  assert.equal(f(24.5), 2);           // 7.47 m / 3.4 = 2.2
  assert.equal(f(11), 1);             // 3.35 m -> 0.99 -> 1
  assert.equal(f(5), 1);              // 1.5 m -> 0.45 -> 0 -> clamped to 1
  assert.equal(f(100), 9);            // 30.48 m / 3.4 = 8.96
  assert.equal(f(9000), 60);
  assert.ok(estimateFloors({ heightFt: 24.5 }).floors.confidence <= 0.3);
  assert.equal(f(20) <= f(40), true);
});

test('living area / footprint rule (moved unchanged from the profile assembler)', () => {
  for (const [live, fp, n] of [[1400, 1400, 1], [2200, 1100, 2], [4200, 1400, 3], [5600, 1400, 4], [700, 1000, 1]]) assert.equal(estimateFloors({ livingAreaSqft: live, footprintSqft: fp }).floors.value, n);
  const clean = estimateFloors({ livingAreaSqft: 2800, footprintSqft: 1400 }), amb = estimateFloors({ livingAreaSqft: 2200, footprintSqft: 1400 });
  assert.ok(clean.floors.confidence > amb.floors.confidence);
  const huge = estimateFloors({ livingAreaSqft: 9000, footprintSqft: 1400 });
  assert.equal(huge.ok, false); assert.match(huge.floors.note, /too high/);
});

test('missing inputs -> unavailable with a reason; deterministic; input not mutated', () => {
  assert.match(estimateFloors({ footprintSqft: 1400 }).floors.note, /no living area/);
  assert.match(estimateFloors({ livingAreaSqft: 1400 }).floors.note, /no main building footprint/);
  assert.equal(estimateFloors({}).floors.tag, 'unavailable'); assert.equal(estimateFloors(null).ok, false);
  const inp = Object.freeze({ livingAreaSqft: 2200, footprintSqft: 1100 });
  assert.deepEqual(estimateFloors(inp, { now: NOW }), estimateFloors(inp, { now: NOW }));
});

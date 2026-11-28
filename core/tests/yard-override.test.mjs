// The owner's own front/back yard outlines (measureFromGeometry `yards`), checked against hand-computed areas on a lot of plain rectangles.
// Lot 50 x 120 ft, house 30 x 30 ft at y 30..60, shed 10 x 10 ft at y 90..100, the street south of the lot. Automatic split: front band y 0..30
// = 1,500 sq ft; back band y > 60 = 3,000 - 100 (shed) = 2,900 sq ft; open ground = 6,000 - 900 - 100 = 5,000 sq ft.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureFromGeometry } from '../measure.js';

const NOW = '2026-11-27T12:00:00Z';
const LAT0 = 34, LNG0 = -118, FT = 0.3048, R = 6371008.8, RAD = Math.PI / 180;
const KX = R * Math.cos(LAT0 * RAD) * RAD, KY = R * RAD;
const P = (x, y) => [LNG0 + (x * FT) / KX, LAT0 + (y * FT) / KY];
const rect = (a, b, c, d) => ({ type: 'Polygon', coordinates: [[P(a, b), P(c, b), P(c, d), P(a, d), P(a, b)]] });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (±${tol})`);
const base = () => ({ parcel: rect(0, 0, 50, 120), buildings: [{ polygon: rect(10, 30, 40, 60), main: true }, { polygon: rect(15, 90, 25, 100), main: false }],
  frontEdge: { coordinates: [P(-5, -10), P(55, -10)] }, roof: { yearBuilt: 1950, propertyType: 'single_family', stories: 1, state: 'CA' } });
const M = (g) => measureFromGeometry(g, { now: NOW });

test('no override: the automatic split is unchanged (front band 1,500, back band 2,900)', () => {
  const m = M(base());
  near(m.front_yard_sqft, 1500, 2, 'front'); near(m.back_yard_sqft, 2900, 2, 'back');
  assert.equal(m.yardOverrides, undefined);
  assert.deepEqual(M({ ...base(), yards: {} }).back_yard_sqft, m.back_yard_sqft, 'empty yards object changes nothing');
});

test('a back-yard box covering the back band gives the same area; a box half the size gives half the area minus the building inside it', () => {
  near(M({ ...base(), yards: { back: rect(0, 60, 50, 120) } }).back_yard_sqft, 2900, 45, 'whole back band');
  const half = M({ ...base(), yards: { back: rect(0, 90, 50, 120) } });
  near(half.back_yard_sqft, 50 * 30 - 100, 25, 'north quarter minus the shed');
  near(half.front_yard_sqft, 1500, 2, 'the front yard keeps its own rule');
  assert.equal(half.yardOverrides.back, true);
});

test('an override reaching outside the lot is clipped to the lot', () => {
  const m = M({ ...base(), yards: { back: rect(-20, 90, 70, 140) } });
  near(m.back_yard_sqft, 50 * 30 - 100, 25, 'only the part on the lot');
});

test('the total open ground stays the lot minus the buildings', () => {
  const m = M({ ...base(), yards: { back: rect(0, 90, 50, 120) } });
  near(m.yard_area_sqft, 5000, 3, 'total');
});

test('overlapping front and back overrides: the one edited LATER wins the overlap', () => {
  const yards = { front: rect(0, 0, 50, 70), back: rect(0, 50, 50, 120) };
  // front (y 0..70) open = 3,500 - house part (y 30..60) 900 = 2,600; back (y 50..120) open = 3,500 - house part (y 50..60) 300 - shed 100 = 3,100;
  // overlap (y 50..70) open = 1,000 - house part (y 50..60) 300 = 700
  const b = M({ ...base(), yards: { ...yards, later: 'back' } });
  near(b.back_yard_sqft, 3100, 40, 'back wins'); near(b.front_yard_sqft, 2600 - 700, 40, 'front loses the overlap');
  const f = M({ ...base(), yards: { ...yards, later: 'front' } });
  near(f.front_yard_sqft, 2600, 40, 'front wins'); near(f.back_yard_sqft, 3100 - 700, 40, 'back loses the overlap');
  const d = M({ ...base(), yards: yards }); // default: back is the later one
  assert.equal(d.back_yard_sqft, b.back_yard_sqft);
  assert.equal(b.yardOverrides.later, 'back'); assert.equal(f.yardOverrides.later, 'front');
});

test('usable yard follows the overrides: an untouched front keeps its usable part; a smaller back box has a smaller usable back', () => {
  const m0 = M(base());
  const m = M({ ...base(), yards: { back: rect(0, 90, 50, 120) } });
  assert.equal(m.usable_front_yard_sqft, m0.usable_front_yard_sqft);
  assert.ok(m.usable_back_yard_sqft < m0.usable_back_yard_sqft, `${m.usable_back_yard_sqft} < ${m0.usable_back_yard_sqft}`);
  assert.ok(m.usable_back_yard_sqft <= m.back_yard_sqft);
  assert.ok(m.usable_yard_sqft === m0.usable_yard_sqft, 'the whole usable yard does not depend on the split');
  // a back override that swallows the old side band moves that usable ground into the back figure
  const big = M({ ...base(), yards: { back: rect(0, 30, 50, 120) } });
  assert.ok(big.usable_back_yard_sqft > m0.usable_back_yard_sqft);
  assert.equal(big.usable_yard_sqft, m0.usable_yard_sqft);
});

test('the driveway still stays out of the usable yard when a yard is overridden', () => {
  const dv = rect(0, 0, 10, 30);
  const a = M({ ...base(), driveway: dv, yards: { front: rect(0, 0, 50, 30) } });
  const b = M({ ...base(), yards: { front: rect(0, 0, 50, 30) } });
  assert.ok(a.usable_front_yard_sqft < b.usable_front_yard_sqft);
  near(a.front_yard_sqft, 1500, 25, 'the front figure still counts the driveway ground');
});

test('with no street reference an override still gives that yard a figure (the other stays unknown)', () => {
  const g = base(); delete g.frontEdge;
  const m = M({ ...g, yards: { front: rect(0, 0, 50, 30) } });
  near(m.front_yard_sqft, 1500, 25); assert.equal(m.back_yard_sqft, null);
  near(m.yard_area_sqft, 5000, 40, 'grid open ground');
});

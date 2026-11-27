import test from 'node:test';
import assert from 'node:assert/strict';
import { polygonAreaSqft, pointInPolygon, sumAreas, distanceM, centroid, yardAreaSqft } from '../geometry.js';

// The helper below uses 111,320 m per degree (equatorial radius), the same convention as tests/domain.test.mjs; the
// module uses the mean Earth radius, so areas differ by about 0.22%. Tolerances below are 0.5%.
// Build a rectangle `w` m east-west by `h` m north-south with its SW corner at (lat, lng).
function rect(lat, lng, w, h) {
  const dLat = h / 111320, dLng = w / (111320 * Math.cos(lat * Math.PI / 180));
  return [[lng, lat], [lng + dLng, lat], [lng + dLng, lat + dLat], [lng, lat + dLat], [lng, lat]];
}
const poly = (...rings) => ({ type: 'Polygon', coordinates: rings });
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} +/- ${tol}`);
const SQFT = 10.7639104167;

test('30 m x 20 m rectangle is 6,458 sq ft (matches the app tests), within 0.5%', () => {
  near(polygonAreaSqft(poly(rect(34, -118.3, 30, 20))), 600 * SQFT, 600 * SQFT * 0.005);
});

test('a 100 m square at 40N is 107,639 sq ft within 0.5%; area is independent of winding order', () => {
  const sq = rect(40, -75, 100, 100);
  near(polygonAreaSqft(poly(sq)), 10000 * SQFT, 10000 * SQFT * 0.005);
  near(polygonAreaSqft(poly([...sq].reverse())), 10000 * SQFT, 10000 * SQFT * 0.005);
});

test('one degree-ish: a 0.001 x 0.001 degree box at the equator is ~12,364 m^2 within 0.5%', () => {
  const g = poly([[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]);
  near(polygonAreaSqft(g), 111.195 * 111.195 * SQFT, 111.195 * 111.195 * SQFT * 0.005);
});

test('holes are subtracted; hole bigger than outer floors at 0', () => {
  const outer = rect(34, -118, 100, 100), hole = rect(34.0002, -117.9998, 20, 20);
  near(polygonAreaSqft(poly(outer, hole)), (10000 - 400) * SQFT, 9600 * SQFT * 0.005);
  assert.equal(polygonAreaSqft(poly(hole, outer)), 0);
});

test('MultiPolygon sums its parts (each with its own holes); Feature wrapper accepted', () => {
  const a = rect(34, -118, 10, 10), b = rect(34.01, -118, 20, 20), bh = rect(34.01005, -117.99995, 5, 5);
  const mp = { type: 'MultiPolygon', coordinates: [[a], [b, bh]] };
  near(polygonAreaSqft(mp), (100 + 400 - 25) * SQFT, 475 * SQFT * 0.005);
  assert.equal(polygonAreaSqft({ type: 'Feature', geometry: mp }), polygonAreaSqft(mp));
});

test('non-polygons throw', () => {
  assert.throws(() => polygonAreaSqft({ type: 'Point', coordinates: [0, 0] }), /unsupported/);
  assert.throws(() => polygonAreaSqft(null), /expected/);
});

test('sumAreas adds geometries', () => {
  const a = poly(rect(34, -118, 10, 10)), b = poly(rect(34, -117, 20, 5));
  near(sumAreas([a, b]), 200 * SQFT, 200 * SQFT * 0.005);
  assert.equal(sumAreas([]), 0);
});

test('pointInPolygon: inside, outside, in a hole, MultiPolygon', () => {
  const outer = rect(34, -118, 100, 100), hole = rect(34.0003, -117.9997, 20, 20);
  const g = poly(outer, hole);
  assert.equal(pointInPolygon({ lat: 34.0001, lng: -117.9999 }, g), true);
  assert.equal(pointInPolygon({ lat: 34.00035, lng: -117.99965 }, g), false, 'inside the hole');
  assert.equal(pointInPolygon({ lat: 34.5, lng: -118 }, g), false);
  const mp = { type: 'MultiPolygon', coordinates: [[outer], [rect(35, -118, 50, 50)]] };
  assert.equal(pointInPolygon({ lat: 35.0001, lng: -117.9999 }, mp), true);
});

test('distanceM (haversine): 1 degree of latitude ~ 111.2 km; same point is 0; symmetric', () => {
  near(distanceM({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }), 111195, 50);
  assert.equal(distanceM({ lat: 34, lng: -118 }, { lat: 34, lng: -118 }), 0);
  const a = { lat: 34.05, lng: -118.25 }, b = { lat: 33.94, lng: -118.41 };
  assert.equal(distanceM(a, b), distanceM(b, a));
  near(distanceM(a, b), 19180, 100, 'hand-computed: 0.11 deg lat = 12.23 km, 0.16 deg lng = 14.77 km at 34N -> 19.18 km');
});

test('centroid of a rectangle is its middle', () => {
  const c = centroid(poly(rect(34, -118, 100, 100)));
  near(c.lat, 34 + 50 / 111320, 1e-6);
});

test('yardAreaSqft: lot minus buildings whose centroid is on the parcel; outside buildings ignored; floored at 0', () => {
  const lot = poly(rect(34, -118, 40, 40));
  const inside = { polygon: poly(rect(34.0001, -117.9999, 10, 10)) };
  const outside = { polygon: poly(rect(34.01, -118, 10, 10)) };
  const r = yardAreaSqft(lot, [inside, outside]);
  assert.equal(r.buildingCount, 1);
  near(r.yardSqft, (1600 - 100) * SQFT, 1500 * SQFT * 0.005);
  const huge = { polygon: poly(rect(33.9999, -118.0001, 80, 80)) };
  assert.equal(yardAreaSqft(lot, [{ polygon: poly(rect(34.0001, -117.9999, 30, 30)) }, huge], 100).yardSqft, 0);
  assert.equal(yardAreaSqft(lot, [], 5000).yardSqft, 5000, 'explicit lot area is used');
});

test('localProjection: round-trips, 1e-4 degree of latitude is ~11.12 m, east scale uses cos(lat0)', async () => {
  const { localProjection, EARTH_RADIUS_M, SQFT_PER_M2 } = await import('../geometry.js');
  const pr = localProjection({ lat: 34.05, lng: -118.25 });
  const [x, y] = pr.toXY([-118.25, 34.0501]);
  near(x, 0, 1e-9); near(y, EARTH_RADIUS_M * 1e-4 * Math.PI / 180, 1e-9);
  const [x2] = pr.toXY([-118.2499, 34.05]);
  near(x2, EARTH_RADIUS_M * Math.cos(34.05 * Math.PI / 180) * 1e-4 * Math.PI / 180, 1e-9);
  const back = pr.toLngLat(pr.toXY([-118.2512, 34.0493]));
  near(back[0], -118.2512, 1e-12); near(back[1], 34.0493, 1e-12);
  near(SQFT_PER_M2, 1 / 0.3048 ** 2, 1e-12);
  assert.throws(() => localProjection({ lat: NaN, lng: 0 }), TypeError);
});

test('localProjection agrees with polygonAreaSqft on a 30 m x 20 m lot within 1e-4', async () => {
  const { localProjection, SQFT_PER_M2 } = await import('../geometry.js');
  const ring = rect(34.05, -118.25, 30, 20);
  const pr = localProjection({ lat: 34.05009, lng: -118.24984 });
  const xy = ring.map(pr.toXY);
  let a = 0;
  for (let i = 0; i < xy.length - 1; i++) a += xy[i][0] * xy[i + 1][1] - xy[i + 1][0] * xy[i][1];
  near(Math.abs(a) / 2 * SQFT_PER_M2, polygonAreaSqft(poly(ring)), polygonAreaSqft(poly(ring)) * 1e-4);
});

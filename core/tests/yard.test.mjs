import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitYard, findFrontEdge, yardAttributes, YARD_CONSTANTS, YARD_CONFIDENCE } from '../yard.js';
import { polygonAreaSqft } from '../geometry.js';

// Scene helper: layouts are drawn in local FEET, then mirrored / rotated (degrees, counter-clockwise) / translated
// and placed at a Los Angeles lat/lng with its own equirectangular conversion, so the lat/lng path is exercised.
const R = 6371008.8, FT = 0.3048, RAD = Math.PI / 180;
function scene({ rot = 0, mirror = false, dx = 0, dy = 0, lat = 34.05, lng = -118.25 } = {}) {
  const c = Math.cos(rot * RAD), s = Math.sin(rot * RAD);
  const kx = R * Math.cos(lat * RAD) * RAD, ky = R * RAD;
  const ll = ([x0, y0]) => {
    const x1 = mirror ? -x0 : x0;
    const x = (x1 * c - y0 * s + dx) * FT, y = (x1 * s + y0 * c + dy) * FT;
    return [lng + x / kx, lat + y / ky];
  };
  const close = (r) => (r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r : [...r, r[0]]);
  return {
    ll,
    poly: (...rings) => ({ type: 'Polygon', coordinates: rings.map((r) => close(r).map(ll)) }),
    multi: (...polys) => ({ type: 'MultiPolygon', coordinates: polys.map((rings) => rings.map((r) => close(r).map(ll))) }),
    line: (pts) => ({ type: 'LineString', coordinates: pts.map(ll) }),
    mline: (...ls) => ({ type: 'MultiLineString', coordinates: ls.map((l) => l.map(ll)) }),
    pt: (p) => { const [lng2, lat2] = ll(p); return { lat: lat2, lng: lng2 }; },
  };
}
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} got ${a}, want ${b} +/- ${tol}`);
const pct = (a, b, msg) => near(a, b, Math.max(Math.abs(b) * 0.005, 0.5), msg);
function expectYards(r, want, msg = '') {
  assert.equal(r.ok, true, `${msg} ${r.reason ?? ''}`);
  for (const [k, v] of Object.entries(want)) pct(r[k], v, `${msg} ${k}`);
  const p = r.precise;
  near(p.frontYardSqft + p.backYardSqft + p.sideYardSqft, p.openSqft, YARD_CONSTANTS.INVARIANT_REL_TOL * p.lotSqft + 1e-6, `${msg} invariant`);
}
const BASE = { lotSqft: 5000, buildingSqft: 1200, openSqft: 3800, frontYardSqft: 1000, backYardSqft: 2000, sideYardSqft: 800 };
const SOUTH = [[-100, -30], [150, -30]];
function base(sc = scene(), extra = {}) {
  return { parcel: sc.poly(rect(0, 0, 50, 100)), buildings: [sc.poly(rect(5, 20, 35, 60))], street: sc.line(SOUTH), ...extra };
}

// ------------------------------------------------------------------ hand-computed rectangle and transforms

test('hand-computed 50 x 100 ft lot: front 1,000, back 2,000, side 800, open 3,800, building 1,200, lot 5,000', () => {
  const r = splitYard(base());
  expectYards(r, BASE);
  assert.equal(r.frontEdge.edges.length, 1);
  assert.equal(r.frontEdge.chosenBy, 'centreline');
  assert.equal(r.confidence, YARD_CONFIDENCE.BASE_CENTRELINE);
  assert.deepEqual(r.warnings, []);
  near(r.house.frontSetbackM, 20 * FT, 0.01);
  near(r.house.rearLineDepthM, 60 * FT, 0.01);
});

for (const rot of [17, 90, 133]) {
  test(`same layout rotated ${rot} degrees gives the same yards`, () => expectYards(splitYard(base(scene({ rot }))), BASE, `rot ${rot}`));
}
test('mirrored layout gives the same yards', () => expectYards(splitYard(base(scene({ mirror: true }))), BASE));
test('mirrored and rotated 250 degrees gives the same yards', () => expectYards(splitYard(base(scene({ mirror: true, rot: 250 }))), BASE));

const SIDES = {
  north: { line: [[-100, 130], [150, 130]], want: { frontYardSqft: 2000, backYardSqft: 1000, sideYardSqft: 800 } },
  east: { line: [[80, -100], [80, 200]], want: { frontYardSqft: 1500, backYardSqft: 500, sideYardSqft: 1800 } },
  west: { line: [[-30, -100], [-30, 200]], want: { frontYardSqft: 500, backYardSqft: 1500, sideYardSqft: 1800 } },
  south: { line: SOUTH, want: { frontYardSqft: 1000, backYardSqft: 2000, sideYardSqft: 800 } },
};
for (const [side, { line, want }] of Object.entries(SIDES)) {
  test(`street on the ${side} side: front line moves and the yards change predictably`, () => {
    const sc = scene({ rot: 33 });
    const r = splitYard(base(sc, { street: sc.line(line) }));
    expectYards(r, { ...want, openSqft: 3800, lotSqft: 5000 }, side);
    near(r.frontEdge.lengthM, (side === 'east' || side === 'west' ? 100 : 50) * FT, 0.01);
  });
}

test('findFrontEdge on the base lot: one edge, east-west bearing, inward north, 30 ft from the centreline', () => {
  const sc = scene();
  const f = findFrontEdge(sc.poly(rect(0, 0, 50, 100)), { street: sc.line(SOUTH) });
  assert.equal(f.ok, true);
  assert.equal(f.edges.length, 1);
  near(f.bearingDeg, 90, 0.01);
  near(f.inwardBearingDeg, 0, 0.01);
  near(f.inward.north, 1, 1e-6); near(f.inward.east, 0, 1e-6);
  near(f.distanceM, 30 * FT, 0.01);
  near(f.lengthM, 50 * FT, 0.01);
  near(f.lotWidthM, 50 * FT, 0.01);
  assert.match(f.how, /nearest/);
});

test('findFrontEdge: no street reference is {ok:false}', () => {
  const sc = scene();
  const f = findFrontEdge(sc.poly(rect(0, 0, 50, 100)), {});
  assert.equal(f.ok, false); assert.match(f.reason, /no street reference/);
});

// ------------------------------------------------------------------ accessory buildings

test('detached garage in the back yard subtracts from back only', () => {
  const sc = scene({ rot: 17 });
  const inp = base(sc); inp.buildings.push(sc.poly(rect(25, 75, 45, 95)));
  expectYards(splitYard(inp), { ...BASE, buildingSqft: 1600, openSqft: 3400, backYardSqft: 1600 });
});

test('porch in front subtracts from front only', () => {
  const sc = scene();
  const inp = base(sc); inp.buildings.push(sc.poly(rect(15, 12, 25, 20)));
  expectYards(splitYard(inp), { ...BASE, buildingSqft: 1280, openSqft: 3720, frontYardSqft: 920 });
});

test('shed straddling the rear building line splits between side and back', () => {
  const sc = scene({ rot: 133 });
  const inp = base(sc); inp.buildings.push(sc.poly(rect(38, 55, 48, 65)));
  expectYards(splitYard(inp), { ...BASE, buildingSqft: 1300, openSqft: 3700, sideYardSqft: 750, backYardSqft: 1950 });
});

test('house at an angle to the front line: d1 and d2 come from the extreme vertices', () => {
  const sc = scene();
  const a = 30 * RAD, hw = 10, hh = 15;
  const house = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [25 + x * Math.cos(a) - y * Math.sin(a), 50 + x * Math.sin(a) + y * Math.cos(a)]);
  const ext = hh * Math.cos(a) + hw * Math.sin(a);
  const d1 = 50 - ext, d2 = 50 + ext;
  const r = splitYard({ ...base(sc), buildings: [sc.poly(house)] });
  expectYards(r, { buildingSqft: 600, frontYardSqft: 50 * d1, backYardSqft: 50 * (100 - d2), sideYardSqft: 50 * (d2 - d1) - 600 });
});

test('mainBuildingIndex overrides the largest-footprint rule', () => {
  const sc = scene();
  const inp = base(sc); inp.buildings.push(sc.poly(rect(25, 75, 45, 95)));
  const r = splitYard({ ...inp, mainBuildingIndex: 1 });
  // d1 = 75, d2 = 95: front = 50*75 - 1200, side = 50*20 - 400, back = 50*5
  expectYards(r, { frontYardSqft: 2550, sideYardSqft: 600, backYardSqft: 250, openSqft: 3400 });
  assert.equal(r.house.index, 1);
  assert.equal(splitYard({ ...inp, mainBuildingIndex: 7 }).ok, false);
});

// ------------------------------------------------------------------ lot shapes

const L = [[0, 0], [60, 0], [60, 50], [30, 50], [30, 100], [0, 100]];
test('L-shaped (concave) lot, street south, house straddling the notch', () => {
  const sc = scene({ rot: 17 });
  const r = splitYard({ parcel: sc.poly(L), buildings: [sc.poly(rect(5, 30, 25, 70))], street: sc.line(SOUTH) });
  expectYards(r, { lotSqft: 4500, buildingSqft: 800, frontYardSqft: 1800, sideYardSqft: 1000, backYardSqft: 900 });
});

test('L-shaped lot, street east: the front band has two separate pieces', () => {
  const sc = scene({ rot: 90 });
  const r = splitYard({ parcel: sc.poly(L), buildings: [sc.poly(rect(5, 30, 25, 70))], street: sc.line([[90, -100], [90, 200]]) });
  expectYards(r, { lotSqft: 4500, frontYardSqft: 2000, sideYardSqft: 1200, backYardSqft: 500 });
  near(r.frontEdge.lengthM, 50 * FT, 0.01);
});

test('flag lot: pole counts as front yard, warning, lower confidence', () => {
  const sc = scene({ rot: 133 });
  const flag = [[24, 0], [36, 0], [36, 60], [60, 60], [60, 120], [0, 120], [0, 60], [24, 60]];
  const r = splitYard({ parcel: sc.poly(flag), buildings: [sc.poly(rect(15, 75, 45, 105))], street: sc.line(SOUTH) });
  expectYards(r, { lotSqft: 4320, buildingSqft: 900, frontYardSqft: 1620, sideYardSqft: 900, backYardSqft: 900 });
  assert.ok(r.warnings.some((w) => /flag lot or irregular front/.test(w)));
  near(r.confidence, YARD_CONFIDENCE.BASE_CENTRELINE * YARD_CONFIDENCE.IRREGULAR_FRONT, 1e-3);
  near(r.frontEdge.frontFraction, 0.2, 1e-3);
});

test('trapezoid lot (front 50 ft, rear 70 ft): no irregular-front warning', () => {
  const sc = scene();
  const r = splitYard({ parcel: sc.poly([[0, 0], [50, 0], [60, 100], [-10, 100]]), buildings: [sc.poly(rect(5, 20, 35, 60))], street: sc.line(SOUTH) });
  expectYards(r, { lotSqft: 6000, frontYardSqft: 1040, sideYardSqft: 1120, backYardSqft: 2640 });
  assert.ok(!r.warnings.some((w) => /irregular/.test(w)));
});

test('parcel with a hole: the hole is not yard and not lot', () => {
  const sc = scene({ rot: 17 });
  const r = splitYard({ ...base(sc), parcel: sc.poly(rect(0, 0, 50, 100), [[38, 70], [38, 80], [48, 80], [48, 70]]) });
  expectYards(r, { ...BASE, lotSqft: 4900, openSqft: 3700, backYardSqft: 1900 });
});

test('MultiPolygon parcel: the part with the house is measured, with a warning', () => {
  const sc = scene();
  const r = splitYard({ ...base(sc), parcel: sc.multi([rect(0, 0, 50, 100)], [rect(200, 0, 220, 20)]) });
  expectYards(r, BASE);
  assert.ok(r.warnings.some((w) => /2 parts/.test(w)));
  near(r.confidence, 0.6 * YARD_CONFIDENCE.MULTIPART_PARCEL, 1e-3);
  // house in the second listed part: still the house part is chosen
  const r2 = splitYard({ ...base(sc), parcel: sc.multi([rect(200, 0, 220, 20)], [rect(0, 0, 50, 100)]) });
  expectYards(r2, BASE);
});

test('repeated vertices, collinear points, unclosed and clockwise rings give the same result', () => {
  const sc = scene({ rot: 17 });
  const messy = { type: 'Polygon', coordinates: [[[0, 0], [0, 50], [0, 100], [0, 100], [25, 100], [50, 100], [50, 0], [25, 0], [25, 0]].map(sc.ll)] };
  const house = { type: 'Polygon', coordinates: [[[5, 20], [5, 60], [35, 60], [35, 40], [35, 20]].map(sc.ll)] };
  const r = splitYard({ parcel: messy, buildings: [house], street: sc.line(SOUTH) });
  expectYards(r, BASE);
  assert.equal(r.frontEdge.edges.length, 1, 'collinear front vertices merge into one edge');
});

// ------------------------------------------------------------------ buildings vs parcel

test('building overhanging the parcel edge: only the part on the parcel counts', () => {
  const sc = scene({ rot: 90 });
  const r = splitYard({ ...base(sc), buildings: [sc.poly(rect(25, 20, 55, 60))] });
  expectYards(r, { lotSqft: 5000, buildingSqft: 1000, openSqft: 4000, frontYardSqft: 1000, sideYardSqft: 1000, backYardSqft: 2000 });
  assert.ok(r.warnings.some((w) => /extends past the parcel line by 200 sq ft/.test(w)));
});

test('building entirely outside the parcel is ignored with a warning', () => {
  const sc = scene();
  const inp = base(sc); inp.buildings.push(sc.poly(rect(60, 20, 90, 60)));
  const r = splitYard(inp);
  expectYards(r, BASE);
  assert.ok(r.warnings.some((w) => /building 1 lies outside the parcel/.test(w)));
});

test('overlapping footprints: the overlap is subtracted once, exactly', () => {
  const sc = scene({ rot: 17 });
  const inp = base(sc); inp.buildings.push(sc.poly(rect(30, 50, 40, 60))); // overlaps the house by 5 x 10
  const r = splitYard(inp);
  expectYards(r, { ...BASE, buildingSqft: 1250, openSqft: 3750, sideYardSqft: 750 });
  assert.ok(r.warnings.some((w) => /overlap is counted once/.test(w)));
  assert.equal(r.confidence, 0.6);
});

test('three identical footprints (duplicate sources) count once', () => {
  const sc = scene();
  const h = sc.poly(rect(5, 20, 35, 60));
  expectYards(splitYard({ ...base(sc), buildings: [h, h, h] }), BASE);
});

test('more than MAX_EXACT_OVERLAP_DEPTH stacked footprints: overcounted, floored at 0, warned', () => {
  const sc = scene();
  const h = sc.poly(rect(5, 20, 35, 60));
  const r = splitYard({ ...base(sc), buildings: Array(YARD_CONSTANTS.MAX_EXACT_OVERLAP_DEPTH + 1).fill(h) });
  assert.equal(r.ok, true);
  assert.equal(r.sideYardSqft, 0);
  pct(r.frontYardSqft, 1000); pct(r.backYardSqft, 2000);
  assert.ok(r.warnings.some((w) => /could not be removed exactly/.test(w)));
  assert.ok(r.confidence < 0.6);
});

test('footprints sharing a wall are not an overlap', () => {
  const sc = scene();
  const inp = base(sc); inp.buildings.push(sc.poly(rect(35, 20, 45, 40)));
  const r = splitYard(inp);
  expectYards(r, { ...BASE, buildingSqft: 1400, openSqft: 3600, sideYardSqft: 600 });
  assert.ok(!r.warnings.some((w) => /overlap/.test(w)));
});

test('invalid building entries are skipped with a warning', () => {
  const sc = scene();
  const inp = base(sc); inp.buildings.push(null, { type: 'Point', coordinates: [0, 0] }, sc.poly([[1, 1], [2, 2], [3, 3]]));
  const r = splitYard(inp);
  expectYards(r, BASE);
  assert.equal(r.warnings.length, 3);
});

test('buildings given as {polygon} (geometry.yardAreaSqft shape) and as Features are accepted', () => {
  const sc = scene();
  const h = sc.poly(rect(5, 20, 35, 60));
  expectYards(splitYard({ ...base(sc), buildings: [{ polygon: h }] }), BASE);
  expectYards(splitYard({ ...base(sc), buildings: [{ type: 'Feature', properties: {}, geometry: h }] }), BASE);
});

// ------------------------------------------------------------------ street references

const CORNER = (sc) => ({
  parcel: sc.poly(rect(0, 0, 50, 100)), buildings: [sc.poly(rect(5, 20, 35, 60))],
  streets: [{ name: 'Main St', geometry: sc.line(SOUTH) }, { name: 'Oak Ave', geometry: sc.line([[80, -100], [80, 200]]) }],
});

test('corner lot, streetName Main St: front south, corner warning, lower confidence', () => {
  const r = splitYard({ ...CORNER(scene({ rot: 17 })), streetName: 'main  st' });
  expectYards(r, BASE);
  assert.ok(r.warnings.includes('corner lot: the second street frontage is counted as side yard'));
  assert.equal(r.frontEdge.street, 'Main St');
  assert.equal(r.frontEdge.otherFrontages[0].kind, 'side');
  near(r.confidence, 0.6 * YARD_CONFIDENCE.SECOND_FRONTAGE, 1e-3);
});

test('corner lot, streetName Oak Ave: front east', () => {
  const r = splitYard({ ...CORNER(scene({ rot: 133 })), streetName: 'Oak Ave' });
  expectYards(r, { frontYardSqft: 1500, backYardSqft: 500, sideYardSqft: 1800 });
  assert.ok(r.warnings.some((w) => /corner lot/.test(w)));
});

test('two equally near unnamed streets: {ok:false}, never a guessed front', () => {
  const r = splitYard(CORNER(scene()));
  assert.equal(r.ok, false); assert.match(r.reason, /pass streetName/);
});

test('several streets, no name, one clearly nearer: it is used, with a warning', () => {
  const sc = scene();
  const inp = CORNER(sc);
  inp.streets[1].geometry = sc.line([[95, -100], [95, 200]]); // Oak Ave 45 ft away
  const r = splitYard(inp);
  expectYards(r, BASE);
  assert.ok(r.warnings.some((w) => /nearest of 2 streets \(Main St\)/.test(w)));
  assert.ok(r.confidence < 0.6);
});

test('streetName not among the supplied streets: {ok:false}', () => {
  const r = splitYard({ ...CORNER(scene()), streetName: 'Elm St' });
  assert.equal(r.ok, false); assert.match(r.reason, /Elm St/);
});

test('through lot: a second street behind the lot is counted as back yard', () => {
  const sc = scene();
  const r = splitYard({ ...base(sc), street: undefined, streetName: 'Main St',
    streets: [{ name: 'Main St', geometry: sc.line(SOUTH) }, { name: 'Alley', geometry: sc.line([[-100, 110], [150, 110]]) }] });
  expectYards(r, BASE);
  assert.ok(r.warnings.some((w) => /through lot/.test(w)));
});

test('street given as a MultiLineString (one piece far away)', () => {
  const sc = scene({ rot: 90 });
  const r = splitYard({ ...base(sc), street: sc.mline([[-500, -300], [-400, -300]], SOUTH) });
  expectYards(r, BASE);
});

test('street as a Feature and as {street:[{name, geometry}]} array', () => {
  const sc = scene();
  expectYards(splitYard({ ...base(sc), street: { type: 'Feature', properties: {}, geometry: sc.line(SOUTH) } }), BASE);
  expectYards(splitYard({ ...base(sc), street: [{ name: 'Main St', geometry: sc.line(SOUTH) }] }), BASE);
});

test('curved street (arc) in front of the lot: nearest edge is still the front', () => {
  const sc = scene({ rot: 17 });
  const arc = [];
  for (let t = -40; t <= 40; t += 4) arc.push([25 + 400 * Math.sin(t * RAD), -30 - 400 * (1 - Math.cos(t * RAD))]);
  const r = splitYard({ ...base(sc), street: sc.line(arc) });
  expectYards(r, BASE);
  near(r.frontEdge.distanceM, 30 * FT, 0.05);
});

test('curved frontage: consecutive edges within 15 degrees join the front line; a sharper edge does not', () => {
  const sc = scene();
  // front made of three edges bending 7 degrees each way (all within 15 of each other), then a 40-degree corner edge
  const f1 = [0, 0], f2 = [20, 0];
  const f0 = [f1[0] - 20 * Math.cos(7 * RAD), 20 * Math.sin(7 * RAD)];
  const f3 = [f2[0] + 20 * Math.cos(7 * RAD), 20 * Math.sin(7 * RAD)];
  const f4 = [f3[0] + 8 * Math.cos(40 * RAD), f3[1] + 8 * Math.sin(40 * RAD)];
  const lot = [f0, f1, f2, f3, f4, [f4[0], 100], [f0[0], 100]];
  const arc = [];
  for (let t = -30; t <= 30; t += 2) arc.push([10 + 190 * Math.sin(t * RAD), 160 - 190 * Math.cos(t * RAD)]);
  const f = findFrontEdge(sc.poly(lot), { street: sc.line(arc) });
  assert.equal(f.ok, true);
  assert.equal(f.edges.length, 3);
  near(f.bearingDeg, 90, 0.5); // length-weighted (chord) direction of the symmetric group is east-west
});

test('street far away: 30 m -> computed with a warning and lower confidence; 70 m -> {ok:false}', () => {
  const sc = scene();
  const m = (v) => v / FT;
  const r = splitYard({ ...base(sc), street: sc.line([[-100, -m(30)], [150, -m(30)]]) });
  expectYards(r, BASE);
  assert.ok(r.warnings.some((w) => /more than 16 m/.test(w)));
  near(r.confidence, 0.6 * YARD_CONFIDENCE.FAR_STREET, 1e-3);
  const r2 = splitYard({ ...base(sc), street: sc.line([[-100, -m(70)], [150, -m(70)]]) });
  assert.equal(r2.ok, false); assert.match(r2.reason, /not treated as its frontage/);
});

test('square lot with a street running diagonally past a corner: front ambiguous, warned', () => {
  const sc = scene();
  const r = splitYard({ parcel: sc.poly(rect(0, 0, 60, 60)), buildings: [sc.poly(rect(20, 20, 40, 40))],
    street: sc.line([[-60, 30], [30, -60]]) });
  assert.equal(r.ok, true);
  assert.ok(r.frontEdge.ambiguous);
  assert.ok(r.warnings.some((w) => /front ambiguous/.test(w)));
  assert.ok(r.confidence < 0.6);
});

test('frontPoint fallback: computed with lower confidence and a warning', () => {
  const sc = scene({ rot: 17 });
  const r = splitYard({ ...base(sc), street: undefined, frontPoint: sc.pt([25, -10]) });
  expectYards(r, BASE);
  assert.equal(r.frontEdge.chosenBy, 'frontPoint');
  assert.equal(r.confidence, YARD_CONFIDENCE.BASE_FRONT_POINT);
  assert.ok(r.warnings.some((w) => /geocoded front point/.test(w)));
});

test('frontPoint inside the parcel near the front: nearest edge, extra warning', () => {
  const sc = scene();
  const r = splitYard({ ...base(sc), street: undefined, frontPoint: sc.pt([25, 3]) });
  expectYards(r, BASE);
  assert.ok(r.warnings.some((w) => /inside the parcel/.test(w)));
  near(r.confidence, YARD_CONFIDENCE.BASE_FRONT_POINT * YARD_CONFIDENCE.POINT_INSIDE, 1e-3);
});

test('centreline wins over frontPoint when both are given', () => {
  const sc = scene();
  const r = splitYard({ ...base(sc), frontPoint: sc.pt([80, 50]) });
  expectYards(r, BASE);
  assert.equal(r.frontEdge.chosenBy, 'centreline');
});

test('no street reference: {ok:false} with a reason', () => {
  const sc = scene();
  for (const extra of [{ street: undefined }, { street: null, frontPoint: null }]) {
    const r = splitYard({ ...base(sc), ...extra });
    assert.equal(r.ok, false); assert.match(r.reason, /no street reference/);
  }
  const bad = splitYard({ ...base(sc), street: { type: 'Point', coordinates: [0, 0] } });
  assert.equal(bad.ok, false); assert.match(bad.reason, /LineString/);
  const badPt = splitYard({ ...base(sc), street: undefined, frontPoint: { lat: NaN, lng: 0 } });
  assert.equal(badPt.ok, false); assert.match(badPt.reason, /frontPoint/);
});

// ------------------------------------------------------------------ no building, degenerate input

test('no buildings: open area = lot, front/back/side null with reason', () => {
  const sc = scene();
  for (const buildings of [[], undefined]) {
    const r = splitYard({ ...base(sc), buildings });
    assert.equal(r.ok, true);
    pct(r.openSqft, 5000); pct(r.lotSqft, 5000);
    assert.equal(r.buildingSqft, 0);
    assert.equal(r.frontYardSqft, null); assert.equal(r.backYardSqft, null); assert.equal(r.sideYardSqft, null);
    assert.equal(r.yardReason, 'no building on the parcel');
  }
});

test('only buildings off the parcel: no house, yards null, warning', () => {
  const sc = scene();
  const r = splitYard({ ...base(sc), buildings: [sc.poly(rect(60, 20, 90, 60))] });
  assert.equal(r.ok, true); assert.equal(r.frontYardSqft, null);
  assert.equal(r.yardReason, 'no building on the parcel');
  assert.ok(r.warnings.some((w) => /outside the parcel/.test(w)));
});

test('degenerate parcels: fewer than 3 vertices, zero area, NaN, wrong type, missing, self-crossing', () => {
  const sc = scene();
  const cases = [
    [{ type: 'Polygon', coordinates: [[[0, 0], [10, 0]].map(sc.ll)] }, /fewer than 3|zero area/],
    [{ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [20, 0], [0, 0]].map(sc.ll)] }, /zero area|fewer than 3/],
    [{ type: 'Polygon', coordinates: [[[-118.25, 34.05], [NaN, 34.05], [-118.24, 34.06], [-118.25, 34.05]]] }, /finite/],
    [{ type: 'Point', coordinates: [-118.25, 34.05] }, /not a GeoJSON Polygon/],
    [undefined, /missing/],
    [{ type: 'Polygon', coordinates: [] }, /no coordinates|empty polygon/],
    [sc.poly([[0, 0], [50, 100], [50, 0], [0, 100]]), /crosses itself/],
    [sc.poly([[0, 0], [60, 100], [50, 0], [0, 100]]), /crosses itself/],
  ];
  for (const [parcel, re] of cases) {
    const r = splitYard({ ...base(sc), parcel });
    assert.equal(r.ok, false, String(re)); assert.match(r.reason, re);
  }
  assert.equal(splitYard(null).ok, false);
  assert.equal(splitYard({ ...base(sc), buildings: 'x' }).ok, false);
});

// ------------------------------------------------------------------ fixture

test('synthetic LA corner-lot fixture: hand-computed yards for either street', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/yard/synthetic-la-corner-lot.json', import.meta.url)));
  assert.match(fx._fixture_note, /SYNTHETIC/);
  for (const [name, want] of Object.entries(fx.expected_by_hand)) {
    const r = splitYard({ parcel: fx.parcel, buildings: fx.buildings, streets: fx.streets, streetName: name });
    expectYards(r, want, name);
    assert.ok(r.warnings.some((w) => /corner lot/.test(w)), name);
  }
  // the module's lot area agrees with geometry.polygonAreaSqft
  const r = splitYard({ parcel: fx.parcel, buildings: fx.buildings, streets: fx.streets, streetName: 'W 4th St' });
  near(r.precise.lotSqft, polygonAreaSqft(fx.parcel), polygonAreaSqft(fx.parcel) * 1e-4);
});

// ------------------------------------------------------------------ generated invariants

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function inRing(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** A random layout in local feet: lot ring (CCW), house, optional garage, street line. */
function layout(rand) {
  const U = (a, b) => a + (b - a) * rand();
  let lot, street;
  if (rand() < 0.5) {
    const A = U(15, 40), B = U(40, 80), k = 4 + Math.floor(rand() * 5);
    const angs = Array.from({ length: k }, (_, i) => (i + U(0.15, 0.85)) * (2 * Math.PI / k)).sort((x, y) => x - y);
    lot = angs.map((t) => [A * Math.cos(t), B * Math.sin(t)]);
    const i = Math.floor(rand() * k), a = lot[i], b = lot[(i + 1) % k];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    const off = U(25, 40), ox = uy * off, oy = -ux * off; // right of a CCW edge = outside
    street = [[a[0] + ox - 500 * ux, a[1] + oy - 500 * uy], [a[0] + ox + 500 * ux, a[1] + oy + 500 * uy]];
  } else {
    const W = U(40, 80), D = U(80, 150), cw = U(10, W * 0.6), cd = U(15, D * 0.6), corner = Math.floor(rand() * 4);
    const full = [[0, 0], [W, 0], [W, D], [0, D]];
    const notch = { 0: [[cw, 0], [W, 0], [W, D], [0, D], [0, cd], [cw, cd]], 1: [[0, 0], [W - cw, 0], [W - cw, cd], [W, cd], [W, D], [0, D]],
      2: [[0, 0], [W, 0], [W, D - cd], [W - cw, D - cd], [W - cw, D], [0, D]], 3: [[0, 0], [W, 0], [W, D], [cw, D], [cw, D - cd], [0, D - cd]] }[corner];
    lot = notch;
    // the two sides not touching the notch corner
    const freeSides = { 0: ['north', 'east'], 1: ['north', 'west'], 2: ['south', 'west'], 3: ['south', 'east'] }[corner];
    const side = freeSides[Math.floor(rand() * 2)];
    street = { south: [[-300, -30], [W + 300, -30]], north: [[-300, D + 30], [W + 300, D + 30]], west: [[-30, -300], [-30, D + 300]], east: [[W + 30, -300], [W + 30, D + 300]] }[side];
    void full;
  }
  const cx = lot.reduce((s, p) => s + p[0], 0) / lot.length, cy = lot.reduce((s, p) => s + p[1], 0) / lot.length;
  let hc;
  do { hc = [cx + U(-12, 12), cy + U(-20, 20)]; } while (!inRing(hc, lot));
  const hw = U(6, 15), hh = U(8, 20), ha = U(0, Math.PI);
  const box = (c, w, h, a) => [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => [c[0] + x * Math.cos(a) - y * Math.sin(a), c[1] + x * Math.sin(a) + y * Math.cos(a)]);
  const buildings = [box(hc, hw, hh, ha)];
  if (rand() < 0.5) buildings.push(box([cx + U(-20, 20), cy + U(-40, 40)], U(4, 9), U(4, 9), U(0, Math.PI)));
  return { lot, buildings, street };
}
function run(lay, opts, { reverse = false, shift = 0 } = {}) {
  const sc = scene(opts);
  const ring = reverse ? [...lay.lot].reverse() : [...lay.lot];
  const rot = ring.slice(shift % ring.length).concat(ring.slice(0, shift % ring.length));
  return splitYard({
    parcel: sc.poly(rot),
    buildings: lay.buildings.map((b) => sc.poly(reverse ? [...b].reverse() : b)),
    street: sc.line(lay.street),
  });
}

test('200 generated layouts: front + back + side = open, all areas >= 0, invariant under scene rotation/translation and ring order', () => {
  const rand = rng(20261127);
  let checked = 0;
  for (let n = 0; n < 200; n++) {
    const lay = layout(rand);
    const r0 = run(lay, {});
    assert.equal(r0.ok, true, `layout ${n}: ${r0.reason}`);
    const p = r0.precise;
    for (const k of ['lotSqft', 'buildingSqft', 'openSqft', 'frontYardSqft', 'backYardSqft', 'sideYardSqft']) assert.ok(p[k] >= 0, `layout ${n} ${k} = ${p[k]}`);
    near(p.frontYardSqft + p.backYardSqft + p.sideYardSqft, p.openSqft, YARD_CONSTANTS.INVARIANT_REL_TOL * p.lotSqft + 1e-6, `layout ${n} invariant`);
    assert.ok(Math.abs(r0.frontYardSqft + r0.backYardSqft + r0.sideYardSqft - r0.openSqft) <= 2, `layout ${n} rounded`);
    assert.ok(r0.confidence > 0 && r0.confidence <= 0.6);
    const opts = { rot: rand() * 360, mirror: rand() < 0.3, dx: (rand() - 0.5) * 2000, dy: (rand() - 0.5) * 2000, lat: 33.7 + rand() * 0.6, lng: -118.6 + rand() * 0.6 };
    const r1 = run(lay, opts);
    const r2 = run(lay, opts, { reverse: true, shift: n + 1 });
    for (const k of ['lotSqft', 'buildingSqft', 'openSqft', 'frontYardSqft', 'backYardSqft', 'sideYardSqft']) {
      near(r1.precise[k], p[k], 5e-5 * p.lotSqft + 0.01, `layout ${n} rigid-motion ${k}`);
      near(r2.precise[k], r1.precise[k], 1e-7 * p.lotSqft + 1e-6, `layout ${n} ring-order ${k}`);
    }
    checked++;
  }
  assert.equal(checked, 200);
});

// ------------------------------------------------------------------ determinism, immutability

test('deterministic and does not mutate its input', () => {
  const sc = scene({ rot: 17 });
  const inp = { ...CORNER(sc), streetName: 'Main St', buildings: [sc.poly(rect(5, 20, 35, 60)), sc.poly(rect(30, 50, 40, 60))] };
  const before = structuredClone(inp);
  const a = splitYard(inp), b = splitYard(inp);
  assert.deepEqual(a, b);
  assert.deepEqual(inp, before);
  const f1 = findFrontEdge(inp.parcel, inp);
  assert.deepEqual(inp, before);
  assert.deepEqual(f1, findFrontEdge(inp.parcel, inp));
});

test('confidence never exceeds the 0.6 cap; constants are frozen', () => {
  assert.ok(Object.isFrozen(YARD_CONSTANTS) && Object.isFrozen(YARD_CONFIDENCE));
  assert.equal(YARD_CONFIDENCE.CONFIDENCE_CAP, 0.6);
  assert.ok(splitYard(base()).confidence <= 0.6);
});

// ------------------------------------------------------------------ provenance

const NOW = '2026-11-27T12:00:00Z';
const SRC = { parcel: 'LA County Assessor parcel', footprints: 'OpenStreetMap buildings', street: 'OpenStreetMap centreline' };

test('yardAttributes: estimated Sourced values naming the sources', () => {
  const r = splitYard(base());
  const a = yardAttributes(r, { now: NOW, sources: SRC });
  assert.equal(a.front_yard_sqft.tag, 'estimated');
  assert.equal(a.front_yard_sqft.value, r.frontYardSqft);
  assert.equal(a.back_yard_sqft.value, r.backYardSqft);
  assert.equal(a.side_yard_sqft.value, r.sideYardSqft);
  assert.equal(a.yard_area_sqft.value, r.openSqft);
  for (const v of Object.values(a)) {
    assert.equal(v.unit, 'sqft'); assert.equal(v.retrievedAt, NOW); assert.ok(v.confidence <= 0.6 && v.confidence > 0);
    for (const s of Object.values(SRC)) assert.ok(v.method.includes(s), `${v.method} names ${s}`);
  }
});

test('yardAttributes: no building -> yards unavailable with the reason, open area estimated', () => {
  const a = yardAttributes(splitYard({ ...base(), buildings: [] }), { now: NOW, sources: SRC });
  for (const k of ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft']) {
    assert.equal(a[k].tag, 'unavailable'); assert.equal(a[k].value, null); assert.equal(a[k].confidence, 0);
    assert.equal(a[k].note, 'no building on the parcel');
  }
  assert.equal(a.yard_area_sqft.tag, 'estimated');
});

test('yardAttributes: failed split -> all four unavailable with the reason (never 0)', () => {
  const a = yardAttributes(splitYard({ ...base(), street: undefined }), { now: NOW, sources: SRC });
  for (const v of Object.values(a)) { assert.equal(v.tag, 'unavailable'); assert.equal(v.value, null); assert.match(v.note, /no street reference/); }
});

test('yardAttributes: frontPoint result names the front point; warnings become the note', () => {
  const sc = scene();
  const a = yardAttributes(splitYard({ ...base(sc), street: undefined, frontPoint: sc.pt([25, -10]) }), { now: NOW, sources: { ...SRC, street: 'Census geocoder' } });
  assert.match(a.front_yard_sqft.method, /front point \(Census geocoder\)/);
  assert.match(a.front_yard_sqft.note, /geocoded front point/);
  assert.equal(a.front_yard_sqft.confidence, YARD_CONFIDENCE.BASE_FRONT_POINT);
});

test('yardAttributes: invalid now or sources throw', () => {
  const r = splitYard(base());
  assert.throws(() => yardAttributes(r, { now: 'yesterday', sources: SRC }), TypeError);
  assert.throws(() => yardAttributes(r, { now: NOW, sources: { parcel: 'x' } }), TypeError);
  assert.throws(() => yardAttributes(r), TypeError);
});

// @ts-check
// An ESTIMATED lot for a house when no parcel outline is available: its share of the block, bounded by the street edge in front and by the
// midlines to the neighbouring buildings. Pure functions, no I/O. Off by default in the builder (see docs/yard-accuracy.md, Stage 2).
//
// PORTED FROM StreetForge streetforge2d.html `lotLayer` (read-only reference), the "estimate" branch used when no parcel map answers:
//   13345-13347  each building gets the part of its block nearer to it than to any other building: a Voronoi split of the footprints'
//                centres (the centre is the mean of the footprint's points, 13365)
//   13367        `half`: Sutherland-Hodgman clip of a convex polygon to the half-plane nearer to a than to b (ported as is)
//   13398        a garage or shed (under 450 sq ft, within 140 ft of a building at least twice its size and 450 sq ft) is not a lot of its own
//   13401-13403  lot lines run square to the street: distances along the block's long side are stretched 3x (K=3) before the split
//   13393/13409  the result is marked lotFrom='estimate'
// SIMPLIFIED, because Everyspace has no drafted block: StreetForge's block is the drafted ground minus the drawn street strips and the cell
// is intersected with it (polygon-clipping library). Here the block is bounded by half-planes: for every street line beside the house (its
// nearest point on the line is not a line end), the street edge = the centreline offset by an ASSUMED half right-of-way (HALF_ROW_FT, by road
// class: typical US widths, not measured). The "long side" direction is the front street's direction near the house. The cell is convex; the
// house footprint is not unioned in and neighbouring footprints are not cut out (both need general polygon clipping). Where nothing bounds
// the cell (no neighbour or street on a side) it is cut at CAP_M from the house and a warning says so.

import { centroid, localProjection, polygonAreaSqft, SQFT_PER_M2 } from './geometry.js';
import { parseStreetName, sameStreet } from './street-ref.js';

/** Assumed half right-of-way (centreline to the lot line), feet, by road class. Alleys: StreetForge draws them 18 ft wide (13858). */
export const HALF_ROW_FT = Object.freeze({ alley: 9, service: 10, living_street: 25, residential: 30, unclassified: 30, street: 30, tertiary: 35, secondary: 40, primary: 45, trunk: 50, pedestrian: 15 });
export const LOT_ESTIMATE = Object.freeze({
  /** StreetForge's stretch of distances along the street (13401). */
  STRETCH: 3,
  /** Garage rule (StreetForge 13398), in feet and square feet. */
  GARAGE_MAX_SQFT: 450, GARAGE_NEAR_FT: 140,
  /** Neighbours farther than this (centre to centre) are ignored. */
  NEIGHBOUR_RADIUS_M: 80,
  /** Without a neighbour or street on a side, the lot is cut this far from the house footprint. */
  CAP_M: 25,
  /** A street is considered only within this distance of the house centre. */
  STREET_RADIUS_M: 70,
  /** Confidence of any estimated lot (no parcel record behind it). */
  CONFIDENCE: 0.15,
});
export const METHOD = 'estimated from neighbouring buildings and the street; no parcel record';
const L = LOT_ESTIMATE;
const FT = 0.3048;

const geomOf = (/** @type {any} */ g) => (g && g.type === 'Feature' ? g.geometry : g && !g.type && g.polygon ? g.polygon : g);
/** Outer ring of the largest part. @param {any} g */
function outerRing(g) {
  const geom = geomOf(g);
  if (!geom) return null;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : null;
  if (!polys || !polys.length) return null;
  let best = null, bestA = -1;
  for (const rings of polys) {
    if (!Array.isArray(rings?.[0]) || rings[0].length < 3) continue;
    const a = polygonAreaSqft({ type: 'Polygon', coordinates: [rings[0]] });
    if (a > bestA) { bestA = a; best = rings[0]; }
  }
  return best && best.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) ? { ring: best, areaSqft: bestA } : null;
}
const area2 = (/** @type {number[][]} */ P) => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };
const mean = (/** @type {number[][]} */ P) => { const Q = P.length > 1 && P[0][0] === P[P.length - 1][0] && P[0][1] === P[P.length - 1][1] ? P.slice(0, -1) : P; return [Q.reduce((s, p) => s + p[0], 0) / Q.length, Q.reduce((s, p) => s + p[1], 0) / Q.length]; };

/** StreetForge `half` (13367): clip convex `poly` to the half-plane nearer to a than to b. @param {number[][]} poly @param {number[]} a @param {number[]} b */
export function half(poly, a, b) {
  const n = [b[0] - a[0], b[1] - a[1]], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], side = (/** @type {number[]} */ q) => (q[0] - m[0]) * n[0] + (q[1] - m[1]) * n[1], out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}
/** Clip a convex polygon to {x : n . x <= c}. @param {number[][]} poly @param {number[]} n @param {number} c */
function clipLine(poly, n, c) {
  const out = [], f = (/** @type {number[]} */ q) => n[0] * q[0] + n[1] * q[1] - c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], sp = f(p), sq = f(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

/** Nearest point of a polyline set to p: {d, foot, dir, atEnd}. @param {number[][][]} lines @param {number[]} p */
function nearestOn(lines, p) {
  let best = { d: Infinity, foot: [0, 0], dir: [1, 0], atEnd: true };
  for (const l of lines) {
    for (let k = 0; k + 1 < l.length; k++) {
      const a = l[k], b = l[k + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      if (l2 <= 0) continue;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      const foot = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(p[0] - foot[0], p[1] - foot[1]);
      if (d < best.d) { const len = Math.sqrt(l2); best = { d, foot, dir: [dx / len, dy / len], atEnd: (t === 0 && k === 0) || (t === 1 && k + 2 === l.length) }; }
    }
  }
  return best;
}
const linesOf = (/** @type {any} */ g) => { const geom = geomOf(g); if (!geom) return null; const ls = geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : null; return ls && ls.every((l) => Array.isArray(l) && l.length >= 2 && l.every((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]))) ? ls : null; };

/**
 * @param {{building:any, neighbours?:any[], streets?:Array<{name:string|null, geometry:any, class?:string, alley?:boolean, kind?:string}>, streetName?:string|null}} input
 * @returns {{ok:true, polygon:any, areaSqft:number, method:string, confidence:number, warnings:string[], frontStreet:string|null, sites:number}|{ok:false, reason:string}}
 */
export function estimateLot(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'input must be an object' };
  const h = outerRing(input.building);
  if (!h) return { ok: false, reason: 'the building footprint is missing or not a polygon' };
  /** @type {string[]} */ const warnings = [];
  const c0 = centroid({ type: 'Polygon', coordinates: [h.ring] });
  const proj = localProjection(c0);
  const H = h.ring.map(proj.toXY);
  const hc = mean(H);
  // ---- sites: the house and its neighbours, without garages and sheds (StreetForge 13398)
  const sites = [{ P: H, c: hc, a: h.areaSqft, self: true }];
  for (const n of input.neighbours ?? []) {
    const r = outerRing(n);
    if (!r) continue;
    const P = r.ring.map(proj.toXY), c = mean(P);
    if (Math.hypot(c[0] - hc[0], c[1] - hc[1]) > L.NEIGHBOUR_RADIUS_M || Math.hypot(c[0] - hc[0], c[1] - hc[1]) < 0.5) continue;
    sites.push({ P, c, a: r.areaSqft, self: false });
  }
  const near = L.GARAGE_NEAR_FT * FT;
  const keep = sites.filter((f) => f.self || f.a >= L.GARAGE_MAX_SQFT || !sites.some((o) => o !== f && o.a >= 2 * f.a && o.a >= L.GARAGE_MAX_SQFT && Math.hypot(o.c[0] - f.c[0], o.c[1] - f.c[1]) < near));
  // ---- streets beside the house
  const streets = [];
  for (const s of input.streets ?? []) {
    const ls = linesOf(s?.geometry);
    if (!ls) continue;
    const xy = ls.map((l) => l.map(proj.toXY));
    const nr = nearestOn(xy, hc);
    if (nr.d > L.STREET_RADIUS_M) continue;
    const cls = s.alley ? 'alley' : String(s.class ?? s.kind ?? 'street');
    streets.push({ s, xy, nr, halfM: (HALF_ROW_FT[/** @type {keyof typeof HALF_ROW_FT} */ (cls)] ?? HALF_ROW_FT.street) * FT, cls });
  }
  const named = input.streetName ? streets.filter((x) => !x.s.alley && x.s.name && sameStreet(String(x.s.name), String(input.streetName))) : [];
  const roads = streets.filter((x) => !x.s.alley);
  const front = (named.length ? named : roads).sort((a, b) => a.nr.d - b.nr.d)[0] ?? null;
  if (!front) return { ok: false, reason: 'no street line near the building: the street edge in front is unknown' };
  if (input.streetName && !named.length) warnings.push(`no mapped street named ${input.streetName} near the building; the nearest street was taken as the front`);
  // ---- Voronoi cell in the stretched frame (lot lines square to the street), then back
  const dir = front.nr.dir, nrm = [-dir[1], dir[0]], K = L.STRETCH;
  const fw = (/** @type {number[]} */ q) => [K * (q[0] * dir[0] + q[1] * dir[1]), q[0] * nrm[0] + q[1] * nrm[1]];
  const bk = (/** @type {number[]} */ q) => [q[0] / K * dir[0] + q[1] * nrm[0], q[0] / K * dir[1] + q[1] * nrm[1]];
  const xs = H.map((q) => q[0]), ys = H.map((q) => q[1]);
  const capBox = [[Math.min(...xs) - L.CAP_M, Math.min(...ys) - L.CAP_M], [Math.max(...xs) + L.CAP_M, Math.min(...ys) - L.CAP_M], [Math.max(...xs) + L.CAP_M, Math.max(...ys) + L.CAP_M], [Math.min(...xs) - L.CAP_M, Math.max(...ys) + L.CAP_M]];
  const big = 400;
  let cell = [[-big * K, -big], [big * K, -big], [big * K, big], [-big * K, big]];
  const fc = fw(hc);
  for (const o of keep) { if (o.self) continue; cell = half(cell, fc, fw(o.c)); if (cell.length < 3) break; }
  if (cell.length < 3) return { ok: false, reason: 'the neighbouring buildings leave no room for a lot' };
  cell = cell.map(bk);
  // ---- street edges: the side of each street the house is on, offset by the half right-of-way
  const used = [];
  for (const st of streets) {
    if (st.nr.atEnd && st !== front) continue; // a street that ends short of the house does not bound it
    const n = [st.nr.foot[0] - hc[0], st.nr.foot[1] - hc[1]], len = Math.hypot(n[0], n[1]);
    if (len < st.halfM + 1) { warnings.push(`the ${st.s.name ?? st.cls} line passes within its assumed half-width of the house centre; it was not used as a boundary`); continue; }
    // half-plane through the street edge, square to the street's local direction
    const t = st.nr.dir, side = [-t[1], t[0]];
    const sgn = Math.sign(side[0] * n[0] + side[1] * n[1]) || 1;
    const nn = [side[0] * sgn, side[1] * sgn]; // from the house towards the street
    const dist = nn[0] * st.nr.foot[0] + nn[1] * st.nr.foot[1] - st.halfM;
    if (dist <= nn[0] * hc[0] + nn[1] * hc[1]) continue;
    cell = clipLine(cell, nn, dist);
    used.push(st);
    if (cell.length < 3) return { ok: false, reason: 'the street edges leave no room for a lot' };
  }
  // ---- cap where nothing bounds the lot
  const before = Math.abs(area2(cell));
  let capped = cell;
  for (let i = 0; i < 4; i++) {
    const a = capBox[i], b = capBox[(i + 1) % 4], d = [b[0] - a[0], b[1] - a[1]], n = [d[1], -d[0]];
    capped = clipLine(capped, n, n[0] * a[0] + n[1] * a[1]);
    if (capped.length < 3) return { ok: false, reason: 'the lot estimate collapsed' };
  }
  if (Math.abs(area2(capped)) < before - 0.01) warnings.push(`no neighbouring building or street bounds the lot on at least one side; it was cut ${L.CAP_M} m from the house`);
  const sideNeighbours = keep.filter((o) => !o.self && Math.abs((o.c[0] - hc[0]) * dir[0] + (o.c[1] - hc[1]) * dir[1]) > 3);
  const leftN = sideNeighbours.some((o) => (o.c[0] - hc[0]) * dir[0] + (o.c[1] - hc[1]) * dir[1] < 0), rightN = sideNeighbours.some((o) => (o.c[0] - hc[0]) * dir[0] + (o.c[1] - hc[1]) * dir[1] > 0);
  if (!leftN || !rightN) warnings.push('no neighbouring building on one side along the street: that side line is a guess');
  if (!used.includes(front)) warnings.push('the front street did not bound the lot');
  const ring = capped.map(proj.toLngLat);
  if (area2(capped) < 0) ring.reverse();
  ring.push([...ring[0]]);
  const polygon = { type: 'Polygon', coordinates: [ring] };
  const areaSqft = polygonAreaSqft(polygon);
  if (areaSqft < h.areaSqft) warnings.push('the estimated lot is smaller than the building footprint');
  return { ok: true, polygon, areaSqft, method: METHOD, confidence: L.CONFIDENCE, warnings, frontStreet: front.s.name ?? null, sites: keep.length,
    detail: { halfRowM: Math.round(front.halfM * 10) / 10, streetsUsed: used.map((x) => x.s.name ?? x.cls), garagesSkipped: sites.length - keep.length } };
}

/**
 * Intersection over union of two polygons, the first CONVEX (an estimated lot): the second is clipped against the first's half-planes
 * (exact for a concave second polygon: see core/yard.js header, point 1). Outer rings only.
 * @param {any} convex @param {any} other
 */
export function polygonIoU(convex, other) {
  const a = outerRing(convex), b = outerRing(other);
  if (!a || !b) return null;
  const proj = localProjection(centroid({ type: 'Polygon', coordinates: [a.ring] }));
  let A = a.ring.map(proj.toXY); if (A.length > 1 && A[0][0] === A[A.length - 1][0] && A[0][1] === A[A.length - 1][1]) A = A.slice(0, -1);
  if (area2(A) < 0) A.reverse();
  let B = b.ring.map(proj.toXY); if (B.length > 1 && B[0][0] === B[B.length - 1][0] && B[0][1] === B[B.length - 1][1]) B = B.slice(0, -1);
  if (area2(B) < 0) B.reverse();
  let I = B;
  for (let i = 0; i < A.length && I.length >= 3; i++) {
    const p = A[i], q = A[(i + 1) % A.length], n = [q[1] - p[1], -(q[0] - p[0])];
    I = clipLine(I, n, n[0] * p[0] + n[1] * p[1]);
  }
  const ia = I.length >= 3 ? Math.abs(area2(I)) : 0, aa = Math.abs(area2(A)), ba = Math.abs(area2(B));
  return ia / (aa + ba - ia);
}

/** sq ft -> m2 (for callers that want metres). */
export const sqftToM2 = (/** @type {number} */ v) => v / SQFT_PER_M2;
export { parseStreetName };

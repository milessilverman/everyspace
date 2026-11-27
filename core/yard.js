// @ts-check
// Deterministic front / back / side yard split of a parcel. Pure functions, zero dependencies, no I/O, no clock.
//
// DEFINITIONS
//  - Front lot line: the outer-ring parcel edge nearest the street centreline (segment-to-polyline distance), plus the
//    consecutive edges that run along the street with it (directed bearing within FRONT_GROUP_MAX_ANGLE_DEG of the
//    nearest edge and distance to the street within FRONT_GROUP_TOL_M of it). Several edges share one direction: the
//    length-weighted sum of their direction vectors (= the chord of the group).
//  - Depth: distance inward, perpendicular to the front line; 0 at the front-line vertex nearest the inside.
//  - House: the largest footprint whose centroid lies on the parcel (`mainBuildingIndex` overrides). d1 / d2 = the
//    smallest / largest depth of any house vertex (front and rear building lines).
//  - front = parcel ∩ {depth < d1} minus buildings, back = parcel ∩ {depth > d2} minus buildings,
//    side = parcel ∩ {d1 <= depth <= d2} minus buildings. open = lot minus building area on the parcel.
//
// FRAME: equirectangular projection around the parcel centroid (geometry.localProjection, metres). At Los Angeles
// (34 N) the planar error for a lot within 100 m of its centroid is < 1.1e-5 relative (about 0.06 sq ft on a
// 5,000 sq ft lot); the spherical Earth adds about +0.03% on areas against WGS84 (same model as geometry.js).
// Square feet use geometry.SQFT_PER_M2.
//
// EXACT AREA METHOD (no triangulation of the parcel needed):
//  1. A ring clipped by Sutherland-Hodgman against a CONVEX region keeps exactly the signed area of (ring ∩ region),
//     even for concave rings: each excursion outside a half-plane is replaced by a segment on its boundary line,
//     which changes the winding number only outside the half-plane. Parcel rings are oriented outer CCW, holes CW,
//     so their winding number is 1 on the lot and 0 in holes; summed signed areas give area(lot ∩ region).
//  2. A footprint's indicator equals the signed sum of its fan triangles (O, p_i, p_i+1) (winding-number identity),
//     so area(lot ∩ footprint ∩ band) = Σ sign_t · area(lot ∩ (triangle_t ∩ band)), and triangle ∩ band is convex.
//  3. Overlapping footprints: the union is taken by inclusion-exclusion over cliques of the overlap graph; the
//     intersection of k footprints expands to products of fan triangles (still convex). Exact up to
//     MAX_EXACT_OVERLAP_DEPTH footprints overlapping at once; beyond that the plain sum is used, yards are floored
//     at 0 and a warning is added.
// TOLERANCE: on the unrounded `precise` values, |front + back + side - open| <= INVARIANT_REL_TOL * lot (floating
// point only). Reported values are rounded to whole sq ft at the end, so they agree within 2 sq ft.

import { centroid, pointInPolygon, localProjection, SQFT_PER_M2 } from './geometry.js';
import { sourced, unavailable } from './provenance.js';

/** Named constants. Distances in metres, angles in degrees. */
export const YARD_CONSTANTS = Object.freeze({
  /** Consecutive edges join the front line when their bearing is within this of the nearest edge's. */
  FRONT_GROUP_MAX_ANGLE_DEG: 15,
  /** ...and their distance to the street is within this of the nearest edge's distance. */
  FRONT_GROUP_TOL_M: 3,
  /** Edges whose nearest distance is within this of the minimum are tied; the tie goes to the smaller midpoint distance. */
  FRONT_TIE_M: 1,
  /** A tied edge outside the front group whose midpoint is within this of the front edge's makes the front ambiguous. */
  AMBIGUOUS_MID_M: 1,
  /** An edge within this distance of a street centreline fronts it (half of a 100 ft right-of-way plus margin). */
  STREET_FRONTAGE_TOL_M: 16,
  /** Beyond this the street is not treated as a frontage at all: {ok:false}. */
  MAX_STREET_DISTANCE_M: 60,
  /** Unnamed candidate streets nearer to the parcel than the nearest + this are a tie: {ok:false}. */
  STREET_TIE_M: 1,
  /** Another street's frontage within this undirected angle of the front line is a rear (through-lot) frontage. */
  THROUGH_LOT_MAX_ANGLE_DEG: 30,
  /** Front line shorter than this fraction of the lot width (extent along the front) = flag lot / irregular front. */
  IRREGULAR_FRONT_FRACTION: 0.35,
  /** Maximum number of footprints overlapping one another that the union handles exactly. */
  MAX_EXACT_OVERLAP_DEPTH: 6,
  /** Overlaps smaller than this (m²) are treated as touching walls. */
  OVERLAP_EPS_M2: 1e-6,
  /** Rings with less area than this (m²) are degenerate. */
  MIN_RING_AREA_M2: 0.01,
  /** Relative tolerance of the front + back + side = open invariant on unrounded values. */
  INVARIANT_REL_TOL: 1e-6,
});

/**
 * Confidence model: a base by street reference, times a penalty per named condition, capped at CONFIDENCE_CAP
 * (geometry-derived yards are estimates: footprints and parcel lines are imperfect, depth bands are a convention).
 */
export const YARD_CONFIDENCE = Object.freeze({
  /** Cap for any geometry-derived yard value. */
  CONFIDENCE_CAP: 0.6,
  /** Front chosen from a street centreline. */
  BASE_CENTRELINE: 0.6,
  /** Front chosen from a geocoded street-side point only (a point says less about which edge faces the street). */
  BASE_FRONT_POINT: 0.35,
  /** Several candidate streets and no streetName: the nearest one was used. */
  UNNAMED_STREET: 0.85,
  /** Street centreline (or front point) farther than STREET_FRONTAGE_TOL_M from the parcel. */
  FAR_STREET: 0.7,
  /** Front point lies inside the parcel. */
  POINT_INSIDE: 0.8,
  /** Another street also fronts the lot (corner or through lot): one frontage is counted as side or back yard. */
  SECOND_FRONTAGE: 0.85,
  /** Flag lot or front line shorter than IRREGULAR_FRONT_FRACTION of the lot width. */
  IRREGULAR_FRONT: 0.7,
  /** Another edge is about as near the street as the chosen one, in a different direction. */
  AMBIGUOUS_FRONT: 0.7,
  /** MultiPolygon parcel: only the part with the house is measured. */
  MULTIPART_PARCEL: 0.85,
  /** Overlapping footprints could not be removed exactly. */
  INEXACT_OVERLAP: 0.8,
});

const K = YARD_CONSTANTS;
const C = YARD_CONFIDENCE;
const DUP_M = 1e-7;
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------- planar primitives (local metres, [x, y])

/** @param {number[][]} r */
function signedArea(r) {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i], q = r[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Drop closing duplicate, repeated vertices, collinear points and zero-area spikes. @param {number[][]} ring */
function cleanRing(ring) {
  const r = [];
  for (const p of ring) {
    const last = r[r.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > DUP_M) r.push(p);
  }
  while (r.length > 1 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) <= DUP_M) r.pop();
  let changed = true;
  while (changed && r.length >= 3) {
    changed = false;
    for (let i = 0; i < r.length && r.length >= 3; i++) {
      const n = r.length, a = r[(i - 1 + n) % n], b = r[i], c = r[(i + 1) % n];
      const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu <= DUP_M || lv <= DUP_M || Math.abs(ux * vy - uy * vx) <= 1e-9 * lu * lv) {
        r.splice(i, 1); changed = true; i--;
      }
    }
  }
  return r;
}

/** @param {number[][]} r @param {boolean} ccw */
function orient(r, ccw) {
  return (signedArea(r) > 0) === ccw ? r : [...r].reverse();
}

/** Point in ring (ray casting). @param {number[]} p @param {number[][]} ring */
function inRingXY(p, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** @param {{outer:number[][], holes:number[][][]}} part @param {number[]} p */
function inPartXY(part, p) {
  return inRingXY(p, part.outer) && !part.holes.some((h) => inRingXY(p, h));
}

/** @param {number[]} p @param {number[]} a @param {number[]} b */
function ptSegDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

const cross3 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Segment-to-segment distance (0 when they cross). */
function segSegDist(a, b, c, d) {
  const o1 = cross3(a, b, c), o2 = cross3(a, b, d), o3 = cross3(c, d, a), o4 = cross3(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return 0;
  return Math.min(ptSegDist(a, c, d), ptSegDist(b, c, d), ptSegDist(c, a, b), ptSegDist(d, a, b));
}

/** @typedef {{a:number, b:number, c:number}} HalfPlane  keeps points with a*x + b*y <= c */

/** Sutherland-Hodgman against one half-plane. @param {number[][]} ring @param {HalfPlane} h */
function clipHalf(ring, h) {
  const out = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const S = ring[i], E = ring[(i + 1) % n];
    const fs = h.a * S[0] + h.b * S[1] - h.c, fe = h.a * E[0] + h.b * E[1] - h.c;
    if (fs <= 0) out.push(S);
    if ((fs < 0 && fe > 0) || (fs > 0 && fe < 0)) {
      const t = fs / (fs - fe);
      out.push([S[0] + t * (E[0] - S[0]), S[1] + t * (E[1] - S[1])]);
    }
  }
  return out;
}

/** Signed area of ring ∩ convex region. @param {number[][]} ring @param {HalfPlane[]} hps */
function clippedArea(ring, hps) {
  let r = ring;
  for (const h of hps) {
    r = clipHalf(r, h);
    if (r.length < 3) return 0;
  }
  return signedArea(r);
}

/** Area (m²) of parcel part ∩ convex region. Outer CCW and holes CW, so the winding number is 1 on the lot. */
function partAreaIn(part, hps) {
  let a = clippedArea(part.outer, hps);
  for (const h of part.holes) a += clippedArea(h, hps);
  return a;
}

/** CCW triangle -> its three half-planes. */
function triHalfPlanes(A, B, Cc) {
  return [[A, B], [B, Cc], [Cc, A]].map(([U, V]) => {
    const a = V[1] - U[1], b = -(V[0] - U[0]);
    return { a, b, c: a * U[0] + b * U[1] };
  });
}

/**
 * Signed fan triangles of a footprint part (outer CCW, holes CW) from its first vertex.
 * @param {{outer:number[][], holes:number[][][]}} bp
 */
function fanTriangles(bp) {
  const O = bp.outer[0];
  const tris = [];
  for (const ring of [bp.outer, ...bp.holes]) {
    for (let i = 0; i < ring.length; i++) {
      const P = ring[i], Q = ring[(i + 1) % ring.length];
      const cr = cross3(O, P, Q);
      if (Math.abs(cr) <= 1e-12) continue;
      const [A, B] = cr > 0 ? [P, Q] : [Q, P];
      tris.push({
        sign: cr > 0 ? 1 : -1,
        hps: triHalfPlanes(O, A, B),
        bbox: [Math.min(O[0], A[0], B[0]), Math.min(O[1], A[1], B[1]), Math.max(O[0], A[0], B[0]), Math.max(O[1], A[1], B[1])],
      });
    }
  }
  return tris;
}

/** Area (m²) of part ∩ (every footprint in `ents`) ∩ region `hps`, by products of fan triangles. */
function intersectionArea(part, ents, hps) {
  let total = 0;
  const rec = (k, acc, sign, bb) => {
    if (bb[0] > bb[2] || bb[1] > bb[3]) return;
    if (k === ents.length) { total += sign * partAreaIn(part, acc); return; }
    for (const t of ents[k].tris) {
      rec(k + 1, acc.concat(t.hps), sign * t.sign,
        [Math.max(bb[0], t.bbox[0]), Math.max(bb[1], t.bbox[1]), Math.min(bb[2], t.bbox[2]), Math.min(bb[3], t.bbox[3])]);
    }
  };
  rec(0, hps, 1, part.bbox);
  return total;
}

/** Cliques of an undirected graph up to size maxK; overflow = a clique larger than maxK exists. */
function cliques(n, adj, maxK) {
  const out = [];
  let overflow = false;
  const ext = (cl, cands) => {
    out.push(cl);
    if (cl.length === maxK) { if (cands.length) overflow = true; return; }
    cands.forEach((v, k) => ext([...cl, v], cands.slice(k + 1).filter((u) => adj[v][u])));
  };
  for (let v = 0; v < n; v++) {
    const cands = [];
    for (let u = v + 1; u < n; u++) if (adj[v][u]) cands.push(u);
    ext([v], cands);
  }
  return { list: out, overflow };
}

// ---------------------------------------------------------------- input parsing

const geomOf = (g) => (g && g.type === 'Feature' ? g.geometry : g);
const isPos = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
  && Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180;

/** Raw polygons ([rings]) of a Polygon/MultiPolygon, or a reason. */
function rawPolygons(g, what) {
  const geom = geomOf(g);
  if (!geom || typeof geom !== 'object') return { reason: `${what} is missing` };
  let polys;
  if (geom.type === 'Polygon') polys = [geom.coordinates];
  else if (geom.type === 'MultiPolygon') polys = geom.coordinates;
  else return { reason: `${what} is not a GeoJSON Polygon or MultiPolygon` };
  if (!Array.isArray(polys) || !polys.length) return { reason: `${what} has no coordinates` };
  for (const rings of polys) {
    if (!Array.isArray(rings) || !rings.length) return { reason: `${what} has an empty polygon` };
    for (const ring of rings) {
      if (!Array.isArray(ring)) return { reason: `${what} has a malformed ring` };
      if (!ring.every(isPos)) return { reason: `${what} has a coordinate that is not a finite [lng, lat]` };
    }
  }
  return { polys };
}

/** Project and clean one polygon ([outer, ...holes]); holes outside the outer ring are dropped with a warning. */
function projectPolygon(rings, proj, warnings, what) {
  const outer = cleanRing(rings[0].map(proj.toXY));
  if (outer.length < 3 || Math.abs(signedArea(outer)) < K.MIN_RING_AREA_M2) return null;
  const o = orient(outer, true);
  const holes = [];
  for (const h of rings.slice(1)) {
    const hc = cleanRing(h.map(proj.toXY));
    if (hc.length < 3 || Math.abs(signedArea(hc)) < K.MIN_RING_AREA_M2) continue;
    if (!hc.every((p) => inRingXY(p, o))) { warnings.push(`${what} has a hole outside its outer ring; the hole was ignored`); continue; }
    holes.push(orient(hc, false));
  }
  const xs = o.map((p) => p[0]), ys = o.map((p) => p[1]);
  return {
    outer: o, holes, raw: rings,
    areaM2: signedArea(o) + holes.reduce((s, h) => s + signedArea(h), 0),
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

function selfIntersects(r) {
  const n = r.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segSegDist(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n]) < 1e-6) return true;
    }
  }
  return false;
}

/** Validate and project a parcel. */
function prepareParcel(parcel) {
  const rp = rawPolygons(parcel, 'parcel');
  if (!rp.polys) return { ok: false, reason: rp.reason };
  let proj;
  try { proj = localProjection(centroid(geomOf(parcel))); } catch { return { ok: false, reason: 'parcel centroid could not be computed' }; }
  const warnings = [];
  const parts = [];
  for (const rings of rp.polys) {
    if (rings[0].length < 3) continue;
    const cleaned = cleanRing(rings[0].map(proj.toXY));
    if (cleaned.length >= 4 && selfIntersects(cleaned)) return { ok: false, reason: 'parcel boundary crosses itself' };
    const p = projectPolygon(rings, proj, warnings, 'parcel');
    if (p) parts.push(p);
  }
  if (!parts.length) return { ok: false, reason: 'parcel has fewer than 3 distinct vertices or zero area' };
  if (!parts.some((p) => p.areaM2 > K.MIN_RING_AREA_M2)) return { ok: false, reason: 'parcel has zero area after its holes' };
  return { ok: true, proj, parts, warnings };
}

function rawLines(g) {
  const geom = geomOf(g);
  if (!geom) return null;
  let lines;
  if (geom.type === 'LineString') lines = [geom.coordinates];
  else if (geom.type === 'MultiLineString') lines = geom.coordinates;
  else return null;
  if (!Array.isArray(lines) || !lines.length) return null;
  for (const l of lines) if (!Array.isArray(l) || l.length < 2 || !l.every(isPos)) return null;
  return lines;
}

const normName = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');

/** Street reference -> {mode, candidates:[{name, lines(xy)}], point}. */
function prepareStreets(ref, proj) {
  if (!ref || typeof ref !== 'object') return { ok: false, reason: 'no street reference: pass a street centreline or a front point' };
  const raw = [];
  const add = (name, geometry) => raw.push({ name: name == null ? null : String(name), geometry });
  if (Array.isArray(ref.street)) ref.street.forEach((s) => add(s && s.name, s && s.geometry));
  else if (ref.street) add(ref.streetName ?? null, ref.street);
  if (Array.isArray(ref.streets)) ref.streets.forEach((s) => add(s && s.name, s && s.geometry));
  const candidates = [];
  for (const s of raw) {
    const lines = rawLines(s.geometry);
    if (!lines) return { ok: false, reason: 'street geometry is not a LineString or MultiLineString with finite coordinates' };
    const xy = lines.map((l) => l.map(proj.toXY));
    const key = s.name == null ? null : normName(s.name);
    const same = key != null && candidates.find((c) => c.key === key);
    if (same) same.lines.push(...xy);
    else candidates.push({ name: s.name, key, lines: xy });
  }
  if (candidates.length) return { ok: true, mode: 'centreline', candidates };
  const fp = ref.frontPoint;
  if (fp != null) {
    if (!Number.isFinite(fp.lat) || !Number.isFinite(fp.lng) || Math.abs(fp.lat) > 90 || Math.abs(fp.lng) > 180) {
      return { ok: false, reason: 'frontPoint is not a finite {lat, lng}' };
    }
    return { ok: true, mode: 'point', candidates: [], point: proj.toXY([fp.lng, fp.lat]) };
  }
  return { ok: false, reason: 'no street reference: pass a street centreline or a front point' };
}

// ---------------------------------------------------------------- front edge

function edgesOf(outer) {
  return outer.map((a, i) => {
    const b = outer[(i + 1) % outer.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return { i, a, b, len, ux: (b[0] - a[0]) / len, uy: (b[1] - a[1]) / len, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  });
}

function distToLines(lines, a, b) {
  let d = Infinity;
  for (const l of lines) for (let k = 0; k + 1 < l.length; k++) d = Math.min(d, segSegDist(a, b, l[k], l[k + 1]));
  return d;
}
const distTarget = (t, a, b) => (t.lines ? distToLines(t.lines, a, b) : ptSegDist(t.point, a, b));
const midTarget = (t, m) => (t.lines ? distToLines(t.lines, m, m) : Math.hypot(m[0] - t.point[0], m[1] - t.point[1]));

/** Rank edges for a target: nearest distance, ties (FRONT_TIE_M) broken by midpoint distance, then index. */
function nearestEdge(edges, target, exclude) {
  const scored = edges.filter((e) => !exclude.has(e.i)).map((e) => ({ e, d: distTarget(target, e.a, e.b), m: midTarget(target, e.mid) }));
  if (!scored.length) return null;
  const D = Math.min(...scored.map((s) => s.d));
  const tied = scored.filter((s) => s.d <= D + K.FRONT_TIE_M).sort((x, y) => x.m - y.m || x.d - y.d || x.e.i - y.e.i);
  return { best: tied[0], tied, D, scored };
}

/** Edges shorter than this never seed the front by the facing rule (corner chamfers, digitising noise). */
const MIN_FACING_EDGE_M = 1.5;
/** Fractions along an edge from which the outward rays are cast. */
const RAY_AT = [0.2, 0.5, 0.8];

/** Distance along the ray p + s*d (s > 0) to segment ab, or Infinity. */
function rayHit(p, d, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const den = d[0] * ey - d[1] * ex;
  if (Math.abs(den) < 1e-12) return Infinity;
  const wx = a[0] - p[0], wy = a[1] - p[1];
  const s = (wx * ey - wy * ex) / den, t = (wx * d[1] - wy * d[0]) / den;
  return s > 1e-9 && t >= 0 && t <= 1 ? s : Infinity;
}

/**
 * The edge facing the street: for each edge (CCW ring, so outward = right of the edge) rays are cast outward, square to the edge, from
 * RAY_AT points; the edge's facing distance is the median of the hits when at least two of the three rays meet the street. Smallest
 * facing distance wins; edges within FRONT_TIE_M of it are tied and the longer edge wins. Null when no edge faces the street within
 * MAX_STREET_DISTANCE_M. @param {any[]} edges @param {number[][][]} lines
 */
function rayFront(edges, lines) {
  const all = [];
  for (const e of edges) {
    if (e.len < MIN_FACING_EDGE_M) continue;
    const out = [e.uy, -e.ux];
    const hits = [];
    for (const f of RAY_AT) {
      const p = [e.a[0] + f * (e.b[0] - e.a[0]), e.a[1] + f * (e.b[1] - e.a[1])];
      let best = Infinity;
      for (const l of lines) for (let k = 0; k + 1 < l.length; k++) best = Math.min(best, rayHit(p, out, l[k], l[k + 1]));
      if (best <= K.MAX_STREET_DISTANCE_M) hits.push(best);
    }
    if (hits.length >= 2) { hits.sort((x, y) => x - y); all.push({ e, d: hits.length === 3 ? hits[1] : (hits[0] + hits[1]) / 2 }); }
  }
  if (!all.length) return null;
  all.sort((x, y) => x.d - y.d || y.e.len - x.e.len || x.e.i - y.e.i);
  const D = all[0].d;
  const tied = all.filter((h) => h.d <= D + K.FRONT_TIE_M).sort((x, y) => y.e.len - x.e.len || x.e.i - y.e.i);
  return { e: tied[0].e, d: tied[0].d, all };
}

const angleDirected = (e, f) => Math.acos(Math.max(-1, Math.min(1, e.ux * f.ux + e.uy * f.uy))) * DEG;
const angleUndirected = (ux, uy, vx, vy) => Math.acos(Math.min(1, Math.abs(ux * vx + uy * vy))) * DEG;
const bearingOf = (x, y) => ((Math.atan2(x, y) * DEG) % 360 + 360) % 360; // compass: 0 = north, clockwise

/**
 * Front edge(s) of one projected parcel part.
 * @returns {{ok:false, reason:string}|{ok:true, [k:string]:any}}
 */
function frontOfPart(part, streets, proj) {
  const warnings = [];
  /** @type {Array<{name:string, factor:number}>} */
  const factors = [];
  const edges = edgesOf(part.outer);
  const n = edges.length;
  let target, streetName = null, others = [];
  if (streets.mode === 'centreline') {
    let chosen;
    const cands = streets.candidates;
    if (streets.wanted != null) {
      chosen = cands.find((c) => c.key === normName(streets.wanted));
      if (!chosen) return { ok: false, reason: `street "${streets.wanted}" is not among the supplied streets` };
    } else if (cands.length === 1) {
      chosen = cands[0];
    } else {
      const dist = cands.map((c) => Math.min(...edges.map((e) => distToLines(c.lines, e.a, e.b))));
      const dmin = Math.min(...dist);
      const near = cands.filter((_, k) => dist[k] <= dmin + K.STREET_TIE_M);
      if (near.length > 1) return { ok: false, reason: `${near.length} streets are about equally near the parcel; pass streetName to choose the address street` };
      chosen = cands[dist.indexOf(dmin)];
      warnings.push(`no streetName given: the nearest of ${cands.length} streets (${chosen.name ?? 'unnamed'}) was used as the front`);
      factors.push({ name: 'UNNAMED_STREET', factor: C.UNNAMED_STREET });
    }
    target = { lines: chosen.lines };
    streetName = chosen.name;
    others = cands.filter((c) => c !== chosen);
  } else {
    target = { point: streets.point };
    if (inPartXY(part, streets.point)) {
      warnings.push('front point lies inside the parcel; the parcel edge nearest to it was used as the front');
      factors.push({ name: 'POINT_INSIDE', factor: C.POINT_INSIDE });
    }
  }
  const ranked = nearestEdge(edges, target, new Set());
  // With a centreline, the edge that FACES the street wins over the edge that merely comes nearest to it: near a junction the
  // centreline curves round the corner (or a junction connector is drawn there), so the corner vertex is nearest to it and a short
  // corner edge or the side edge could be taken. "Faces" = a ray cast outward, square to the edge, from points along it, meets the
  // street (rayFront). Measured on Los Angeles corner lots (docs/yard-accuracy.md, Stage 1). Falls back to the nearest edge when no
  // edge faces the street within MAX_STREET_DISTANCE_M.
  const facing = target.lines ? rayFront(edges, target.lines) : null;
  const star = facing ? (ranked.scored.find((s) => s.e.i === facing.e.i) ?? ranked.best) : ranked.best;
  const what = streets.mode === 'centreline' ? 'street centreline' : 'front point';
  if (star.d > K.MAX_STREET_DISTANCE_M) {
    return { ok: false, reason: `the ${what} is ${star.d.toFixed(1)} m from the parcel (more than ${K.MAX_STREET_DISTANCE_M} m): not treated as its frontage` };
  }
  if (star.d > K.STREET_FRONTAGE_TOL_M) {
    warnings.push(`the ${what} is ${star.d.toFixed(1)} m from the nearest parcel edge (more than ${K.STREET_FRONTAGE_TOL_M} m); front chosen with lower confidence`);
    factors.push({ name: 'FAR_STREET', factor: C.FAR_STREET });
  }
  // grow the group along the ring in both directions
  const group = [star.e.i];
  const fits = (e) => angleDirected(e, star.e) <= K.FRONT_GROUP_MAX_ANGLE_DEG && distTarget(target, e.a, e.b) <= star.d + K.FRONT_GROUP_TOL_M;
  for (let k = 1; k < n; k++) { const e = edges[(star.e.i + k) % n]; if (!fits(e)) break; group.push(e.i); }
  for (let k = 1; group.length < n; k++) {
    const e = edges[(((star.e.i - k) % n) + n) % n];
    if (group.includes(e.i) || !fits(e)) break;
    group.unshift(e.i);
  }
  const gEdges = group.map((i) => edges[i]);
  const gSet = new Set(group);
  let vx = 0, vy = 0, frontLen = 0;
  for (const e of gEdges) { vx += e.b[0] - e.a[0]; vy += e.b[1] - e.a[1]; frontLen += e.len; }
  const vl = Math.hypot(vx, vy);
  const ux = vx / vl, uy = vy / vl;
  const nx = -uy, ny = ux; // left of a CCW ring = inside
  const depth0 = Math.min(...gEdges.flatMap((e) => [e.a[0] * nx + e.a[1] * ny, e.b[0] * nx + e.b[1] * ny]));
  const along = part.outer.map((p) => p[0] * ux + p[1] * uy);
  const lotWidth = Math.max(...along) - Math.min(...along);
  const frontFraction = frontLen / lotWidth;

  let ambiguous = false;
  const rival = facing
    ? facing.all.find((h) => !gSet.has(h.e.i) && h.d <= facing.d + K.FRONT_TIE_M && angleUndirected(h.e.ux, h.e.uy, ux, uy) > K.FRONT_GROUP_MAX_ANGLE_DEG)
    : ((r) => (r && r.m <= star.m + K.AMBIGUOUS_MID_M ? r : null))(ranked.tied.find((s) => !gSet.has(s.e.i)));
  if (rival && angleUndirected(rival.e.ux, rival.e.uy, ux, uy) > K.FRONT_GROUP_MAX_ANGLE_DEG) {
    ambiguous = true;
    warnings.push('front ambiguous: another parcel edge is about as near the street in a different direction');
    factors.push({ name: 'AMBIGUOUS_FRONT', factor: C.AMBIGUOUS_FRONT });
  }
  if (frontFraction < K.IRREGULAR_FRONT_FRACTION) {
    warnings.push(`flag lot or irregular front: the front line is ${Math.round(frontFraction * 100)}% of the lot width (under ${Math.round(K.IRREGULAR_FRONT_FRACTION * 100)}%); front and back yards follow depth from that short line`);
    factors.push({ name: 'IRREGULAR_FRONT', factor: C.IRREGULAR_FRONT });
  }
  const otherFrontages = [];
  for (const o of others) {
    const r = nearestEdge(edges, { lines: o.lines }, gSet);
    if (!r || r.best.d > K.STREET_FRONTAGE_TOL_M) continue;
    const through = angleUndirected(r.best.e.ux, r.best.e.uy, ux, uy) <= K.THROUGH_LOT_MAX_ANGLE_DEG;
    otherFrontages.push({ street: o.name, kind: through ? 'rear' : 'side', distanceM: r.best.d, edgeIndex: r.best.e.i });
  }
  if (otherFrontages.some((f) => f.kind === 'side')) {
    warnings.push('corner lot: the second street frontage is counted as side yard');
  }
  if (otherFrontages.some((f) => f.kind === 'rear')) {
    warnings.push('through lot: the rear street frontage is counted as back yard');
  }
  if (otherFrontages.length) factors.push({ name: 'SECOND_FRONTAGE', factor: C.SECOND_FRONTAGE });

  const ll = (p) => { const [lng, lat] = proj.toLngLat(p); return { lat, lng }; };
  const how = streets.mode === 'centreline'
    ? `parcel edge nearest the ${streetName ? `centreline of ${streetName}` : 'street centreline'}${group.length > 1 ? `, with ${group.length - 1} consecutive edge(s) along the street` : ''}`
    : `parcel edge nearest the front point${group.length > 1 ? `, with ${group.length - 1} consecutive edge(s) in line` : ''}`;
  return {
    ok: true,
    xy: { ux, uy, nx, ny, depth0, group },
    report: {
      edges: gEdges.map((e) => ({ from: ll(e.a), to: ll(e.b), lengthM: e.len, distanceM: distTarget(target, e.a, e.b) })),
      lengthM: frontLen,
      bearingDeg: bearingOf(ux, uy) % 180,
      inward: { east: nx, north: ny },
      inwardBearingDeg: bearingOf(nx, ny),
      distanceM: star.d,
      chosenBy: streets.mode === 'centreline' ? 'centreline' : 'frontPoint',
      street: streetName,
      how,
      lotWidthM: lotWidth,
      frontFraction,
      ambiguous,
      otherFrontages,
    },
    warnings,
    factors,
  };
}

/**
 * Find the front lot line of a parcel.
 * @param {any} parcel GeoJSON Polygon/MultiPolygon (WGS84) or Feature
 * @param {{street?:any, streets?:Array<{name:string, geometry:any}>, streetName?:string, frontPoint?:{lat:number,lng:number}}} streetRef
 * @param {{partIndex?:number}} [options] which MultiPolygon part (default: the largest)
 */
export function findFrontEdge(parcel, streetRef, options = {}) {
  const pp = prepareParcel(parcel);
  if (!pp.ok) return { ok: false, reason: pp.reason };
  const st = prepareStreets(streetRef, pp.proj);
  if (!st.ok) return { ok: false, reason: st.reason };
  st.wanted = streetRef.streetName ?? null;
  let idx = options.partIndex;
  if (idx == null) idx = pp.parts.reduce((b, p, k) => (p.areaM2 > pp.parts[b].areaM2 ? k : b), 0);
  const part = pp.parts[idx];
  if (!part) return { ok: false, reason: `parcel has no part ${idx}` };
  const f = frontOfPart(part, st, pp.proj);
  if (!f.ok) return f;
  return { ok: true, ...f.report, warnings: [...pp.warnings, ...f.warnings], confidenceFactors: f.factors };
}

// ---------------------------------------------------------------- yard split

/** Parse the buildings list: each item a Polygon/MultiPolygon, a Feature, or {polygon}. */
function prepareBuildings(list, proj, warnings) {
  const out = [];
  list.forEach((item, index) => {
    const g = item && !item.type && item.polygon ? item.polygon : item;
    const rp = rawPolygons(g, `building ${index}`);
    if (!rp.polys) { warnings.push(`${rp.reason}; it was ignored`); return; }
    const parts = [];
    for (const rings of rp.polys) {
      if (rings[0].length < 3) continue;
      const p = projectPolygon(rings, proj, warnings, `building ${index}`);
      if (p) parts.push(p);
    }
    if (!parts.length) { warnings.push(`building ${index} has zero area; it was ignored`); return; }
    let cLL = null;
    try { cLL = centroid(geomOf(g)); } catch { /* handled below */ }
    out.push({ index, parts, areaM2: parts.reduce((s, p) => s + p.areaM2, 0), centroidLL: cLL, geometry: geomOf(g) });
  });
  return out;
}

const m2ToSqft = (m2) => m2 * SQFT_PER_M2;

/**
 * Split a parcel into front, back and side yard.
 * @param {{parcel:any, buildings?:any[], street?:any, streets?:Array<{name:string, geometry:any}>, streetName?:string,
 *   frontPoint?:{lat:number,lng:number}, mainBuildingIndex?:number}} input
 */
export function splitYard(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'input must be an object' };
  const pp = prepareParcel(input.parcel);
  if (!pp.ok) return { ok: false, reason: pp.reason };
  const warnings = [...pp.warnings];
  const factors = [];
  const proj = pp.proj;
  const st = prepareStreets(input, proj);
  if (!st.ok) return { ok: false, reason: st.reason };
  st.wanted = input.streetName ?? null;
  if (input.buildings != null && !Array.isArray(input.buildings)) return { ok: false, reason: 'buildings must be an array' };
  const blds = prepareBuildings(input.buildings ?? [], proj, warnings);

  // house: largest footprint whose centroid lies on the parcel
  const onParcel = (b) => b.centroidLL && pointInPolygon(b.centroidLL, geomOf(input.parcel));
  let house = null;
  if (input.mainBuildingIndex != null) {
    house = blds.find((b) => b.index === input.mainBuildingIndex) ?? null;
    if (!house) return { ok: false, reason: `mainBuildingIndex ${input.mainBuildingIndex} is not a usable building` };
  } else {
    for (const b of blds) if (onParcel(b) && (!house || b.areaM2 > house.areaM2)) house = b;
  }

  // parcel part: the one holding the house centroid, else the largest
  let partIdx = pp.parts.reduce((b, p, k) => (p.areaM2 > pp.parts[b].areaM2 ? k : b), 0);
  if (house) {
    const hc = house.centroidLL ? proj.toXY([house.centroidLL.lng, house.centroidLL.lat]) : null;
    const k = hc ? pp.parts.findIndex((p) => inPartXY(p, hc)) : -1;
    if (k >= 0) partIdx = k;
  }
  const part = pp.parts[partIdx];
  if (pp.parts.length > 1) {
    warnings.push(`parcel has ${pp.parts.length} parts: only the part ${house ? 'containing the house' : '(largest)'} is measured`);
    factors.push({ name: 'MULTIPART_PARCEL', factor: C.MULTIPART_PARCEL });
  }

  const f = frontOfPart(part, st, proj);
  if (!f.ok) return { ok: false, reason: f.reason };
  warnings.push(...f.warnings);
  factors.push(...f.factors);

  // footprint parts that touch the parcel part
  const ents = [];
  for (const b of blds) {
    let inside = 0;
    const bEnts = b.parts.map((p) => ({ b, tris: fanTriangles(p), areaM2: p.areaM2 }));
    for (const e of bEnts) { e.insideM2 = intersectionArea(part, [e], []); inside += e.insideM2; }
    if (inside <= K.OVERLAP_EPS_M2) {
      if (b !== house) warnings.push(`building ${b.index} lies outside the parcel and is ignored`);
      continue;
    }
    if (b.areaM2 - inside > 0.01) {
      warnings.push(`building ${b.index} extends past the parcel line by ${Math.round(m2ToSqft(b.areaM2 - inside))} sq ft; only the part on the parcel is counted`);
    }
    for (const e of bEnts) if (e.insideM2 > K.OVERLAP_EPS_M2) ents.push(e);
  }
  if (house && !ents.some((e) => e.b === house)) return { ok: false, reason: `building ${house.index} does not overlap the parcel` };

  // overlap graph and exact union by inclusion-exclusion
  const adj = ents.map(() => ents.map(() => false));
  let overlapCount = 0;
  for (let i = 0; i < ents.length; i++) {
    for (let j = i + 1; j < ents.length; j++) {
      if (intersectionArea(part, [ents[i], ents[j]], []) > K.OVERLAP_EPS_M2) { adj[i][j] = adj[j][i] = true; overlapCount++; }
    }
  }
  const cl = cliques(ents.length, adj, K.MAX_EXACT_OVERLAP_DEPTH);
  const exactUnion = !cl.overflow;
  if (overlapCount && exactUnion) warnings.push(`${overlapCount} pair(s) of footprints overlap; the overlap is counted once`);
  if (!exactUnion) {
    warnings.push(`more than ${K.MAX_EXACT_OVERLAP_DEPTH} footprints overlap one another: overlaps could not be removed exactly, building area may be overcounted and yards are floored at 0`);
    factors.push({ name: 'INEXACT_OVERLAP', factor: C.INEXACT_OVERLAP });
  }
  const builtIn = (hps) => {
    if (!exactUnion) return ents.reduce((s, e) => s + intersectionArea(part, [e], hps), 0);
    let s = 0;
    for (const c of cl.list) s += (c.length % 2 ? 1 : -1) * intersectionArea(part, c.map((k) => ents[k]), hps);
    return s;
  };

  const lotM2 = partAreaIn(part, []);
  const builtM2 = Math.max(0, builtIn([]));
  const openM2 = Math.max(0, lotM2 - builtM2);

  const conf = (base, fs) => Math.round(Math.min(C.CONFIDENCE_CAP, fs.reduce((s, x) => s * x.factor, base)) * 1000) / 1000;
  const base = st.mode === 'centreline' ? C.BASE_CENTRELINE : C.BASE_FRONT_POINT;
  if (st.mode === 'point') warnings.push('no street centreline: the front was chosen from a geocoded front point, with lower confidence');
  const openFactors = factors.filter((x) => x.name === 'MULTIPART_PARCEL' || x.name === 'INEXACT_OVERLAP');

  const precise = { lotSqft: m2ToSqft(lotM2), buildingSqft: m2ToSqft(builtM2), openSqft: m2ToSqft(openM2), frontYardSqft: null, backYardSqft: null, sideYardSqft: null };
  let yardReason = null, houseInfo = null;
  /** @type {any} */ let bands = null;
  const method = `front line = ${f.report.how}; depth bands at the house's front and rear building lines; `
    + 'areas by exact half-plane clipping (Sutherland-Hodgman) of the parcel with signed fan triangles of each footprint'
    + `${overlapCount ? ' and inclusion-exclusion for overlaps' : ''}; local equirectangular frame around the parcel centroid`;

  if (!house) {
    yardReason = 'no building on the parcel';
    if (blds.length) warnings.push('no building centroid lies on the parcel: front, back and side yard are not split');
  } else {
    const { nx, ny, depth0 } = f.xy;
    const depths = house.parts.flatMap((p) => p.outer.map((q) => q[0] * nx + q[1] * ny - depth0));
    const d1 = Math.min(...depths), d2 = Math.max(...depths);
    const lo = { a: nx, b: ny, c: d1 + depth0 }; // depth <= d1
    const hiOut = { a: -nx, b: -ny, c: -(d2 + depth0) }; // depth >= d2
    const loOut = { a: -nx, b: -ny, c: -(d1 + depth0) }; // depth >= d1
    const hi = { a: nx, b: ny, c: d2 + depth0 }; // depth <= d2
    const band = (hps) => {
      const raw = partAreaIn(part, hps) - builtIn(hps);
      if (raw < -K.INVARIANT_REL_TOL * lotM2 && exactUnion) warnings.push('a yard band came out negative and was floored at 0');
      return Math.max(0, raw);
    };
    precise.frontYardSqft = m2ToSqft(band([lo]));
    precise.backYardSqft = m2ToSqft(band([hiOut]));
    precise.sideYardSqft = m2ToSqft(band([loOut, hi]));
    houseInfo = { index: house.index, frontSetbackM: d1, rearLineDepthM: d2 };
    bands = { origin: proj.origin, nx, ny, depth0, d1, d2 };
  }
  const rnd = (v) => (v == null ? null : Math.round(v));
  return {
    ok: true,
    lotSqft: rnd(precise.lotSqft),
    buildingSqft: rnd(precise.buildingSqft),
    openSqft: rnd(precise.openSqft),
    frontYardSqft: rnd(precise.frontYardSqft),
    backYardSqft: rnd(precise.backYardSqft),
    sideYardSqft: rnd(precise.sideYardSqft),
    yardReason,
    frontEdge: f.report,
    house: houseInfo,
    method,
    confidence: conf(base, factors),
    openConfidence: conf(C.BASE_CENTRELINE, openFactors),
    confidenceFactors: factors,
    warnings,
    precise,
    ...(bands ? { bands } : {}),
  };
}

/**
 * The yard zone of a point, with the same depth bands splitYard measured (front: depth < d1, back: depth > d2, side: between). For
 * pixels of an aerial photo (core/aerial.js). Returns null for a failed or unsplit result. Does not test whether the point is on the lot.
 * @param {any} result splitYard output
 * @returns {((lng:number, lat:number)=>('front'|'back'|'side'))|null}
 */
export function yardZoneAt(result) {
  const b = result && result.ok ? result.bands : null;
  if (!b) return null;
  const proj = localProjection(b.origin);
  return (lng, lat) => {
    const [x, y] = proj.toXY([lng, lat]);
    const d = x * b.nx + y * b.ny - b.depth0;
    return d < b.d1 ? 'front' : d > b.d2 ? 'back' : 'side';
  };
}

// ---------------------------------------------------------------- provenance

const SOURCE = 'Everyspace yard geometry';

/**
 * Turn a splitYard result into Sourced attributes.
 * @param {any} result splitYard output
 * @param {{now:string, sources:{parcel:string, footprints:string, street:string}}} opts
 * @returns {{front_yard_sqft:any, back_yard_sqft:any, side_yard_sqft:any, yard_area_sqft:any}}
 */
export function yardAttributes(result, { now, sources } = /** @type {any} */ ({})) {
  if (typeof now !== 'string' || Number.isNaN(Date.parse(now))) throw new TypeError('yardAttributes: now must be an ISO time');
  if (!sources || ['parcel', 'footprints', 'street'].some((k) => typeof sources[k] !== 'string' || !sources[k])) {
    throw new TypeError('yardAttributes: sources.parcel, sources.footprints and sources.street must be non-empty strings');
  }
  const keys = ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft', 'yard_area_sqft'];
  if (!result || result.ok !== true) {
    const why = (result && result.reason) || 'yard split failed';
    return /** @type {any} */ (Object.fromEntries(keys.map((k) => [k, unavailable(why, SOURCE)])));
  }
  const note = result.warnings.length ? result.warnings.join('; ') : undefined;
  const ref = result.frontEdge.chosenBy === 'centreline' ? `street centreline (${sources.street})` : `front point (${sources.street})`;
  const est = (value, conf, what, split) => sourced(value, {
    tag: 'estimated', source: SOURCE, confidence: conf, retrievedAt: now, unit: 'sqft', note,
    method: `${what}: parcel polygon (${sources.parcel}) minus building footprints (${sources.footprints})`
      + (split ? `, split by depth from the front lot line facing the ${ref}` : `; front line from the ${ref}`),
  });
  const yard = (v, what) => (v == null ? unavailable(result.yardReason || 'yard could not be split', SOURCE) : est(v, result.confidence, what, true));
  return {
    front_yard_sqft: yard(result.frontYardSqft, 'front yard'),
    back_yard_sqft: yard(result.backYardSqft, 'back yard'),
    side_yard_sqft: yard(result.sideYardSqft, 'side yard'),
    yard_area_sqft: est(result.openSqft, result.openConfidence, 'open area (lot minus buildings)', false),
  };
}

// @ts-check
// The DRIVEWAY of a lot, estimated from evidence Everyspace already has. Pure, deterministic, no I/O.
//
// Evidence, in this order (nothing found -> {ok:false, reason}; a default rectangle is never drawn):
//  (a) 'map+photo': a mapped driveway line (Overture transportation, class service / subclass driveway: core/providers/overture-roads.js keeps
//      them apart from the street lines) that lies on or enters the lot picks the strip of (b) it runs along; the width is only what the
//      photo shows paved.
//  (b) 'photo': in the aerial classification of the lot's open ground (core/aerial.js), read in the street's frame (u along the front lot
//      line, d inward, core/yard.js bands): in each 0.3 m column the paving that runs unbroken from the front lot line inward and runs into
//      a building (house or garage); adjacent such columns form a strip, and the widest strip at least MIN_WIDTH_M wide is the driveway.
//      Paving behind the house's rear line counts only where it runs into another building (a rear garage along the side); paving that
//      never reaches the front line (a patio) is never a driveway; the public sidewalk and roadway are outside the lot and never read.
//  The first version (a flood fill of all connected paving) was looked at on the ten LA test lots and rejected before measuring: in LA the
//  paving often wraps round the house, so the fill outlined the whole yard (docs/yard-accuracy.md, Driveway).
//  A mapped line with no photo to confirm its width is NOT turned into a polygon ({ok:false} with the line in `line`).
// The outline is traced from the pixels and simplified (Douglas-Peucker) to at most MAX_CORNERS corners so an owner can drag it.
// Width = the strip's width across the front line; length = the median depth the paving runs.
// Area (`drivewayAreaSqft`): the outline clipped to the lot minus the building outlines, on the same 0.25 m grid as core/usable-yard.js;
// the builder and core/measure.js both use it, so a dragged outline and the lookup agree.

import { localProjection, centroid, SQFT_PER_M2, polygonAreaSqft } from './geometry.js';
import { CLASS } from './aerial.js';

export const DRIVEWAY = Object.freeze({
  /** The paving must start within this depth of the front lot line (m). */
  SEED_DEPTH_M: 2,
  /** Sampling step of the street-frame grid (m; NAIP pixels are 0.6 m). */
  STEP_M: 0.3,
  /** Breaks in the paving up to this long (m) are bridged (a crack of shade, a tree branch). */
  GAP_M: 1.2,
  /** Narrower runs are not a driveway (m; 2.4 m = 8 ft, a narrow single driveway). */
  MIN_WIDTH_M: 2.4,
  /** A region touches a building when a building pixel is within this (m). */
  TOUCH_M: 1.2,
  /** A mapped line counts when it comes this close to the lot (m). */
  LINE_NEAR_M: 3,
  /** Smaller regions are not a driveway (m2; 10 m2 = 108 sq ft). */
  MIN_AREA_M2: 10,
  /** Wider than this (ft) gets a warning: probably a paved front yard or parking pad as well. */
  WIDE_FT: 26,
  MAX_CORNERS: 12,
  CONFIDENCE: Object.freeze({ 'map+photo': 0.4, photo: 0.3 }),
});
export const DRIVEWAY_METHOD = {
  'map+photo': 'the mapped driveway line (OpenStreetMap via Overture) on the lot, widened to the paving the aerial photo shows around it',
  photo: 'the paved or bare ground in the aerial photo that runs from the street side of the lot to a building, outlined and simplified',
};
const D = DRIVEWAY;

const geomOf = (/** @type {any} */ g) => (g && g.type === 'Feature' ? g.geometry : g && !g.type && g.polygon ? g.polygon : g);
const polysOf = (/** @type {any} */ g) => { const x = geomOf(g); return x?.type === 'Polygon' ? [x.coordinates] : x?.type === 'MultiPolygon' ? x.coordinates : []; };
function inPolys(/** @type {number[][][][]} */ polys, /** @type {number} */ x, /** @type {number} */ y) {
  for (const rings of polys) {
    let c = false;
    for (const ring of rings) for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xi, yi] = ring[a], [xj, yj] = ring[b];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    if (c) return true;
  }
  return false;
}
const linesOf = (/** @type {any} */ g) => { const x = geomOf(g); return x?.type === 'LineString' ? [x.coordinates] : x?.type === 'MultiLineString' ? x.coordinates : []; };
function segDist(/** @type {number[]} */ p, /** @type {number[]} */ a, /** @type {number[]} */ b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Outer boundary of a pixel mask as a loop of pixel-corner points (the longest loop). @param {Uint8Array} m @param {number} W @param {number} H */
export function traceOutline(m, W, H) {
  const at = (/** @type {number} */ i, /** @type {number} */ j) => i >= 0 && j >= 0 && i < W && j < H && m[j * W + i] === 1;
  /** @type {Map<string, number[][]>} */ const out = new Map();
  const add = (/** @type {number[]} */ a, /** @type {number[]} */ b) => { const k = `${a[0]},${a[1]}`; (out.get(k) ?? out.set(k, []).get(k))?.push(b); };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!at(i, j)) continue;
    if (!at(i, j - 1)) add([i, j], [i + 1, j]);
    if (!at(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
    if (!at(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
    if (!at(i - 1, j)) add([i, j + 1], [i, j]);
  }
  let best = /** @type {number[][]} */ ([]);
  const keys = [...out.keys()].sort();
  for (const k0 of keys) {
    while ((out.get(k0)?.length ?? 0) > 0) {
      const loop = [k0.split(',').map(Number)];
      let k = k0;
      for (let guard = 0; guard < 4 * W * H + 8; guard++) {
        const nx = out.get(k)?.shift();
        if (!nx) break;
        k = `${nx[0]},${nx[1]}`;
        if (k === k0) break;
        loop.push(nx);
      }
      if (loop.length > best.length) best = loop;
    }
  }
  return best;
}

/** Douglas-Peucker on a closed loop, raising the tolerance until at most maxN corners remain. @param {number[][]} loop @param {number} tol @param {number} maxN */
export function simplifyLoop(loop, tol, maxN) {
  if (loop.length <= 3) return loop;
  const dp = (/** @type {number[][]} */ pts, /** @type {number} */ t) => {
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = /** @type {number[]} */ (st.pop());
      let md = -1, mi = -1;
      for (let i = a + 1; i < b; i++) { const d = segDist(pts[i], pts[a], pts[b]); if (d > md) { md = d; mi = i; } }
      if (md > t) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  // split the loop at its two farthest-apart points so both halves are open polylines
  let far = 0, fd = -1; for (let i = 1; i < loop.length; i++) { const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]); if (d > fd) { fd = d; far = i; } }
  let t = tol, res = loop;
  for (let k = 0; k < 40; k++) {
    const a = dp(loop.slice(0, far + 1), t), b = dp([...loop.slice(far), loop[0]], t);
    res = [...a, ...b.slice(1, -1)];
    if (res.length <= maxN) break;
    t *= 1.4;
  }
  return res;
}

/**
 * @param {{parcel:any, buildings?:any[], mainBuildingIndex?:number, yard?:any, image?:any, classes?:Uint8Array|null, driveways?:Array<{geometry:any}>}} input
 *   `yard` = core/yard.js splitYard result (its bands give the front line); `classes` = core/aerial.js classifyLot(...).classes (class + 1 per pixel)
 */
export function detectDriveway(input) {
  const fail = (/** @type {string} */ reason, /** @type {any} */ extra = {}) => ({ ok: /** @type {const} */ (false), reason, ...extra });
  if (!input || typeof input !== 'object') return fail('input must be an object');
  const lot = polysOf(input.parcel);
  if (!lot.length) return fail('no lot outline');
  const bands = input.yard && input.yard.ok ? input.yard.bands : null;
  if (!bands) return fail('the front of the lot is not known (no yard split), so a driveway cannot be followed from the street side');
  const blds = (input.buildings ?? []).map(polysOf);
  const proj = localProjection(bands.origin);
  const depth = (/** @type {number} */ lng, /** @type {number} */ lat) => { const [x, y] = proj.toXY([lng, lat]); return x * bands.nx + y * bands.ny - bands.depth0; };
  // mapped driveway lines on or near the lot (local metres)
  const lotC = centroid({ type: 'Polygon', coordinates: lot[0] });
  const pl = localProjection(lotC);
  const lotXY = lot.map((rings) => rings.map((r) => r.map((p) => pl.toXY(p))));
  const nearLot = (/** @type {number[]} */ q) => {
    const [lng, lat] = pl.toLngLat(q);
    if (inPolys(lot, lng, lat)) return true;
    for (const rings of lotXY) for (const r of rings) for (let i = 0; i + 1 < r.length; i++) if (segDist(q, r[i], r[i + 1]) <= D.LINE_NEAR_M) return true;
    return false;
  };
  const mapLines = [];
  for (const d of input.driveways ?? []) for (const l of linesOf(d?.geometry)) {
    if (!Array.isArray(l) || l.length < 2) continue;
    const xy = l.map((p) => pl.toXY(p));
    let hit = false;
    for (let i = 0; i + 1 < xy.length && !hit; i++) for (let s = 0; s <= 8 && !hit; s++) hit = nearLot([xy[i][0] + ((xy[i + 1][0] - xy[i][0]) * s) / 8, xy[i][1] + ((xy[i + 1][1] - xy[i][1]) * s) / 8]);
    if (hit) mapLines.push(xy);
  }
  const im = input.image, cls = input.classes;
  if (!im || !cls) {
    return fail(mapLines.length ? 'a mapped driveway line crosses the lot, but there is no aerial photo to show its width' : 'no aerial photo reading and no mapped driveway line', mapLines.length ? { line: mapLines.map((l) => l.map((q) => pl.toLngLat(q))) } : {});
  }
  // the lot in the street frame: u along the front line, d = depth inward from it (core/yard.js bands), sampled every STEP_M
  const W = im.width, H = im.height;
  const ux = -bands.ny, uy = bands.nx; // along the front line
  const toUD = (/** @type {number} */ lng, /** @type {number} */ lat) => { const [x, y] = proj.toXY([lng, lat]); return [x * ux + y * uy, x * bands.nx + y * bands.ny - bands.depth0]; };
  const fromUD = (/** @type {number} */ u, /** @type {number} */ d) => { const dd = d + bands.depth0; return proj.toLngLat([u * ux + dd * bands.nx, u * uy + dd * bands.ny]); };
  let u0 = Infinity, u1 = -Infinity, dMax = -Infinity;
  for (const rings of lot) for (const p of rings[0]) { const [u, d] = toUD(p[0], p[1]); u0 = Math.min(u0, u); u1 = Math.max(u1, u); dMax = Math.max(dMax, d); }
  const S = D.STEP_M, NU = Math.ceil((u1 - u0) / S), ND = Math.ceil(Math.max(0, dMax) / S) + 1;
  if (NU * ND > 1_000_000) return fail('the lot is too large to search for a driveway');
  // cell state: 1 paved, 2 building (index in bld), 3 other open ground, 0 off the lot or no data
  const state = new Uint8Array(NU * ND), bld = new Int16Array(NU * ND).fill(-1);
  for (let a = 0; a < NU; a++) for (let b = 0; b < ND; b++) {
    const [lng, lat] = fromUD(u0 + (a + 0.5) * S, (b + 0.5) * S);
    if (!inPolys(lot, lng, lat)) continue;
    const bi = blds.findIndex((p) => p.length && inPolys(p, lng, lat));
    if (bi >= 0) { state[a * ND + b] = 2; bld[a * ND + b] = bi; continue; }
    const pi = Math.floor(((lng - im.bbox[0]) / (im.bbox[2] - im.bbox[0])) * W), pj = Math.floor(((im.bbox[3] - lat) / (im.bbox[3] - im.bbox[1])) * H);
    if (pi < 0 || pj < 0 || pi >= W || pj >= H) continue;
    const c = cls[pj * W + pi];
    state[a * ND + b] = c === CLASS.PAVED + 1 ? 1 : c ? 3 : 0;
  }
  const main = Number.isInteger(input.mainBuildingIndex) ? /** @type {number} */ (input.mainBuildingIndex) : -1;
  const touchN = Math.max(1, Math.round(D.TOUCH_M / S));
  // each column: the paving that runs unbroken (gaps up to GAP_M) from the front line inward, and the building it runs into
  /** @type {Array<{run:number, to:number}>} */ const col = [];
  for (let a = 0; a < NU; a++) {
    let b = 0;
    while (b < ND && state[a * ND + b] === 0 && b * S < D.SEED_DEPTH_M) b++; // the lot line itself may fall between samples
    if (b >= ND || state[a * ND + b] !== 1 || b * S >= D.SEED_DEPTH_M) { col.push({ run: 0, to: -1 }); continue; }
    let end = b, gap = 0;
    for (let k = b; k < ND; k++) {
      const st = state[a * ND + k];
      if (st === 1) { end = k; gap = 0; continue; }
      if (st === 2) break;
      if (++gap * S > D.GAP_M) break;
    }
    let to = -1;
    for (let k = end + 1; k <= Math.min(ND - 1, end + touchN); k++) if (state[a * ND + k] === 2) { to = bld[a * ND + k]; break; }
    // behind the house's rear line the paving counts only when it runs into another building (a rear garage)
    if ((end + 1) * S > bands.d2 + 1 && (to < 0 || to === main)) {
      let k = end; while (k > 0 && (k + 1) * S > bands.d2 + 1) k--;
      end = k; to = -1;
      for (let q = end + 1; q <= Math.min(ND - 1, end + touchN); q++) if (state[a * ND + q] === 2) { to = bld[a * ND + q]; break; }
    }
    col.push({ run: (end + 1) * S, to });
  }
  // bands of adjacent columns that run into a building; the mapped line (if any) picks its band, else the widest
  /** @type {Array<{a:number, b:number}>} */ const groups = [];
  for (let a = 0; a < NU; a++) {
    if (col[a].to < 0) continue;
    const g = groups[groups.length - 1];
    if (g && a - g.b <= 2) g.b = a; else groups.push({ a, b: a });
  }
  const minCols = Math.ceil(D.MIN_WIDTH_M / S);
  const okGroups = groups.filter((g) => g.b - g.a + 1 >= minCols);
  if (!okGroups.length) return fail(groups.length ? 'the paving from the street side to a building is narrower than a driveway' : 'no paving runs from the street side of the lot to a building in the aerial photo');
  const warnings = [];
  let source = /** @type {'map+photo'|'photo'} */ ('photo');
  let pick = okGroups.slice().sort((x, y) => (y.b - y.a) - (x.b - x.a) || x.a - y.a)[0];
  if (mapLines.length) {
    // where the mapped line crosses the front strip of the lot
    const us = [];
    for (const l of mapLines) for (let i = 0; i + 1 < l.length; i++) for (let s2 = 0; s2 <= 10; s2++) {
      const q = [l[i][0] + ((l[i + 1][0] - l[i][0]) * s2) / 10, l[i][1] + ((l[i + 1][1] - l[i][1]) * s2) / 10];
      const [lng, lat] = pl.toLngLat(q); const [u, d] = toUD(lng, lat);
      if (d > -D.LINE_NEAR_M && d < 6) us.push((u - u0) / S);
    }
    const hit = okGroups.find((g) => us.some((u) => u >= g.a - 2 && u <= g.b + 3));
    if (hit) { pick = hit; source = 'map+photo'; } else warnings.push('a mapped driveway line crosses the lot, but no paving from the street to a building lies along it; the photo alone was read');
  }
  if (okGroups.length > 1 && source === 'photo') warnings.push(`${okGroups.length} paved strips run from the street to a building; the widest was taken`);
  // outline: front corners, then the run ends across the band, simplified
  const pts = [[pick.a * S, 0]];
  for (let a = pick.a; a <= pick.b; a++) { const r = col[a].to >= 0 ? col[a].run : 0; pts.push([a * S, r], [(a + 1) * S, r]); }
  pts.push([(pick.b + 1) * S, 0]);
  const simp = simplifyLoop(pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]), 0.5, D.MAX_CORNERS);
  const ring = simp.map(([u, d]) => fromUD(u0 + u, d));
  let a2 = 0; for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; a2 += p[0] * q[1] - q[0] * p[1]; }
  if (a2 < 0) ring.reverse();
  ring.push([...ring[0]]);
  const polygon = { type: 'Polygon', coordinates: [ring] };
  const areaSqft = polygonAreaSqft(polygon);
  if (areaSqft / SQFT_PER_M2 < D.MIN_AREA_M2) return fail('the paved strip is too small to be a driveway');
  const widthM = (pick.b - pick.a + 1) * S;
  const runs = []; for (let a = pick.a; a <= pick.b; a++) if (col[a].to >= 0) runs.push(col[a].run);
  runs.sort((x, y) => x - y);
  const lengthM = runs[runs.length >> 1];
  const tally = new Map(); for (let a = pick.a; a <= pick.b; a++) if (col[a].to >= 0) tally.set(col[a].to, (tally.get(col[a].to) ?? 0) + 1);
  const reach = [...tally.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? null;
  const widthFt = Math.round(widthM / 0.3048), lengthFt = Math.round(lengthM / 0.3048);
  if (widthFt > D.WIDE_FT) warnings.push(`the paved strip is ${widthFt} ft wide: it may include a paved front yard or a parking pad`);
  if (reach !== null && reach !== main) warnings.push('the paving runs to a building other than the house (a garage?)');
  if (source === 'photo') warnings.push('read from the photo alone: trees over a driveway hide it, and a paved front yard looks the same');
  return { ok: /** @type {const} */ (true), polygon, areaSqft: Math.round(areaSqft), widthFt, lengthFt, reachesBuildingIndex: reach, source,
    confidence: D.CONFIDENCE[source], method: DRIVEWAY_METHOD[source], warnings, corners: ring.length - 1 };
}

/**
 * Area of a driveway outline that lies on the lot and not under a building (sq ft), on a 0.25 m grid (cell centres), as core/usable-yard.js.
 * @param {any} driveway polygon @param {any} parcel @param {any[]} [buildings] @param {number} [cellM]
 */
export function drivewayAreaSqft(driveway, parcel, buildings = [], cellM = 0.25) {
  const dv = polysOf(driveway), lot = polysOf(parcel);
  if (!dv.length || !lot.length) return null;
  const blds = buildings.map(polysOf).filter((p) => p.length);
  const pr = localProjection(centroid({ type: 'Polygon', coordinates: dv[0] }));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const rings of dv) for (const p of rings[0]) { const [x, y] = pr.toXY(p); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const W = Math.ceil((x1 - x0) / cellM), H = Math.ceil((y1 - y0) / cellM);
  if (W * H > 4_000_000) return null;
  let n = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [lng, lat] = pr.toLngLat([x0 + (i + 0.5) * cellM, y0 + (j + 0.5) * cellM]);
    if (inPolys(dv, lng, lat) && inPolys(lot, lng, lat) && !blds.some((b) => inPolys(b, lng, lat))) n++;
  }
  return Math.round(n * cellM * cellM * SQFT_PER_M2);
}

// @ts-check
// USABLE yard: the part of a lot's open ground (lot minus building outlines, minus anything excluded such as a pool) that is at least W wide
// in every direction. Pure, deterministic, no I/O.
//
// MODELLING ASSUMPTION (Everyspace's, not a rule from any code or survey): W = 10 ft by default (`minWidthFt`), "room for a table and chairs,
// a play area or a small lawn". Narrow strips beside the house, a 3 ft path or the sliver between a garage and the fence are left out.
// Slope, fences, hedges and what stands on the ground are NOT known: a patio counts as usable, a steep bank counts too.
//
// METHOD: the open ground is rasterised on a local grid (equirectangular frame around the lot centroid, core/geometry.js localProjection,
// cells of `cellM`, default 0.25 m; a cell is open when its centre is on the lot and not inside a building or an excluded area). A
// morphological OPENING by a disc of diameter W keeps exactly the cells covered by some W-wide disc that fits inside the open ground: erosion
// (cells whose centre is more than W/2 from every closed cell centre, measured with an exact Euclidean distance transform) then dilation by
// W/2 (cells within W/2 of an eroded cell). Cells outside the grid count as closed (the lot line bounds the yard).
// ACCURACY OF THE GRID: area is counted in whole cells, so a straight boundary is right to about half a cell; a convex lot corner loses the
// part a W-wide disc cannot reach, (W/2)^2 (1 - pi/4) = 5.4 sq ft per right-angled corner at W = 10 ft (that is part of the definition, not
// an error). Tests: core/tests/usable-yard.test.mjs.

import { centroid, localProjection, SQFT_PER_M2 } from './geometry.js';
import { yardZoneAt } from './yard.js';

export const USABLE_DEFAULTS = Object.freeze({ MIN_WIDTH_FT: 10, CELL_M: 0.25, MAX_CELLS: 4_000_000 });
export const usableMethod = (/** @type {number} */ w) => `open ground at least ${w} ft wide; narrow strips beside the house are left out; slope and what is on the ground are not known`
  + ` (the ${w} ft width is an Everyspace modelling assumption; grid of 0.25 m cells, morphological opening by a ${w} ft disc)`;
const FT = 0.3048;

const geomOf = (/** @type {any} */ g) => (g && g.type === 'Feature' ? g.geometry : g && !g.type && g.polygon ? g.polygon : g);
const polysOf = (/** @type {any} */ g) => { const x = geomOf(g); return x?.type === 'Polygon' ? [x.coordinates] : x?.type === 'MultiPolygon' ? x.coordinates : []; };
/** even-odd over every ring of every part. @param {number[][][][]} polys @param {number} x @param {number} y */
function inPolys(polys, x, y) {
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

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). @param {Float64Array} f @param {number} n */
function dt1(f, n) {
  const d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (f[v[k]] === Infinity) { v[k] = q; continue; }
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  if (f[v[0]] === Infinity) { d.fill(Infinity); return d; }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
  return d;
}
/** Squared Euclidean distance (in cells) from every cell to the nearest source cell. @param {Uint8Array} src @param {number} W @param {number} H */
export function distanceTransform(src, W, H) {
  const out = new Float64Array(W * H), col = new Float64Array(H), row = new Float64Array(W);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) col[y] = src[y * W + x] ? 0 : Infinity;
    const d = dt1(col, H);
    for (let y = 0; y < H; y++) out[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) row[x] = out[y * W + x];
    const d = dt1(row, W);
    for (let x = 0; x < W; x++) out[y * W + x] = d[x];
  }
  return out;
}

/**
 * Morphological opening of a binary mask by a disc of radius r (cells). Pure.
 * @param {Uint8Array} open 1 = open ground @param {number} W @param {number} H @param {number} r
 */
export function openByDisc(open, W, H, r) {
  const closed = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) closed[k] = open[k] ? 0 : 1;
  const dc = distanceTransform(closed, W, H);
  const r2 = r * r;
  const eroded = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) eroded[k] = open[k] && dc[k] > r2 ? 1 : 0;
  const de = distanceTransform(eroded, W, H);
  const out = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) out[k] = open[k] && de[k] <= r2 ? 1 : 0;
  return out;
}

/**
 * @param {{parcel:any, buildings?:any[], yard?:any, zoneAt?:((lng:number,lat:number)=>string|null)|null, minWidthFt?:number, cellM?:number,
 *   exclude?:Array<any|((lng:number,lat:number)=>boolean)>}} input  `yard` = a core/yard.js splitYard result (its depth bands split the
 *   usable area into front/back/side); `exclude` = polygons or predicates (a detected pool)
 */
export function usableYard(input) {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'input must be an object' };
  const lot = polysOf(input.parcel);
  if (!lot.length || !lot.every((r) => Array.isArray(r?.[0]) && r[0].length >= 3)) return { ok: false, reason: 'no lot polygon' };
  const minWidthFt = input.minWidthFt ?? USABLE_DEFAULTS.MIN_WIDTH_FT;
  if (!Number.isFinite(minWidthFt) || minWidthFt <= 0 || minWidthFt > 200) return { ok: false, reason: 'minWidthFt must be a number of feet between 0 and 200' };
  const cellM = input.cellM ?? USABLE_DEFAULTS.CELL_M;
  if (!Number.isFinite(cellM) || cellM <= 0.01 || cellM > 2) return { ok: false, reason: 'cellM must be between 0.01 and 2 m' };
  let c0;
  try { c0 = centroid(geomOf(input.parcel)); } catch { return { ok: false, reason: 'lot centroid could not be computed' }; }
  const proj = localProjection(c0);
  const blds = (input.buildings ?? []).map(polysOf).filter((p) => p.length);
  const excl = (input.exclude ?? []).map((e) => (typeof e === 'function' ? e : ((p) => (p.length ? (/** @type {number} */ x, /** @type {number} */ y) => inPolys(p, x, y) : null))(polysOf(e)))).filter(Boolean);
  // grid: the lot's box in local metres plus one cell, row 0 at the north
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const rings of lot) for (const p of rings[0]) { const [x, y] = proj.toXY(p); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  x0 -= cellM; y0 -= cellM; x1 += cellM; y1 += cellM;
  const W = Math.ceil((x1 - x0) / cellM), H = Math.ceil((y1 - y0) / cellM);
  if (W * H > USABLE_DEFAULTS.MAX_CELLS) return { ok: false, reason: `the lot is too large for the usable-yard grid (${W} x ${H} cells)` };
  const top = y0 + H * cellM; // north edge of the grid
  const zoneAt = typeof input.zoneAt === 'function' ? input.zoneAt : input.yard ? yardZoneAt(input.yard) : null;
  const open = new Uint8Array(W * H);
  const lngLat = (/** @type {number} */ i, /** @type {number} */ j) => proj.toLngLat([x0 + (i + 0.5) * cellM, top - (j + 0.5) * cellM]);
  let openCells = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [x, y] = lngLat(i, j);
    if (!inPolys(lot, x, y) || blds.some((p) => inPolys(p, x, y)) || excl.some((f) => /** @type {Function} */ (f)(x, y))) continue;
    open[j * W + i] = 1; openCells++;
  }
  const r = (minWidthFt * FT) / 2 / cellM;
  const usable = openByDisc(open, W, H, r);
  const cellSqft = cellM * cellM * SQFT_PER_M2;
  const z = { front: 0, back: 0, side: 0, none: 0 };
  let n = 0;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    if (!usable[j * W + i]) continue;
    n++;
    if (zoneAt) { const [x, y] = lngLat(i, j); const zz = zoneAt(x, y); z[/** @type {'front'|'back'|'side'} */ (zz) in z ? /** @type {'front'|'back'|'side'} */ (zz) : 'none']++; } else z.none++;
  }
  const [w, s] = proj.toLngLat([x0, y0]), [e, nn] = proj.toLngLat([x0 + W * cellM, top]);
  return {
    ok: true,
    usableSqft: Math.round(n * cellSqft),
    usableFrontSqft: zoneAt ? Math.round(z.front * cellSqft) : null,
    usableBackSqft: zoneAt ? Math.round(z.back * cellSqft) : null,
    usableSideSqft: zoneAt ? Math.round(z.side * cellSqft) : null,
    openSqft: Math.round(openCells * cellSqft),
    minWidthFt, method: usableMethod(minWidthFt),
    cells: { mask: usable, width: W, height: H, cellM, originLngLat: [w, nn], bbox: [w, s, e, nn], rowOrder: 'north to south', crs: 'EPSG:4326 (cells are equal steps of longitude and latitude)' },
  };
}

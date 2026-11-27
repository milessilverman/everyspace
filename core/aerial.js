// @ts-check
// Reading a lot's open ground from one aerial photo (USDA NAIP, 60 cm): classical per-pixel rules, no model. Pure functions over pixel arrays.
//
// REUSED from StreetForge streetforge2d.html (read-only reference):
//   12746-12757  `strip`: per pixel tone L = log(1 + luma) / log(256) (luma 0.299 R + 0.587 G + 0.114 B) and greenness
//                G = (2g - r - b) / (r + g + b + 30); ported as `tone` and `greenness`
//   12902-12904  `crowns`: "crowns are what stays green and dark (lawn is green but light)": vegetation with tone < 0.88 is tree canopy,
//                lighter vegetation is lawn/planting (StreetForge's thresholds green > 0.05, dark < 0.88, unchanged)
//   12994-12999  `naipFlight`: pixels that are (near) black carry no data (r + g + b < 8)
// NOT from StreetForge: StreetForge reads only the visible bands (asset_bidx image|1,2,3). NAIP also has a near-infrared band (checked live
// 2026-11-27: Planetary Computer items list bands Red, Green, Blue, NIR); when it is present vegetation is NDVI = (NIR - R)/(NIR + R) >= 0.2
// (the usual textbook cut for green vegetation, not tuned on our test lots), and water is a pixel whose NIR is lower than its blue and green
// (water absorbs near-infrared; roofs, tarps and paint reflect it). Without NIR (the USGS fallback) vegetation is StreetForge's greenness
// G > 0.05 and water is not classified at all (no pool is ever reported from visible light alone).
//
// Classes: VEG_TREE, VEG_LOW (lawn/planting), PAVED (paved or bare: driveway, patio, bare soil, dry lawn), WATER, SHADOW (too dark to tell),
// NODATA. Order of the rules: no data -> water -> vegetation -> shadow -> paved/bare.

/** Class codes. */
export const CLASS = Object.freeze({ NODATA: 0, VEG_TREE: 1, VEG_LOW: 2, PAVED: 3, WATER: 4, SHADOW: 5 });
export const CLASS_NAMES = ['no data', 'tree canopy', 'lawn or planting', 'paved or bare', 'water', 'shadow'];

/** Thresholds. Fixed before measuring; see docs/yard-accuracy.md for what they get right and wrong. */
export const AERIAL_RULES = Object.freeze({
  /** NDVI at or above this = vegetation (textbook value for green vegetation). */
  NDVI_VEG: 0.2,
  /** StreetForge greenness above this = vegetation (visible-only fallback; streetforge2d.html:12903 `green = .05`). */
  GREEN_VEG: 0.05,
  /** StreetForge tone below this = dark (tree canopy) when the pixel is vegetation (streetforge2d.html:12903 `dark = .88`). */
  TONE_TREE: 0.88,
  /** Tone below this (luma about 45 of 255) and not vegetation = shadow, nothing read. */
  TONE_SHADOW: 0.69,
  /** Water: NIR below this fraction of the blue band AND of the green band, blue above red, and not dark. */
  WATER_NIR_RATIO: 0.75,
  /** No data: r + g + b below this (StreetForge 12999). */
  NODATA_SUM: 8,
  /** A pool is a connected water region between these sizes (m2): 10 m2 = 108 sq ft (a tarp or a puddle is smaller), 150 m2 = 1,615 sq ft. */
  POOL_MIN_M2: 10, POOL_MAX_M2: 150,
  /** ... and compact: its pixels fill at least this share of its bounding box. */
  POOL_COMPACT: 0.4,
  /** Front-yard check: if this share of the front band (with data) is paved-like, a warning is added and the yard confidence lowered. */
  FRONT_PAVED_WARN: 0.7,
  /** Lowest share of the open ground that must have photo data, else nothing is reported. */
  MIN_COVERAGE: 0.95,
});
const R = AERIAL_RULES;
const LOG256 = 1 / Math.log(256);

/** StreetForge tone (0..1). */
export const tone = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) => Math.log(1 + 0.299 * r + 0.587 * g + 0.114 * b) * LOG256;
/** StreetForge greenness. */
export const greenness = (/** @type {number} */ r, /** @type {number} */ g, /** @type {number} */ b) => (2 * g - r - b) / (r + g + b + 30);
/** NDVI from digital numbers (not reflectance: a relative index). */
export const ndvi = (/** @type {number} */ r, /** @type {number} */ n) => (n + r > 0 ? (n - r) / (n + r) : 0);

/**
 * Classify one pixel. `n` is the near-infrared value, or null/undefined when the photo has no NIR band.
 * @param {number} r @param {number} g @param {number} b @param {number|null|undefined} n
 */
export function classifyPixel(r, g, b, n) {
  if (r + g + b < R.NODATA_SUM) return CLASS.NODATA;
  const t = tone(r, g, b);
  const hasNir = typeof n === 'number';
  if (hasNir && n < R.WATER_NIR_RATIO * b && n < R.WATER_NIR_RATIO * g && b > r && t >= R.TONE_SHADOW) return CLASS.WATER;
  const veg = hasNir ? ndvi(r, n) >= R.NDVI_VEG : greenness(r, g, b) > R.GREEN_VEG;
  if (veg) return t < R.TONE_TREE ? CLASS.VEG_TREE : CLASS.VEG_LOW;
  if (t < R.TONE_SHADOW) return CLASS.SHADOW;
  return CLASS.PAVED;
}

// ---------------------------------------------------------------- images and georeferencing

/**
 * @typedef {{width:number, height:number, bbox:[number,number,number,number], r:Uint8Array, g:Uint8Array, b:Uint8Array, nir:Uint8Array|null,
 *   mask:Uint8Array|null, date:string|null, gsdM:number|null, source:string, bands:string}} AerialImage
 * Row-major, row 0 at the north. bbox = [west, south, east, north] in WGS84 degrees; pixels are equal steps of longitude and latitude
 * (the image was requested in EPSG:4326).
 */

/**
 * Parse a NumPy .npy file of unsigned bytes in C order (what Planetary Computer's tiler returns for `.npy`). Throws on anything else.
 * @param {Uint8Array} bytes @returns {{shape:number[], data:Uint8Array}}
 */
export function parseNpy(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 10 || bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== 'NUMPY') throw new Error('not a .npy file');
  const major = bytes[6];
  const hlen = major === 1 ? bytes[8] | (bytes[9] << 8) : (bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24)) >>> 0;
  const start = major === 1 ? 10 : 12;
  const header = new TextDecoder('latin1').decode(bytes.subarray(start, start + hlen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order':\s*(True|False)/.exec(header)?.[1];
  const shapeTxt = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || !fortran || shapeTxt === undefined) throw new Error('.npy header is not readable');
  if (descr !== '|u1' && descr !== '<u1') throw new Error(`.npy data type ${descr} is not unsigned bytes`);
  if (fortran !== 'False') throw new Error('.npy data in Fortran order is not supported');
  const shape = shapeTxt.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!shape.length || shape.some((v) => !Number.isInteger(v) || v <= 0)) throw new Error('.npy shape is not valid');
  const count = shape.reduce((a, v) => a * v, 1);
  const data = bytes.subarray(start + hlen, start + hlen + count);
  if (data.length !== count) throw new Error(`.npy data is truncated (${data.length} of ${count} bytes)`);
  return { shape, data };
}

/**
 * Build an AerialImage from band planes (shape [bands, height, width]): bands 1-3 = R, G, B, band 4 = NIR when present, a last band = mask
 * when `hasMask`.
 * @param {{shape:number[], data:Uint8Array}} arr @param {{bbox:[number,number,number,number], hasMask?:boolean, nirBand?:boolean, date?:string|null, gsdM?:number|null, source:string}} meta
 * @returns {AerialImage}
 */
export function imageFromPlanes(arr, meta) {
  const [nb, h, w] = arr.shape;
  const want = 3 + (meta.nirBand ? 1 : 0) + (meta.hasMask ? 1 : 0);
  if (arr.shape.length !== 3 || nb !== want) throw new Error(`expected ${want} bands, got shape (${arr.shape.join(', ')})`);
  const plane = (/** @type {number} */ k) => arr.data.subarray(k * w * h, (k + 1) * w * h);
  return { width: w, height: h, bbox: meta.bbox, r: plane(0), g: plane(1), b: plane(2), nir: meta.nirBand ? plane(3) : null, mask: meta.hasMask ? plane(nb - 1) : null,
    date: meta.date ?? null, gsdM: meta.gsdM ?? null, source: meta.source, bands: meta.nirBand ? 'red, green, blue, near-infrared' : 'red, green, blue' };
}

/**
 * Build an AerialImage from interleaved RGBA (what a canvas getImageData or a PNG decoder gives). Alpha < 128 = no data.
 * @param {{width:number, height:number, data:Uint8Array|Uint8ClampedArray}} rgba @param {{bbox:[number,number,number,number], date?:string|null, gsdM?:number|null, source:string}} meta
 * @returns {AerialImage}
 */
export function imageFromRgba(rgba, meta) {
  const { width: w, height: h, data } = rgba;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || !data || data.length !== w * h * 4) throw new Error('decoded image has the wrong size');
  const r = new Uint8Array(w * h), g = new Uint8Array(w * h), b = new Uint8Array(w * h), m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { r[i] = data[4 * i]; g[i] = data[4 * i + 1]; b[i] = data[4 * i + 2]; m[i] = data[4 * i + 3] >= 128 ? 255 : 0; }
  return { width: w, height: h, bbox: meta.bbox, r, g, b, nir: null, mask: m, date: meta.date ?? null, gsdM: meta.gsdM ?? null, source: meta.source, bands: 'red, green, blue' };
}

/** Centre of pixel (i, j) -> [lng, lat]. @param {{width:number,height:number,bbox:number[]}} im @param {number} i @param {number} j */
export function pixelToLngLat(im, i, j) {
  const [w, s, e, n] = im.bbox;
  return [w + ((i + 0.5) * (e - w)) / im.width, n - ((j + 0.5) * (n - s)) / im.height];
}
/** [lng, lat] -> fractional pixel coordinates (pixel centres at .5). @param {{width:number,height:number,bbox:number[]}} im @param {number} lng @param {number} lat */
export function lngLatToPixel(im, lng, lat) {
  const [w, s, e, n] = im.bbox;
  return [((lng - w) / (e - w)) * im.width, ((n - lat) / (n - s)) * im.height];
}
/** Ground area of one pixel, m2 (spherical Earth as core/geometry.js). @param {{width:number,height:number,bbox:number[]}} im */
export function pixelAreaM2(im) {
  const [w, s, e, n] = im.bbox, Rm = 6371008.8, rad = Math.PI / 180;
  const dx = (((e - w) / im.width) * rad) * Rm * Math.cos(((s + n) / 2) * rad), dy = (((n - s) / im.height) * rad) * Rm;
  return dx * dy;
}

// ---------------------------------------------------------------- the lot

const geomOf = (/** @type {any} */ g) => (g && g.type === 'Feature' ? g.geometry : g && !g.type && g.polygon ? g.polygon : g);
const polysOf = (/** @type {any} */ g) => { const x = geomOf(g); return x?.type === 'Polygon' ? [x.coordinates] : x?.type === 'MultiPolygon' ? x.coordinates : []; };
/** Even-odd point in polygon over all rings of all parts, on raw [lng, lat]. */
function inPoly(/** @type {number[][][][]} */ polys, /** @type {number} */ x, /** @type {number} */ y) {
  for (const rings of polys) {
    let inside = false;
    for (const ring of rings) for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xi, yi] = ring[a], [xj, yj] = ring[b];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
const bboxOfPolys = (/** @type {number[][][][]} */ polys) => { let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity; for (const rings of polys) for (const p of rings[0] ?? []) { w = Math.min(w, p[0]); e = Math.max(e, p[0]); s = Math.min(s, p[1]); n = Math.max(n, p[1]); } return [w, s, e, n]; };

/**
 * Classify the open ground of a lot (lot minus building outlines) and report it per yard zone.
 * @param {{image:AerialImage, parcel:any, buildings?:any[], zoneAt?:((lng:number, lat:number)=>('front'|'back'|'side'|null))|null}} input
 */
export function classifyLot(input) {
  const im = input?.image;
  if (!im || !Number.isInteger(im.width) || !im.r) return { ok: false, reason: 'no image' };
  const lot = polysOf(input.parcel);
  if (!lot.length) return { ok: false, reason: 'no lot polygon' };
  const blds = (input.buildings ?? []).map(polysOf).filter((p) => p.length);
  const zoneAt = typeof input.zoneAt === 'function' ? input.zoneAt : null;
  const W = im.width, H = im.height, px = pixelAreaM2(im);
  const [bw, bs, be, bn] = bboxOfPolys(lot);
  const [i0, j1] = lngLatToPixel(im, bw, bs), [i1, j0] = lngLatToPixel(im, be, bn);
  const cls = new Uint8Array(W * H); // 0 = not open ground of the lot; else class + 1
  const zone = new Uint8Array(W * H); // 1 front, 2 side, 3 back
  let lotPx = 0, outside = 0, nodata = 0, roofPx = 0, roofVeg = 0;
  const per = { front: new Float64Array(6), side: new Float64Array(6), back: new Float64Array(6), all: new Float64Array(6) };
  for (let j = Math.max(0, Math.floor(j0) - 1); j <= Math.min(H - 1, Math.ceil(j1)); j++) {
    for (let i = Math.max(0, Math.floor(i0) - 1); i <= Math.min(W - 1, Math.ceil(i1)); i++) {
      const [x, y] = pixelToLngLat(im, i, j);
      if (!inPoly(lot, x, y)) continue;
      const k = j * W + i;
      const valid = !im.mask || im.mask[k] >= 128;
      const c = valid ? classifyPixel(im.r[k], im.g[k], im.b[k], im.nir ? im.nir[k] : null) : CLASS.NODATA;
      if (blds.some((p) => inPoly(p, x, y))) { roofPx++; if (c === CLASS.VEG_TREE || c === CLASS.VEG_LOW) roofVeg++; continue; }
      lotPx++;
      if (c === CLASS.NODATA) { nodata++; continue; }
      cls[k] = c + 1;
      const z = zoneAt ? zoneAt(x, y) : null;
      zone[k] = z === 'front' ? 1 : z === 'side' ? 2 : z === 'back' ? 3 : 0;
      per.all[c] += px;
      if (z) per[z][c] += px;
    }
  }
  // pixels of the lot outside the image
  const lotInImage = lotPx;
  if (i0 < 0 || j0 < 0 || i1 > W || j1 > H) outside = 1;
  const coverage = lotPx ? (lotPx - nodata) / lotPx : 0;
  // pools: compact connected water regions of plausible size
  const seen = new Uint8Array(W * H), pools = [];
  for (let k = 0; k < W * H; k++) {
    if (cls[k] !== CLASS.WATER + 1 || seen[k]) continue;
    const stack = [k]; seen[k] = 1; let n = 0, mi = W, ma = -1, mj = H, mb = -1; const z = [0, 0, 0, 0];
    while (stack.length) {
      const q = /** @type {number} */ (stack.pop()), qi = q % W, qj = (q - qi) / W; n++; z[zone[q]]++;
      if (qi < mi) mi = qi; if (qi > ma) ma = qi; if (qj < mj) mj = qj; if (qj > mb) mb = qj;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = qi + di, nj = qj + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nk = nj * W + ni; if (!seen[nk] && cls[nk] === CLASS.WATER + 1) { seen[nk] = 1; stack.push(nk); }
      }
    }
    const areaM2 = n * px, compact = n / ((ma - mi + 1) * (mb - mj + 1));
    const ok = areaM2 >= R.POOL_MIN_M2 && areaM2 <= R.POOL_MAX_M2 && compact >= R.POOL_COMPACT;
    const zn = ['none', 'front', 'side', 'back'][z.indexOf(Math.max(...z))];
    pools.push({ areaM2, pixels: n, compact: Math.round(compact * 100) / 100, pool: ok, zone: zn, why: ok ? null : areaM2 < R.POOL_MIN_M2 ? 'too small for a pool' : areaM2 > R.POOL_MAX_M2 ? 'too large for a pool' : 'not compact' });
  }
  const sq = (/** @type {number} */ m2) => Math.round(m2 * 10.763910416709722);
  const sum = (/** @type {Float64Array} */ a, /** @type {number[]} */ cs) => cs.reduce((s, c) => s + a[c], 0);
  const zones = /** @type {const} */ (['front', 'side', 'back']);
  const zoneSplit = (/** @type {number[]} */ cs) => Object.fromEntries(zones.map((z) => [z, sq(sum(per[z], cs))]));
  const VEG = [CLASS.VEG_TREE, CLASS.VEG_LOW];
  const frontData = sum(per.front, [CLASS.VEG_TREE, CLASS.VEG_LOW, CLASS.PAVED, CLASS.WATER, CLASS.SHADOW]);
  const frontPavedShare = frontData > 0 ? per.front[CLASS.PAVED] / frontData : null;
  const poolHits = pools.filter((p) => p.pool);
  const openSqft = sq(lotPx * px);
  const shadowShare = lotPx ? per.all[CLASS.SHADOW] / (lotPx * px) : 0;
  return {
    ok: true,
    coverage, imagePartial: Boolean(outside), pixelAreaM2: px,
    summary: {
      openPixelSqft: openSqft, greenSqft: sq(sum(per.all, VEG)), treeSqft: sq(per.all[CLASS.VEG_TREE]), lowVegSqft: sq(per.all[CLASS.VEG_LOW]), pavedSqft: sq(per.all[CLASS.PAVED]),
      waterSqft: sq(per.all[CLASS.WATER]), shadowSqft: sq(per.all[CLASS.SHADOW]), noDataSqft: sq(nodata * px), shadowShare,
      green: zoneSplit(VEG), tree: zoneSplit([CLASS.VEG_TREE]), paved: zoneSplit([CLASS.PAVED]),
      pool: poolHits.length ? { areaSqft: sq(poolHits.reduce((s, p) => s + p.areaM2, 0)), count: poolHits.length, zone: poolHits[0].zone } : null,
      waterRegions: pools.map((p) => ({ areaSqft: sq(p.areaM2), compact: p.compact, pool: p.pool, why: p.why })),
      roofPixels: roofPx, roofVegPct: roofPx ? (roofVeg / roofPx) * 100 : null,
      frontPavedShare,
    },
    frontPavingWarning: frontPavedShare !== null && frontPavedShare >= R.FRONT_PAVED_WARN,
    classes: cls, lotPixels: lotInImage,
  };
}

/** sq ft helper for callers. */
export const SQFT_PER_M2 = 10.763910416709722;

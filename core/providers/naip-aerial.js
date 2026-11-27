// @ts-check
// One USDA NAIP aerial photo of a lot (kind 'aerial', keyless, US-wide): the newest flight at 60 cm or better, cut to the lot's box at the
// photo's native resolution, with the near-infrared band. Read by core/aerial.js. Never throws; a failure is {ok:false, reason, code}.
//
// REUSED from StreetForge streetforge2d.html (read-only reference):
//   12980-12982  sources: Microsoft Planetary Computer STAC search + data API for USDA NAIP, USGS `USGSNAIPPlus` ImageServer `exportImage` as
//                the fallback; NAIP is US Government imagery, credit requested
//   12988-12993  `flightsOver`: STAC search over the box, items with gsd <= 0.6 grouped by flight (naip:year), flight date = its newest
//                item's date, newest flight first
//   12994-12999  `naipFlight`: the data API's `/item/bbox/{box}/{W}x{H}` endpoint per item of the flight, items composited (where one has
//                no data another fills in), a photo with under half its pixels covered is refused
//   13000-13005  `usgsMosaic`: exportImage with bbox/size/format (date unknown)
// Changes on purpose: StreetForge asks for JPEG of bands 1,2,3 in Web Mercator and decodes it on a canvas. Here the data API is asked for
// `.npy` of bands 1,2,3,4 (+ its mask) in WGS84 (`coord_crs`/`dst_crs` default EPSG:4326): raw bytes, so no canvas is needed, pixels are
// exact, and NIR is available (checked live 2026-11-27: shape (5, H, W), unsigned bytes). One STAC request + one image request per flight
// item over the lot (usually one). The USGS fallback returns PNG of bands 1,2,3 and needs `deps.decodeImage(bytes) -> {width, height, data}`
// (a canvas in the browser, a fixture decoder in tests); without NIR, core/aerial.js uses visible greenness and reports no water.
// CORS (checked live 2026-11-27 with Origin https://milessilverman.github.io and https://www.milessilverman.com): STAC search (GET),
// the data API (.npy) and the USGS ImageServer all answer `access-control-allow-origin: *`, so a page may read the pixels.

import { isoNow } from '../parcel.js';
import { fail } from './util.js';
import { parseNpy, imageFromPlanes, imageFromRgba } from '../aerial.js';

export const STAC_SEARCH = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
export const DATA_API = 'https://planetarycomputer.microsoft.com/api/data/v1';
export const USGS_EXPORT = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
export const SOURCE_NAME = 'USDA NAIP aerial photo (via Microsoft Planetary Computer)';
export const USGS_SOURCE_NAME = 'USDA NAIP aerial photo (USGS NAIP Plus mosaic)';
export const ATTRIBUTION_TEXT = 'Aerial photo: USDA NAIP (US Government imagery)';
/** Native NAIP resolution asked for (m); StreetForge keeps flights at 60 cm or better (gsd <= 0.6). */
export const TARGET_GSD_M = 0.6;
/** Margin around the lot box, metres (the photo can be offset by a metre or two from the parcel map). */
export const MARGIN_M = 6;
/** Largest image side, pixels (a 240 m lot side at 60 cm). Bigger boxes are refused rather than read coarser. */
export const MAX_PX = 400;
const DEFAULT_RADIUS_M = 45;
const DEFAULT_TIMEOUT_MS = 8000;

/** [w, s, e, n] of a (Multi)Polygon. @param {any} g */
function bboxOf(g) {
  const geom = g && g.type === 'Feature' ? g.geometry : g;
  const polys = geom?.type === 'Polygon' ? [geom.coordinates] : geom?.type === 'MultiPolygon' ? geom.coordinates : [];
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const rings of polys) for (const p of rings[0] ?? []) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** Run a fetch with a timeout; resolves to the response or throws {code}. @param {any} deps @param {string} url @param {number} ms */
async function timed(deps, url, ms) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  /** @type {any} */ let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => { ctl?.abort(); rej(Object.assign(new Error(`timeout after ${ms} ms`), { code: 'timeout' })); }, ms); });
  try {
    return await Promise.race([Promise.resolve(deps.fetch(url, { credentials: 'omit', ...(ctl ? { signal: ctl.signal } : {}) })), t]);
  } catch (e) {
    if (/** @type {any} */ (e)?.code === 'timeout') throw e;
    throw Object.assign(new Error(`network error: ${e instanceof Error ? e.message : String(e)}`), { code: 'network' });
  } finally { clearTimeout(timer); }
}
/** @param {any} res @param {number} ms */
async function bytesOf(res, ms) {
  /** @type {any} */ let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`timeout after ${ms} ms`), { code: 'timeout' })), ms); });
  try { return new Uint8Array(/** @type {ArrayBuffer} */ (await Promise.race([res.arrayBuffer(), t]))); } finally { clearTimeout(timer); }
}
const httpCode = (/** @type {number} */ s) => (s === 404 ? 'not_found' : s === 429 ? 'rate_limited' : s >= 500 ? 'server_error' : 'http_error');

/**
 * Pure: STAC search answer -> flights over the box, newest first (StreetForge flightsOver).
 * @param {any} json @param {number[]} box [w, s, e, n]
 */
export function flightsFrom(json, box) {
  /** @type {Map<string, {key:string, gsd:number, items:Array<{id:string, bbox:number[]|null}>, date:string}>} */
  const by = new Map();
  for (const f of Array.isArray(json?.features) ? json.features : []) {
    const p = f?.properties ?? {}, gsd = Number(p.gsd);
    if (!(gsd <= TARGET_GSD_M) || typeof f.id !== 'string') continue;
    const bb = Array.isArray(f.bbox) && f.bbox.length === 4 ? f.bbox.map(Number) : null;
    if (bb && (bb[2] < box[0] || bb[0] > box[2] || bb[3] < box[1] || bb[1] > box[3])) continue;
    const key = `${p['naip:year'] ?? String(p.datetime ?? '').slice(0, 4)}${gsd <= 0.3 ? 'h' : ''}`;
    if (!by.has(key)) by.set(key, { key, gsd, items: [], date: '' });
    const g = /** @type {any} */ (by.get(key));
    g.items.push({ id: f.id, bbox: bb });
    const dt = String(p.datetime ?? '').slice(0, 10);
    if (dt > g.date) g.date = dt;
  }
  return [...by.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * The image box for a query: the parcel's box plus MARGIN_M, else the point plus radiusM. Pure.
 * @param {{lat?:number, lng?:number, parcel?:any, radiusM?:number}} q
 * @returns {{box:number[], W:number, H:number}|{error:string}}
 */
export function imageBox(q) {
  const pb = q?.parcel ? bboxOf(q.parcel) : null;
  const lat0 = pb ? (pb[1] + pb[3]) / 2 : q?.lat;
  if (!Number.isFinite(lat0)) return { error: 'lat/lng or a parcel polygon is required' };
  const mLat = 110540, mLng = 111320 * Math.cos((/** @type {number} */ (lat0) * Math.PI) / 180);
  const r = Number.isFinite(q.radiusM) ? /** @type {number} */ (q.radiusM) : DEFAULT_RADIUS_M;
  const box = pb ? [pb[0] - MARGIN_M / mLng, pb[1] - MARGIN_M / mLat, pb[2] + MARGIN_M / mLng, pb[3] + MARGIN_M / mLat]
    : Number.isFinite(q.lat) && Number.isFinite(q.lng) ? [/** @type {number} */ (q.lng) - r / mLng, /** @type {number} */ (q.lat) - r / mLat, /** @type {number} */ (q.lng) + r / mLng, /** @type {number} */ (q.lat) + r / mLat] : null;
  if (!box) return { error: 'lat/lng or a parcel polygon is required' };
  const W = Math.ceil(((box[2] - box[0]) * mLng) / TARGET_GSD_M), H = Math.ceil(((box[3] - box[1]) * mLat) / TARGET_GSD_M);
  if (W > MAX_PX || H > MAX_PX) return { error: `the lot is too large for one photo request (${W} x ${H} px at 60 cm; limit ${MAX_PX})` };
  return { box, W: Math.max(4, W), H: Math.max(4, H) };
}

/** Data-API url for one item. @param {string} item @param {number[]} box @param {number} W @param {number} H */
export function itemImageUrl(item, box, W, H) {
  const u = new URL(`${DATA_API}/item/bbox/${box.map((v) => v.toFixed(7)).join(',')}/${W}x${H}.npy`);
  for (const [k, v] of Object.entries({ collection: 'naip', item, assets: 'image', asset_bidx: 'image|1,2,3,4', resampling: 'nearest' })) u.searchParams.set(k, v);
  return u.href;
}
/** USGS exportImage url (PNG of bands 1-3, WGS84). @param {number[]} box @param {number} W @param {number} H */
export function usgsImageUrl(box, W, H) {
  const u = new URL(USGS_EXPORT);
  for (const [k, v] of Object.entries({ bbox: box.map((v) => v.toFixed(7)).join(','), bboxSR: '4326', imageSR: '4326', size: `${W},${H}`, format: 'png32', bandIds: '0,1,2', interpolation: 'RSP_NearestNeighbor', f: 'image' })) u.searchParams.set(k, v);
  return u.href;
}

/** @param {{lat?:number, lng?:number, parcel?:any, radiusM?:number}} q @param {any} deps */
async function lookup(q, deps) {
  let at;
  try { at = isoNow(deps?.now); } catch (e) { return fail(e instanceof Error ? e.message : '`now` must be injected', 'bad_query'); }
  if (typeof deps?.fetch !== 'function') return fail('no fetch provided', 'no_fetch');
  const bx = imageBox(q);
  if ('error' in bx) return fail(bx.error, 'bad_query');
  const { box, W, H } = bx;
  const ms = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const counts = { requests: 0, bytes: 0 };
  /** @type {string[]} */ const tried = [];
  const bbox4 = /** @type {[number,number,number,number]} */ (box);

  // 1. Planetary Computer: newest flight, its items over the box, composited
  try {
    counts.requests++;
    const res = await timed(deps, `${STAC_SEARCH}?collections=naip&bbox=${box.map((v) => v.toFixed(6)).join(',')}&limit=50`, ms);
    if (!res?.ok) throw Object.assign(new Error(`photo catalogue: HTTP ${res?.status ?? 'error'}`), { code: httpCode(res?.status ?? 0) });
    const raw = await bytesOf(res, ms); counts.bytes += raw.length;
    let json; try { json = JSON.parse(new TextDecoder().decode(raw)); } catch { throw Object.assign(new Error('photo catalogue answer is not JSON'), { code: 'malformed_json' }); }
    const flights = flightsFrom(json, box);
    if (!flights.length) throw Object.assign(new Error('no NAIP photo at 60 cm or better covers this place'), { code: 'no_match' });
    const F = flights[0];
    /** @type {any} */ let img = null;
    for (const it of F.items.slice(0, 4)) {
      counts.requests++;
      const r = await timed(deps, itemImageUrl(it.id, box, W, H), ms);
      if (!r?.ok) throw Object.assign(new Error(`photo: HTTP ${r?.status ?? 'error'}`), { code: httpCode(r?.status ?? 0) });
      const b = await bytesOf(r, ms); counts.bytes += b.length;
      let part;
      try { part = imageFromPlanes(parseNpy(b), { bbox: bbox4, hasMask: true, nirBand: true, date: F.date || null, gsdM: F.gsd, source: SOURCE_NAME }); }
      catch (e) { throw Object.assign(new Error(`photo could not be read: ${e instanceof Error ? e.message : String(e)}`), { code: 'decode_error' }); }
      if (part.width !== W || part.height !== H) throw Object.assign(new Error(`photo has size ${part.width}x${part.height}, asked ${W}x${H}`), { code: 'decode_error' });
      if (!img) img = part;
      else for (let k = 0; k < W * H; k++) if (/** @type {Uint8Array} */ (img.mask)[k] < 128 && /** @type {Uint8Array} */ (part.mask)[k] >= 128) { img.r[k] = part.r[k]; img.g[k] = part.g[k]; img.b[k] = part.b[k]; img.nir[k] = part.nir[k]; img.mask[k] = 255; }
      if (coverageOf(img) >= 0.999) break;
    }
    if (!img || coverageOf(img) < 0.5) throw Object.assign(new Error('the newest photo flight covers under half of the box'), { code: 'no_match' });
    return { ok: /** @type {const} */ (true), image: img, source: SOURCE_NAME, retrievedAt: at, date: img.date, flight: F.key, items: F.items.length, counts, attribution: ATTRIBUTION_TEXT,
      license: 'US Government work (USDA Farm Production and Conservation Business Center); public domain, credit requested', nir: true };
  } catch (e) { tried.push(`Planetary Computer: ${e instanceof Error ? e.message : String(e)}`); if (!deps.decodeImage) return fail(`${tried[0]}; the USGS fallback needs an image decoder`, /** @type {any} */ (e)?.code ?? 'network'); }

  // 2. USGS mosaic (visible bands, date unknown)
  try {
    counts.requests++;
    const r = await timed(deps, usgsImageUrl(box, W, H), ms);
    if (!r?.ok) throw Object.assign(new Error(`HTTP ${r?.status ?? 'error'}`), { code: httpCode(r?.status ?? 0) });
    const b = await bytesOf(r, ms); counts.bytes += b.length;
    let decoded;
    try { decoded = await deps.decodeImage(b); } catch (e) { throw Object.assign(new Error(`photo could not be decoded: ${e instanceof Error ? e.message : String(e)}`), { code: 'decode_error' }); }
    let img;
    try { img = imageFromRgba(decoded, { bbox: bbox4, date: null, gsdM: null, source: USGS_SOURCE_NAME }); } catch (e) { throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { code: 'decode_error' }); }
    if (img.width !== W || img.height !== H) throw Object.assign(new Error(`photo has size ${img.width}x${img.height}, asked ${W}x${H}`), { code: 'decode_error' });
    return { ok: /** @type {const} */ (true), image: img, source: USGS_SOURCE_NAME, retrievedAt: at, date: null, counts, attribution: ATTRIBUTION_TEXT,
      license: 'US Government work (USDA/USGS); public domain, credit requested', nir: false, fallbackReason: tried[0] };
  } catch (e) {
    tried.push(`USGS: ${e instanceof Error ? e.message : String(e)}`);
    return fail(tried.join('; '), /** @type {any} */ (e)?.code ?? 'network');
  }
}

/** Share of pixels with data. @param {{mask:Uint8Array|null, width:number, height:number}} im */
function coverageOf(im) {
  if (!im.mask) return 1;
  let n = 0; for (let k = 0; k < im.mask.length; k++) if (im.mask[k] >= 128) n++;
  return n / im.mask.length;
}

/** @type {any} */
export const naipAerial = {
  id: 'naip-aerial', label: SOURCE_NAME, kind: 'aerial', needsKey: false, role: 'fallback', priority: 50, verified: true,
  coverage: { national: true }, retentionDays: null, corsStatus: 'verified 2026-11-27 (access-control-allow-origin: *)',
  licenseNote: 'USDA NAIP: US Government imagery, public domain; credit requested ("Aerial photo: USDA NAIP"). Read through Microsoft Planetary Computer (free, no key) or USGS The National Map.',
  lookup,
};

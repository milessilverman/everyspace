// @ts-check
// Overture Maps building footprints as a keyless, nationwide footprint provider (kind 'footprint').
//
// PORTED FROM StreetForge streetforge2d.html (read-only reference):
//   13596-13597  release catalog + tile-file URL (`OV`)         -> OVERTURE_CATALOG_URL, tileFileUrl
//   13631-13638  `ovFile`: current release from the catalog, remembered one day, refreshed once if the file is gone -> resolveRelease + lookup
//   13639-13662  `overtureBuildings`: tile maths (zoom min(14, maxz)), `building` layer, filters, tile units -> lng/lat, fragments by id
//   13689-13700  `addMissingBuildings`: ONLY its 8 m2 speck filter (`if(a<8)continue`); its overlap test against a base map is not ported
//   13684-13687  `overtureFor`: 5-minute outage memo and result cache: NOT ported (callers decide whether to retry)
//   PMTiles + vector-tile decoding: see ./pmtiles.js (ported from 13598-13630).
// What StreetForge actually does: reads the public `buildings.pmtiles` of the current release by HTTP range requests (16 KB header+root
// directory, one leaf directory, one gzip tile per z14 tile), decodes the Mapbox Vector Tile `building` layer in plain JavaScript
// (no library), skips `is_underground` and class roof/carport/shelter, and merges fragments of one building cut by a tile edge with
// the third-party `polygon-clipping` library. THAT MERGE IS NOT PORTED (no dependencies): a building seen in more than one tile is
// returned as its largest piece with `partial: true` (unless the pieces are the same size, i.e. duplicates), and a warning.
//
// Licence: Overture Maps Foundation data, buildings theme: ODbL 1.0 (it includes OpenStreetMap-derived footprints). Attribution text is
// the one StreetForge shows on its map: "Drafted buildings: Overture Maps Foundation (ODbL)" (streetforge2d.html:13161).
// Not verified here: whether Everyspace's own storage of the derived numbers triggers ODbL share-alike; the owner should confirm.
//
// Each footprint is read with at most: 1 catalog request (cached one day), 1 header+root request, 0-1 leaf request, and 1 request per
// z14 tile covering the search box (usually 1, up to 4 across tile edges). Directories are cached per file.

import { polygonAreaSqft, pointInPolygon, centroid } from '../geometry.js';
import { CONFIDENCE, isoNow } from '../parcel.js';
import { fail, round } from './util.js';
import { createPmtilesReader, decodeMvtLayer, decodePolygons, tilePointToLngLat, lngToTileX, latToTileY, raceTimeout, PmtilesError } from './pmtiles.js';

export const OVERTURE_CATALOG_URL = 'https://stac.overturemaps.org/catalog.json';
/** @param {string} release @param {string} [theme] */
export const tileFileUrl = (release, theme = 'buildings') => `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${encodeURIComponent(release)}/${theme}.pmtiles`;
export const ATTRIBUTION_TEXT = 'Drafted buildings: Overture Maps Foundation (ODbL)';
export const ATTRIBUTION_HTML = 'Drafted buildings: <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps Foundation</a> (ODbL)';
export const SOURCE_NAME = 'Overture Maps buildings (Overture Maps Foundation, ODbL)';
/** Canopies, carports and shelters are not buildings (StreetForge 13652). */
export const SKIP_CLASS = /^(roof|carport|shelter)$/;
/** Specks under 8 m2 are dropped (StreetForge addMissingBuildings, `if(a<8)continue`). */
export const MIN_AREA_M2 = 8;
const SQFT_PER_M2 = 10.763910416709722;
const M_TO_FT = 3.28084;
const DAY_MS = 864e5;
const RELEASE_RE = /^\d{4}-\d\d-\d\d\.\d+$/;
const MAX_TILES = 9;
const DEFAULT_NEAR_M = 25;
const DEFAULT_RADIUS_M = 40;

/** Cache of the current release (one day) and of PMTiles directories (per file). */
export function createOvertureCache() {
  return { release: /** @type {{release:string, atMs:number}|null} */ (null), dirs: /** @type {Map<string, any>} */ (new Map()) };
}
let shared = createOvertureCache();
/** Forget the module-level cache (tests, or to force a fresh catalog read). */
export function clearOvertureCache() { shared = createOvertureCache(); }
/** The module-level cache (shared with the Overture roads provider, so one catalog read serves both). */
export function sharedOvertureCache() { return shared; }

/**
 * One polygon's rings (open, in decoding order: outer then holes) -> GeoJSON rings: closed, outer counter-clockwise, holes clockwise.
 * @param {number[][][]} P
 */
export function ringsAreaFixup(P) {
  const signed = (/** @type {number[][]} */ R) => { let a = 0; for (let i = 0, j = R.length - 1; i < R.length; j = i++) a += (R[j][0] - R[i][0]) * (R[j][1] + R[i][1]); return a / 2; };
  return P.map((R, i) => {
    const closed = R[0][0] === R[R.length - 1][0] && R[0][1] === R[R.length - 1][1] ? R : [...R, R[0]];
    const ccw = signed(closed) > 0; // with y up, the sum of (xj-xi)(yj+yi) is positive for counter-clockwise
    return (i === 0) === ccw ? closed : [...closed].reverse();
  });
}

/** @param {any} g @returns {number[][][][]} */
const polysOf = (g) => (g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : []);

/** [w, s, e, n] of a polygon geometry, or null. @param {any} g */
function bboxOf(g) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const rings of polysOf(g)) for (const p of rings[0] ?? []) { if (p[0] < w) w = p[0]; if (p[0] > e) e = p[0]; if (p[1] < s) s = p[1]; if (p[1] > n) n = p[1]; }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** Centroid of the largest part of a (Multi)Polygon. @param {any} g */
function mainCentroid(g) {
  if (g.type === 'Polygon') return centroid(g);
  let best = g.coordinates[0], bestA = -1;
  for (const rings of g.coordinates) { const a = polygonAreaSqft({ type: 'Polygon', coordinates: rings }); if (a > bestA) { bestA = a; best = rings; } }
  return centroid({ type: 'Polygon', coordinates: best });
}

/**
 * The current release name from the catalog (cached one day), refreshing when asked.
 * @returns {Promise<{ok:true, release:string, fromCache:boolean}|{ok:false, reason:string, code:string}>}
 */
export async function resolveRelease(deps, cache, nowMs, stats, force = false) {
  if (!force && cache.release && nowMs - cache.release.atMs < DAY_MS) return { ok: true, release: cache.release.release, fromCache: true };
  const ctl = new AbortController();
  const timeoutMs = deps.timeoutMs ?? 12000;
  try {
    stats.requests++;
    const res = await raceTimeout(Promise.resolve(deps.fetch(OVERTURE_CATALOG_URL, { signal: ctl.signal, credentials: 'omit', headers: { Accept: 'application/json' } })), timeoutMs, () => ctl.abort());
    if (!res?.ok) return { ok: false, reason: `Overture catalog unreachable: HTTP ${res?.status ?? 'error'}`, code: 'catalog_unreachable' };
    let j;
    try { const t = await raceTimeout(Promise.resolve(res.text()), timeoutMs, () => ctl.abort()); stats.bytes += new TextEncoder().encode(t).length; j = JSON.parse(t); } catch (e2) { if (e2 instanceof PmtilesError && e2.code === 'timeout') throw e2; return { ok: false, reason: 'Overture catalog is not valid JSON', code: 'catalog_unreachable' }; }
    if (!j || typeof j.latest !== 'string' || !RELEASE_RE.test(j.latest)) return { ok: false, reason: 'Overture catalog names no usable current release', code: 'catalog_unreachable' };
    cache.release = { release: j.latest, atMs: nowMs };
    return { ok: true, release: j.latest, fromCache: false };
  } catch (e) {
    const timedOut = (e instanceof PmtilesError && e.code === 'timeout') || (e instanceof Error && e.name === 'AbortError');
    return { ok: false, reason: timedOut ? `Overture catalog timeout after ${timeoutMs} ms` : `Overture catalog unreachable: ${e instanceof Error ? e.message : String(e)}`, code: timedOut ? 'timeout' : 'catalog_unreachable' };
  }
}

/**
 * Pure: turn decoded building-layer tiles into WGS84 building records (before parcel filtering).
 * @param {Array<{z:number, x:number, y:number, layer:{ext:number, features:any[]}|null}>} tiles
 * @param {{w:number,s:number,e:number,n:number}} box  keep buildings whose outline box meets this box
 */
export function buildingsFromTiles(tiles, box) {
  const counts = { features: 0, notPolygon: 0, underground: 0, skippedClass: 0, speck: 0, outsideBox: 0, noGeometry: 0 };
  /** @type {Map<string, Array<{tileKey:string, polygons:number[][][][], props:Record<string,any>}>>} */
  const byId = new Map();
  let anon = 0;
  for (const { z, x, y, layer } of tiles) {
    if (!layer) continue;
    for (const f of layer.features) {
      counts.features++;
      if (f.type !== 3) { counts.notPolygon++; continue; }
      if (f.props.is_underground === true) { counts.underground++; continue; }
      if (SKIP_CLASS.test(String(f.props.class || ''))) { counts.skippedClass++; continue; }
      const polys = decodePolygons(f.rings).map((P) => P.map((R) => R.map((p) => tilePointToLngLat(z, x, y, layer.ext, p))));
      if (!polys.length) { counts.noGeometry++; continue; }
      const id = typeof f.props.id === 'string' && f.props.id ? f.props.id : `anon-${anon++}`;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id)?.push({ tileKey: `${z}/${x}/${y}`, polygons: polys, props: f.props });
    }
  }
  const out = [];
  for (const [id, frags] of byId) {
    // fragments of one id per tile; the tile holding the most area is the base, others only mark the building partial
    /** @type {Map<string, {polygons:any[], props:any, area:number}>} */
    const perTile = new Map();
    for (const fr of frags) {
      const gj = fr.polygons.map((P) => ringsAreaFixup(P));
      const a = gj.reduce((s, rings) => s + polygonAreaSqft({ type: 'Polygon', coordinates: rings }), 0);
      const cur = perTile.get(fr.tileKey);
      if (cur) { cur.polygons.push(...gj); cur.area += a; } else perTile.set(fr.tileKey, { polygons: gj, props: fr.props, area: a });
    }
    const pieces = [...perTile.values()].sort((a, b) => b.area - a.area);
    const base = pieces[0];
    const partial = pieces.length > 1 && pieces.some((p) => Math.abs(p.area - base.area) / base.area > 0.02);
    const polygon = base.polygons.length === 1 ? { type: /** @type {const} */ ('Polygon'), coordinates: base.polygons[0] } : { type: /** @type {const} */ ('MultiPolygon'), coordinates: base.polygons };
    const areaSqft = polygonAreaSqft(polygon);
    if (areaSqft / SQFT_PER_M2 < MIN_AREA_M2) { counts.speck++; continue; }
    const bb = bboxOf(polygon);
    if (!bb || bb[2] < box.w || bb[0] > box.e || bb[3] < box.s || bb[1] > box.n) { counts.outsideBox++; continue; }
    out.push({ id, polygon, areaSqft, props: base.props, partial, fragments: pieces.length });
  }
  return { buildings: out, counts };
}

/** Positive finite number from a tile property (numbers only; strings such as "12" are not guessed at). @param {any} v */
const posNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * Overture `sources` is a list of {dataset, ...}; the tiles may also carry a flattened '@geometry_source' (StreetForge reads that one).
 * @param {Record<string,any>} p
 */
export function datasetOf(p) {
  if (typeof p['@geometry_source'] === 'string' && p['@geometry_source']) return p['@geometry_source'];
  if (typeof p['@source'] === 'string' && p['@source']) return p['@source'];
  if (typeof p.sources === 'string' && p.sources) { try { const s = JSON.parse(p.sources); if (Array.isArray(s) && s[0]?.dataset) return String(s[0].dataset); } catch { /* not JSON */ } }
  if (typeof p.dataset === 'string' && p.dataset) return p.dataset;
  return null;
}

/** @param {{lat:number, lng:number, parcel?:any, nearM?:number, radiusM?:number, includeNear?:boolean}} q @param {any} deps */
async function lookup(q, deps) {
  let at;
  try { at = isoNow(deps?.now); } catch (e) { return fail(e instanceof Error ? e.message : '`now` must be injected', 'bad_query'); }
  if (typeof deps?.fetch !== 'function') return fail('no fetch provided', 'no_fetch');
  const hasPoint = q && Number.isFinite(q.lat) && Number.isFinite(q.lng);
  const parcelBox = q?.parcel ? bboxOf(q.parcel) : null;
  if (!hasPoint && !parcelBox) return fail('lat/lng or a parcel polygon is required', 'bad_query');
  const nearM = Number.isFinite(q.nearM) ? /** @type {number} */ (q.nearM) : DEFAULT_NEAR_M;
  const lat0 = parcelBox ? (parcelBox[1] + parcelBox[3]) / 2 : q.lat;
  const padLat = (parcelBox ? nearM : Math.max(nearM, q.radiusM ?? DEFAULT_RADIUS_M)) / 110540;
  const padLng = (parcelBox ? nearM : Math.max(nearM, q.radiusM ?? DEFAULT_RADIUS_M)) / (111320 * Math.cos((lat0 * Math.PI) / 180));
  const box = parcelBox
    ? { w: parcelBox[0] - padLng, s: parcelBox[1] - padLat, e: parcelBox[2] + padLng, n: parcelBox[3] + padLat }
    : { w: q.lng - padLng, s: q.lat - padLat, e: q.lng + padLng, n: q.lat + padLat };

  const cache = deps.overtureCache ?? shared;
  const nowMs = Date.parse(at);
  const stats = { requests: 0, bytes: 0 };
  /** @type {string[]} */ const warnings = [];

  let rel = await resolveRelease(deps, cache, nowMs, stats);
  if (!rel.ok) return fail(rel.reason, rel.code);
  /** @param {string} release */
  const open = async (release) => {
    const reader = createPmtilesReader({ url: tileFileUrl(release), fetch: deps.fetch, gunzip: deps.gunzip, timeoutMs: deps.timeoutMs, dirCache: cache.dirs, stats });
    await reader.open();
    return reader;
  };
  let reader;
  try { reader = await open(rel.release); } catch (e) {
    if (!(e instanceof PmtilesError)) return fail(`Overture file: ${String(e)}`, 'network');
    if (rel.fromCache && (e.code === 'http' || e.code === 'not_pmtiles')) { // a remembered release may have been deleted (releases live ~60 days)
      rel = await resolveRelease(deps, cache, nowMs, stats, true);
      if (!rel.ok) return fail(rel.reason, rel.code);
      try { reader = await open(rel.release); } catch (e2) { return failFrom(e2, 'Overture buildings file'); }
    } else return failFrom(e, 'Overture buildings file');
  }

  const z = Math.min(14, reader.maxZoom || 14);
  const x0 = lngToTileX(box.w, z), x1 = lngToTileX(box.e, z), y0 = latToTileY(box.n, z), y1 = latToTileY(box.s, z);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) return fail('the search area spans too many map tiles', 'bad_query');
  /** @type {Array<{z:number,x:number,y:number,layer:any}>} */ const tiles = [];
  let tilesMissing = 0;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    let bytes;
    try { bytes = await reader.tile(z, x, y); } catch (e) { return failFrom(e, `tile ${z}/${x}/${y}`); }
    if (!bytes) { tilesMissing++; continue; } // no tile in the file = no buildings there
    try { tiles.push({ z, x, y, layer: decodeMvtLayer(bytes, 'building') }); } catch (e) {
      return fail(`could not decode tile ${z}/${x}/${y}: ${e instanceof Error ? e.message : String(e)}`, 'decode_error');
    }
  }

  const { buildings: raw, counts: c0 } = buildingsFromTiles(tiles, box);
  const counts = { ...c0, tiles: tiles.length, tilesMissing, release: rel.release, requests: stats.requests, bytes: stats.bytes, outsideParcel: 0, near: 0, partial: 0 };
  const includeNear = q.includeNear === true;
  const buildings = [];
  for (const b of raw) {
    const c = mainCentroid(b.polygon);
    // with a parcel: on = the building's centroid lies on the parcel (as LARIAC does). Without one: on = the building contains the point,
    // and a building is kept only if it contains the point or its centroid is within radiusM of it.
    const on = q.parcel ? pointInPolygon(c, q.parcel) : pointInPolygon({ lat: q.lat, lng: q.lng }, b.polygon);
    if (q.parcel && !on) { if (!includeNear) { counts.outsideParcel++; continue; } counts.near++; }
    if (!q.parcel && !on && !withinRadius(c, q, q.radiusM ?? DEFAULT_RADIUS_M)) { counts.outsideParcel++; continue; }
    if (b.partial) { counts.partial++; warnings.push(`building ${b.id} is cut by a map-tile edge; its footprint is the largest piece only`); }
    const p = b.props;
    const h = posNum(p.height), fl = posNum(p.num_floors);
    const kind = String(p.class || p.subtype || '') || 'building';
    buildings.push({
      polygon: b.polygon, areaSqft: round(b.areaSqft, 1), kind, ...(h !== null ? { heightFt: round(h * M_TO_FT, 1) } : {}), ...(fl !== null ? { floors: fl } : {}),
      id: b.id, dataset: datasetOf(p), onParcel: Boolean(on), ...(typeof p.class === 'string' && p.class ? { buildingClass: p.class } : {}), ...(b.partial ? { partial: true, fragments: b.fragments } : {}),
      ...(typeof p['@name'] === 'string' && p['@name'] ? { name: p['@name'] } : {}),
    });
  }
  buildings.sort((a, b) => b.areaSqft - a.areaSqft || (a.id < b.id ? -1 : 1));
  return {
    ok: /** @type {const} */ (true), buildings, source: SOURCE_NAME, retrievedAt: at, confidence: CONFIDENCE.osmBuildings, counts, warnings,
    attribution: ATTRIBUTION_TEXT, license: 'ODbL 1.0 (Overture Maps Foundation, buildings theme)',
    ...(buildings.length ? {} : { note: q.parcel ? 'no Overture building lies on this parcel (it may be vacant, or the building is newer than the release)' : 'no Overture building near this point' }),
  };
}

/** @param {{lat:number,lng:number}} c @param {{lat:number,lng:number}} q @param {number} r */
function withinRadius(c, q, r) {
  const dy = (c.lat - q.lat) * 110540, dx = (c.lng - q.lng) * 111320 * Math.cos((q.lat * Math.PI) / 180);
  return Math.hypot(dx, dy) <= r;
}

/** @param {any} e @param {string} what */
function failFrom(e, what) {
  if (e instanceof PmtilesError) {
    const code = e.code === 'http' ? 'http_error' : e.code === 'decode' ? 'decode_error' : e.code === 'not_pmtiles' ? 'decode_error' : e.code;
    return fail(`${what}: ${e.message}`, code);
  }
  return fail(`${what}: ${e instanceof Error ? e.message : String(e)}`, 'network');
}

/** @type {import('./types.js').FootprintProvider} */
export const overtureBuildings = {
  id: 'overture-buildings', label: SOURCE_NAME, kind: 'footprint', needsKey: false, role: 'fallback', priority: 50, verified: true,
  // everywhere except Los Angeles County, where it is reached only as the fallback inside the LARIAC provider (see withOvertureFallback)
  coverage: /** @type {any} */ ({ national: true, exceptCountyFips: ['06037'] }), retentionDays: null,
  licenseNote: 'ODbL 1.0, Overture Maps Foundation (buildings theme; includes OpenStreetMap and ML-detected footprints). Attribution: "Drafted buildings: Overture Maps Foundation (ODbL)". Share-alike applies to a derived database; confirm before storing at scale.',
  lookup,
};

/**
 * A footprint provider that asks `primary` (LARIAC) first and asks Overture ONLY when the primary found no building or failed, so the
 * assembler (which calls every footprint provider it is given) pays Overture's ~5 requests / ~400 KB only when it is needed.
 * Same id, kind, coverage and key rules as the primary. When Overture answers, the result says so: `source` is Overture's, `fallbackFrom`
 * names the primary and why it was not used, `warnings` repeats it. If Overture finds nothing either, the PRIMARY's own result
 * (empty or failed) is returned unchanged.
 * @param {import('./types.js').FootprintProvider} primary
 * @param {import('./types.js').FootprintProvider} [overture]
 * @returns {import('./types.js').FootprintProvider}
 */
export function withOvertureFallback(primary, overture = overtureBuildings) {
  return {
    ...primary,
    licenseNote: `${primary.licenseNote} If it finds no building, Overture Maps buildings (ODbL; "${ATTRIBUTION_TEXT}") are used instead and the result says so.`,
    async lookup(q, deps) {
      const r = await primary.lookup(q, deps);
      if (r.ok && r.buildings.length) return r;
      const why = r.ok ? `${primary.id} found no building on the parcel` : `${primary.id} failed: ${r.reason}`;
      const o = await overture.lookup(q, deps);
      if (!o.ok || !o.buildings.length) return r;
      return { ...o, fallbackFrom: primary.id, fallbackReason: why, warnings: [...(o.warnings ?? []), `${why}; building outlines come from Overture Maps instead`] };
    },
  };
}

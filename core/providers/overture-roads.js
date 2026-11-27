// @ts-check
// Overture Maps road centrelines as a keyless, nationwide street provider (kind 'street'): the named streets near a property, for the
// front/back yard split (core/yard.js) and the estimated lot (core/lot-estimate.js).
//
// REUSED (StreetForge streetforge2d.html, read-only reference):
//   13597         `OV`: the same Overture catalog and tile bucket as the buildings provider, theme `transportation` instead of `buildings`
//   13598-13630   PMTiles reader + vector-tile decoder (already ported to ./pmtiles.js; reused unchanged)
//   13631-13638   current release from the catalog (./overture-buildings.js resolveRelease; one catalog read serves both providers)
//   13718-13727   which OpenStreetMap ways StreetForge keeps as streets: no sidewalks/crossings, no steps, service roads only when they are
//                 alleys (`t.service!=='alley'` dropped; unnamed service dropped), named paths only
//   13824-13831   the same rules for map-tile roads: motorways dropped (`/^motorway/`), tracks dropped, service roads kept only when an
//                 alley or named, sidewalks/crossings/steps dropped
//   13974         road kinds: ROAD_CLS -> 'road', service -> 'alley', pedestrian -> 'ped', the rest 'path'
//   13541, 13538  ROAD_CLS and the OSM highway -> class table (residential/unclassified -> street, living_street -> street_limited)
// StreetForge reads its road lines from Mapbox tiles and Overpass, not from Overture. Overture's `transportation.pmtiles` is published at
// the same place as the buildings file (checked live 2026-11-27: release 2026-11-18.0, ranged GET answers 206 with
// `access-control-allow-origin: *`); its `segment` layer carries OpenStreetMap's classes (`class`, `subclass`, `@name`), so StreetForge's
// filters port one to one. Licence: ODbL 1.0 (OpenStreetMap-derived).
//
// Cost: 1 catalog request (shared, cached one day), 1 header+root request (cached per file), 0-1 leaf directory, 1 z14 tile (rarely up to 4
// when the search box crosses a tile edge). A z14 tile is large in a dense downtown (City Hall: about 0.8 MB transferred, 3.2 MB decoded).

import { isoNow } from '../parcel.js';
import { localProjection } from '../geometry.js';
import { fail } from './util.js';
import { createPmtilesReader, decodeMvtLayer, tilePointToLngLat, lngToTileX, latToTileY, PmtilesError } from './pmtiles.js';
import { resolveRelease, sharedOvertureCache, tileFileUrl } from './overture-buildings.js';

export const SOURCE_NAME = 'Overture Maps transportation (Overture Maps Foundation, ODbL; OpenStreetMap-derived)';
export const ATTRIBUTION_TEXT = 'Street lines: Overture Maps Foundation (ODbL), © OpenStreetMap contributors';
/** Default search radius around the point, metres. A lot's own street centreline is within this of the lot's centre on any normal lot. */
export const DEFAULT_RADIUS_M = 100;
const MAX_TILES = 4;
/** Car streets (StreetForge ROAD_CLS 13541 in Overture's/OSM's names). */
export const STREET_CLASSES = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'living_street']);

/**
 * Pure: is this decoded `segment` feature a street that can front a lot? Returns {keep:false, why} or {keep:true, alley, kind}.
 * @param {Record<string, any>} p feature properties
 */
export function classifySegment(p) {
  const cls = String(p.class ?? ''), sub = String(p.subclass ?? ''), name = typeof p['@name'] === 'string' ? p['@name'].trim() : '';
  if (p.subtype !== 'road') return { keep: false, why: 'not a road (rail or water)' };
  if (/^motorway/.test(cls)) return { keep: false, why: 'motorway' };
  if (sub === 'link') return { keep: false, why: 'ramp or link' };
  if (/(^|")is_tunnel/.test(String(p.road_flags ?? '')) && !/between/.test(String(p.road_flags ?? ''))) return { keep: false, why: 'tunnel' };
  if (cls === 'footway' || cls === 'steps' || cls === 'path' || cls === 'cycleway' || cls === 'bridleway' || cls === 'track') return { keep: false, why: 'footpath, steps or track' };
  if (sub === 'sidewalk' || sub === 'crosswalk') return { keep: false, why: 'sidewalk or crossing' };
  if (cls === 'service') {
    if (sub === 'alley') return { keep: true, alley: true, kind: 'alley' };
    if (sub === 'driveway' || sub === 'parking_aisle') return { keep: false, why: 'driveway or parking aisle' };
    return name ? { keep: true, alley: false, kind: 'service' } : { keep: false, why: 'unnamed service road' };
  }
  if (cls === 'pedestrian') return name ? { keep: true, alley: false, kind: 'pedestrian' } : { keep: false, why: 'unnamed pedestrian way' };
  if (STREET_CLASSES.has(cls)) return { keep: true, alley: false, kind: 'street' };
  return name ? { keep: true, alley: false, kind: 'street' } : { keep: false, why: `unnamed ${cls || 'unknown'} road` };
}

/**
 * Pure: decoded `segment` layers -> streets near a point. Pieces of one segment cut by tile edges are joined into one MultiLineString.
 * @param {Array<{z:number, x:number, y:number, layer:{ext:number, features:any[]}|null}>} tiles
 * @param {{lat:number, lng:number}} point @param {number} radiusM
 */
export function streetsFromTiles(tiles, point, radiusM) {
  const counts = { features: 0, notLine: 0, dropped: /** @type {Record<string, number>} */ ({}), far: 0 };
  /** @type {Map<string, {props:any, kind:string, alley:boolean, parts:number[][][]}>} */
  const byId = new Map();
  let anon = 0;
  for (const { z, x, y, layer } of tiles) {
    if (!layer) continue;
    for (const f of layer.features) {
      counts.features++;
      if (f.type !== 2) { counts.notLine++; continue; }
      const c = classifySegment(f.props);
      if (!c.keep) { counts.dropped[c.why] = (counts.dropped[c.why] ?? 0) + 1; continue; }
      const id = typeof f.props.id === 'string' && f.props.id ? f.props.id : `anon-${anon++}`;
      const parts = f.rings.filter((l) => l.length >= 2).map((l) => l.map((p) => tilePointToLngLat(z, x, y, layer.ext, p)));
      if (!parts.length) continue;
      const cur = byId.get(id);
      if (cur) cur.parts.push(...parts); else byId.set(id, { props: f.props, kind: /** @type {string} */ (c.kind), alley: Boolean(c.alley), parts });
    }
  }
  const proj = localProjection(point);
  const out = [];
  for (const [id, s] of byId) {
    let d = Infinity;
    for (const l of s.parts) {
      const q = l.map((p) => proj.toXY(p));
      for (let k = 0; k + 1 < q.length; k++) d = Math.min(d, segDist0(q[k], q[k + 1]));
    }
    if (d > radiusM) { counts.far++; continue; }
    const name = typeof s.props['@name'] === 'string' && s.props['@name'].trim() ? s.props['@name'].trim() : null;
    const geometry = s.parts.length === 1 ? { type: 'LineString', coordinates: s.parts[0] } : { type: 'MultiLineString', coordinates: s.parts };
    out.push({ name, geometry, class: String(s.props.class ?? ''), kind: s.kind, alley: s.alley, id, distanceM: Math.round(d * 10) / 10 });
  }
  out.sort((a, b) => a.distanceM - b.distanceM || (a.id < b.id ? -1 : 1));
  return { streets: out, counts };
}

/** Distance from the origin to segment ab (local metres). @param {number[]} a @param {number[]} b */
function segDist0(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / l2)) : 0;
  return Math.hypot(a[0] + t * dx, a[1] + t * dy);
}

/** @param {{lat:number, lng:number, radiusM?:number, address?:string}} q @param {any} deps */
async function lookup(q, deps) {
  let at;
  try { at = isoNow(deps?.now); } catch (e) { return fail(e instanceof Error ? e.message : '`now` must be injected', 'bad_query'); }
  if (typeof deps?.fetch !== 'function') return fail('no fetch provided', 'no_fetch');
  if (!q || !Number.isFinite(q.lat) || !Number.isFinite(q.lng)) return fail('lat/lng required', 'bad_query');
  const radiusM = Number.isFinite(q.radiusM) && /** @type {number} */ (q.radiusM) > 0 ? /** @type {number} */ (q.radiusM) : DEFAULT_RADIUS_M;
  const cache = deps.overtureCache ?? sharedOvertureCache();
  const stats = { requests: 0, bytes: 0 };
  const nowMs = Date.parse(at);
  let rel = await resolveRelease(deps, cache, nowMs, stats);
  if (!rel.ok) return fail(rel.reason, rel.code);
  const open = async (/** @type {string} */ release) => {
    const reader = createPmtilesReader({ url: tileFileUrl(release, 'transportation'), fetch: deps.fetch, gunzip: deps.gunzip, timeoutMs: deps.timeoutMs, dirCache: cache.dirs, stats });
    await reader.open();
    return reader;
  };
  let reader;
  try { reader = await open(rel.release); } catch (e) {
    if (!(e instanceof PmtilesError)) return fail(`Overture transportation file: ${String(e)}`, 'network');
    if (rel.fromCache && (e.code === 'http' || e.code === 'not_pmtiles')) {
      rel = await resolveRelease(deps, cache, nowMs, stats, true);
      if (!rel.ok) return fail(rel.reason, rel.code);
      try { reader = await open(rel.release); } catch (e2) { return failFrom(e2, 'Overture transportation file'); }
    } else return failFrom(e, 'Overture transportation file');
  }
  const z = Math.min(14, reader.maxZoom || 14);
  const padLat = radiusM / 110540, padLng = radiusM / (111320 * Math.cos((q.lat * Math.PI) / 180));
  const x0 = lngToTileX(q.lng - padLng, z), x1 = lngToTileX(q.lng + padLng, z), y0 = latToTileY(q.lat + padLat, z), y1 = latToTileY(q.lat - padLat, z);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) return fail('the search area spans too many map tiles', 'bad_query');
  /** @type {Array<{z:number,x:number,y:number,layer:any}>} */ const tiles = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    let bytes;
    try { bytes = await reader.tile(z, x, y); } catch (e) { return failFrom(e, `tile ${z}/${x}/${y}`); }
    if (!bytes) continue;
    try { tiles.push({ z, x, y, layer: decodeMvtLayer(bytes, 'segment') }); } catch (e) {
      return fail(`could not decode tile ${z}/${x}/${y}: ${e instanceof Error ? e.message : String(e)}`, 'decode_error');
    }
  }
  const { streets, counts } = streetsFromTiles(tiles, { lat: q.lat, lng: q.lng }, radiusM);
  return {
    ok: /** @type {const} */ (true), streets, source: SOURCE_NAME, retrievedAt: at, attribution: ATTRIBUTION_TEXT, license: 'ODbL 1.0 (Overture Maps Foundation, transportation theme)',
    counts: { ...counts, tiles: tiles.length, release: rel.release, requests: stats.requests, bytes: stats.bytes },
    ...(streets.length ? {} : { note: 'no mapped street within the search radius' }),
  };
}

/** @param {any} e @param {string} what */
function failFrom(e, what) {
  if (e instanceof PmtilesError) {
    const code = e.code === 'http' ? 'http_error' : e.code === 'decode' || e.code === 'not_pmtiles' ? 'decode_error' : e.code;
    return fail(`${what}: ${e.message}`, code);
  }
  return fail(`${what}: ${e instanceof Error ? e.message : String(e)}`, 'network');
}

/** @type {import('./types.js').StreetProvider} */
export const overtureRoads = {
  id: 'overture-roads', label: SOURCE_NAME, kind: 'street', needsKey: false, role: 'fallback', priority: 50, verified: true,
  coverage: { national: true }, retentionDays: null,
  licenseNote: 'ODbL 1.0, Overture Maps Foundation transportation theme (OpenStreetMap-derived). Attribution: "Street lines: Overture Maps Foundation (ODbL), © OpenStreetMap contributors".',
  lookup,
};

// @ts-check
// LARIAC building outlines 2020 (LA County) as a keyless footprint fallback. Verified live 2026-11-27:
// LACounty_Dynamic/LARIAC_Buildings_2020/MapServer/0. CODE values found with one returnDistinctValues query:
// 'Building', 'Free Standing Solar Structure', 'Courtyard'. Only 'Building' is kept. AREA and HEIGHT are in feet (the layer's
// state-plane units); AREA is stored as a cross-check, the area used is computed from the geometry.
// The layer holds several vintages (SOURCE LARIAC2 2008 .. LARIAC6 2020): a building whose centroid lies inside a
// building of a later DATE_ is treated as superseded and dropped; buildings whose centroid is outside the parcel are dropped
// (they only touch it). Polygon queries are sent by POST: a ~2 KB GET url returned HTTP 404 from the host's front end.

import { ringsToGeoJSON, CONFIDENCE } from '../parcel.js';
import { polygonAreaSqft, pointInPolygon, centroid } from '../geometry.js';
import { callJson, fail, isoNow, pos, text, round } from './util.js';

const URL_ = 'https://public.gis.lacounty.gov/public/rest/services/LACounty_Dynamic/LARIAC_Buildings_2020/MapServer/0/query';
export const BUILDING_CODE = 'Building';
export const SOURCE_NAME = 'LARIAC building outlines 2020 (LA County)';
const DEFAULT_RADIUS_M = 40;

/** Centroid of the largest part of a (Multi)Polygon. @param {any} g */
function mainCentroid(g) {
  if (g.type === 'Polygon') return centroid(g);
  let best = g.coordinates[0], bestA = -1;
  for (const rings of g.coordinates) { const a = polygonAreaSqft({ type: 'Polygon', coordinates: rings }); if (a > bestA) { bestA = a; best = rings; } }
  return centroid({ type: 'Polygon', coordinates: best });
}

/** GeoJSON (outer CCW, holes CW) -> Esri rings (outer CW, holes CCW): every ring reversed. @param {any} g */
export function toEsriRings(g) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.flatMap((/** @type {number[][][]} */ rings) => rings.map((r) => [...r].reverse()));
}

const yearOf = (/** @type {any} */ d) => { const n = pos(d); return n !== null ? n : 0; };

/** @param {{lat:number, lng:number, parcel?:any}} q @param {any} deps */
async function lookup(q, deps) {
  const at = isoNow(deps?.now);
  if (!q || !Number.isFinite(q.lat) || !Number.isFinite(q.lng)) return fail('lat/lng required', 'bad_query');
  const base = { outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'json' };
  const body = q.parcel
    ? new URLSearchParams({ ...base, geometryType: 'esriGeometryPolygon', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      geometry: JSON.stringify({ rings: toEsriRings(q.parcel), spatialReference: { wkid: 4326 } }) })
    : new URLSearchParams({ ...base, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', geometry: `${q.lng},${q.lat}`, distance: String(DEFAULT_RADIUS_M), units: 'esriSRUnit_Meter' });
  const r = await callJson(URL_, deps, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  if (!r.ok) return fail(r.reason, r.code);
  if (r.json?.error) return fail(`service error: ${r.json.error.message ?? r.json.error.code ?? 'unknown'}`, 'http_error');
  const feats = r.json?.features;
  if (!Array.isArray(feats)) return fail('malformed response', 'malformed_json');
  const counts = { returned: feats.length, notBuilding: 0, outsideParcel: 0, superseded: 0, noGeometry: 0, exceededTransferLimit: Boolean(r.json?.exceededTransferLimit) };
  const all = [];
  for (const f of feats) {
    const a = f?.attributes ?? {};
    if (String(a.CODE ?? '').toLowerCase() !== BUILDING_CODE.toLowerCase()) { counts.notBuilding++; continue; }
    const polygon = ringsToGeoJSON(f.geometry?.rings ?? []);
    if (!polygon) { counts.noGeometry++; continue; }
    all.push({ polygon, a, date: yearOf(a.DATE_), c: mainCentroid(polygon) });
  }
  const kept = all.filter((b) => {
    if (q.parcel && !pointInPolygon(b.c, q.parcel)) { counts.outsideParcel++; return false; }
    if (all.some((o) => o !== b && o.date > b.date && pointInPolygon(b.c, o.polygon))) { counts.superseded++; return false; }
    return true;
  });
  const buildings = kept.map((b) => {
    const areaSqft = round(polygonAreaSqft(b.polygon), 1);
    const layerAreaSqft = pos(b.a.AREA);
    const h = pos(b.a.HEIGHT);
    return {
      polygon: b.polygon, areaSqft, kind: BUILDING_CODE, ...(h !== null ? { heightFt: round(h, 1) } : {}),
      layerAreaSqft, areaDifferencePct: layerAreaSqft ? round((Math.abs(areaSqft - layerAreaSqft) / layerAreaSqft) * 100, 2) : null,
      id: text(b.a.BLD_ID), vintage: text(String(b.a.DATE_ ?? '')), status: text(b.a.STATUS), layerSource: text(b.a.SOURCE),
    };
  });
  return { ok: /** @type {const} */ (true), buildings, source: SOURCE_NAME, retrievedAt: at, confidence: CONFIDENCE.osmBuildings + 0.1, counts };
}

/** @type {import('./types.js').FootprintProvider} */
export const lariacBuildings = {
  id: 'lariac-buildings', label: SOURCE_NAME, kind: 'footprint', needsKey: false, role: 'fallback', priority: 10, verified: true,
  coverage: { state: 'CA', countyFips: '06037', county: 'Los Angeles County' }, retentionDays: null,
  licenseNote: 'Public LA County GIS service (LARIAC); no copyright or licence text is published on the service. Imagery vintages 2008-2020: new or demolished buildings are not reflected.',
  lookup,
};

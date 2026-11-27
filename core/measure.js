// @ts-check
// Measure a lot from its outlines, with the SAME functions the property builder uses (core/property-profile.js): polygon area
// (core/geometry.js), core/yard.js splitYard, core/roof.js estimateRoof, core/usable-yard.js usableYard. A page calls it after the owner
// drags a corner on the map; given the builder's own `geometry` bundle it reproduces the builder's numbers exactly (tested).
//
// Street reference, in this order: `streets` (+ `streetName`), the lines the builder used; else `frontEdge` (a LineString along the lot's
// front line, e.g. after the owner moved it: the parcel edge nearest to it becomes the front); else `frontPoint`; else none (yards unavailable).
// `driveway` (a polygon, or {polygon}): measured clipped to the lot minus buildings (core/driveway.js drivewayAreaSqft) and left out of the
// usable yard (cars park there); front and back yard totals do not change. Buildings may carry `kind` (core/building-kind.js); totals per
// kind are returned only when some building has that kind.

import { polygonAreaSqft, pointInPolygon, centroid } from './geometry.js';
import { splitYard, yardZoneAt } from './yard.js';
import { estimateRoof } from './roof.js';
import { usableYard, USABLE_DEFAULTS } from './usable-yard.js';
import { drivewayAreaSqft } from './driveway.js';
import { validKind } from './building-kind.js';

/** Outlines smaller than this are measured but flagged `minor` (a mapping speck, a small shed). */
export const MINOR_BUILDING_SQFT = 100;

const r1 = (/** @type {number} */ v) => Math.round(v * 10) / 10;
const polyOf = (/** @type {any} */ b) => (b && !b.type && b.polygon ? b.polygon : b);

/** Footprint area as the footprint providers report it (polygon area rounded to 0.1 sq ft). @param {any} g */
export const footprintAreaSqft = (g) => r1(polygonAreaSqft(g));

/** Which reference a geometry bundle gives, as splitYard arguments (null = none). @param {any} g */
export function yardReferenceArgs(g) {
  if (Array.isArray(g?.streets) && g.streets.length) return { streets: g.streets.map((/** @type {any} */ s) => ({ name: s.name, geometry: s.geometry })), ...(g.streetName ? { streetName: g.streetName } : {}) };
  const fe = g?.frontEdge?.coordinates ?? (g?.frontEdge?.type === 'LineString' ? g.frontEdge.coordinates : null);
  if (Array.isArray(fe) && fe.length >= 2) return { streets: [{ name: 'front line', geometry: { type: 'LineString', coordinates: fe } }], streetName: 'front line' };
  if (g?.frontPoint && Number.isFinite(g.frontPoint.lat) && Number.isFinite(g.frontPoint.lng)) return { frontPoint: { lat: g.frontPoint.lat, lng: g.frontPoint.lng }, ...(g.streetName ? { streetName: g.streetName } : {}) };
  return null;
}

/**
 * @param {{parcel:any, buildings:Array<any|{polygon:any, main?:boolean}>, streets?:Array<{name:string, geometry:any}>, streetName?:string|null,
 *   frontEdge?:{coordinates:number[][]}|null, frontPoint?:{lat:number,lng:number}|null, yearBuilt?:number|null, state?:string|null,
 *   propertyType?:string|null, stories?:number|null, pitchRise?:number, roofType?:string, minWidthFt?:number, exclude?:any[], driveway?:any}} g
 * @param {{now:string}} ctx
 */
export function measureFromGeometry(g, ctx) {
  const out = /** @type {any} */ ({ lot_area_sqft: null, building_footprint_sqft: null, roof_area_sqft: null, front_yard_sqft: null, back_yard_sqft: null, yard_area_sqft: null,
    usable_yard_sqft: null, usable_front_yard_sqft: null, usable_back_yard_sqft: null, driveway_area_sqft: null, buildings: /** @type {any[]} */ ([]),
    garage_present: null, garage_area_sqft: null, adu_present: null, adu_area_sqft: null, shed_area_sqft: null, other_buildings_area_sqft: null, zones: null, reasons: /** @type {string[]} */ ([]) });
  if (!g || !g.parcel) { out.reasons.push('no lot outline'); return out; }
  let lot;
  try { lot = Math.round(polygonAreaSqft(g.parcel)); } catch { out.reasons.push('the lot outline is not a polygon'); return out; }
  out.lot_area_sqft = lot;
  const list = (g.buildings ?? []).map((b) => ({ polygon: polyOf(b), main: Boolean(b && b.main), kind: validKind(b && b.kind) })).filter((b) => b.polygon);
  // the buildings on the lot (centroid on it), as the builder keeps them; the main one is flagged, else the largest
  const mainPart = (/** @type {any} */ p) => (p.type === 'MultiPolygon' ? { type: 'Polygon', coordinates: p.coordinates.reduce((a, c) => (polygonAreaSqft({ type: 'Polygon', coordinates: c }) > polygonAreaSqft({ type: 'Polygon', coordinates: a }) ? c : a)) } : p);
  const on = list.filter((b) => { try { return pointInPolygon(centroid(mainPart(b.polygon)), g.parcel); } catch { return false; } });
  const areas = on.map((b) => footprintAreaSqft(b.polygon));
  let mainIdx = on.findIndex((b) => b.main);
  if (mainIdx < 0) areas.forEach((a, i) => { if (mainIdx < 0 || a > areas[mainIdx]) mainIdx = i; });
  if (mainIdx >= 0) {
    out.building_footprint_sqft = Math.round(areas[mainIdx]);
    const ri = g.roof ?? g; // the builder's bundle carries the roof inputs under `roof`
    const rr = estimateRoof({ footprintSqft: areas[mainIdx], yearBuilt: ri.yearBuilt ?? null, propertyType: ri.propertyType ?? null, stories: ri.stories ?? null,
      ...(ri.state && ri.state !== '??' ? { stateCode: ri.state } : {}), ...(ri.pitchRise !== undefined ? { pitchRise: ri.pitchRise } : {}), ...(ri.roofType ? { roofType: ri.roofType } : {}) }, { now: ctx.now });
    if (rr.ok) out.roof_area_sqft = rr.roof.value; else out.reasons.push(rr.roof.note ?? 'roof not estimated');
  } else out.reasons.push('no building on the lot');
  // buildings and totals by kind
  out.buildings = on.map((b, i) => ({ index: i, kind: b.kind, areaSqft: Math.round(areas[i]), ...(areas[i] < MINOR_BUILDING_SQFT ? { minor: true } : {}) }));
  const sumKind = (/** @type {string[]} */ ks) => { const hit = out.buildings.filter((/** @type {any} */ b) => ks.includes(b.kind)); return hit.length ? hit.reduce((s2, /** @type {any} */ b) => s2 + b.areaSqft, 0) : null; };
  out.garage_area_sqft = sumKind(['garage']); out.garage_present = out.garage_area_sqft !== null ? true : null;
  out.adu_area_sqft = sumKind(['adu']); out.adu_present = out.adu_area_sqft !== null ? true : null;
  out.shed_area_sqft = sumKind(['shed']); out.other_buildings_area_sqft = sumKind(['other', 'carport', 'pool_house']);
  const dvPoly = g.driveway ? polyOf(g.driveway) : null;
  if (dvPoly) { out.driveway_area_sqft = drivewayAreaSqft(dvPoly, g.parcel, on.map((b) => b.polygon)); if (out.driveway_area_sqft === null) out.reasons.push('the driveway outline is not a polygon'); }
  const ref = yardReferenceArgs(g);
  /** @type {any} */ let yard = null;
  if (mainIdx >= 0 && ref) {
    const y = splitYard({ parcel: g.parcel, buildings: on.map((b) => b.polygon), mainBuildingIndex: mainIdx, ...ref });
    if (y.ok) yard = y; else out.reasons.push(`yard: ${y.reason}`);
  } else if (!ref) out.reasons.push('no street reference: front and back yard are not split');
  if (yard) {
    out.front_yard_sqft = yard.frontYardSqft; out.back_yard_sqft = yard.backYardSqft;
    out.yard_area_sqft = [yard.frontYardSqft, yard.backYardSqft, yard.sideYardSqft].every((v) => typeof v === 'number') ? yard.frontYardSqft + yard.backYardSqft + yard.sideYardSqft : null;
    out.side_yard_sqft_hidden = yard.sideYardSqft;
  }
  const u = usableYard({ parcel: g.parcel, buildings: on.map((b) => b.polygon), yard, minWidthFt: g.minWidthFt ?? USABLE_DEFAULTS.MIN_WIDTH_FT, exclude: [...(g.exclude ?? []), ...(dvPoly && out.driveway_area_sqft !== null ? [dvPoly] : [])] });
  if (u.ok) { out.usable_yard_sqft = u.usableSqft; out.usable_front_yard_sqft = u.usableFrontSqft; out.usable_back_yard_sqft = u.usableBackSqft; }
  else out.reasons.push(`usable yard: ${u.reason}`);
  out.zones = yard ? { bands: yard.bands ?? null, frontEdge: yard.frontEdge, zoneAt: yardZoneAt(yard) } : null;
  out.yard = yard; out.usable = u.ok ? u : null;
  return out;
}

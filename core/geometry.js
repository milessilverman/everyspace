// @ts-check
// WGS84 geometry helpers. GeoJSON order is [lng, lat]; points are {lat, lng}.
//
// AREA METHOD: each ring is projected to a local tangent plane (x = R*cos(lat0)*dLng, y = R*dLat, radians, lat0 =
// the ring's mean latitude, R = 6,371,008.8 m) and measured with the shoelace formula. Holes are subtracted.
// ACCURACY LIMIT: planar distortion is negligible below a few km (well under 0.1% for a parcel); the spherical
// Earth model differs from the WGS84 ellipsoid by up to ~0.5%. Fine for lot and roof sizing, NOT for survey,
// legal or tax use. Rings larger than ~10 km are not supported accurately.

/** Mean Earth radius used by every helper here, metres. */
export const EARTH_RADIUS_M = 6371008.8;
const R = EARTH_RADIUS_M;
/** Square feet per square metre (exact: 1 ft = 0.3048 m). */
export const SQFT_PER_M2 = 10.763910416709722;
const RAD = Math.PI / 180;

/** @typedef {{lat:number, lng:number}} LatLng */
/** @typedef {number[][]} Ring */
/** @typedef {{type:'Polygon', coordinates:Ring[]}|{type:'MultiPolygon', coordinates:Ring[][]}} PolygonGeometry */

/** Accepts a Polygon/MultiPolygon geometry or a Feature wrapping one; returns a list of polygons (arrays of rings). */
function polygonsOf(g) {
  const geom = g && g.type === 'Feature' ? g.geometry : g;
  if (!geom || !Array.isArray(geom.coordinates)) throw new TypeError('expected a GeoJSON Polygon or MultiPolygon');
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  throw new TypeError(`unsupported geometry type ${geom.type}`);
}

/** @param {Ring} ring */
function ringAreaM2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * RAD;
  const kx = R * Math.cos(lat0) * RAD;
  const ky = R * RAD;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(a) / 2;
}

/**
 * Area in square feet of a GeoJSON Polygon or MultiPolygon (outer rings minus holes, floored at 0). Throws
 * TypeError for anything that is not a polygon.
 * @param {any} geometry
 */
export function polygonAreaSqft(geometry) {
  let m2 = 0;
  for (const rings of polygonsOf(geometry)) {
    const [outer, ...holes] = rings;
    m2 += Math.max(0, ringAreaM2(outer) - holes.reduce((s, h) => s + ringAreaM2(h), 0));
  }
  return m2 * SQFT_PER_M2;
}

/** @param {any[]} geometries */
export function sumAreas(geometries) {
  return geometries.reduce((s, g) => s + polygonAreaSqft(g), 0);
}

/** @param {{lat:number,lng:number}} pt @param {Ring} ring */
function inRing(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt.lat !== yj > pt.lat && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/**
 * Ray-casting test; a point inside a hole is outside. Points exactly on an edge are not defined.
 * @param {LatLng} point
 * @param {any} geometry Polygon, MultiPolygon or Feature
 */
export function pointInPolygon(point, geometry) {
  return polygonsOf(geometry).some(([outer, ...holes]) => inRing(point, outer) && !holes.some((h) => inRing(point, h)));
}

/**
 * Great-circle (haversine) distance in metres.
 * @param {LatLng} a @param {LatLng} b
 */
export function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Area-weighted centroid of the outer ring of a polygon (first polygon of a MultiPolygon); falls back to the vertex
 * mean for a degenerate ring. Computed in degrees, which is fine at parcel scale.
 * @param {any} geometry
 * @returns {LatLng}
 */
export function centroid(geometry) {
  const ring = polygonsOf(geometry)[0][0];
  let a = 0, cx = 0, cy = 0;
  const [ox, oy] = ring[0]; // work relative to the first vertex to avoid cancellation at large coordinates
  for (let i = 0; i < ring.length; i++) {
    const x1 = ring[i][0] - ox, y1 = ring[i][1] - oy;
    const x2 = ring[(i + 1) % ring.length][0] - ox, y2 = ring[(i + 1) % ring.length][1] - oy;
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-18) {
    const n = ring.length;
    return { lng: ring.reduce((s, p) => s + p[0], 0) / n, lat: ring.reduce((s, p) => s + p[1], 0) / n };
  }
  return { lng: ox + cx / (3 * a), lat: oy + cy / (3 * a) };
}

/**
 * Yard estimate = lot area minus the footprints of buildings whose centroid lies on the parcel, floored at 0.
 * Counts only buildings given; ignores driveways, pools and unmapped structures, so treat it as an estimate.
 * @param {any} parcel Polygon/MultiPolygon
 * @param {Array<{polygon:any}>} buildings
 * @param {number} [lotSqft] use this lot area instead of measuring `parcel`
 */
export function yardAreaSqft(parcel, buildings, lotSqft) {
  const lot = lotSqft ?? polygonAreaSqft(parcel);
  const on = buildings.filter((b) => pointInPolygon(centroid(b.polygon), parcel));
  const built = sumAreas(on.map((b) => b.polygon));
  return { lotSqft: lot, buildingSqft: built, buildingCount: on.length, yardSqft: Math.max(0, lot - built) };
}

/**
 * Local planar frame: equirectangular projection around `origin` (x = R*cos(lat0)*dLng east, y = R*dLat north,
 * metres, same R as above). ERROR BOUND: the east scale is fixed at cos(lat0), so at a point dy metres north of the
 * origin lengths are off by about tan(lat0)*dy/R relative: at Los Angeles (34 N) and 100 m from the origin that is
 * < 1.1e-5 (0.06 sq ft on a 5,000 sq ft lot). Against the WGS84 ellipsoid the spherical R adds, at 34 N, about +0.25%
 * on north-south lengths, -0.22% on east-west lengths and +0.03% on areas. Use within ~1 km of the origin only.
 * @param {LatLng} origin
 * @returns {{origin:LatLng, toXY:(p:number[])=>number[], toLngLat:(p:number[])=>number[]}}
 */
export function localProjection(origin) {
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || Math.abs(origin.lat) >= 90) {
    throw new TypeError('localProjection: origin must be {lat, lng} with finite values and |lat| < 90');
  }
  const kx = R * Math.cos(origin.lat * RAD) * RAD, ky = R * RAD;
  return {
    origin: { lat: origin.lat, lng: origin.lng },
    toXY: (p) => [(p[0] - origin.lng) * kx, (p[1] - origin.lat) * ky],
    toLngLat: (p) => [origin.lng + p[0] / kx, origin.lat + p[1] / ky],
  };
}

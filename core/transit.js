// @ts-check
// Nearby transit summary from OpenStreetMap elements (the same Overpass answer core/parcel.js `overpassNear` already
// fetches: railway=station, public_transport=platform and highway=bus_stop nodes). Ported from City Pretty (read-only):
//   /home/user/milessilverman/city-pretty/src/engines/gtfsWalkshedEngine.js:6-58 `evaluateTransitWalkshed`
//     - straight-line (haversine, R = 3958.8 mi) distance from the origin to each stop (lines 8-20);
//     - default walk radius `maxWalkMiles = 0.5` (line 6); the nearest heavy-rail/subway, light-rail/streetcar and bus/BRT
//       stop inside it, and a count of buses per hour (lines 22-47).
//   /home/user/milessilverman/city-pretty/pipeline/osm_extract.py:22-37 `is_transit_station`: tourist, heritage, miniature,
//     zoo and private rail "stations" are not transit (tag and name rules copied below).
//   docs/ERRATA-round8.4.md:201 (quoting City Pretty's own rule): "A streetcar or cable-car stop is a street stop, not a rail station".
//
// WHAT CITY PRETTY SAYS vs WHAT ITS CODE DOES: the header of gtfsWalkshedEngine.js claims "network-distance walkshed
// contours and peak/off-peak headways". The code is straight-line distance only, with no network and no headways, and
// nothing in the app calls it (app/app.js:1028 holds a copy, with no caller; the app reads precomputed per-block-group
// dist_to_* fields built by its pipeline instead). The 0.5 mile radius is a default argument with no comment; City
// Pretty's docs tie the half mile to California's statutory transit-proximity tests (docs/GRAND-VISION-AND-ECOSYSTEM.md:99).
//
// NOT ported: "frequent bus" (tripsPerHour >= 4, line 39) and buses per hour. OpenStreetMap carries no timetable, so
// frequency is unknown here and the summary says so; it never reports a stop as frequent.
// Pure, dependency-free except core/geometry.js; inputs are never mutated; `now` is passed in.

import { distanceM } from './geometry.js';
import { sourced, unavailable } from './provenance.js';

/** gtfsWalkshedEngine.js:6 default walk radius, miles; 1 mile = 1609.344 m exactly. */
export const WALK_MILES = 0.5;
export const WALK_RADIUS_M = WALK_MILES * 1609.344;
/** How far the nearest-stop search looks; matches core/parcel.js TRANSIT_RADIUS_M (the radius the Overpass query uses). */
export const SEARCH_RADIUS_M = 1500;

// osm_extract.py:24-29 (copied; Python `re.I` -> JS `i`)
const NONTRANSIT = /miniature|mini[ -]?train|vintage railroad|heritage rail|excursion|scenic rail|railroad museum|railway museum|tea garden|steam(er)?s? train|park railroad|park train/i;
const MUSEUM_OP = /\bhistor(y|ical)\b|museum/i;
const ZOO = /\b(zoo|safari)\b/i;

/** osm_extract.py:32-37 `is_transit_station`, plus the tram rule quoted above. @param {Record<string,string>} t */
export function isTransitStation(t) {
  if (t.usage === 'tourism' || t['railway:historic'] || t.historic === 'railway_station' || t.station === 'miniature'
    || t.tourism === 'attraction' || t.tourism === 'museum' || t.access === 'private' || t.access === 'no') return false;
  if (t.station === 'tram' || t.station === 'funicular' || t.railway === 'tram_stop') return false;
  const txt = ['name', 'operator', 'network', 'description', 'note'].map((k) => String(t[k] ?? '')).join(' ');
  return !NONTRANSIT.test(txt) && !(ZOO.test(txt) && !t.network) && !MUSEUM_OP.test(String(t.operator ?? ''));
}

/** Same classification order as core/parcel.js `transitNear`: rail station, then bus stop, then platform. @param {any} el */
function kindOf(el) {
  const tg = el?.tags ?? {};
  if (tg.railway === 'station') return isTransitStation(tg) ? 'rail_station' : null;
  if (tg.highway === 'bus_stop') return 'bus_stop';
  if (tg.public_transport === 'platform') return 'platform';
  return null;
}

/**
 * @param {any[]} elements Overpass elements (nodes with lat/lon and tags)
 * @param {{lat:number,lng:number}} point
 * @param {{walkRadiusM?:number, searchRadiusM?:number}} [opts]
 * @returns {{nearest:{name:string|null, kind:string, distanceM:number}|null, countWithinWalk:number, railWithinWalk:number, walkRadiusM:number, searchRadiusM:number, method:string, frequencyKnown:false}}
 */
export function summarizeTransit(elements, point, opts = {}) {
  const walk = typeof opts.walkRadiusM === 'number' && opts.walkRadiusM > 0 ? opts.walkRadiusM : WALK_RADIUS_M;
  const search = typeof opts.searchRadiusM === 'number' && opts.searchRadiusM > 0 ? opts.searchRadiusM : SEARCH_RADIUS_M;
  /** @type {Array<{name:string|null, kind:string, distanceM:number}>} */ const stops = [];
  for (const el of Array.isArray(elements) ? elements : []) {
    if (el?.type !== 'node' || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
    const kind = kindOf(el);
    if (!kind) continue;
    const d = distanceM(point, { lat: el.lat, lng: el.lon });
    if (d <= search) stops.push({ name: el.tags?.name ?? null, kind, distanceM: d });
  }
  stops.sort((a, b) => a.distanceM - b.distanceM);
  const inWalk = stops.filter((s) => s.distanceM <= walk);
  return {
    nearest: stops[0] ? { ...stops[0], distanceM: Math.round(stops[0].distanceM) } : null,
    countWithinWalk: inWalk.length,
    railWithinWalk: inWalk.filter((s) => s.kind === 'rail_station').length,
    walkRadiusM: Math.round(walk),
    searchRadiusM: search,
    method: `straight-line distance to mapped stops (City Pretty's 0.5 mile walk radius); stops counted: rail stations, bus stops, platforms; tourist/heritage/tram stops excluded; frequency unknown`,
    frequencyKnown: false,
  };
}

/**
 * Profile attributes from a summary. When OpenStreetMap could not be read pass `summary = null` and `unavailableReason`.
 * @param {ReturnType<typeof summarizeTransit>|null} summary
 * @param {{now?:string, source?:string, unavailableReason?:string, sourceUrl?:string, license?:string}} [o]
 * @returns {{transit_distance_m:any, transit_stops_nearby:any, rail_station_nearby:any}}
 */
export function transitAttributes(summary, o = {}) {
  const source = o.source ?? 'OpenStreetMap via Overpass API';
  const at = typeof o.now === 'string' ? o.now : null;
  const extra = { ...(o.sourceUrl ? { sourceUrl: o.sourceUrl } : {}), ...(o.license ? { license: o.license } : {}) };
  if (!summary) {
    const why = o.unavailableReason ?? 'transit stops were not looked up';
    return { transit_distance_m: unavailable(why, source), transit_stops_nearby: unavailable(why, source), rail_station_nearby: unavailable(why, source) };
  }
  const base = { tag: /** @type {const} */ ('estimated'), source, retrievedAt: at, ...extra };
  const caveat = 'OpenStreetMap is volunteer-mapped, so a stop that is not mapped is not proof there is none. Not walking distance. Service frequency is not known.';
  const nearest = summary.nearest;
  return {
    transit_distance_m: nearest
      ? sourced(nearest.distanceM, { ...base, confidence: 0.5, unit: 'm', method: `straight-line distance to the nearest mapped ${nearest.kind.replace('_', ' ')}${nearest.name ? ' (' + nearest.name + ')' : ''}`, note: caveat })
      : unavailable(`no transit stop mapped within ${summary.searchRadiusM} m`, source),
    transit_stops_nearby: sourced(summary.countWithinWalk, { ...base, confidence: 0.45, unit: `stops within ${summary.walkRadiusM} m`, method: summary.method, note: caveat }),
    rail_station_nearby: sourced(summary.railWithinWalk > 0, { ...base, confidence: 0.5, method: `at least one mapped rail station within ${summary.walkRadiusM} m (${summary.railWithinWalk} found)`, note: caveat }),
  };
}

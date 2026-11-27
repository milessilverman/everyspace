// @ts-check
// What a building on the lot is, ONLY as far as a data source says so. Pure. The kind is never inferred from size or position.
// Sources read: Overture's building `class` (core/providers/overture-buildings.js `buildingClass`; OpenStreetMap's `building=*` tag for
// OSM-derived outlines), or an OSM `building` tag passed as `osmBuilding`. LARIAC outlines carry no kind (every record is 'Building').
// The builder labels the main (largest) building 'house' (product rule); every other building keeps what its source says, else null.

/** Everyspace building kinds. */
export const BUILDING_KINDS = Object.freeze(['house', 'garage', 'adu', 'shed', 'carport', 'pool_house', 'other']);

/** Source class / OSM building value -> kind. Values not listed give null (unknown), never a guess. */
export const CLASS_TO_KIND = Object.freeze({
  garage: 'garage', garages: 'garage', carport: 'carport', shed: 'shed',
  house: 'house', detached: 'house', semidetached_house: 'house', bungalow: 'house',
});

/**
 * @param {{buildingClass?:string|null, osmBuilding?:string|null, kind?:string|null}} b a footprint provider's building record
 * @returns {{kind:string|null, source:string|null, value:string|null}}
 */
export function kindFromSource(b) {
  const raw = typeof b?.buildingClass === 'string' && b.buildingClass ? { v: b.buildingClass, src: 'Overture Maps building class' }
    : typeof b?.osmBuilding === 'string' && b.osmBuilding ? { v: b.osmBuilding, src: 'OpenStreetMap building tag' } : null;
  if (!raw) return { kind: null, source: null, value: null };
  const k = /** @type {Record<string,string>} */ (CLASS_TO_KIND)[raw.v.trim().toLowerCase()] ?? null;
  return { kind: k, source: k ? raw.src : null, value: raw.v };
}

/** A kind an owner or a page may set: one of BUILDING_KINDS or null. @param {any} k */
export const validKind = (k) => (typeof k === 'string' && BUILDING_KINDS.includes(k) ? k : null);

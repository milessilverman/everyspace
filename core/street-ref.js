// @ts-check
// Which street a property fronts, from road centrelines near it (core/providers/overture-roads.js) and the typed address. Pure.
//
// RULE: the street named in the address is the front street when a road line of that name is near (names compared as the assessor's
// situs match does: core/parcel.js parseStreet, so "S Cochran Ave" = "South Cochran Avenue"). Every other street is passed along too, so
// core/yard.js can recognise a corner (side frontage) or a through lot (rear frontage). Alleys are passed only together with a matched
// named street: as the only reference they could be taken for the front, which a rear alley is not. Without a name match the nearest
// non-alley street is the front (core/yard.js picks it and warns "no streetName given"). No street at all: null (the caller falls back
// to a geocoder street-side point).

import { parseStreet } from './parcel.js';

/** Normalised words of a street name ("South Cochran Avenue" -> {core:['COCHRAN'], suffix:'AVE', dir:'S'}), or null. @param {string|null|undefined} name */
export function parseStreetName(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  const p = parseStreet(`1 ${name}`);
  return p && p.core.length ? { core: p.core, suffix: p.suffix, dir: p.dir } : null;
}

/**
 * Same street? Equal core words; suffixes must agree when both are present; directions must agree when both are present.
 * @param {string} a @param {string} b
 */
export function sameStreet(a, b) {
  const x = parseStreetName(a), y = parseStreetName(b);
  if (!x || !y) return false;
  if (x.core.length !== y.core.length || !x.core.every((w, i) => w === y.core[i])) return false;
  if (x.suffix && y.suffix && x.suffix !== y.suffix) return false;
  if (x.dir && y.dir && x.dir !== y.dir) return false;
  return true;
}

/** The street part of an address line ("1829 S COCHRAN AVE, LOS ANGELES" -> "S COCHRAN AVE"), or null. @param {string} address */
export function addressStreet(address) {
  const p = parseStreet(String(address ?? '').split(',')[0]);
  if (!p || !p.core.length) return null;
  return [p.dir, ...p.core, p.suffix].filter(Boolean).join(' ');
}

/**
 * @param {{streets:Array<{name:string|null, geometry:any, alley?:boolean, kind?:string}>, address?:string}} input
 * @returns {null|{streets:Array<{name:string|null, geometry:any}>, streetName:string|null, matched:boolean, how:string, alleys:number}}
 */
export function streetReference(input) {
  const list = Array.isArray(input?.streets) ? input.streets.filter((s) => s && s.geometry) : [];
  if (!list.length) return null;
  const wanted = input.address ? addressStreet(input.address) : null;
  const hits = wanted ? list.filter((s) => !s.alley && s.name && sameStreet(s.name, wanted)) : [];
  if (hits.length) {
    // the matched segments share one name (the address's), so core/yard.js joins them into one centreline
    const streets = list.map((s) => (hits.includes(s) ? { name: wanted, geometry: s.geometry } : { name: s.name ?? (s.alley ? 'alley' : null), geometry: s.geometry }));
    return { streets: dedupeUnnamed(streets), streetName: wanted, matched: true, how: `centreline of ${wanted} (named in the address)`, alleys: list.filter((s) => s.alley).length };
  }
  const roads = list.filter((s) => !s.alley);
  if (!roads.length) return null;
  return { streets: dedupeUnnamed(roads.map((s) => ({ name: s.name, geometry: s.geometry }))), streetName: null, matched: false,
    how: wanted ? `no mapped street named ${wanted} nearby; nearest street centreline` : 'nearest street centreline', alleys: 0 };
}

/** Unnamed lines get distinct labels so core/yard.js keeps them apart ("unnamed 1", ...); named ones keep their name. @param {Array<{name:string|null, geometry:any}>} s */
function dedupeUnnamed(s) {
  let k = 0;
  return s.map((x) => (x.name ? x : { ...x, name: `unnamed ${++k}` }));
}

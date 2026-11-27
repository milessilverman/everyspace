// @ts-check
// Number of floors from the evidence a profile can have. What is ported, and from where:
//  - OSM `building:levels` used as the floor count: StreetForge /home/user/streetforge/streetforge2d.html:13730 (reads
//    `building:levels`, keeps it only when it is a positive integer) and :14177 / :14384 (`floors = levels || ...`).
//    City Pretty (workers/sources.ts:1167-1170, 1243) also reads the tag but states "levels -> height is NOT converted here:
//    that is an estimate".
//  - Height -> floors: StreetForge :14177 `Math.round(height / 3.4)` and :14384 `Math.max(1, Math.min(60, Math.round(height / 3.4)))`.
//    Height is in metres there (:13730 converts feet with /3.28084). The 3.4 m (about 11.2 ft) storey height has NO comment or
//    source in StreetForge; it is a drawing default, so a floor count from height is low confidence here.
//  - Living area / footprint: this is Everyspace's own existing rule (moved here unchanged from core/property-profile.js,
//    ratio > 4.5 refused, whole number clamped to 1..4). City Pretty has a related inference only the other way round
//    (footprint = living area / stories, roofAreaEngine.js:44, parcelHouseAuditor.js:84), not a floor count.
// Lot size: City Pretty and StreetForge only read an assessor or parcel-service value or the parcel polygon's area
// (StreetForge's `lotFrom` is 'parcel'/'estimate', :1322, :13391, :13409); core/geometry.js `polygonAreaSqft` already does that,
// so no lot-size function is added. Pure; inputs are never mutated; `now` is passed in.

import { sourced, unavailable } from './provenance.js';

const SOURCE = 'Everyspace floors estimate';
/** StreetForge streetforge2d.html:14384; no source or comment there. */
export const METRES_PER_STOREY = 3.4;
export const FEET_PER_METRE = 3.28084;
export const MAX_FLOORS_FROM_HEIGHT = 60;
export const MAX_FLOORS_FROM_RATIO = 4;
export const MAX_PLAUSIBLE_RATIO = 4.5;
const isNum = (/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/**
 * @param {{heightFt?:number|null, levelsTag?:number|string|null, livingAreaSqft?:number|null, footprintSqft?:number|null}} input
 * @param {{now?:string}} [ctx]
 * @returns {{ok:boolean, floors:import('./types.js').Sourced<number>, ratio?:number}}
 */
export function estimateFloors(input, ctx = {}) {
  const i = input ?? {};
  const at = typeof ctx.now === 'string' ? ctx.now : null;
  const lv = typeof i.levelsTag === 'string' ? parseInt(i.levelsTag, 10) : i.levelsTag;
  if (isNum(lv) && Number.isInteger(lv) && lv > 0) {
    return { ok: true, floors: sourced(lv, { tag: 'estimated', source: 'OpenStreetMap building:levels tag', confidence: 0.5, retrievedAt: at, method: 'building:levels tag on the mapped building', note: 'Volunteer-mapped; the owner should confirm.' }) };
  }
  if (isNum(i.heightFt) && i.heightFt > 0) {
    const n = Math.max(1, Math.min(MAX_FLOORS_FROM_HEIGHT, Math.round(i.heightFt / FEET_PER_METRE / METRES_PER_STOREY)));
    return { ok: true, floors: sourced(n, { tag: 'estimated', source: SOURCE, confidence: 0.3, retrievedAt: at, method: `building height ${i.heightFt} ft / ${METRES_PER_STOREY} m per storey, rounded (StreetForge rule)`, note: 'A typical storey height; real storeys vary (taller ground floors, attics).' }) };
  }
  const living = i.livingAreaSqft, fp = i.footprintSqft;
  if (isNum(living) && isNum(fp) && fp > 0) {
    const ratio = living / fp;
    if (ratio > MAX_PLAUSIBLE_RATIO) return { ok: false, ratio, floors: unavailable(`living area / footprint = ${r2(ratio)}, too high to estimate floors (footprint may be incomplete)`, SOURCE) };
    const n = Math.min(MAX_FLOORS_FROM_RATIO, Math.max(1, Math.round(ratio)));
    const ambiguous = Math.abs(ratio - Math.round(ratio)) > 0.35 || ratio < 0.7;
    return { ok: true, ratio, floors: sourced(n, { tag: 'estimated', source: SOURCE, confidence: ambiguous ? 0.15 : 0.25, retrievedAt: at, method: 'living area / main building footprint, rounded to a whole number in 1..4',
      note: `Ratio ${r2(ratio)}.${ambiguous ? ' Ratio is far from a whole number; low confidence.' : ''}` }) };
  }
  return { ok: false, floors: unavailable(`floors cannot be estimated: ${!isNum(living) ? 'no living area' : 'no main building footprint'}`, SOURCE) };
}

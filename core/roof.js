// @ts-check
// Roof surface area from a building footprint and a pitch. Ported from City Pretty (read-only reference):
//   /home/user/milessilverman/city-pretty/src/engines/roofAreaEngine.js
//     lines 10-28   getDefaultPitchRise (default pitch by state and build era)
//     lines 30-100  footprint choice, garage addition, eaves overhang
//     lines 102-120 pitch (rise per 12) -> slope multiplier, roof-shape multiplier, gross roof area
//   Tests that exercise it there: tests/unit/safetyRules.test.ts:17-21 (no inputs -> "not_recorded", 0 sq ft) and
//   tests/e2e/site.spec.ts:1907-1925 (unknown build year is not assumed: pitch 5.5 for null, 4.5 for 1960; a 1,800 sq ft
//   outline gives more than 1,800 sq ft). There is no unit test of the numeric result there.
//
// WHAT CITY PRETTY SAYS ABOUT ITS OWN CONSTANTS (roofAreaEngine.js:5-8): "Default pitches are a rule of thumb by state and
// build era, with no source. An 18 Nov 2026 edit credited them to 'NREL ResStock (NREL/TP-5500-75217)' and 'IRC Section
// R905'; no report with that number was found, and R905 sets only minimum slopes per roofing material ..., not typical
// pitches, so the credit was removed." Lines 14, 24: "(rule of thumb; no source)". The shape multipliers (1.01, 1.05, 1.08,
// 1.16) and the 18-inch eave overhang carry no source or comment at all. This module therefore never reports a default-pitch
// result as measured and keeps its confidence low.
//
// Differences from City Pretty (each one deliberate):
//  - City Pretty's solar, panel-count and re-roofing outputs (its lines 122-139) are NOT ported: they rest on assumed shares.
//  - Everyspace is scoped to Los Angeles County, so `stateCode` defaults to 'CA' (City Pretty's own default, line 11).
//  - An owner who says the roof is flat but gives no pitch gets rise 0.5:12, City Pretty's lower clamp (line 104); City Pretty
//    itself would keep the era pitch and only change the shape multiplier, which is inconsistent.
//  - A condo property returns unavailable (the roof is shared with the building). A multi-family building returns unavailable unless the owner gives a
//    roof type (flat, gable or hip); a flat one uses the flat shape factor with no pitch. (Everyspace guard.)
// Pure, dependency-free ES module; inputs are never mutated; no clock (`now` is passed in).

import { sourced, unavailable } from './provenance.js';

const SOURCE = 'Everyspace roof estimate (City Pretty roof-area method)';

/** roofAreaEngine.js:14-15 */
export const ARID_STATES = ['AZ', 'NV', 'NM'];
export const SNOW_RAIN_STATES = ['MN', 'WI', 'MI', 'NY', 'MA', 'VT', 'NH', 'ME', 'WA', 'OR'];
/** roofAreaEngine.js:17-27 (rise per 12 of run; every value "rule of thumb; no source"). */
export const DEFAULT_PITCH_RISE = Object.freeze({ arid: 3.5, snowPre1940: 8.0, snow: 7.0, pre1940: 7.5, y1945to1978: 4.5, other: 5.5 });
/** roofAreaEngine.js:40, 82, 86 */
export const MIN_FOOTPRINT_SQFT = 200;
export const MIN_LIVING_SQFT = 200;
export const GARAGE_ADDITION_SQFT = Object.freeze({ oneStory: 380, multiStory: 400 });
/** roofAreaEngine.js:91 (inches); 0 for an outline traced at the roof edge */
export const DEFAULT_OVERHANG_INCHES = 18;
/** roofAreaEngine.js:95-96: eaves are computed on a 1 : 1.4 rectangle with the footprint's area */
export const ASPECT = 1.4;
/** roofAreaEngine.js:104 pitch clamp */
export const PITCH_RISE_MIN = 0.5, PITCH_RISE_MAX = 18.0;
/** roofAreaEngine.js:112-116 */
export const SHAPE_MULTIPLIER = Object.freeze({ flat: 1.01, gable: 1.05, hip: 1.08, complex: 1.16 });

const isNum = (/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v);
const conf = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/**
 * roofAreaEngine.js:10-28. An unknown build year gives the neutral 5.5 (not the 1945-78 value).
 * @param {number|null|undefined} yearBuilt @param {string} [stateCode]
 */
export function defaultPitchRise(yearBuilt, stateCode = 'CA') {
  const st = String(stateCode || 'CA').toUpperCase();
  const y = isNum(yearBuilt) && yearBuilt > 0 ? yearBuilt : null;
  if (ARID_STATES.includes(st)) return { rise: DEFAULT_PITCH_RISE.arid, basis: `${st} (desert/arid state)` };
  if (SNOW_RAIN_STATES.includes(st)) return y && y < 1940 ? { rise: DEFAULT_PITCH_RISE.snowPre1940, basis: `${st} (snow/rain state), built before 1940` } : { rise: DEFAULT_PITCH_RISE.snow, basis: `${st} (snow/rain state)` };
  if (y && y < 1940) return { rise: DEFAULT_PITCH_RISE.pre1940, basis: `built ${y} (before 1940)` };
  if (y && y >= 1945 && y <= 1978) return { rise: DEFAULT_PITCH_RISE.y1945to1978, basis: `built ${y} (1945-1978)` };
  return { rise: DEFAULT_PITCH_RISE.other, basis: y ? `built ${y} (no era rule applies)` : 'build year unknown (no era rule applies)' };
}

/**
 * @param {{footprintSqft?:number|null, livingSqft?:number|null, yearBuilt?:number|null, propertyType?:string|null, stories?:number|null,
 *   pitchDegrees?:number|null, pitchRise?:number|null, roofType?:'flat'|'gable'|'hip'|'complex'|null, stateCode?:string, footprintIsOutline?:boolean,
 *   hasGarage?:boolean, garageSqft?:number|null, eavesOverhangInches?:number|null}} input
 *   `footprintIsOutline` (default true) says the footprint is a traced building outline, so eaves and the garage are already in it
 *   (City Pretty line 75: osm_building_outline / cadastral_outline).
 * @param {{now?:string}} [ctx] `now` becomes retrievedAt; time is never read from a clock here.
 */
export function estimateRoof(input, ctx = {}) {
  const i = input ?? {};
  const at = typeof ctx.now === 'string' ? ctx.now : null;
  const gone = (/** @type {string} */ why) => ({ ok: false, roof: unavailable(why, SOURCE) });
  // A condo owner has no roof of their own: the building's roof is shared (docs/condos-and-buildings.md).
  if (i.propertyType === 'condo') return gone("roof area not estimated for a condo property: shared with the building (the building footprint is not one unit's roof)");
  // A multi-family building is estimated ONLY when the owner has said what the roof is (flat, gable or hip): apartment roofs are not assumed flat.
  const ownerRoof = i.roofType === 'flat' || i.roofType === 'gable' || i.roofType === 'hip';
  const building = i.propertyType === 'multi_family';
  if (building && !ownerRoof) return gone('roof area for a multi-family building needs the roof type: tell us the roof type (flat, gable or hip); apartment-building roofs are not assumed to be flat or pitched');

  const stories = Math.max(1, Number(i.stories) || 1);
  const living = isNum(i.livingSqft) && i.livingSqft > 0 ? Math.max(MIN_LIVING_SQFT, i.livingSqft) : 0;
  let plan = 0, outline = false, from = '';
  if (isNum(i.footprintSqft) && i.footprintSqft > MIN_FOOTPRINT_SQFT) { plan = Math.round(i.footprintSqft); outline = i.footprintIsOutline !== false; from = outline ? 'building outline' : 'footprint figure'; }
  else if (living) { plan = Math.round(living / stories); from = `living area / ${stories} stor${stories === 1 ? 'y' : 'ies'}`; }
  else return gone('no building footprint (over 200 sq ft) and no living area to estimate a roof from');

  // garage (lines 77-88) and eaves (lines 90-98): only when the footprint is not a traced outline
  let garage = 0;
  if (i.hasGarage !== false) {
    if (isNum(i.garageSqft) && i.garageSqft > 150) garage = i.garageSqft;
    else if (!outline) garage = stories > 1 ? GARAGE_ADDITION_SQFT.multiStory : GARAGE_ADDITION_SQFT.oneStory;
  }
  const overhangIn = isNum(i.eavesOverhangInches) ? Math.max(0, i.eavesOverhangInches) : outline ? 0 : DEFAULT_OVERHANG_INCHES;
  const oh = overhangIn / 12;
  const w = Math.sqrt(plan / ASPECT), l = w * ASPECT;
  const eaves = Math.round(2 * (w + l) * oh + 4 * oh * oh);
  const planArea = plan + garage + eaves;

  // pitch (lines 102-109)
  /** @type {number} */ let rise; let pitchFrom; let ownerPitch = false;
  if (isNum(i.pitchRise)) { rise = i.pitchRise; pitchFrom = 'owner-supplied pitch'; ownerPitch = true; }
  else if (isNum(i.pitchDegrees)) { rise = 12 * Math.tan((i.pitchDegrees * Math.PI) / 180); pitchFrom = 'owner-supplied pitch'; ownerPitch = true; }
  else if (i.roofType === 'flat' && building) { rise = 0; pitchFrom = 'owner says the roof is flat (no pitch applied)'; ownerPitch = true; }
  else if (i.roofType === 'flat') { rise = PITCH_RISE_MIN; pitchFrom = 'owner says the roof is flat'; ownerPitch = true; }
  else { const d = defaultPitchRise(i.yearBuilt, i.stateCode); rise = d.rise; pitchFrom = `typical pitch for ${building ? 'houses (a house rule of thumb, not apartment buildings)' : 'homes'} ${d.basis}`; }
  if (!(building && rise === 0)) rise = Math.max(PITCH_RISE_MIN, Math.min(PITCH_RISE_MAX, rise));
  const slopeFactor = Number((Math.sqrt(144 + rise * rise) / 12).toFixed(4));
  const pitchDegrees = Number(((Math.atan(rise / 12) * 180) / Math.PI).toFixed(1));
  const shape = i.roofType && i.roofType in SHAPE_MULTIPLIER ? i.roofType : rise <= 2.0 ? 'flat' : 'gable';
  const shapeMultiplier = SHAPE_MULTIPLIER[/** @type {'flat'|'gable'|'hip'|'complex'} */ (shape)];
  const area = Math.round(planArea * slopeFactor * shapeMultiplier);

  const ownerShape = Boolean(i.roofType);
  // Honest confidence: the pitch default is an unsourced rule of thumb (City Pretty's own words); the eaves and shape
  // multipliers are unsourced as well. An outline-based estimate with an owner pitch is better, but still not a measurement.
  const c = ownerPitch ? (ownerShape ? 0.55 : 0.5) : 0.25;
  const method = `roof area = footprint (${from}${garage ? ' + garage' : ''}${eaves ? ' + eaves' : ''}) x slope factor ${slopeFactor} (pitch ${conf(rise)}:12, ${pitchFrom}) x ${shape}-roof factor ${shapeMultiplier}; method from City Pretty roofAreaEngine.js`;
  const note = ownerPitch
    ? 'Estimated from the building outline and the pitch you gave; the roof-shape factor is a planning default. Not a measured roof area.'
    : `The pitch is a typical value for homes of this kind (${pitchFrom}), not this roof's measured pitch; the source we borrowed it from calls it a rule of thumb with no published source. Give your roof pitch to improve this.`;
  const roof = sourced(area, { tag: 'estimated', source: SOURCE, confidence: c, retrievedAt: at, unit: 'sqft', method, note });
  return { ok: true, roof, planAreaSqft: planArea, footprintSqft: plan, garageSqft: garage, eavesSqft: eaves, overhangInches: overhangIn, pitchRise: conf(rise), pitchDegrees, pitchSource: pitchFrom, slopeFactor, roofShape: shape, shapeMultiplier };
}

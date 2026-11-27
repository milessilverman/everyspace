// The small adapter between the estimator page and what the property lookup says about condos and apartment buildings.
// Everything the page needs to know about that contract lives here (pure functions, no page state, nothing stored):
//   - reading a unit from typed address text ("... Apt 4", "#4", "Unit 4") and putting it back after a suggestion is chosen;
//   - the four things an owner can own here, and which one a profile says;
//   - the lines and questions each kind of owner sees (the core's own question lists are used when it exports them);
//   - per-unit figures of an earning option.
// If the core exports its own unit parser (parseUnit) it is the source of truth: the page asks it first (see useCoreParser).

/** What the owner can say they own here, in the order shown. */
export const OWN_CHOICES = [
  ['single_family', 'house', 'A house'],
  ['condo', 'condo', 'A condo or one unit in a building'],
  ['multi_family', 'building', 'A whole apartment building'],
  ['land', 'land', 'Land only'],
];
/** property_type value -> the view that kind of owner sees. */
export const VIEW_OF_TYPE = { single_family: 'house', condo: 'condo', multi_family: 'building', land: 'land' };
export const TYPE_OF_VIEW = { house: 'single_family', condo: 'condo', building: 'multi_family', land: 'land' };

// ---- units in an address --------------------------------------------------------------------------------------------
const UNIT_RE = /(?:^|[\s,])(?:(apt|apartment|unit|suite|ste|rm|room)(?:\.\s*|\s+)#?\s*([A-Za-z0-9][A-Za-z0-9-]{0,7})|#\s*([A-Za-z0-9][A-Za-z0-9-]{0,7}))(?=$|[\s,])/i;
const DESIGNATOR = { apt: 'Apt', apartment: 'Apt', unit: 'Unit', suite: 'Suite', ste: 'Ste', rm: 'Rm', room: 'Rm' };

let coreParser = null;
/** Hand the page the core's own unit parser, when the core has one: (text) => {address, unit} | null. */
export function useCoreParser(fn) { coreParser = typeof fn === 'function' ? fn : null; }

/**
 * Split typed text into the address without its unit and the unit.
 * @param {string} text
 * @returns {{base:string, unit:string|null, designator:string|null}} `designator` is the unit as it was written ("Apt 4", "#4")
 */
export function parseUnit(text) {
  const t = String(text ?? '');
  if (coreParser) {
    try {
      const r = coreParser(t);
      if (r && typeof r === 'object') {
        const unit = r.unit === null || r.unit === undefined || r.unit === '' ? null : String(r.unit);
        const base = typeof r.address === 'string' ? r.address : typeof r.base === 'string' ? r.base : t;
        const own = unit ? UNIT_RE.exec(t) : null; // the owner's own wording ("Apt 4", "#4") is what goes back after a suggestion
        const word = own && own[1] ? DESIGNATOR[own[1].toLowerCase()] : null;
        return { base: tidy(base), unit, designator: unit ? (r.designator ?? (own ? (word ? `${word} ${unit}` : `#${unit}`) : `Unit ${unit}`)) : null };
      }
    } catch { /* use the page's own reading */ }
  }
  const m = UNIT_RE.exec(t);
  if (!m) return { base: t, unit: null, designator: null };
  const word = m[1] ? m[1].toLowerCase() : null;
  const unit = (m[2] ?? m[3]).toUpperCase();
  const designator = word ? `${DESIGNATOR[word]} ${unit}` : `#${unit}`;
  const cut = t.slice(0, m.index) + (m[0].startsWith(',') ? ',' : '') + t.slice(m.index + m[0].length);
  return { base: tidy(cut), unit, designator };
}
function tidy(s) { return s.replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, ''); }
/** The typed text without its unit. */
export const stripUnit = (text) => parseUnit(text).base;
/** A suggestion with the owner's unit put back in the natural place: "123 Main St Apt 4, Los Angeles, CA". */
export function withUnit(suggestion, designator) {
  const s = String(suggestion ?? '');
  if (!designator || parseUnit(s).unit) return s;
  const i = s.indexOf(',');
  return i < 0 ? `${s} ${designator}` : `${s.slice(0, i)} ${designator}${s.slice(i)}`;
}
/** Same address, ignoring case, spaces and commas (to see that the owner typed the address that was suggested). */
export const sameAddress = (a, b) => String(a).toLowerCase().replace(/[\s,.]+/g, ' ').trim() === String(b).toLowerCase().replace(/[\s,.]+/g, ' ').trim();

// ---- what the lookup said --------------------------------------------------------------------------------------------
/**
 * The "which unit is yours?" answer of a lookup, or null.
 * @param {any} pj @returns {{units:Array<{unit:string,label:string}>, unitCount:number}|null}
 */
export function unitRequest(pj) {
  if (!pj || pj.needsUnit !== true) return null;
  const units = (Array.isArray(pj.units) ? pj.units : []).map((u) => (typeof u === 'string' ? { unit: u, label: u } : u))
    .filter((u) => u && u.unit !== undefined && u.unit !== null && String(u.unit) !== '').map((u) => ({ unit: String(u.unit), label: String(u.label ?? u.unit) }));
  const n = Number(pj.complex?.unitCount);
  return { units, unitCount: Number.isFinite(n) && n > 0 ? n : units.length };
}

/** Query options handed to the lookup, from the owner's answers; nothing that is unset. */
export function queryOptions(o) {
  const q = {};
  if (o.unit) q.unit = String(o.unit);
  if (o.ownsWholeBuilding) q.ownsWholeBuilding = true;
  if (o.ownerPropertyType) q.ownerPropertyType = o.ownerPropertyType;
  if (o.roofType) q.roofType = o.roofType;
  return q;
}

/** The view for a profile: the owner's choice first, then "whole building", then "a unit chosen", then what the lookup says; null when nobody knows. */
export function viewFor({ ownerType, wholeBuilding, unit, propertyType }) {
  if (ownerType && VIEW_OF_TYPE[ownerType]) return { view: VIEW_OF_TYPE[ownerType], guessed: false };
  if (wholeBuilding) return { view: 'building', guessed: false };
  if (unit) return { view: 'condo', guessed: false };
  if (propertyType && VIEW_OF_TYPE[propertyType]) return { view: VIEW_OF_TYPE[propertyType], guessed: true };
  return { view: null, guessed: false };
}

// ---- lines and questions ---------------------------------------------------------------------------------------------
/** The condo list, exactly these lines in this order. */
export const CONDO_FACTS = ['unit_label', 'living_area_sqft', 'bedrooms', 'bathrooms', 'year_built', 'remodeled_year', 'assigned_parking_spaces', 'storage_unit_present', 'balcony_present', 'hoa_allows_rentals'];
/** Lines added at the top of the building list. */
export const BUILDING_FACTS = ['units', 'units_available_to_rent', 'parking_spaces', 'laundry_room_present', 'roof_access_present', 'roof_type'];
/** The land list: lot and yard facts only. */
export const LAND_FACTS = ['lot_area_sqft', 'front_yard_sqft', 'back_yard_sqft', 'yard_area_sqft'];
export const BUILDING_TOTAL_LABELS = { living_area_sqft: 'Total living area', bedrooms: 'Bedrooms in the building', bathrooms: 'Bathrooms in the building' };
export const ROOF_TYPES = [['flat', 'Flat'], ['gable', 'Gable'], ['hip', 'Hip'], ['unsure', 'Not sure']];
export const HOA_CHOICES = [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']];
/** Fallback copies of the question lists (the core's CONDO_OWNER_KEYS / BUILDING_OWNER_KEYS win when it exports them). */
export const FALLBACK_QUESTIONS = {
  assigned_parking_spaces: { question: 'How many parking spaces come with your unit?', type: 'number' },
  storage_unit_present: { question: 'Do you have a storage unit?', type: 'yesno' },
  balcony_present: { question: 'Do you have a balcony or patio?', type: 'yesno' },
  hoa_allows_rentals: { question: 'Does your HOA allow rentals?', type: 'choice', choices: ['yes', 'no', 'unsure'] },
  units: { question: 'How many units are in the building?', type: 'number' },
  units_available_to_rent: { question: 'How many units could you offer this way?', type: 'number' },
  parking_spaces: { question: 'How many parking spaces does the building have?', type: 'number' },
  laundry_room_present: { question: 'Is there a laundry room?', type: 'yesno' },
  roof_access_present: { question: 'Is there roof access?', type: 'yesno' },
};
export const LINE_LABELS = {
  unit_label: 'Unit', assigned_parking_spaces: 'Assigned parking spaces', storage_unit_present: 'Storage unit', balcony_present: 'Balcony or patio',
  hoa_allows_rentals: 'Does your HOA allow rentals?', units: 'Number of units', units_available_to_rent: 'How many units could you offer this way?',
  parking_spaces: 'Parking spaces', laundry_room_present: 'Laundry room', roof_access_present: 'Roof access', roof_type: 'Roof type',
};
/** The questions for a view, merging the core's lists (when it has them) over the fallback copies. @param {any} core module namespace or null */
export function questionsFrom(core) {
  const out = { ...FALLBACK_QUESTIONS };
  for (const list of [core?.CONDO_OWNER_KEYS, core?.BUILDING_OWNER_KEYS]) {
    if (!Array.isArray(list)) continue;
    for (const q of list) if (q && typeof q.key === 'string' && typeof q.question === 'string') out[q.key] = { question: q.question, type: q.type ?? out[q.key]?.type ?? 'number', ...(q.choices ? { choices: q.choices } : {}) };
  }
  return out;
}

// ---- earnings --------------------------------------------------------------------------------------------------------
/** How many of a thing an option covers (units, parking spaces); 1 when the core does not say. */
export function quantityOf(o) { const q = Number(o?.quantity); return Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1; }
/** The word for what the quantity counts, from the option's unit ("space" -> "6 parking spaces", unit rentals -> "4 units"). */
export function quantityWords(o) {
  const q = quantityOf(o);
  const what = String(o?.quantityLabel ?? '').trim() || (/park|space|stall|garage|driveway/i.test(`${o?.id} ${o?.unit}`) ? 'parking space' : /storage/i.test(`${o?.id}`) ? 'storage space' : 'unit');
  return `${q} ${what}${q === 1 ? '' : 's'}`;
}
/**
 * One scenario's yearly net income per unit, in cents, or null. Reads the core's `perUnit` figures; a core that only has totals
 * gets total / quantity (the totals are quantity times the per-unit figure).
 * @param {any} e estimate from core/revenue.js @param {any} o @param {'conservative'|'baseline'|'optimistic'} scn
 */
export function perUnitYearCents(e, o, scn) {
  const pu = e?.perUnit;
  const v = pu?.[scn]?.noiCentsPerYear ?? pu?.scenarios?.[scn]?.noiCentsPerYear ?? e?.scenarios?.[scn]?.perUnitNoiCentsPerYear ?? e?.scenarios?.[scn]?.perUnit?.noiCentsPerYear;
  if (Number.isFinite(v)) return v;
  const t = e?.scenarios?.[scn]?.noiCentsPerYear;
  return Number.isFinite(t) ? Math.round(t / quantityOf(o)) : null;
}

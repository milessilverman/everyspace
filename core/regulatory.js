// @ts-check
// Regulatory feasibility from data rules (core/data/jurisdictions.js). Pure: no I/O, `now` injected, no mutation.
// Status comes from the MOST SPECIFIC level (city > county > state > generic) that has a rule with effect
// allow/restrict/prohibit for the category; inside that level prohibit > restrict > allow. 'require' rules add
// requirements but never decide status. Any unverified rule caps confidence at 0.3.
import { JURISDICTIONS } from './data/jurisdictions.js';
import { CATEGORIES } from './data/categories.js';

/** @typedef {import('./types.js').Feasibility} Feasibility */
/** @typedef {import('./types.js').PropertyProfile} PropertyProfile */
/** @typedef {import('./data/jurisdictions.js').JurisdictionRule} JurisdictionRule */

export const UNVERIFIED_CAP = 0.3;
const BASE_CONFIDENCE = 0.8;
const STALE_DAYS = 365;
export const NO_RULES_NOTE = 'No rules on file for this location; check with the city or county.';
export const NOT_COVERED_NOTE = 'Rules on file for this location do not cover this use; check with the city.';
export const UNVERIFIED_NOTE = 'Rule text has not been verified against the official source.';
export const NO_CITY_NOTE = 'The city could not be determined for this property, so city rules were not applied; check with the city.';

/** Trim, lower-case, collapse whitespace. @param {any} s */
const norm = (s) => (typeof s === 'string' ? s.trim().replace(/\s+/g, ' ').toLowerCase() : '');
/** County name without a trailing "County" / "Parish" / "Borough". @param {any} s */
const normCounty = (s) => norm(s).replace(/ (county|parish|borough)$/, '');
/** FIPS compared as a trimmed string. @param {any} s */
const normFips = (s) => (typeof s === 'string' || typeof s === 'number' ? String(s).trim() : '');

/**
 * Specificity of a rule for a location: 3 city, 2 county, 1 state, 0 generic, -1 no match.
 * County matches by FIPS when both sides carry one (a differing FIPS never matches), otherwise by normalised name.
 * A city-scoped rule never matches a location without a city.
 * @param {JurisdictionRule['jurisdiction']} rj
 * @param {any} loc
 */
function specificity(rj, loc) {
  if (!rj) return 0;
  const hasAny = rj.state || rj.county || rj.countyFips || rj.city;
  if (!hasAny) return 0;
  if (!loc) return -1;
  if (rj.state && norm(rj.state) !== norm(loc.state)) return -1;
  if (rj.county || rj.countyFips) {
    const rf = normFips(rj.countyFips), lf = normFips(loc.countyFips);
    if (rf && lf) { if (rf !== lf) return -1; }
    else if (rj.county) { if (normCounty(rj.county) === '' || normCounty(rj.county) !== normCounty(loc.county)) return -1; }
    else return -1;
  }
  if (rj.city && (norm(rj.city) === '' || norm(rj.city) !== norm(loc.city))) return -1;
  return rj.city ? 3 : (rj.county || rj.countyFips) ? 2 : 1;
}

/**
 * Would a city-scoped rule for this category apply in the location's state/county if the city were known?
 * @param {JurisdictionRule[]} rules @param {any} loc @param {string} key @param {string|undefined} group
 */
function cityRuleSkipped(rules, loc, key, group) {
  if (!loc || norm(loc.city) !== '') return false;
  return rules.some((r) => r.jurisdiction?.city && appliesToCategory(r, key, group)
    && specificity({ ...r.jurisdiction, city: undefined }, loc) > 0);
}

/**
 * @param {JurisdictionRule} rule
 * @param {string} key
 * @param {string|undefined} group
 */
function appliesToCategory(rule, key, group) {
  const k = rule.categoryKeys, g = rule.groups;
  if (!k && !g) return true;
  return !!(k && k.includes(key)) || !!(g && group && g.includes(group));
}

/** @param {JurisdictionRule} r @param {string} now */
function isVerified(r, now) {
  if (!r.verified || !r.verifiedAt) return false;
  const t = Date.parse(r.verifiedAt), n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return false;
  return (n - t) / 86400000 <= STALE_DAYS;
}

// ---- condo: the owner's HOA (docs/condos-and-buildings.md) -----------------------------------------------------------------------------------------
export const HOA_NO_SUMMARY = 'Your HOA does not allow this (you told us)';
export const HOA_CHECK_REQUIREMENT = "Check your HOA's rental rules";
/** An Everyspace checklist item, NOT a statement of law and not verified against any source. */
export const HOA_CHECK_RULE = Object.freeze({ ruleId: 'everyspace/checklist/hoa-rental-rules', summary: "Everyspace owner checklist: check your HOA's rental rules (a checklist item, not a legal rule).",
  effect: /** @type {const} */ ('require'), verified: false, sourceRef: 'Everyspace checklist item (not a legal rule)' });

/**
 * Does this use bring guests or renters into the unit? Read from the category's own data (strangers in the home, or the home interior as its resource).
 * @param {any} cat
 */
const bringsPeopleIn = (cat) => Boolean(cat && (cat.strangersInHome === true || (cat.resourceUse && cat.resourceUse.home_interior)));

/**
 * A condo owner's HOA answer (`hoa_allows_rentals`, owner-confirmed) applied on top of the rules: 'no' prohibits every use that brings guests or renters
 * into the unit; 'unsure' or no answer adds the checklist item "Check your HOA's rental rules"; 'yes' adds nothing. Only for property_type 'condo'.
 * @param {Feasibility} f @param {any} cat @param {PropertyProfile} profile @returns {Feasibility}
 */
function applyHoa(f, cat, profile) {
  const a = profile?.attributes ?? {};
  if (a.property_type?.value !== 'condo' || !bringsPeopleIn(cat)) return f;
  const h = a.hoa_allows_rentals;
  const answer = h && h.tag === 'owner-confirmed' && typeof h.value === 'string' ? h.value : null;
  if (answer === 'yes') return f;
  if (answer === 'no') {
    return { ...f, status: 'prohibited', confidence: 0.9,
      rules: [{ ruleId: 'owner/hoa-no-rentals', summary: HOA_NO_SUMMARY, effect: 'prohibit', verified: true, source: 'owner', sourceRef: 'Owner statement (hoa_allows_rentals = no)' }, ...f.rules] };
  }
  if (f.requirements.includes(HOA_CHECK_REQUIREMENT)) return f;
  return { ...f, rules: [...f.rules, { ...HOA_CHECK_RULE }], requirements: [...f.requirements, HOA_CHECK_REQUIREMENT] };
}

/**
 * @param {string} categoryKey
 * @param {PropertyProfile} profile
 * @param {{now:string, jurisdictions?:JurisdictionRule[], categories?:Array<{key:string, group:string}>}} opts
 * @returns {Feasibility}
 */
export function checkFeasibility(categoryKey, profile, { now, jurisdictions = JURISDICTIONS, categories = CATEGORIES }) {
  const f = checkFeasibilityRules(categoryKey, profile, { now, jurisdictions, categories });
  return applyHoa(f, categories.find((c) => c.key === categoryKey), profile);
}

/**
 * @param {string} categoryKey
 * @param {PropertyProfile} profile
 * @param {{now:string, jurisdictions:JurisdictionRule[], categories:Array<{key:string, group:string}>}} opts
 * @returns {Feasibility}
 */
function checkFeasibilityRules(categoryKey, profile, { now, jurisdictions, categories }) {
  const group = categories.find((c) => c.key === categoryKey)?.group;
  const attr = profile?.attributes?.jurisdiction;
  const loc = attr && attr.tag !== 'unavailable' ? attr.value : null;

  /** @type {Array<{rule:JurisdictionRule, level:number}>} */
  const matched = [];
  for (const rule of jurisdictions) {
    if (!appliesToCategory(rule, categoryKey, group)) continue;
    const level = specificity(rule.jurisdiction, loc);
    if (level >= 0) matched.push({ rule, level });
  }
  matched.sort((a, b) => b.level - a.level || (a.rule.id < b.rule.id ? -1 : 1));

  const requirements = [...new Set(matched.flatMap((m) => m.rule.requirements))];
  const rules = matched.map(({ rule }) => {
    /** @type {Feasibility['rules'][number]} */
    const o = { ruleId: rule.id, summary: rule.summary, effect: rule.effect, verified: isVerified(rule, now) };
    if (rule.sourceUrl) o.sourceUrl = rule.sourceUrl;
    return o;
  });

  const deciding = matched.filter((m) => m.rule.effect !== 'require');
  const location = matched.filter((m) => m.level > 0);
  const noCity = cityRuleSkipped(jurisdictions, loc, categoryKey, group);
  if (!loc || location.length === 0 || deciding.length === 0) {
    let note = !loc || location.length === 0 ? NO_RULES_NOTE : NOT_COVERED_NOTE;
    if (noCity) note = NO_CITY_NOTE;
    return { status: 'unknown', rules, confidence: 0, requirements, note };
  }
  const top = Math.max(...deciding.map((m) => m.level));
  const atTop = deciding.filter((m) => m.level === top).map((m) => m.rule.effect);
  const effect = atTop.includes('prohibit') ? 'prohibit' : atTop.includes('restrict') ? 'restrict' : 'allow';
  const status = effect === 'prohibit' ? 'prohibited' : effect === 'restrict' ? 'restricted' : 'feasible';

  const allVerified = matched.every((m) => isVerified(m.rule, now));
  const confidence = allVerified ? BASE_CONFIDENCE : Math.min(BASE_CONFIDENCE, UNVERIFIED_CAP);
  /** @type {Feasibility} */
  const out = { status, rules, confidence, requirements };
  const notes = [];
  if (!allVerified) notes.push(UNVERIFIED_NOTE);
  if (noCity) notes.push(NO_CITY_NOTE);
  if (notes.length) out.note = notes.join(' ');
  return out;
}

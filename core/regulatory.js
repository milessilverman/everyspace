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
const UNVERIFIED_NOTE = 'These rules are unverified (not yet checked against official sources); treat them as a checklist, not legal advice.';

const norm = (/** @type {any} */ s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

/**
 * Specificity of a rule for a location: 3 city, 2 county, 1 state, 0 generic, -1 no match.
 * @param {JurisdictionRule['jurisdiction']} rj
 * @param {any} loc
 */
function specificity(rj, loc) {
  if (!rj) return 0;
  const hasAny = rj.state || rj.county || rj.city;
  if (!hasAny) return 0;
  if (!loc) return -1;
  for (const f of /** @type {const} */ (['state', 'county', 'city'])) {
    if (rj[f] && norm(rj[f]) !== norm(loc[f])) return -1;
  }
  return rj.city ? 3 : rj.county ? 2 : 1;
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

/**
 * @param {string} categoryKey
 * @param {PropertyProfile} profile
 * @param {{now:string, jurisdictions?:JurisdictionRule[], categories?:Array<{key:string, group:string}>}} opts
 * @returns {Feasibility}
 */
export function checkFeasibility(categoryKey, profile, { now, jurisdictions = JURISDICTIONS, categories = CATEGORIES }) {
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
  if (!loc || location.length === 0 || deciding.length === 0) {
    const note = !loc || location.length === 0 ? NO_RULES_NOTE : 'Rules on file for this location do not decide this use; check with the city or county.';
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
  if (!allVerified) out.note = UNVERIFIED_NOTE;
  return out;
}

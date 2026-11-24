// @ts-check
// Opportunity identification: which ways could this property earn, and how honestly do we know it?
// Pure, deterministic (sorted by id), no mutation, `now` injected. Reads attributes defensively from
// profile.attributes[key] (a Sourced object or undefined); an attribute that is missing, 'unavailable' or null is
// UNKNOWN, never guessed. Unknown requirements produce no opportunity; missingEvidence() lists what to ask instead.
import { CATEGORIES, ATTRIBUTE_QUESTIONS } from './data/categories.js';
import { checkFeasibility } from './regulatory.js';

/** @typedef {import('./types.js').Opportunity} Opportunity */
/** @typedef {import('./types.js').PropertyProfile} PropertyProfile */
/** @typedef {import('./data/categories.js').CategoryDef} CategoryDef */
/** @typedef {import('./data/categories.js').Rule} Rule */
/** @typedef {'yes'|'no'|'unknown'} Tri */

/** @param {PropertyProfile} profile @param {string} key */
function read(profile, key) {
  const a = profile?.attributes?.[key];
  if (!a || a.tag === 'unavailable' || a.value === null || a.value === undefined) return null;
  return a;
}

/** Presence: non-null; numbers > 0; strings/arrays non-empty. @param {any} v */
function isPresent(v) {
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') return v.length > 0 && v !== 'unknown';
  if (Array.isArray(v)) return v.length > 0;
  return v !== null && v !== undefined;
}

/**
 * Three-valued evaluation of a rule. `used` = attribute keys of satisfied leaves; `missing` = unknown attribute keys
 * that block the decision.
 * @param {Rule} rule
 * @param {PropertyProfile} profile
 * @returns {{state:Tri, used:Set<string>, missing:Set<string>}}
 */
export function evaluateRule(rule, profile) {
  const used = new Set(), missing = new Set();
  if ('never' in rule) return { state: 'no', used, missing };
  if ('all' in rule || 'any' in rule) {
    const isAll = 'all' in rule;
    const kids = (isAll ? rule.all : rule.any).map((r) => evaluateRule(r, profile));
    const yes = kids.filter((k) => k.state === 'yes'), no = kids.filter((k) => k.state === 'no'), unk = kids.filter((k) => k.state === 'unknown');
    /** @type {Tri} */
    let state;
    if (isAll) state = no.length ? 'no' : unk.length ? 'unknown' : 'yes';
    else state = yes.length ? 'yes' : unk.length ? 'unknown' : 'no';
    if (state === 'yes') for (const k of yes) k.used.forEach((u) => used.add(u));
    if (state === 'unknown') for (const k of unk) k.missing.forEach((m) => missing.add(m));
    return { state, used, missing };
  }
  const a = read(profile, rule.attr);
  if (!a || a.value === 'unknown') return { state: 'unknown', used, missing: new Set([rule.attr]) };
  const v = a.value;
  let ok = true;
  if ('equals' in rule) ok = v === rule.equals;
  else if (rule.in) ok = rule.in.includes(v);
  else if (rule.notIn) ok = !rule.notIn.includes(v);
  else if (typeof rule.min === 'number') ok = typeof v === 'number' && v >= rule.min;
  else if ('includes' in rule) ok = Array.isArray(v) && v.includes(rule.includes);
  else ok = isPresent(v);
  if (ok) used.add(rule.attr);
  return { state: ok ? 'yes' : 'no', used, missing };
}

/**
 * Conflict map with symmetry applied (a lists b OR b lists a).
 * @param {CategoryDef[]} categories
 * @returns {Map<string, Set<string>>}
 */
function conflictMap(categories) {
  const m = new Map(categories.map((c) => [c.key, new Set(/** @type {string[]} */ ([]))]));
  for (const c of categories) for (const o of c.conflictsWith) {
    if (!m.has(o)) continue;
    m.get(c.key)?.add(o);
    m.get(o)?.add(c.key);
  }
  return m;
}

/**
 * @param {PropertyProfile} profile
 * @param {{now:string, categories?:CategoryDef[], jurisdictions?:import('./data/jurisdictions.js').JurisdictionRule[]}} opts
 * @returns {Opportunity[]}
 */
export function identifyOpportunities(profile, { now, categories = CATEGORIES, jurisdictions } = /** @type {any} */ ({})) {
  const hits = [];
  for (const cat of categories) {
    const r = evaluateRule(cat.requires, profile);
    if (r.state === 'yes') hits.push({ cat, evidence: [...r.used].sort() });
  }
  const present = new Set(hits.map((h) => h.cat.key));
  const conflicts = conflictMap(categories);

  /** @type {Opportunity[]} */
  const out = hits.map(({ cat, evidence }) => {
    let basis = cat.basisDefault;
    for (const o of cat.basisOverrides ?? []) {
      if (evaluateRule(o.when, profile).state === 'yes') { basis = o.basis; break; }
    }
    const confs = evidence.map((k) => read(profile, k)?.confidence ?? 0);
    const feasibility = checkFeasibility(cat.key, profile, { now, ...(jurisdictions ? { jurisdictions } : {}), categories });
    /** @type {string[]} */
    const notes = [];
    if (basis === 'permit') notes.push('Needs a permit or registration before it can start.');
    if (basis === 'construction') notes.push('Needs building work or a major investment first.');
    if (basis === 'setup') notes.push('Needs minor purchases or preparation first.');
    const est = evidence.filter((k) => read(profile, k)?.tag === 'estimated');
    if (est.length) notes.push(`Based on estimated values (${est.join(', ')}); confirm to improve accuracy.`);
    return {
      id: cat.key,
      categoryKey: cat.key,
      label: cat.label,
      basis,
      unit: cat.unit,
      evidence,
      evidenceConfidence: confs.length ? Math.min(...confs) : 0,
      feasibility,
      conflictsWith: [...(conflicts.get(cat.key) ?? [])].filter((k) => present.has(k)).sort(),
      resourceUse: { ...cat.resourceUse },
      effort: cat.effort,
      privacyImpact: cat.privacyImpact,
      strangersInHome: cat.strangersInHome,
      notes,
    };
  });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Categories that cannot be decided because an attribute is unknown, with what to ask the owner.
 * @param {PropertyProfile} profile
 * @param {{categories?:CategoryDef[]}} [opts]
 * @returns {Array<{categoryKey:string, label:string, needs:string[], question:string}>}
 */
export function missingEvidence(profile, { categories = CATEGORIES } = {}) {
  const out = [];
  for (const cat of categories) {
    const r = evaluateRule(cat.requires, profile);
    if (r.state !== 'unknown') continue;
    const needs = [...r.missing].sort();
    const question = needs.map((k) => ATTRIBUTE_QUESTIONS[/** @type {keyof typeof ATTRIBUTE_QUESTIONS} */ (k)] ?? `Can you tell us about ${k.replace(/_/g, ' ')}?`).join(' ');
    out.push({ categoryKey: cat.key, label: cat.label, needs, question });
  }
  return out.sort((a, b) => (a.categoryKey < b.categoryKey ? -1 : 1));
}

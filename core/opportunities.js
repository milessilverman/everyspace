// @ts-check
// Opportunity identification: which ways could this property earn, and how honestly do we know it?
// Pure, deterministic (sorted by id), no mutation, `now` injected. Reads attributes defensively from
// profile.attributes[key] (a Sourced object or undefined); an attribute that is missing, 'unavailable' or null is
// UNKNOWN, never guessed. Unknown requirements produce no opportunity; missingEvidence() lists what to ask instead.
//
// Evidence classes (core/data/categories.js `evidence.class`): 'auto' categories are emitted from real profile
// attributes; 'owner' categories only after the owner confirms them (attribute tag 'owner-confirmed'); investment
// ideas (something not built yet) only with includeInvestmentIdeas:true, basis construction, cost unknown.
// A yard or lot is never evidence of a sport court, pasture, hives, kitchen, RV pad or film location.
//
// SHARED RESOURCES (Everyspace modelling assumption, not a market fact): uses that occupy the same physical thing
// carry the same `resourceUse` key (home_interior, yard, pool, garage, roof, parking). Time-sharing is modelled
// as MUTUAL EXCLUSION, which is a simplification: in reality a yard could host different uses at different hours.
// Resources with a fixed capacity of 1 (home_interior, yard, pool, garage, roof) are also turned into pairwise
// conflictsWith here, so the optimizer cannot add them up even if the caller forgets resourceCapacity. `parking`
// has a variable capacity: pass defaultResourceCapacity(profile) as constraints.resourceCapacity.
// entire_home conflicts with everything inside or behind the home (private_room, backyard, pool, garage_storage,
// kitchen, ...), ASSUMING a whole-home guest has the whole property, garage included.
import { CATEGORIES, ATTRIBUTE_QUESTIONS } from './data/categories.js';
import { checkFeasibility } from './regulatory.js';

/** @typedef {import('./types.js').Opportunity} Opportunity */
/** @typedef {import('./types.js').PropertyProfile} PropertyProfile */
/** @typedef {import('./data/categories.js').CategoryDef} CategoryDef */
/** @typedef {import('./data/categories.js').Rule} Rule */
/** @typedef {'yes'|'no'|'unknown'} Tri */

/** Resources whose capacity is always 1 in defaultResourceCapacity, so sharing one is a hard conflict. */
const EXCLUSIVE_RESOURCES = ['home_interior', 'yard', 'pool', 'garage', 'roof'];
/** Boolean `*_present` style attributes that observe the asset itself (an estimate of them still shows the asset). */
const OBSERVED_ASSET_ATTRS = new Set(['pool_present', 'garage_present', 'adu_present', 'attic_present', 'basement_present', 'shed_present', 'waterfront_access']);

/**
 * Attribute keys the owner answers (outside the AttributeKey list in types.js; the profile accepts any string key).
 * @param {CategoryDef[]} [categories]
 * @returns {string[]} sorted, unique
 */
export function ownerAttributeKeys(categories = CATEGORIES) {
  return [...new Set(categories.flatMap((c) => c.evidence?.ownerKeys ?? []))].sort();
}
export const OWNER_ATTRIBUTE_KEYS = Object.freeze(ownerAttributeKeys());

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
  // ownerOnly: only an owner-confirmed value counts; anything else is "ask the owner".
  if (!a || a.value === 'unknown' || (rule.ownerOnly && a.tag !== 'owner-confirmed')) return { state: 'unknown', used, missing: new Set([rule.attr]) };
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
 * @param {{now:string, categories?:CategoryDef[], jurisdictions?:import('./data/jurisdictions.js').JurisdictionRule[], includeInvestmentIdeas?:boolean}} opts
 * @returns {Opportunity[]}
 */
export function identifyOpportunities(profile, { now, categories = CATEGORIES, jurisdictions, includeInvestmentIdeas = false } = /** @type {any} */ ({})) {
  /** @type {Array<{cat:CategoryDef, evidence:string[], idea:boolean}>} */
  const hits = [];
  for (const cat of categories) {
    const r = evaluateRule(cat.requires, profile);
    if (r.state === 'yes') { hits.push({ cat, evidence: [...r.used].sort(), idea: false }); continue; }
    const inv = cat.evidence?.investment;
    if (includeInvestmentIdeas && inv) {
      const ri = evaluateRule(inv.requires, profile);
      if (ri.state === 'yes') hits.push({ cat, evidence: [...ri.used].sort(), idea: true });
    }
  }
  const present = new Set(hits.map((h) => h.cat.key));
  const conflicts = conflictMap(categories);
  // Pairwise conflicts for resources with fixed capacity 1 (see header).
  for (const a of hits) for (const b of hits) {
    if (a.cat.key === b.cat.key) continue;
    if (EXCLUSIVE_RESOURCES.some((r) => a.cat.resourceUse?.[r] && b.cat.resourceUse?.[r])) conflicts.get(a.cat.key)?.add(b.cat.key);
  }

  /** @type {Opportunity[]} */
  const out = hits.map(({ cat, evidence, idea }) => {
    let basis = cat.basisDefault;
    if (idea) basis = /** @type {NonNullable<CategoryDef['evidence']['investment']>} */ (cat.evidence.investment).basis;
    else for (const o of cat.basisOverrides ?? []) {
      if (evaluateRule(o.when, profile).state === 'yes') { basis = o.basis; break; }
    }
    /** @type {string[]} */
    const notes = [];
    // 'existing' needs evidence of the asset itself: measured, owner-confirmed, or an estimate of an observed asset.
    if (basis === 'existing' && !idea) {
      const assetEv = evidence.filter((k) => k !== 'property_type');
      const solid = (/** @type {string} */ k) => { const t = read(profile, k)?.tag; return t === 'measured' || t === 'owner-confirmed' || (t === 'estimated' && OBSERVED_ASSET_ATTRS.has(k)); };
      if (assetEv.length && !assetEv.some(solid)) {
        basis = 'setup';
        notes.push('The asset is only estimated from area or counts, not observed; confirm it before treating it as ready now.');
      }
    }
    if (idea) notes.push('Investment idea: this does not exist on the property yet. Cost and feasibility are unknown until checked.');
    const confs = evidence.map((k) => read(profile, k)?.confidence ?? 0);
    const feasibility = checkFeasibility(cat.key, profile, { now, ...(jurisdictions ? { jurisdictions } : {}), categories });
    if (basis === 'permit') notes.push('Needs a permit or registration before it can start.');
    if (basis === 'construction' && !idea) notes.push('Needs building work or a major investment first.');
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
 * Resource capacities for OwnerConstraints.resourceCapacity. Fixed 1 for the single-instance resources; parking is the
 * owner-confirmed or measured parking_spaces, else 1 if any driveway/parking attribute is available, else 0.
 * @param {PropertyProfile} profile
 * @returns {Record<string, number>}
 */
export function defaultResourceCapacity(profile) {
  const spaces = read(profile, 'parking_spaces');
  let parking = 0;
  if (spaces && (spaces.tag === 'owner-confirmed' || spaces.tag === 'measured') && typeof spaces.value === 'number' && Number.isFinite(spaces.value)) {
    parking = Math.max(0, Math.floor(spaces.value));
  } else if (spaces || read(profile, 'driveway_area_sqft')) {
    parking = 1;
  }
  return { home_interior: 1, yard: 1, pool: 1, garage: 1, roof: 1, parking };
}

/**
 * What to ask the owner: every 'owner' category not yet answered (with its own question) and every 'auto' category
 * that cannot be decided because an attribute is unknown. Categories already ruled out (e.g. by property type) are not asked.
 * @param {PropertyProfile} profile
 * @param {{categories?:CategoryDef[]}} [opts]
 * @returns {Array<{categoryKey:string, label:string, needs:string[], question:string, evidenceClass:string}>}
 */
export function missingEvidence(profile, { categories = CATEGORIES } = {}) {
  const out = [];
  for (const cat of categories) {
    const r = evaluateRule(cat.requires, profile);
    if (r.state !== 'unknown') continue;
    const needs = [...r.missing].sort();
    const ownerKeys = cat.evidence?.ownerKeys ?? [];
    const generic = (/** @type {string} */ k) => ATTRIBUTE_QUESTIONS[/** @type {keyof typeof ATTRIBUTE_QUESTIONS} */ (k)] ?? `Can you tell us about ${k.replace(/_/g, ' ')}?`;
    const question = needs.map((k) => (ownerKeys.includes(k) && cat.evidence.question ? cat.evidence.question : generic(k))).filter((q, i, a) => a.indexOf(q) === i).join(' ');
    out.push({ categoryKey: cat.key, label: cat.label, needs, question, evidenceClass: cat.evidence?.class ?? 'auto' });
  }
  return out.sort((a, b) => (a.categoryKey < b.categoryKey ? -1 : 1));
}

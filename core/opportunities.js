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
import { CATEGORIES, ATTRIBUTE_QUESTIONS, CONDO_OWNER_KEYS, BUILDING_OWNER_KEYS, QUESTION_DEFS, ASK_CUTOFFS, GEAR_CHOICES, SIZE_INPUTS, CATEGORY_SIZE_KEYS } from './data/categories.js';
import { checkFeasibility } from './regulatory.js';

/** @typedef {import('./types.js').Opportunity} Opportunity */
/** @typedef {import('./types.js').PropertyProfile} PropertyProfile */
/** @typedef {import('./data/categories.js').CategoryDef} CategoryDef */
/** @typedef {import('./data/categories.js').Rule} Rule */
/** @typedef {'yes'|'no'|'unknown'} Tri */

export { CONDO_OWNER_KEYS, BUILDING_OWNER_KEYS, QUESTION_DEFS, ASK_CUTOFFS, GEAR_CHOICES, SIZE_INPUTS };
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
  const sizes = QUESTION_DEFS.filter((d) => d.size).map((d) => /** @type {string} */ (d.size?.key));
  return [...new Set([...categories.flatMap((c) => c.evidence?.ownerKeys ?? []), ...sizes])].sort();
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
  // ownerOnly / ownerConfirmed: only an owner-confirmed value counts; anything else is "ask the owner".
  if (!a || a.value === 'unknown' || ((rule.ownerOnly || rule.ownerConfirmed) && a.tag !== 'owner-confirmed')) return { state: 'unknown', used, missing: new Set([rule.attr]) };
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
 * How many identical units an opportunity is offered as, from what the OWNER said (an assumed quantity is never used):
 *  - apartment_unit of a multi-family building: units_available_to_rent (0 -> not offered; more than `units` -> `units`); unanswered -> `needed`, no quantity;
 *  - parking_spot of a multi-family building: parking_spaces when owner-confirmed; of a condo: assigned_parking_spaces (already required by the rule).
 * @param {string} key @param {PropertyProfile} profile
 * @returns {{quantity?:number, needed?:{key:string, question:string}, drop?:boolean, note?:string}}
 */
function quantityFor(key, profile) {
  const type = read(profile, 'property_type')?.value;
  const owner = (/** @type {string} */ k) => { const a = read(profile, k); return a && a.tag === 'owner-confirmed' && typeof a.value === 'number' && Number.isFinite(a.value) ? Math.floor(a.value) : null; };
  if (key === 'apartment_unit' && type === 'multi_family') {
    const n = owner('units_available_to_rent');
    if (n === null) return { needed: { key: 'units_available_to_rent', question: ATTRIBUTE_QUESTIONS.units_available_to_rent }, note: 'Tell us how many units you could offer this way; no number is assumed.' };
    if (n < 1) return { drop: true };
    const u = read(profile, 'units')?.value;
    const total = typeof u === 'number' && Number.isFinite(u) ? Math.floor(u) : null;
    return total !== null && n > total ? { quantity: total, note: `You said ${n} units; the building has ${total}, so ${total} is used.` } : { quantity: n };
  }
  if (key === 'parking_spot' && type === 'multi_family') { const n = owner('parking_spaces'); return n !== null && n >= 1 ? { quantity: n } : {}; }
  if (key === 'parking_spot' && type === 'condo') { const n = owner('assigned_parking_spaces'); return n !== null && n >= 1 ? { quantity: n } : {}; }
  return {};
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
  const out = /** @type {Opportunity[]} */ (hits.map(({ cat, evidence, idea }) => {
    const qf = idea ? {} : quantityFor(cat.key, profile);
    if (qf.drop) return null;
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
    if (qf.note) notes.push(qf.note);
    // a size the owner gave for this kind of space: kept and shown, but the estimate has no size-dependent input, so say so (never invent an effect)
    for (const sk of CATEGORY_SIZE_KEYS[cat.key] ?? []) {
      const sz = read(profile, sk);
      if (sz && sz.tag === 'owner-confirmed' && typeof sz.value === 'number' && !SIZE_INPUTS[cat.key]) notes.push(`You told us about ${Math.round(sz.value).toLocaleString('en-US')} sq ft. The size is not yet used in this estimate.`);
    }
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
      ...(qf.quantity !== undefined ? { quantity: qf.quantity } : {}),
      ...(qf.needed ? { quantityNeeded: qf.needed } : {}),
    };
  }).filter((o) => o !== null));
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
  const type = read(profile, 'property_type')?.value;
  let parking = 0;
  if (type === 'condo') {
    // a condo owner has only the spaces assigned to the unit, as the owner confirmed (never a driveway or a guess)
    const a = read(profile, 'assigned_parking_spaces');
    if (a && a.tag === 'owner-confirmed' && typeof a.value === 'number' && Number.isFinite(a.value)) parking = Math.max(0, Math.floor(a.value));
  } else if (spaces && (spaces.tag === 'owner-confirmed' || spaces.tag === 'measured') && typeof spaces.value === 'number' && Number.isFinite(spaces.value)) {
    parking = Math.max(0, Math.floor(spaces.value));
  } else if (spaces || read(profile, 'driveway_area_sqft')) {
    parking = 1;
  }
  // a multi-family building has as many dwellings as units (apartment_unit uses `quantity` of them); a house or a condo has one
  const u = read(profile, 'units')?.value;
  const dwellings = type === 'multi_family' && typeof u === 'number' && Number.isFinite(u) && u >= 2 ? Math.floor(u) : 1;
  return { home_interior: dwellings, yard: 1, pool: 1, garage: 1, roof: 1, parking };
}

/**
 * What to ask the owner: every 'owner' category not yet answered (with its own question) and every 'auto' category
 * that cannot be decided because an attribute is unknown. Categories already ruled out (e.g. by property type) are not asked.
 * @param {PropertyProfile} profile
 * @param {{categories?:CategoryDef[]}} [opts]
 * @returns {Array<{categoryKey:string, label:string, needs:string[], question:string, evidenceClass:string}>}
 */
export function missingEvidence(profile, { categories = CATEGORIES, asked = [] } = {}) {
  const out = [];
  const skip = new Set(asked);
  for (const cat of categories) {
    const r = evaluateRule(cat.requires, profile);
    if (r.state !== 'unknown') continue;
    // a key the owner already answered "I don't know" is not asked again
    const needs = [...r.missing].filter((k) => !skip.has(k)).sort();
    if (!needs.length) continue;
    const ownerKeys = cat.evidence?.ownerKeys ?? [];
    const generic = (/** @type {string} */ k) => ATTRIBUTE_QUESTIONS[/** @type {keyof typeof ATTRIBUTE_QUESTIONS} */ (k)] ?? `Can you tell us about ${k.replace(/_/g, ' ')}?`;
    // every key has its OWN question (a basement and a shed are two questions, never one); the category's question only when it has a single key
    const own = (/** @type {string} */ k) => cat.evidence?.questions?.[k] ?? QUESTION_DEFS.find((d) => d.key === k)?.question ?? [...CONDO_OWNER_KEYS, ...BUILDING_OWNER_KEYS].find((x) => x.key === k)?.question;
    const question = needs.map((k) => (own(k) ?? (ownerKeys.length === 1 && ownerKeys.includes(k) && cat.evidence.question ? cat.evidence.question : generic(k)))).filter((q, i, a) => a.indexOf(q) === i).join(' ');
    out.push({ categoryKey: cat.key, label: cat.label, needs, question, evidenceClass: cat.evidence?.class ?? 'auto' });
  }
  return out.sort((a, b) => (a.categoryKey < b.categoryKey ? -1 : 1));
}

// ---------------------------------------------------------------------------------------------------------------------
// The guided owner questions
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Is a question worth asking for this profile? Pure. See QuestionDef.askWhen in core/data/categories.js for the rule language.
 * An attribute the profile does not have is never "true" and a lot size that is not known is never "large".
 * @param {any} rule @param {PropertyProfile} profile @returns {boolean}
 */
export function evaluateAskWhen(rule, profile) {
  if (rule === undefined || rule === null) return true;
  if (rule.all) return rule.all.every((/** @type {any} */ r) => evaluateAskWhen(r, profile));
  if (rule.any) return rule.any.some((/** @type {any} */ r) => evaluateAskWhen(r, profile));
  if ('not' in rule) return !evaluateAskWhen(rule.not, profile);
  if (rule.never) return false;
  if (rule.propertyType) { const t = read(profile, 'property_type')?.value; return typeof t === 'string' && rule.propertyType.includes(t); }
  if (rule.lotAtLeast) {
    const lot = read(profile, 'lot_area_sqft')?.value;
    const min = /** @type {Record<string, number>} */ (ASK_CUTOFFS)[rule.lotAtLeast];
    return typeof lot === 'number' && Number.isFinite(lot) && typeof min === 'number' && lot >= min;
  }
  if (rule.attrTrue) return read(profile, rule.attrTrue)?.value === true;
  if (rule.attrKnown) return read(profile, rule.attrKnown) !== null;
  if (rule.attrUnknown) return read(profile, rule.attrUnknown) === null;
  return false;
}

/** Attribute keys whose answer could still decide this rule (leaves already ruled out, by an answer or by the property type, do not count). @param {Rule} rule @param {PropertyProfile} profile @returns {Set<string>} */
function reach(rule, profile) {
  if ('never' in rule) return new Set();
  if ('all' in rule || 'any' in rule) {
    const isAll = 'all' in rule;
    const kids = isAll ? rule.all : rule.any;
    if (isAll && kids.some((k) => evaluateRule(k, profile).state === 'no')) return new Set();
    const out = new Set();
    for (const k of kids) for (const x of reach(k, profile)) out.add(x);
    return out;
  }
  return evaluateRule(rule, profile).state === 'no' ? new Set() : new Set([rule.attr]);
}

/**
 * @typedef {{key:string, question:string, type:'yesno'|'number'|'choice'|'gear', unit?:string, choices?:Array<{value:string,label:string}>, unknownValue?:string, parent?:string, order:number, hold:string}} OwnerQuestion
 */
/**
 * The owner questions for this profile, in the order to ask them: what is relevant to what the owner owns and could still change an option
 * (`ask`), what is relevant but not by default (`lessCommon`: shown only when the owner asks for them), what they already answered
 * (`answered`) and what they said "I don't know" to (`unknown`, never asked again).
 * Nothing is asked until the property type is known. A Yes to a space that has a size is followed by its own "about how big" question.
 * @param {PropertyProfile} profile
 * @param {{asked?:string[], categories?:CategoryDef[]}} [opts] asked: keys answered "I don't know" this visit
 * @returns {{ask:OwnerQuestion[], lessCommon:OwnerQuestion[], answered:Array<OwnerQuestion & {value:any}>, unknown:OwnerQuestion[]}}
 */
export function ownerQuestions(profile, { asked = [], categories = CATEGORIES } = {}) {
  const out = { ask: [], lessCommon: [], answered: [], unknown: [] };
  const ptype = read(profile, 'property_type')?.value;
  if (typeof ptype !== 'string' || ptype === 'unknown') return out;
  const dk = new Set(asked);
  const reachable = new Set();
  for (const c of categories) if (c.evidence?.class !== 'none') for (const k of reach(c.requires, profile)) reachable.add(k);
  const seen = new Set();
  /** @param {any} d @param {string} key @param {string} question @param {string} [parent] @param {number} order */
  const q = (d, key, question, parent, order) => ({ key, question: d.questionFor?.[ptype] ?? question, type: parent ? 'number' : d.type, ...(parent ? { unit: 'sq ft' } : d.unit ? { unit: d.unit } : {}), ...(d.choices && !parent ? { choices: d.choices } : {}), ...(d.unknownValue && !parent ? { unknownValue: d.unknownValue } : {}), ...(parent ? { parent } : {}), order, hold: d.hold });
  for (const d of QUESTION_DEFS) {
    if (seen.has(d.key)) continue;
    const relevant = d.types ? d.types.includes(ptype) : reachable.has(d.key);
    if (d.types && !relevant) continue; // another definition of the same key may be the one for this property type
    seen.add(d.key);
    const attr = read(profile, d.key);
    const mine = q(d, d.key, d.question, undefined, d.order);
    // the size follow-up of a space that is there (answered Yes now, or known from the picture) and has no size yet
    /** @type {OwnerQuestion|null} */
    let follow = null;
    if (d.size && attr && attr.value === true && (relevant || attr.tag === 'owner-confirmed')) {
      const sz = read(profile, d.size.key);
      follow = q(d, d.size.key, d.size.question, d.key, d.order + 0.5);
      if (sz) { if (sz.tag === 'owner-confirmed') out.answered.push({ ...follow, value: sz.value }); follow = null; }
    }
    const answeredHere = attr?.tag === 'owner-confirmed';
    if (answeredHere) out.answered.push({ ...mine, value: attr.value });
    else if (!attr && dk.has(d.key)) out.unknown.push(mine);
    else if (!attr && (relevant)) (evaluateAskWhen(d.askWhen, profile) ? out.ask : out.lessCommon).push(mine);
    if (follow) (dk.has(follow.key) ? out.unknown : out.ask).push(follow);
  }
  const by = (/** @type {{order:number}} */ a, /** @type {{order:number}} */ b) => a.order - b.order;
  for (const k of ['ask', 'lessCommon', 'answered', 'unknown']) /** @type {any} */ (out)[k].sort(by);
  return out;
}

/**
 * Options that wait for an answer the owner gave as "I don't know": one plain line per question, with what it would unlock.
 * @param {PropertyProfile} profile @param {string[]} asked keys answered "I don't know"
 * @param {{categories?:CategoryDef[]}} [opts]
 * @returns {Array<{key:string, line:string, labels:string[]}>}
 */
export function heldBack(profile, asked, { categories = CATEGORIES } = {}) {
  const dk = new Set(asked);
  /** @type {Map<string,{key:string, line:string, labels:string[]}>} */
  const out = new Map();
  if (!dk.size) return [];
  for (const cat of categories) {
    if (cat.evidence?.class === 'none') continue;
    const r = evaluateRule(cat.requires, profile);
    if (r.state !== 'unknown') continue;
    for (const k of [...r.missing].sort()) {
      if (!dk.has(k)) continue;
      const d = QUESTION_DEFS.find((x) => x.key === k);
      if (!d) continue;
      const e = out.get(k) ?? { key: k, line: d.hold, labels: [] };
      e.labels.push(cat.label);
      out.set(k, e);
    }
  }
  return [...out.values()].sort((a, b) => (QUESTION_DEFS.find((x) => x.key === a.key)?.order ?? 0) - (QUESTION_DEFS.find((x) => x.key === b.key)?.order ?? 0));
}

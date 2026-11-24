// @ts-check
// Deterministic revenue model (docs/revenue-method.md §2-§6). Pure functions: no I/O, no clock, no randomness.
// Money is integer cents. Rounding: `roundCents` = half away from zero, with a tiny tolerance so that binary
// floating-point noise (e.g. 15299.999999999998) does not move a value across a half-cent boundary.

import { defaultPrice, defaultVolume, DEFAULT_SOURCE } from './data/assumptions.js';
import { defaultChannelFor, FEE_CONFIDENCE, FEE_SOURCE } from './data/platform-fees.js';
import { SPREAD_SETS, SPREAD_SOURCE, SCENARIO_NAMES } from './data/scenarios.js';

/** @typedef {import('./types.js').Opportunity} Opportunity */
/** @typedef {import('./types.js').PropertyProfile} PropertyProfile */
/** @typedef {import('./types.js').EstimateInputs} EstimateInputs */
/** @typedef {import('./types.js').ScenarioResult} ScenarioResult */
/** @typedef {import('./types.js').ScenarioName} ScenarioName */
/** @typedef {import('./types.js').OpportunityEstimate} OpportunityEstimate */
/** @typedef {import('./types.js').ConfidenceLabel} ConfidenceLabel */
/** @template T @typedef {import('./types.js').Sourced<T>} Sourced */

/** @type {ReadonlyArray<keyof EstimateInputs>} */
export const INPUT_KEYS = Object.freeze([
  'priceCents', 'unitsPerMonth', 'capacityUnitsPerMonth', 'bookingsPerMonth', 'platformFeeRate',
  'cleaningCentsPerBooking', 'utilitiesCentsPerMonth', 'insuranceCentsPerMonth', 'taxRate', 'permitCentsPerYear',
  'upfrontCents', 'seasonality',
]);
/** Without these no number is shown (price/volume per §5; capacity and seasonality are structural). */
const REQUIRED_KEYS = Object.freeze(['priceCents', 'unitsPerMonth', 'capacityUnitsPerMonth', 'seasonality']);
/** Cost inputs: when unavailable they are excluded from the math and cap confidence at 0.3 (§5). */
const COST_KEYS = Object.freeze([
  'bookingsPerMonth', 'platformFeeRate', 'cleaningCentsPerBooking', 'utilitiesCentsPerMonth',
  'insuranceCentsPerMonth', 'taxRate', 'permitCentsPerYear', 'upfrontCents',
]);
const RATE_KEYS = Object.freeze(['platformFeeRate', 'taxRate']);
const TAGS = Object.freeze(['measured', 'estimated', 'owner-confirmed', 'unavailable']);

export const DAYS_PER_MONTH = 30.4; // docs/revenue-method.md §2 (calendar arithmetic)
export const MISSING_COST_CAP = 0.3; // §5
export const REGULATORY_CAP = 0.3; // §5
export const DEFAULT_INPUT_CAP = 0.6; // §6: "medium" at most while a revenue-driving input is a planning default
export const OWNER_CONFIDENCE = 0.9; // §2
export const SEASONALITY_CONFIDENCE = 0.1; // §2
export const UPFRONT_EXISTING_CONFIDENCE = 0.2;

/** Capacity in billable units per month for each DurationUnit (pure calendar arithmetic). */
const CAPACITY = Object.freeze({
  night: { value: DAYS_PER_MONTH, tag: 'measured', method: '30.4 nights a month' },
  day: { value: DAYS_PER_MONTH, tag: 'measured', method: '30.4 days a month' },
  week: { value: DAYS_PER_MONTH / 7, tag: 'measured', method: '30.4 days / 7 weeks a month' },
  month: { value: 1, tag: 'measured', method: '1 month a month' },
  hour: { value: 24 * DAYS_PER_MONTH, tag: 'estimated', method: '24 hours x 30.4 days (physical maximum; set your real opening hours)' },
});

// ---------- small private helpers ----------

/**
 * Round to an integer, half away from zero, tolerant of float noise.
 * @param {number} x
 */
export function roundCents(x) {
  const a = Math.abs(x);
  const r = Math.floor(a + 0.5 + 1e-9 + a * 1e-12);
  return r === 0 ? 0 : Math.sign(x) * r;
}

/** @param {number} x */
const round1 = (x) => roundCents(x * 10) / 10;

/**
 * @template T
 * @param {T} value @param {string|undefined} unit @param {Partial<Sourced<T>>} meta
 * @returns {Sourced<T>}
 */
function mk(value, unit, meta) {
  /** @type {Sourced<T>} */
  const s = { value, tag: meta.tag ?? 'estimated', source: meta.source ?? DEFAULT_SOURCE, retrievedAt: meta.retrievedAt ?? null, confidence: meta.confidence ?? 0 };
  if (unit) s.unit = unit;
  if (meta.method) s.method = meta.method;
  if (meta.note) s.note = meta.note;
  return s;
}

/** @param {string} reason @param {string} [unit] @returns {Sourced<any>} */
function unavailableInput(reason, unit) {
  return mk(null, unit, { tag: 'unavailable', source: 'none', confidence: 0, note: reason });
}

/** @template T @param {Sourced<T>} s @returns {Sourced<T>} */
function cloneSourced(s) {
  const c = { ...s };
  if (Array.isArray(s.value)) c.value = /** @type {any} */ ([...s.value]);
  return c;
}

/** @param {number} n @returns {ConfidenceLabel} */
export function labelFor(n) { return n >= 0.75 ? 'high' : n >= 0.4 ? 'medium' : 'low'; }

/** @param {object} o @param {string} k */
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- defaults ----------

/**
 * Default inputs for one opportunity. Every field is a Sourced value; anything without a recorded default is
 * 'unavailable'. `profile` is accepted for the pinned interface; no profile attribute is a revenue input today.
 * @param {Opportunity} opportunity
 * @param {PropertyProfile} [_profile]
 * @param {{jurisdictionDefaults?: {taxRate?: Sourced<number>, permitCentsPerYear?: Sourced<number>}}} [opts]
 * @returns {EstimateInputs}
 */
export function defaultInputs(opportunity, _profile, opts = {}) {
  if (!opportunity || typeof opportunity.categoryKey !== 'string' || typeof opportunity.unit !== 'string') {
    throw new Error('defaultInputs: opportunity with categoryKey and unit is required');
  }
  const { categoryKey: cat, unit } = opportunity;
  const cap = own(CAPACITY, unit) ? CAPACITY[/** @type {keyof typeof CAPACITY} */ (unit)] : null;

  const p = defaultPrice(cat, unit);
  const priceCents = p
    ? mk(p.valueCents, 'cents', { confidence: p.confidence, method: `${p.method} (${p.sourceRef})`, note: 'Planning default, not market data' })
    : unavailableInput(`No default price for ${cat} per ${unit}`, 'cents');

  const v = defaultVolume(cat, unit);
  let unitsPerMonth;
  if (v && v.kind === 'occupancy' && cap) {
    unitsPerMonth = mk(v.value * cap.value, unit, {
      confidence: 0.15,
      method: `${v.value * 100}% of the time rented x ${cap.method} (${v.sourceRef})`,
      note: 'Planning default, not market data',
    });
  } else if (v && v.kind === 'units') {
    unitsPerMonth = mk(v.value, unit, { confidence: 0.15, method: `${v.value} ${unit}s a month (${v.sourceRef})`, note: 'Planning default, not market data' });
  } else {
    unitsPerMonth = unavailableInput(`No default volume for ${cat} per ${unit}`, unit);
  }

  const capacityUnitsPerMonth = cap
    ? mk(cap.value, unit, {
      tag: /** @type {any} */ (cap.tag),
      source: 'Calendar arithmetic (docs/revenue-method.md §2)',
      confidence: cap.tag === 'measured' ? 0.9 : 0.2,
      method: cap.method,
    })
    : unavailableInput(`Unknown unit ${unit}`, unit);

  const ch = defaultChannelFor(cat, unit);
  const platformFeeRate = ch
    ? mk(ch.fee.hostFeeRate, 'fraction', {
      tag: ch.fee.verified ? 'measured' : 'estimated',
      source: FEE_SOURCE,
      confidence: FEE_CONFIDENCE,
      method: `${ch.fee.name} host fee (${ch.fee.sourceRef}); default channel from ${ch.ruleRef}; verified:${ch.fee.verified}`,
      note: ch.fee.perBookingFeeCents
        ? `Per-booking fee of ${ch.fee.perBookingFeeCents} cents is not included`
        : (ch.fee.verified ? 'Fee from the platform table' : 'Fee is an unverified estimate'),
    })
    : unavailableInput(`No default listing site recorded for ${cat} per ${unit}`, 'fraction');

  const jd = opts.jurisdictionDefaults ?? {};
  const taxRate = jd.taxRate ? cloneSourced(jd.taxRate) : unavailableInput('No occupancy/sales tax default for this jurisdiction', 'fraction');
  const permitCentsPerYear = jd.permitCentsPerYear ? cloneSourced(jd.permitCentsPerYear) : unavailableInput('No permit cost default for this jurisdiction', 'cents');

  const upfrontCents = opportunity.basis === 'existing'
    ? mk(0, 'cents', { confidence: UPFRONT_EXISTING_CONFIDENCE, method: "basis 'existing': the asset is usable now", note: 'Assumes no purchase is needed; enter any real start-up cost' })
    : unavailableInput('No start-up cost data; enter your own', 'cents');

  /** @type {EstimateInputs} */
  const inputs = {
    priceCents,
    unitsPerMonth,
    capacityUnitsPerMonth,
    bookingsPerMonth: unavailableInput('No typical booking length is recorded', 'bookings'),
    platformFeeRate,
    cleaningCentsPerBooking: unavailableInput('No cleaning cost data', 'cents'),
    utilitiesCentsPerMonth: unavailableInput('No utilities cost data', 'cents'),
    insuranceCentsPerMonth: unavailableInput('No insurance cost data', 'cents'),
    taxRate,
    permitCentsPerYear,
    upfrontCents,
    seasonality: mk(Array(12).fill(1), 'multiplier', { confidence: SEASONALITY_CONFIDENCE, method: 'flat 1.0 x 12 (no seasonal data)' }),
  };
  validateInputs(inputs);
  return inputs;
}

// ---------- validation ----------

/**
 * Throws a clear Error when inputs are malformed. Unavailable inputs must have value null.
 * @param {EstimateInputs} inputs
 */
export function validateInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') throw new Error('EstimateInputs: object required');
  for (const key of INPUT_KEYS) {
    const s = /** @type {Sourced<any>} */ (inputs[key]);
    if (!s || typeof s !== 'object') throw new Error(`EstimateInputs.${key}: missing Sourced value`);
    if (!TAGS.includes(s.tag)) throw new Error(`EstimateInputs.${key}: invalid tag ${String(s.tag)}`);
    if (typeof s.confidence !== 'number' || !(s.confidence >= 0 && s.confidence <= 1)) {
      throw new Error(`EstimateInputs.${key}: confidence must be a number in 0..1`);
    }
    if (s.tag === 'unavailable') {
      if (s.value !== null && s.value !== undefined) throw new Error(`EstimateInputs.${key}: unavailable input must have value null`);
      continue;
    }
    if (key === 'seasonality') {
      const a = s.value;
      if (!Array.isArray(a) || a.length !== 12) throw new Error('EstimateInputs.seasonality: must be an array of 12 monthly multipliers');
      for (const x of a) {
        if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) throw new Error('EstimateInputs.seasonality: each multiplier must be a finite number >= 0');
      }
      const sum = a.reduce((t, x) => t + x, 0);
      if (Math.abs(sum - 12) > 1e-6) throw new Error(`EstimateInputs.seasonality: multipliers must average 1.0 (sum is ${sum}, expected 12)`);
      continue;
    }
    const x = s.value;
    if (typeof x !== 'number' || Number.isNaN(x)) throw new Error(`EstimateInputs.${key}: value must be a number (got ${String(x)})`);
    if (!Number.isFinite(x)) throw new Error(`EstimateInputs.${key}: value must be finite`);
    if (x < 0) throw new Error(`EstimateInputs.${key}: value must not be negative (got ${x})`);
    if (RATE_KEYS.includes(key) && x > 1) throw new Error(`EstimateInputs.${key}: rate is a fraction 0..1 (got ${x})`);
  }
}

// ---------- overrides ----------

/**
 * Owner overrides. Each overridden field becomes owner-confirmed / 'Owner' / 0.9 / retrievedAt = now.
 * `overrides` maps input keys to raw values (number, or 12 numbers for seasonality) or to {value}.
 * @param {EstimateInputs} inputs
 * @param {Partial<Record<keyof EstimateInputs, any>>} overrides
 * @param {string} now ISO time
 * @returns {EstimateInputs}
 */
export function withOverrides(inputs, overrides, now) {
  if (typeof now !== 'string' || !now) throw new Error('withOverrides: `now` (ISO time string) is required');
  if (!overrides || typeof overrides !== 'object') throw new Error('withOverrides: overrides object required');
  validateInputs(inputs);
  /** @type {any} */
  const out = {};
  for (const key of INPUT_KEYS) out[key] = cloneSourced(inputs[key]);
  for (const key of Object.keys(overrides)) {
    if (!INPUT_KEYS.includes(/** @type {any} */ (key))) throw new Error(`withOverrides: unknown input ${key}`);
    let raw = /** @type {any} */ (overrides)[key];
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) raw = raw.value;
    if (raw === null || raw === undefined) throw new Error(`withOverrides: ${key} needs a value`);
    const value = Array.isArray(raw) ? [...raw] : raw;
    out[key] = mk(value, inputs[/** @type {keyof EstimateInputs} */ (key)].unit, {
      tag: 'owner-confirmed', source: 'Owner', retrievedAt: now, confidence: OWNER_CONFIDENCE,
    });
  }
  validateInputs(out);
  return out;
}

// ---------- estimate ----------

/**
 * @param {EstimateInputs} inputs
 * @param {{price:number, volume:number}} f
 * @returns {ScenarioResult}
 */
function computeScenario(inputs, f) {
  const has = (/** @type {keyof EstimateInputs} */ k) => inputs[k].tag !== 'unavailable';
  const num = (/** @type {keyof EstimateInputs} */ k) => /** @type {number} */ (inputs[k].value);
  const price = num('priceCents');
  const upm = num('unitsPerMonth');
  const cap = num('capacityUnitsPerMonth');
  const season = /** @type {number[]} */ (inputs.seasonality.value);
  const feeRate = has('platformFeeRate') ? num('platformFeeRate') : null;
  const cleaning = has('cleaningCentsPerBooking') && has('bookingsPerMonth') ? num('cleaningCentsPerBooking') * num('bookingsPerMonth') : null;
  const utilities = has('utilitiesCentsPerMonth') ? roundCents(num('utilitiesCentsPerMonth')) : 0;
  const insurance = has('insuranceCentsPerMonth') ? roundCents(num('insuranceCentsPerMonth')) : 0;
  const taxRate = has('taxRate') ? num('taxRate') : null;
  const permitMonthly = has('permitCentsPerYear') ? roundCents(num('permitCentsPerYear') / 12) : 0;
  const upfrontKnown = has('upfrontCents');
  const upfront = upfrontKnown ? roundCents(num('upfrontCents')) : 0;

  let units = 0; let gross = 0; let fee = 0; let clean = 0; let taxPermit = 0; let noi = 0;
  /** @type {number[]} */
  const noiByMonth = [];
  for (let m = 0; m < 12; m++) {
    const unitsM = Math.min(cap, upm * f.volume * season[m]);
    const grossM = roundCents(price * f.price * unitsM);
    const feeM = feeRate === null ? 0 : roundCents(grossM * feeRate);
    const cleanM = cleaning === null || upm === 0 ? 0 : roundCents((cleaning * unitsM) / upm);
    const taxM = (taxRate === null ? 0 : roundCents(grossM * taxRate)) + permitMonthly;
    const noiM = grossM - feeM - cleanM - utilities - insurance - taxM;
    units += unitsM; gross += grossM; fee += feeM; clean += cleanM; taxPermit += taxM; noi += noiM;
    noiByMonth.push(noiM);
  }
  const perMonth = (/** @type {number} */ y) => roundCents(y / 12);
  return {
    grossCentsPerMonth: perMonth(gross),
    platformFeeCentsPerMonth: perMonth(fee),
    cleaningCentsPerMonth: perMonth(clean),
    utilitiesCentsPerMonth: utilities,
    insuranceCentsPerMonth: insurance,
    taxAndPermitCentsPerMonth: perMonth(taxPermit),
    noiCentsPerMonth: perMonth(noi),
    grossCentsPerYear: gross,
    noiCentsPerYear: noi,
    noiCentsByMonth: noiByMonth,
    occupancy: cap > 0 ? Math.min(1, units / (12 * cap)) : 0,
    upfrontCents: upfront,
    roi: upfrontKnown && upfront > 0 ? noi / upfront : null,
    paybackMonths: upfrontKnown && upfront > 0 && noi > 0 ? round1(upfront / (noi / 12)) : null,
  };
}

/**
 * Feasibility-driven confidence cap (§5): unknown status or any unverified rule caps at 0.3.
 * @param {Opportunity} o
 */
function regulatoryCapApplies(o) {
  const f = o.feasibility;
  if (!f) return true;
  return f.status === 'unknown' || (f.rules ?? []).some((r) => !r.verified);
}

/**
 * §6: "high" needs every revenue-driving input to be owner-confirmed or verified. True when an input that moves the
 * result is still a planning default: the platform fee, tax and permit rates, the capacity ceiling, and (for nightly
 * and hourly categories, where months differ) the flat seasonality.
 * @param {Opportunity} o @param {EstimateInputs} used
 */
function usesPlanningDefaults(o, used) {
  const confirmed = (/** @type {keyof EstimateInputs} */ k) => used[k].tag === 'owner-confirmed' || used[k].tag === 'measured';
  for (const k of /** @type {Array<keyof EstimateInputs>} */ (['platformFeeRate', 'taxRate', 'permitCentsPerYear', 'capacityUnitsPerMonth'])) {
    if (used[k].tag !== 'unavailable' && !confirmed(k)) return true;
  }
  return (o.unit === 'night' || o.unit === 'hour') && !confirmed('seasonality');
}

/**
 * Estimate one opportunity in all three scenarios.
 * @param {Opportunity} opportunity
 * @param {EstimateInputs} inputs
 * @returns {OpportunityEstimate}
 */
export function estimateOpportunity(opportunity, inputs) {
  if (!opportunity || typeof opportunity.id !== 'string') throw new Error('estimateOpportunity: opportunity with id is required');
  validateInputs(inputs);
  /** @type {EstimateInputs} */
  const used = /** @type {any} */ ({});
  for (const key of INPUT_KEYS) /** @type {any} */ (used)[key] = cloneSourced(inputs[key]);

  const missing = INPUT_KEYS.filter((k) => used[k].tag === 'unavailable');
  const available = !REQUIRED_KEYS.some((k) => missing.includes(/** @type {any} */ (k)));

  const ownerData = used.priceCents.tag === 'owner-confirmed' && used.unitsPerMonth.tag === 'owner-confirmed';
  const setName = ownerData ? 'owner-history' : 'uncalibrated';
  const set = SPREAD_SETS[setName];

  /** @type {Array<{key:string, text:string, source:string}>} */
  const assumptions = [];
  for (const key of INPUT_KEYS) {
    const s = used[key];
    if (s.tag === 'unavailable' || s.tag === 'owner-confirmed') continue;
    const text = [s.method, s.note].filter(Boolean).join('. ') || `${key} default`;
    assumptions.push({ key, text, source: s.source });
  }
  /** @type {Array<{key:string, reason:string}>} */
  const notIncluded = [];
  // An owner-entered cleaning cost cannot be used without a booking count, and no count is ever guessed: say so.
  if (used.cleaningCentsPerBooking.tag !== 'unavailable' && used.bookingsPerMonth.tag === 'unavailable') {
    const reason = 'cleaning cost entered but number of bookings unknown, so cleaning is not included';
    used.bookingsPerMonth.note = reason;
    notIncluded.push({ key: 'cleaningCentsPerBooking', reason });
    assumptions.push({ key: 'cleaningCentsPerBooking', text: `Not included: ${reason}`, source: 'none' });
  }
  for (const k of missing) {
    if (COST_KEYS.includes(k)) assumptions.push({ key: k, text: `Not included: ${used[k].note ?? 'unavailable'}`, source: 'none' });
  }
  if (available) {
    for (const name of SCENARIO_NAMES) {
      const f = set[name];
      assumptions.push({ key: `scenario.${name}`, text: `${setName} spread set: price x${f.price}, volume x${f.volume}`, source: SPREAD_SOURCE });
    }
  }

  let confidence = 0;
  /** @type {Record<ScenarioName, ScenarioResult>|null} */
  let scenarios = null;
  if (available) {
    scenarios = /** @type {any} */ ({});
    for (const name of SCENARIO_NAMES) /** @type {any} */ (scenarios)[name] = computeScenario(used, set[name]);
    const ev = typeof opportunity.evidenceConfidence === 'number' ? opportunity.evidenceConfidence : 0;
    confidence = Math.min(used.priceCents.confidence, used.unitsPerMonth.confidence, ev);
    // Unknown local rules are not "zero confidence in the owner's numbers": the regulatory cap below applies instead.
    if (opportunity.feasibility && opportunity.feasibility.status !== 'unknown' && typeof opportunity.feasibility.confidence === 'number') {
      confidence = Math.min(confidence, opportunity.feasibility.confidence);
    }
    if (missing.some((k) => COST_KEYS.includes(k))) confidence = Math.min(confidence, MISSING_COST_CAP);
    if (regulatoryCapApplies(opportunity)) confidence = Math.min(confidence, REGULATORY_CAP);
    if (usesPlanningDefaults(opportunity, used)) confidence = Math.min(confidence, DEFAULT_INPUT_CAP);
  }

  return {
    opportunityId: opportunity.id,
    available,
    scenarios,
    confidence,
    confidenceLabel: labelFor(confidence),
    inputs: used,
    assumptions,
    missing: [...missing],
    notIncluded,
  };
}

// ---------- combined totals ----------

/**
 * Combined totals for a selection of estimates in one scenario.
 * @param {OpportunityEstimate[]|Record<string, OpportunityEstimate>} estimates
 * @param {string[]} selectedIds
 * @param {ScenarioName} scenario
 */
export function summarize(estimates, selectedIds, scenario) {
  if (!SCENARIO_NAMES.includes(scenario)) throw new Error(`summarize: unknown scenario ${String(scenario)}`);
  const list = Array.isArray(estimates) ? estimates : Object.values(estimates ?? {});
  /** @type {Map<string, OpportunityEstimate>} */
  const byId = new Map(list.map((e) => [e.opportunityId, e]));
  const ids = [...new Set(selectedIds)].sort();
  let grossYear = 0; let noiYear = 0; let upfront = 0; let confidence = ids.length ? 1 : 0;
  const byMonth = Array(12).fill(0);
  /** @type {string[]} */ const unavailableIds = [];
  /** @type {string[]} */ const upfrontUnknownIds = [];
  /** @type {string[]} */ const included = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e || !e.available || !e.scenarios) { unavailableIds.push(id); continue; }
    const r = e.scenarios[scenario];
    included.push(id);
    grossYear += r.grossCentsPerYear; noiYear += r.noiCentsPerYear; upfront += r.upfrontCents;
    r.noiCentsByMonth.forEach((v, i) => { byMonth[i] += v; });
    if (e.inputs.upfrontCents.tag === 'unavailable') upfrontUnknownIds.push(id);
    confidence = Math.min(confidence, e.confidence);
  }
  if (!included.length) confidence = 0;
  return {
    scenario,
    selected: included,
    unavailableIds,
    upfrontUnknownIds,
    grossCentsPerYear: grossYear,
    noiCentsPerYear: noiYear,
    noiCentsPerMonth: roundCents(noiYear / 12),
    noiCentsByMonth: byMonth,
    upfrontCents: upfront,
    paybackMonths: !upfrontUnknownIds.length && upfront > 0 && noiYear > 0 ? round1(upfront / (noiYear / 12)) : null,
    confidence,
    confidenceLabel: labelFor(confidence),
  };
}

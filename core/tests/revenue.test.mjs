// Revenue model tests: hand-computed worked examples (exact cents) per docs/revenue-method.md §3-§6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultInputs, withOverrides, estimateOpportunity, summarize, roundCents, validateInputs } from '../revenue.js';

const NOW = '2026-11-24T12:00:00Z';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} !~ ${b}`);

/** @returns {import('../types.js').Opportunity} */
function opp(over = {}) {
  return {
    id: 'pool', categoryKey: 'pool', label: 'Pool', basis: 'existing', unit: 'hour', evidence: ['pool_present'],
    evidenceConfidence: 0.8, feasibility: { status: 'feasible', rules: [], confidence: 0.9, requirements: [] },
    conflictsWith: [], resourceUse: {}, effort: 3, privacyImpact: 2, strangersInHome: false, notes: [], ...over,
  };
}
const home = (over = {}) => opp({ id: 'home', categoryKey: 'entire_home', label: 'Whole home', unit: 'night', ...over });

function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

// Fully owner-specified entire_home inputs used by several worked examples.
function fullInputs(extra = {}) {
  return withOverrides(defaultInputs(home(), null), {
    priceCents: 15000, unitsPerMonth: 10, bookingsPerMonth: 4, platformFeeRate: 0.1, cleaningCentsPerBooking: 5000,
    utilitiesCentsPerMonth: 3000, insuranceCentsPerMonth: 2000, taxRate: 0.12, permitCentsPerYear: 30000,
    upfrontCents: 100000, ...extra,
  }, NOW);
}

// ---------- defaults ----------

test('defaultInputs: price and volume copied from TYPICAL / estimateItem, tagged as uncited planning defaults', () => {
  const i = defaultInputs(home(), null);
  assert.equal(i.priceCents.value, 18000); // TYPICAL.entire_home.daily = $180
  assert.equal(i.priceCents.tag, 'estimated');
  assert.equal(i.priceCents.source, 'Everyspace planning default (uncited)');
  assert.equal(i.priceCents.confidence, 0.2);
  assert.match(i.priceCents.method, /index\.html:5299 TYPICAL/);
  assert.equal(i.unitsPerMonth.value, 16); // USE.nightly[1]
  assert.equal(i.unitsPerMonth.confidence, 0.15);
  assert.equal(i.capacityUnitsPerMonth.value, 30.4);
  assert.equal(i.capacityUnitsPerMonth.tag, 'measured');
  assert.equal(i.platformFeeRate.value, 0.155); // airbnb host fee
  assert.equal(i.platformFeeRate.confidence, 0.2);
  assert.deepEqual(i.seasonality.value, Array(12).fill(1));
  assert.equal(i.seasonality.confidence, 0.1);
});

test('defaultInputs: every missing default is unavailable with value null and confidence 0, never 0 cents', () => {
  const i = defaultInputs(opp({ basis: 'setup' }), null);
  for (const k of ['bookingsPerMonth', 'cleaningCentsPerBooking', 'utilitiesCentsPerMonth', 'insuranceCentsPerMonth', 'taxRate', 'permitCentsPerYear', 'upfrontCents']) {
    assert.equal(i[k].tag, 'unavailable', k);
    assert.equal(i[k].value, null, k);
    assert.equal(i[k].confidence, 0, k);
    assert.ok(i[k].note, k);
  }
});

test('defaultInputs: existing basis gets 0 upfront with a note; hourly capacity is estimated arithmetic', () => {
  const i = defaultInputs(opp(), null);
  assert.equal(i.upfrontCents.value, 0);
  assert.equal(i.upfrontCents.tag, 'estimated');
  assert.ok(i.upfrontCents.note);
  assert.equal(i.capacityUnitsPerMonth.tag, 'estimated');
  assert.equal(i.capacityUnitsPerMonth.value, 24 * 30.4);
});

test('defaultInputs: unit without a recorded volume (parking by the hour) => unitsPerMonth unavailable', () => {
  const i = defaultInputs(opp({ id: 'p', categoryKey: 'parking_spot', unit: 'hour' }), null);
  assert.equal(i.priceCents.value, 400);
  assert.equal(i.unitsPerMonth.tag, 'unavailable');
  assert.equal(i.platformFeeRate.value, 0.30); // spothero
});

test('defaultInputs: infrastructure price per year is divided by 12; company lease = 1 month a month', () => {
  const i = defaultInputs(opp({ id: 's', categoryKey: 'rooftop_solar', unit: 'month' }), null);
  assert.equal(i.priceCents.value, 8333); // round(100000 / 12)
  assert.equal(i.unitsPerMonth.value, 1);
  assert.equal(i.platformFeeRate.tag, 'unavailable'); // no channel implied by existing code
});

test('defaultInputs: occupancy converts to units with the unit capacity (garage storage by the week)', () => {
  const i = defaultInputs(opp({ id: 'g', categoryKey: 'garage_storage', unit: 'week' }), null);
  assert.equal(i.priceCents.value, 2500);
  near(i.unitsPerMonth.value, 0.75 * (30.4 / 7));
  assert.equal(i.platformFeeRate.value, 0.049); // neighbor
});

test('defaultInputs: jurisdiction tax/permit defaults are passed through opts (copied, not shared)', () => {
  const taxRate = { value: 0.14, unit: 'fraction', tag: 'estimated', source: 'jurisdictions.js', retrievedAt: null, confidence: 0.2 };
  const i = defaultInputs(home(), null, { jurisdictionDefaults: { taxRate } });
  assert.deepEqual(i.taxRate, taxRate);
  assert.notEqual(i.taxRate, taxRate);
  assert.equal(i.permitCentsPerYear.tag, 'unavailable');
});

// ---------- worked examples ----------

test('worked example, defaults only (pool by the hour): three scenarios in exact cents', () => {
  const e = estimateOpportunity(opp(), defaultInputs(opp(), null));
  assert.equal(e.available, true);
  // baseline: units 16, gross 4000*16 = 64000, fee 15% = 9600, NOI 54400
  const b = e.scenarios.baseline;
  assert.equal(b.grossCentsPerMonth, 64000);
  assert.equal(b.platformFeeCentsPerMonth, 9600);
  assert.equal(b.noiCentsPerMonth, 54400);
  assert.equal(b.grossCentsPerYear, 768000);
  assert.equal(b.noiCentsPerYear, 652800);
  near(b.occupancy, 16 / 729.6);
  // conservative: units 16*0.6 = 9.6, gross 4000*0.85*9.6 = 32640, fee 4896, NOI 27744
  const c = e.scenarios.conservative;
  assert.equal(c.grossCentsPerMonth, 32640);
  assert.equal(c.platformFeeCentsPerMonth, 4896);
  assert.equal(c.noiCentsPerYear, 27744 * 12);
  // optimistic: units 20.8, gross 4000*1.1*20.8 = 91520, fee 13728, NOI 77792
  const o = e.scenarios.optimistic;
  assert.equal(o.grossCentsPerMonth, 91520);
  assert.equal(o.noiCentsPerYear, 77792 * 12);
  // unavailable costs are excluded, not zero-filled into the inputs
  assert.equal(b.cleaningCentsPerMonth, 0);
  assert.equal(b.taxAndPermitCentsPerMonth, 0);
  assert.equal(e.confidence, 0.15); // min(price 0.2, volume 0.15, evidence 0.8, feasibility 0.9)
  assert.equal(e.confidenceLabel, 'low');
});

test('worked example, every formula row (baseline, owner-history spread)', () => {
  const e = estimateOpportunity(home(), fullInputs());
  const b = e.scenarios.baseline;
  assert.equal(b.grossCentsPerMonth, 150000); // 15000 x 10
  assert.equal(b.platformFeeCentsPerMonth, 15000); // 10%
  assert.equal(b.cleaningCentsPerMonth, 20000); // 5000 x 4 x 10/10
  assert.equal(b.utilitiesCentsPerMonth, 3000);
  assert.equal(b.insuranceCentsPerMonth, 2000);
  assert.equal(b.taxAndPermitCentsPerMonth, 20500); // 18000 + round(30000/12)
  assert.equal(b.noiCentsPerMonth, 89500);
  assert.equal(b.noiCentsPerYear, 1074000);
  assert.equal(b.grossCentsPerYear, 1800000);
  assert.equal(b.upfrontCents, 100000);
  assert.equal(b.roi, 10.74);
  assert.equal(b.paybackMonths, 1.1); // 100000 / 89500 = 1.117
  near(b.occupancy, 10 / 30.4);
});

test('worked example, conservative and optimistic owner-history scenarios with half-cent rounding', () => {
  const e = estimateOpportunity(home(), fullInputs());
  const c = e.scenarios.conservative; // price x0.95, volume x0.85 -> units 8.5
  assert.equal(c.grossCentsPerMonth, 121125);
  assert.equal(c.platformFeeCentsPerMonth, 12113); // 12112.5 rounds half away from zero
  assert.equal(c.cleaningCentsPerMonth, 17000);
  assert.equal(c.taxAndPermitCentsPerMonth, 17035); // 14535 + 2500
  assert.equal(c.noiCentsPerMonth, 69977);
  assert.equal(c.noiCentsPerYear, 839724);
  const o = e.scenarios.optimistic; // price x1.05, volume x1.15 -> units 11.5
  assert.equal(o.grossCentsPerMonth, 181125);
  assert.equal(o.platformFeeCentsPerMonth, 18113);
  assert.equal(o.cleaningCentsPerMonth, 23000);
  assert.equal(o.taxAndPermitCentsPerMonth, 24235);
  assert.equal(o.noiCentsPerYear, 110777 * 12);
});

test('roundCents: half away from zero and tolerant of float noise', () => {
  assert.equal(roundCents(2.5), 3);
  assert.equal(roundCents(-2.5), -3);
  assert.equal(roundCents(2.4999), 2);
  assert.equal(roundCents(15299.999999999998), 15300);
  assert.equal(roundCents(18000 * 0.85), 15300);
  assert.ok(Object.is(roundCents(-0.2), 0));
});

test('per-month figures are the yearly sum / 12, rounded', () => {
  // price 1001, 1 unit: gross 1001/month, permit 1000/yr -> round(83.33) = 83 per month
  const i = withOverrides(defaultInputs(opp(), null), { priceCents: 1001, unitsPerMonth: 1, permitCentsPerYear: 1000, platformFeeRate: 0 }, NOW);
  const b = estimateOpportunity(opp(), i).scenarios.baseline;
  assert.equal(b.taxAndPermitCentsPerMonth, 83);
  assert.equal(b.noiCentsPerYear, (1001 - 83) * 12);
  assert.equal(b.noiCentsPerMonth, 918);
});

test('seasonality: monthly NOI follows the multipliers and sums to the year; total units unchanged', () => {
  const season = [0.5, 0.5, 1, 1, 1, 1, 1.5, 1.5, 1, 1, 1, 1];
  const flat = estimateOpportunity(home(), fullInputs()).scenarios.baseline;
  const e = estimateOpportunity(home(), fullInputs({ seasonality: season })).scenarios.baseline;
  assert.equal(e.noiCentsByMonth.reduce((a, b) => a + b, 0), e.noiCentsPerYear);
  assert.equal(e.grossCentsPerYear, flat.grossCentsPerYear); // 120 units either way
  // January: units 5, gross 75000, fee 7500, cleaning 10000, util 3000, ins 2000, tax 9000 + 2500
  assert.equal(e.noiCentsByMonth[0], 75000 - 7500 - 10000 - 3000 - 2000 - 11500);
  // July: units 15, gross 225000, fee 22500, cleaning 30000, tax 27000 + 2500
  assert.equal(e.noiCentsByMonth[6], 225000 - 22500 - 30000 - 3000 - 2000 - 29500);
  assert.equal(flat.noiCentsByMonth.reduce((a, b) => a + b, 0), flat.noiCentsPerYear);
});

test('capacity caps units in the optimistic scenario only', () => {
  const e = estimateOpportunity(home(), fullInputs({ capacityUnitsPerMonth: 11 }));
  assert.equal(e.scenarios.optimistic.grossCentsPerMonth, roundCents(15000 * 1.05 * 11)); // 11.5 capped to 11
  assert.equal(e.scenarios.optimistic.occupancy, 1);
  assert.equal(e.scenarios.baseline.grossCentsPerMonth, 150000);
  near(e.scenarios.baseline.occupancy, 10 / 11);
});

test('ROI and payback are null when upfront is 0 or unknown', () => {
  const zero = estimateOpportunity(home(), fullInputs({ upfrontCents: 0 })).scenarios.baseline;
  assert.equal(zero.roi, null);
  assert.equal(zero.paybackMonths, null);
  const unknown = estimateOpportunity(opp({ basis: 'setup' }), defaultInputs(opp({ basis: 'setup' }), null));
  assert.equal(unknown.scenarios.baseline.roi, null);
  assert.equal(unknown.scenarios.baseline.paybackMonths, null);
  assert.ok(unknown.missing.includes('upfrontCents'));
});

test('negative NOI: reported as negative, ROI negative, payback null', () => {
  const e = estimateOpportunity(home(), fullInputs({ utilitiesCentsPerMonth: 200000 })).scenarios.baseline;
  assert.equal(e.noiCentsPerMonth, 89500 + 3000 - 200000);
  assert.ok(e.noiCentsPerYear < 0);
  assert.ok(e.roi < 0);
  assert.equal(e.paybackMonths, null);
});

test('unavailable price => available:false, no numbers, listed as missing', () => {
  const o = opp({ unit: 'day' }); // TYPICAL.pool has hourly only
  const e = estimateOpportunity(o, defaultInputs(o, null));
  assert.equal(e.available, false);
  assert.equal(e.scenarios, null);
  assert.ok(e.missing.includes('priceCents'));
  assert.equal(e.confidence, 0);
  assert.equal(e.confidenceLabel, 'low');
});

test('unavailable cost => excluded from the math, listed as not included, confidence capped at 0.3', () => {
  const i = withOverrides(defaultInputs(opp(), null), { priceCents: 4000, unitsPerMonth: 16, platformFeeRate: 0.15 }, NOW);
  const e = estimateOpportunity(opp(), i);
  assert.equal(e.available, true);
  assert.equal(e.confidence, 0.3); // min(0.9, 0.9, 0.8, 0.9) = 0.8, capped
  assert.ok(e.missing.includes('cleaningCentsPerBooking'));
  assert.ok(e.assumptions.some((a) => a.key === 'utilitiesCentsPerMonth' && /^Not included/.test(a.text)));
  assert.equal(e.scenarios.baseline.noiCentsPerMonth, 54400);
});

test('unknown regulatory status or unverified rule caps confidence at 0.3', () => {
  const unknown = home({ feasibility: { status: 'unknown', rules: [], confidence: 0.9, requirements: [] } });
  assert.equal(estimateOpportunity(unknown, fullInputs()).confidence, 0.3);
  const unverified = home({ feasibility: { status: 'feasible', rules: [{ ruleId: 'r', summary: 's', effect: 'allow', verified: false }], confidence: 0.9, requirements: [] } });
  assert.equal(estimateOpportunity(unverified, fullInputs()).confidence, 0.3);
});

test('owner overrides: tag/source/confidence/retrievedAt, owner-history spread set, higher confidence', () => {
  const before = estimateOpportunity(home(), defaultInputs(home(), null));
  const i = fullInputs();
  assert.equal(i.priceCents.tag, 'owner-confirmed');
  assert.equal(i.priceCents.source, 'Owner');
  assert.equal(i.priceCents.confidence, 0.9);
  assert.equal(i.priceCents.retrievedAt, NOW);
  assert.equal(i.priceCents.unit, 'cents');
  const after = estimateOpportunity(home(), i);
  assert.ok(before.assumptions.some((a) => a.key === 'scenario.conservative' && /uncalibrated/.test(a.text)));
  assert.ok(after.assumptions.some((a) => a.key === 'scenario.conservative' && /owner-history/.test(a.text) && /x0\.95/.test(a.text)));
  assert.equal(before.confidence, 0.15);
  // min(0.9, 0.9, evidence 0.8, feasibility 0.9) = 0.8, but a nightly category with the flat default seasonality is capped at 0.6
  assert.equal(after.confidence, 0.6);
  assert.equal(after.confidenceLabel, 'medium');
  const seasonal = estimateOpportunity(home(), fullInputs({ seasonality: [0.8, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.3, 1.1, 1, 0.8, 0.7] }));
  assert.equal(seasonal.confidence, 0.8, 'every revenue-driving input is confirmed');
  assert.equal(seasonal.confidenceLabel, 'high');
});

test('only price owner-confirmed => still the uncalibrated spread set', () => {
  const i = withOverrides(defaultInputs(home(), null), { priceCents: 20000 }, NOW);
  const e = estimateOpportunity(home(), i);
  assert.equal(e.scenarios.conservative.grossCentsPerMonth, roundCents(20000 * 0.85 * 16 * 0.6));
});

test('assumptions list every default used and the three scenario factors', () => {
  const e = estimateOpportunity(home(), defaultInputs(home(), null));
  const keys = e.assumptions.map((a) => a.key);
  for (const k of ['priceCents', 'unitsPerMonth', 'capacityUnitsPerMonth', 'platformFeeRate', 'seasonality', 'scenario.conservative', 'scenario.baseline', 'scenario.optimistic']) {
    assert.ok(keys.includes(k), k);
  }
  assert.ok(e.assumptions.every((a) => typeof a.text === 'string' && typeof a.source === 'string'));
});

test('validation: negative price, wrong seasonality length, NaN, rate above 1 throw clear errors', () => {
  const base = defaultInputs(home(), null);
  assert.throws(() => withOverrides(base, { priceCents: -1 }, NOW), /priceCents.*negative/);
  assert.throws(() => withOverrides(base, { seasonality: Array(11).fill(1) }, NOW), /seasonality.*12/);
  assert.throws(() => withOverrides(base, { seasonality: [2, ...Array(11).fill(1)] }, NOW), /average 1\.0/);
  assert.throws(() => withOverrides(base, { unitsPerMonth: NaN }, NOW), /unitsPerMonth.*number/);
  assert.throws(() => withOverrides(base, { taxRate: 1.5 }, NOW), /taxRate.*fraction/);
  assert.throws(() => withOverrides(base, { bogus: 1 }, NOW), /unknown input bogus/);
  assert.throws(() => withOverrides(base, { priceCents: 1 }), /now/);
  assert.throws(() => estimateOpportunity(home(), { ...base, priceCents: { ...base.priceCents, value: NaN } }), /priceCents/);
  assert.throws(() => validateInputs({ ...base, seasonality: undefined }), /seasonality/);
});

test('determinism and immutability: same input twice => deep-equal; inputs are never mutated', () => {
  const o = deepFreeze(home());
  const i = deepFreeze(fullInputs({ seasonality: [0.5, 0.5, 1, 1, 1, 1, 1.5, 1.5, 1, 1, 1, 1] }));
  const snapshot = JSON.parse(JSON.stringify(i));
  const a = estimateOpportunity(o, i);
  const b = estimateOpportunity(o, i);
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(i)), snapshot);
  const j = withOverrides(i, { priceCents: 1 }, NOW);
  assert.equal(i.priceCents.value, 15000);
  assert.notEqual(j.seasonality.value, i.seasonality.value); // copied, not shared
  assert.deepEqual(defaultInputs(o, null), defaultInputs(o, null));
});

test('summarize: combined totals for a selection in one scenario', () => {
  const e1 = estimateOpportunity(home(), fullInputs());
  const e2 = estimateOpportunity(opp(), defaultInputs(opp(), null));
  const bad = estimateOpportunity(opp({ id: 'x', unit: 'day' }), defaultInputs(opp({ id: 'x', unit: 'day' }), null));
  const s = summarize([e1, e2, bad], ['pool', 'home', 'x'], 'baseline');
  assert.deepEqual(s.selected, ['home', 'pool']);
  assert.deepEqual(s.unavailableIds, ['x']);
  assert.equal(s.noiCentsPerYear, 1074000 + 652800);
  assert.equal(s.grossCentsPerYear, 1800000 + 768000);
  assert.equal(s.noiCentsPerMonth, 89500 + 54400);
  assert.equal(s.upfrontCents, 100000);
  assert.equal(s.paybackMonths, roundCents(100000 / ((1074000 + 652800) / 12) * 10) / 10);
  assert.equal(s.confidence, 0.15);
  assert.equal(summarize([], [], 'baseline').confidence, 0);
  assert.throws(() => summarize([], [], 'best'), /scenario/);
});

// ---------- review-gate #9: owner cleaning cost without a booking count ----------
test('cleaning cost entered while bookings per month is unknown is reported as not included, never silently dropped', () => {
  const base = defaultInputs(home(), null);
  const i = withOverrides(base, { priceCents: 10000, unitsPerMonth: 20, cleaningCentsPerBooking: 8000 }, NOW);
  const e = estimateOpportunity(home(), i);
  assert.equal(e.scenarios.baseline.cleaningCentsPerMonth, 0);
  assert.ok(e.missing.includes('bookingsPerMonth'));
  assert.deepEqual(e.notIncluded.map((x) => x.key), ['cleaningCentsPerBooking']);
  assert.match(e.notIncluded[0].reason, /cleaning cost entered but number of bookings unknown, so cleaning is not included/);
  assert.match(e.inputs.bookingsPerMonth.note, /cleaning is not included/);
  assert.ok(e.assumptions.some((a) => a.key === 'cleaningCentsPerBooking' && /^Not included: cleaning cost entered/.test(a.text)));
  assert.ok(e.confidence <= 0.3, 'missing-cost cap stays');
  assert.equal(i.bookingsPerMonth.value, null, 'no booking count is guessed');
  // with a booking count the cleaning is included and the flag is empty
  const ok = estimateOpportunity(home(), withOverrides(i, { bookingsPerMonth: 5 }, NOW));
  assert.deepEqual(ok.notIncluded, []);
  assert.ok(ok.scenarios.baseline.cleaningCentsPerMonth > 0);
  // no cleaning entered: nothing to flag
  assert.deepEqual(estimateOpportunity(home(), withOverrides(base, { priceCents: 10000, unitsPerMonth: 20 }, NOW)).notIncluded, []);
});

// ---------- review-gate #10: confidence with default fee / seasonality ----------
test('confidence is capped at medium (0.6) while the platform fee is not confirmed or verified', () => {
  const all = { priceCents: 10000, unitsPerMonth: 20, bookingsPerMonth: 5, cleaningCentsPerBooking: 5000, utilitiesCentsPerMonth: 1000,
    insuranceCentsPerMonth: 1000, taxRate: 0.1, permitCentsPerYear: 0, upfrontCents: 0 };
  const season = [0.8, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.3, 1.1, 1, 0.8, 0.7];
  const withDefaultFee = estimateOpportunity(home(), withOverrides(defaultInputs(home(), null), { ...all, seasonality: season }, NOW));
  assert.equal(withDefaultFee.inputs.platformFeeRate.tag, 'estimated');
  assert.equal(withDefaultFee.confidence, 0.6);
  assert.equal(withDefaultFee.confidenceLabel, 'medium');
  // fee confirmed but seasonality is the flat default, nightly category
  const flat = estimateOpportunity(home(), withOverrides(defaultInputs(home(), null), { ...all, platformFeeRate: 0.155 }, NOW));
  assert.equal(flat.confidence, 0.6);
  assert.equal(flat.confidenceLabel, 'medium');
  // every revenue-driving input confirmed: high is reachable
  const full = estimateOpportunity(home(), withOverrides(defaultInputs(home(), null), { ...all, platformFeeRate: 0.155, seasonality: season }, NOW));
  assert.equal(full.confidence, 0.8);
  assert.equal(full.confidenceLabel, 'high');
  // a daily/monthly category is not capped by the flat seasonality
  const monthly = (over) => ({ id: 'dp', categoryKey: 'driveway_parking', label: 'Driveway', basis: 'existing', unit: 'month', evidence: [], evidenceConfidence: 0.9,
    feasibility: { status: 'feasible', rules: [{ ruleId: 'r', summary: 's', effect: 'allow', verified: true }], confidence: 0.8, requirements: [] },
    conflictsWith: [], resourceUse: {}, effort: 1, privacyImpact: 0, strangersInHome: false, notes: [], ...over });
  const mo = monthly({});
  const mi = defaultInputs(mo, null);
  if (mi.priceCents.tag !== 'unavailable') {
    const e = estimateOpportunity(mo, withOverrides(mi, { ...all, platformFeeRate: 0.1 }, NOW));
    assert.equal(e.confidence, 0.8);
  }
});

// ---------- unknown local rules: cap, not zero ----------
test('unknown feasibility caps confidence at 0.3 instead of forcing 0 when price and volume are the owner\'s', () => {
  const unknown = home({ feasibility: { status: 'unknown', rules: [], confidence: 0, requirements: [] } });
  const e = estimateOpportunity(unknown, fullInputs());
  assert.equal(e.confidence, 0.3);
  assert.equal(e.confidenceLabel, 'low');
  // still no better than the default-input estimate when nothing is the owner's
  assert.ok(estimateOpportunity(unknown, defaultInputs(unknown, null)).confidence <= 0.15);
});

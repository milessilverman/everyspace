// Optimizer tests (docs/revenue-method.md §7): exhaustive subset search, constraints, goals, tie-breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimize } from '../optimizer.js';
import { defaultInputs, withOverrides, estimateOpportunity } from '../revenue.js';

/** Minimal Opportunity. */
function o(id, over = {}) {
  return {
    id, categoryKey: over.categoryKey ?? id, label: id, basis: 'existing', unit: 'month', evidence: [], evidenceConfidence: 0.9,
    feasibility: { status: 'feasible', rules: [], confidence: 0.9, requirements: [] },
    conflictsWith: [], resourceUse: {}, effort: 1, privacyImpact: 0, strangersInHome: false, notes: [], ...over,
  };
}

/** Minimal available OpportunityEstimate with the same result in every scenario (unless `byScenario`). */
function est(id, { noi, up = 0, conf = 0.2, upUnknown = false, byScenario = {} }) {
  const r = (n) => ({
    grossCentsPerMonth: 0, platformFeeCentsPerMonth: 0, cleaningCentsPerMonth: 0, utilitiesCentsPerMonth: 0,
    insuranceCentsPerMonth: 0, taxAndPermitCentsPerMonth: 0, noiCentsPerMonth: Math.round(n / 12), grossCentsPerYear: n * 2,
    noiCentsPerYear: n, noiCentsByMonth: Array(12).fill(n / 12), occupancy: 0.5, upfrontCents: upUnknown ? 0 : up, roi: null, paybackMonths: null,
  });
  return {
    opportunityId: id, available: true,
    scenarios: { conservative: r(byScenario.conservative ?? noi), baseline: r(noi), optimistic: r(byScenario.optimistic ?? noi) },
    confidence: conf, confidenceLabel: 'low',
    inputs: { upfrontCents: upUnknown ? { value: null, tag: 'unavailable', source: 'none', retrievedAt: null, confidence: 0 } : { value: up, tag: 'owner-confirmed', source: 'Owner', retrievedAt: 'x', confidence: 0.9 } },
    assumptions: [], missing: upUnknown ? ['upfrontCents'] : [],
  };
}
const unavailableEst = (id) => ({ opportunityId: id, available: false, scenarios: null, confidence: 0, confidenceLabel: 'low', inputs: {}, assumptions: [], missing: ['priceCents'] });

const byId = (list) => Object.fromEntries(list.map((e) => [e.opportunityId, e]));
const reasonOf = (res, id) => res.rejected.find((r) => r.id === id)?.reason;

// Shared fixture: each of the five goals selects a different combination.
//   A room     NOI 600000 up 0       effort 4 privacy 3 strangers  conflicts B
//   B pool     NOI 400000 up 200000  effort 3 privacy 2
//   C parking  NOI 100000 up 10000   effort 1 privacy 1
//   D solar    NOI 150000 up 200000  effort 1 privacy 0
//   E storage  NOI  80000 up 0       effort 1 privacy 2
const SHARED = [
  o('A', { categoryKey: 'room', effort: 4, privacyImpact: 3, strangersInHome: true, conflictsWith: ['B'] }),
  o('B', { categoryKey: 'pool', effort: 3, privacyImpact: 2 }),
  o('C', { categoryKey: 'parking', effort: 1, privacyImpact: 1 }),
  o('D', { categoryKey: 'solar', effort: 1, privacyImpact: 0 }),
  o('E', { categoryKey: 'storage', effort: 1, privacyImpact: 2 }),
];
const SHARED_EST = byId([
  est('A', { noi: 600000 }), est('B', { noi: 400000, up: 200000 }), est('C', { noi: 100000, up: 10000 }),
  est('D', { noi: 150000, up: 200000 }), est('E', { noi: 80000 }),
]);
const run = (goal, constraints = {}, opps = SHARED, ests = SHARED_EST, scenario = 'baseline') => optimize(opps, ests, { goal, constraints, scenario });

// ---------- goals ----------

test('max_net_income: highest NOI combination; conflict loser rejected; total below the naive sum', () => {
  const r = run('max_net_income');
  assert.deepEqual(r.selected, ['A', 'C', 'D', 'E']);
  assert.equal(r.totals.noiCentsPerYear, 930000);
  assert.equal(r.naiveSumNoiCentsPerYear, 1330000);
  assert.ok(r.totals.noiCentsPerYear < r.naiveSumNoiCentsPerYear);
  assert.match(reasonOf(r, 'B'), /Conflicts with A/);
  assert.equal(r.totals.upfrontCents, 210000);
  assert.equal(r.totals.paybackMonths, 2.7); // 210000 / (930000/12) = 2.709
  assert.equal(r.totals.noiCentsPerMonth, 77500);
  assert.equal(r.totals.grossCentsPerYear, 1860000);
  assert.equal(r.totals.effort, 7);
  assert.equal(r.totals.privacyImpact, 3);
  assert.equal(r.goal, 'max_net_income');
  assert.equal(r.scenario, 'baseline');
});

test('min_upfront: highest first-year net cash (NOI - upfront) drops D', () => {
  const r = run('min_upfront');
  assert.deepEqual(r.selected, ['A', 'C', 'E']);
  assert.equal(r.totals.noiCentsPerYear - r.totals.upfrontCents, 770000);
});

test('min_effort: only effort <= 2, then highest NOI', () => {
  const r = run('min_effort');
  assert.deepEqual(r.selected, ['C', 'D', 'E']);
  assert.match(reasonOf(r, 'A'), /Effort 4 is above the limit of 2/);
});

test('privacy: only privacy impact <= 1 and no strangers in the home', () => {
  const r = run('privacy');
  assert.deepEqual(r.selected, ['C', 'D']);
  assert.match(reasonOf(r, 'E'), /privacy goal/);
  assert.match(reasonOf(r, 'A'), /privacy goal|strangers/i);
});

test('fastest_payback: lowest combined payback (zero-upfront A+E), then highest NOI', () => {
  const r = run('fastest_payback');
  assert.deepEqual(r.selected, ['A', 'E']);
  assert.equal(r.totals.paybackMonths, null); // upfront 0
});

test('the five goals yield five different selections on one fixture', () => {
  const sel = ['max_net_income', 'min_upfront', 'min_effort', 'privacy', 'fastest_payback'].map((g) => run(g).selected.join(','));
  assert.equal(new Set(sel).size, 5);
});

test('min_effort uses maxEffort instead of 2 when given', () => {
  const r = run('min_effort', { maxEffort: 3 });
  assert.deepEqual(r.selected, ['B', 'C', 'D', 'E']);
});

// ---------- constraints ----------

test('constraint maxUpfrontCents', () => {
  const r = run('max_net_income', { maxUpfrontCents: 50000 });
  assert.deepEqual(r.selected, ['A', 'C', 'E']);
  assert.match(reasonOf(r, 'D'), /above your limit of 50000/);
});

test('constraint maxEffort', () => {
  const r = run('max_net_income', { maxEffort: 3 });
  assert.deepEqual(r.selected, ['B', 'C', 'D', 'E']);
  assert.match(reasonOf(r, 'A'), /Effort 4/);
});

test('constraint maxPrivacyImpact', () => {
  const r = run('max_net_income', { maxPrivacyImpact: 1 });
  assert.deepEqual(r.selected, ['C', 'D']);
  assert.match(reasonOf(r, 'B'), /Privacy impact 2/);
});

test('constraint noStrangersInHome', () => {
  const r = run('max_net_income', { noStrangersInHome: true });
  assert.deepEqual(r.selected, ['B', 'C', 'D', 'E']);
  assert.match(reasonOf(r, 'A'), /strangers/);
});

test('constraint excludedCategories', () => {
  const r = run('max_net_income', { excludedCategories: ['solar'] });
  assert.deepEqual(r.selected, ['A', 'C', 'E']);
  assert.match(reasonOf(r, 'D'), /excluded/);
});

test('constraint onlyPreferred + preferredCategories filter', () => {
  const r = run('max_net_income', { preferredCategories: ['parking', 'storage'], onlyPreferred: true });
  assert.deepEqual(r.selected, ['C', 'E']);
  assert.match(reasonOf(r, 'A'), /preferred/);
});

test('preferredCategories alone is a tie-breaker (after confidence, before count and ids)', () => {
  const opps = [o('P', { categoryKey: 'x', conflictsWith: ['Q'] }), o('Q', { categoryKey: 'y' })];
  const ests = byId([est('P', { noi: 1000 }), est('Q', { noi: 1000 })]);
  assert.deepEqual(optimize(opps, ests, { goal: 'max_net_income' }).selected, ['P']);
  assert.deepEqual(optimize(opps, ests, { goal: 'max_net_income', constraints: { preferredCategories: ['y'] } }).selected, ['Q']);
});

test('resourceCapacity: 2 parking spaces, 3 parking opportunities => best two', () => {
  const opps = ['p1', 'p2', 'p3'].map((id) => o(id, { categoryKey: 'parking_spot', resourceUse: { parking: 1 } }));
  const ests = byId([est('p1', { noi: 30000 }), est('p2', { noi: 50000 }), est('p3', { noi: 40000 })]);
  const r = optimize(opps, ests, { goal: 'max_net_income', constraints: { resourceCapacity: { parking: 2 } } });
  assert.deepEqual(r.selected, ['p2', 'p3']);
  assert.match(reasonOf(r, 'p1'), /Not enough parking: 2 available/);
  assert.equal(r.naiveSumNoiCentsPerYear, 120000);
  // without a capacity the resource is not limited
  assert.deepEqual(optimize(opps, ests, { goal: 'max_net_income' }).selected, ['p1', 'p2', 'p3']);
});

test('resourceCapacity: a single opportunity needing more than the capacity is rejected up front', () => {
  const r = optimize([o('lot', { resourceUse: { parking: 3 } })], byId([est('lot', { noi: 1 })]), { goal: 'max_net_income', constraints: { resourceCapacity: { parking: 2 } } });
  assert.deepEqual(r.selected, []);
  assert.match(reasonOf(r, 'lot'), /Needs 3 parking but only 2/);
});

// ---------- regulation, investments, unavailable ----------

test('regulation: prohibited never selected; unknown and unverified only with allowUnknownRegulatory', () => {
  const opps = [
    o('ok'),
    o('ban', { feasibility: { status: 'prohibited', rules: [], confidence: 0.9, requirements: [] } }),
    o('unk', { feasibility: { status: 'unknown', rules: [], confidence: 0.3, requirements: [] } }),
    o('unv', { feasibility: { status: 'feasible', rules: [{ ruleId: 'r1', summary: 's', effect: 'allow', verified: false }], confidence: 0.3, requirements: [] } }),
  ];
  const ests = byId(opps.map((x) => est(x.id, { noi: 1000 })));
  const strict = optimize(opps, ests, { goal: 'max_net_income' });
  assert.deepEqual(strict.selected, ['ok']);
  assert.match(reasonOf(strict, 'ban'), /Prohibited/);
  assert.match(reasonOf(strict, 'unk'), /unknown/);
  assert.match(reasonOf(strict, 'unv'), /not verified/);
  const allowed = optimize(opps, ests, { goal: 'max_net_income', constraints: { allowUnknownRegulatory: true } });
  assert.deepEqual(allowed.selected, ['ok', 'unk', 'unv']);
  assert.match(reasonOf(allowed, 'ban'), /Prohibited/);
});

test('investments (permit/construction) are separated unless includeInvestments', () => {
  const opps = [o('now'), o('adu', { basis: 'construction' }), o('str', { basis: 'permit' })];
  const ests = byId([est('now', { noi: 100 }), est('adu', { noi: 9000, up: 1000 }), est('str', { noi: 500 })]);
  const r = optimize(opps, ests, { goal: 'max_net_income' });
  assert.deepEqual(r.selected, ['now']);
  assert.deepEqual(r.investments, ['adu', 'str']);
  assert.match(reasonOf(r, 'adu'), /Investment \(construction\)/);
  assert.equal(r.naiveSumNoiCentsPerYear, 9600);
  const all = optimize(opps, ests, { goal: 'max_net_income', constraints: { includeInvestments: true } });
  assert.deepEqual(all.selected, ['adu', 'now', 'str']);
  assert.deepEqual(all.investments, []);
});

test('unavailable or missing estimate => rejected with reason, not in the naive sum', () => {
  const opps = [o('a'), o('b'), o('c')];
  const r = optimize(opps, { a: est('a', { noi: 10 }), b: unavailableEst('b') }, { goal: 'max_net_income' });
  assert.deepEqual(r.selected, ['a']);
  assert.match(reasonOf(r, 'b'), /Estimate unavailable: missing priceCents/);
  assert.match(reasonOf(r, 'c'), /No estimate/);
  assert.equal(r.naiveSumNoiCentsPerYear, 10);
});

test('unknown upfront: allowed for max_net_income, rejected for min_upfront / fastest_payback / maxUpfrontCents', () => {
  const opps = [o('u')];
  const ests = byId([est('u', { noi: 1000, upUnknown: true })]);
  const m = optimize(opps, ests, { goal: 'max_net_income' });
  assert.deepEqual(m.selected, ['u']);
  assert.equal(m.totals.paybackMonths, null);
  for (const args of [{ goal: 'min_upfront' }, { goal: 'fastest_payback' }, { goal: 'max_net_income', constraints: { maxUpfrontCents: 5 } }]) {
    const r = optimize(opps, ests, args);
    assert.deepEqual(r.selected, []);
    assert.match(reasonOf(r, 'u'), /Start-up cost is unknown/);
  }
});

test('negative-NOI opportunity is left out with a reason', () => {
  const r = optimize([o('loss'), o('win')], byId([est('loss', { noi: -500 }), est('win', { noi: 500 })]), { goal: 'max_net_income' });
  assert.deepEqual(r.selected, ['win']);
  assert.match(reasonOf(r, 'loss'), /not positive/);
});

// ---------- conflicts, ties, scenario ----------

test('conflictsWith is symmetrised (only the second lists the first)', () => {
  const opps = [o('x'), o('y', { conflictsWith: ['x'] })];
  const r = optimize(opps, byId([est('x', { noi: 100 }), est('y', { noi: 90 })]), { goal: 'max_net_income' });
  assert.deepEqual(r.selected, ['x']);
  assert.match(reasonOf(r, 'y'), /Conflicts with x/);
});

test('tie-break 1: equal objective => higher confidence', () => {
  const opps = [o('a', { conflictsWith: ['b'] }), o('b')];
  const r = optimize(opps, byId([est('a', { noi: 100, conf: 0.1 }), est('b', { noi: 100, conf: 0.2 })]), { goal: 'max_net_income' });
  assert.deepEqual(r.selected, ['b']);
  assert.equal(r.confidence, 0.2);
});

test('tie-break 2: equal objective and confidence => fewer opportunities', () => {
  const opps = [o('a', { conflictsWith: ['m', 'n'] }), o('m'), o('n')];
  const r = optimize(opps, byId([est('a', { noi: 100 }), est('m', { noi: 50 }), est('n', { noi: 50 })]), { goal: 'max_net_income' });
  assert.deepEqual(r.selected, ['a']);
});

test('tie-break 3: otherwise ids alphabetically; input order does not matter', () => {
  const opps = [o('q', { conflictsWith: ['p'] }), o('p')];
  const ests = byId([est('p', { noi: 100 }), est('q', { noi: 100 })]);
  assert.deepEqual(optimize(opps, ests, { goal: 'max_net_income' }).selected, ['p']);
  assert.deepEqual(optimize([...opps].reverse(), ests, { goal: 'max_net_income' }), optimize(opps, ests, { goal: 'max_net_income' }));
});

test('scenario selects which ScenarioResult is optimized', () => {
  const opps = [o('a', { conflictsWith: ['b'] }), o('b')];
  const ests = byId([est('a', { noi: 100, byScenario: { conservative: 10 } }), est('b', { noi: 90, byScenario: { conservative: 60 } })]);
  assert.deepEqual(optimize(opps, ests, { goal: 'max_net_income', scenario: 'baseline' }).selected, ['a']);
  const c = optimize(opps, ests, { goal: 'max_net_income', scenario: 'conservative' });
  assert.deepEqual(c.selected, ['b']);
  assert.equal(c.naiveSumNoiCentsPerYear, 70);
});

// ---------- edges ----------

test('empty input => empty selection with zero totals', () => {
  const r = optimize([], {}, { goal: 'max_net_income' });
  assert.deepEqual(r.selected, []);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.investments, []);
  assert.deepEqual(r.totals, { noiCentsPerMonth: 0, noiCentsPerYear: 0, grossCentsPerYear: 0, upfrontCents: 0, paybackMonths: null, effort: 0, privacyImpact: 0 });
  assert.equal(r.naiveSumNoiCentsPerYear, 0);
  assert.equal(r.confidence, 0);
});

test('more than 20 selectable opportunities throws; filtered-out ones do not count', () => {
  const opps = Array.from({ length: 21 }, (_, i) => o(`o${String(i).padStart(2, '0')}`));
  const ests = byId(opps.map((x) => est(x.id, { noi: 1 })));
  assert.throws(() => optimize(opps, ests, { goal: 'max_net_income' }), /21 selectable opportunities exceed the limit of 20/);
  const r = optimize(opps, ests, { goal: 'max_net_income', constraints: { excludedCategories: ['o00'] } });
  assert.equal(r.selected.length, 20);
});

test('invalid goal / scenario / duplicate ids throw clear errors', () => {
  assert.throws(() => optimize([], {}, { goal: 'most' }), /unknown goal most/);
  assert.throws(() => optimize([], {}, { goal: 'privacy', scenario: 'best' }), /unknown scenario/);
  assert.throws(() => optimize([o('a'), o('a')], {}, { goal: 'privacy' }), /duplicate opportunity id a/);
});

test('determinism and immutability of optimizer inputs', () => {
  const freeze = (x) => { if (x && typeof x === 'object') { Object.freeze(x); Object.values(x).forEach(freeze); } return x; };
  const opps = freeze(structuredClone(SHARED));
  const ests = freeze(structuredClone(SHARED_EST));
  const a = optimize(opps, ests, { goal: 'min_upfront', constraints: freeze({ resourceCapacity: { parking: 1 } }) });
  const b = optimize(opps, ests, { goal: 'min_upfront', constraints: { resourceCapacity: { parking: 1 } } });
  assert.deepEqual(a, b);
  assert.deepEqual(opps, SHARED);
});

// ---------- brute-force cross-check ----------

test('brute-force cross-check on an enumerated 8-opportunity fixture, every goal', () => {
  // Deterministic, random-free fixture: values from simple modular arithmetic.
  const opps = []; const ests = {};
  for (let i = 0; i < 8; i++) {
    const id = `k${i}`;
    opps.push(o(id, {
      effort: 1 + (i % 4), privacyImpact: i % 3, strangersInHome: i === 5,
      conflictsWith: i % 3 === 0 && i + 1 < 8 ? [`k${i + 1}`] : [],
      resourceUse: i % 2 === 0 ? { parking: 1 } : {},
    }));
    ests[id] = est(id, { noi: ((i * 37) % 11) * 10000 - 15000, up: ((i * 5) % 4) * 25000, conf: 0.1 + (i % 2) * 0.1 });
  }
  const cap = { parking: 2 };
  const goals = ['max_net_income', 'min_upfront', 'min_effort', 'privacy', 'fastest_payback'];
  for (const goal of goals) {
    const allowed = opps.filter((x) => (goal !== 'min_effort' || x.effort <= 2) && (goal !== 'privacy' || (x.privacyImpact <= 1 && !x.strangersInHome)));
    let bestScore = null;
    for (let mask = 0; mask < 1 << allowed.length; mask++) {
      const set = allowed.filter((_, j) => mask & (1 << j));
      const idsIn = new Set(set.map((x) => x.id));
      if (set.some((x) => x.conflictsWith.some((c) => idsIn.has(c)) || opps.some((y) => idsIn.has(y.id) && y.conflictsWith.includes(x.id)))) continue;
      if (set.reduce((t, x) => t + (x.resourceUse.parking ?? 0), 0) > cap.parking) continue;
      const noi = set.reduce((t, x) => t + ests[x.id].scenarios.baseline.noiCentsPerYear, 0);
      const up = set.reduce((t, x) => t + ests[x.id].scenarios.baseline.upfrontCents, 0);
      const score = goal === 'min_upfront' ? [noi - up] : goal === 'fastest_payback' ? [noi > 0 ? -(up / (noi / 12)) : -Infinity, noi] : [noi];
      if (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && (score[1] ?? 0) > (bestScore[1] ?? 0))) bestScore = score;
    }
    const r = optimize(opps, ests, { goal, constraints: { resourceCapacity: cap } });
    const sel = r.selected;
    const noi = sel.reduce((t, id) => t + ests[id].scenarios.baseline.noiCentsPerYear, 0);
    const up = sel.reduce((t, id) => t + ests[id].scenarios.baseline.upfrontCents, 0);
    const got = goal === 'min_upfront' ? [noi - up] : goal === 'fastest_payback' ? [noi > 0 ? -(up / (noi / 12)) : -Infinity, noi] : [noi];
    assert.deepEqual(got, bestScore, goal);
    // the selection itself is feasible
    const s = new Set(sel);
    assert.ok(sel.every((id) => !opps.find((x) => x.id === id).conflictsWith.some((c) => s.has(c))), goal);
    assert.ok(sel.reduce((t, id) => t + (opps.find((x) => x.id === id).resourceUse.parking ?? 0), 0) <= 2, goal);
    assert.equal(r.selected.length + r.rejected.length, 8, goal);
  }
});

// ---------- end to end with the real revenue model ----------

test('end to end: real estimates, conflicting stay vs pool, parking capacity', () => {
  const NOW = '2026-11-24T00:00:00Z';
  const mk = (id, categoryKey, unit, over = {}) => o(id, { categoryKey, unit, ...over });
  const opps = [
    mk('entire_home', 'entire_home', 'night', { conflictsWith: ['pool'], effort: 4, privacyImpact: 3, strangersInHome: true }),
    mk('pool', 'pool', 'hour', { effort: 3, privacyImpact: 2 }),
    mk('parking_spot', 'parking_spot', 'month', { resourceUse: { parking: 1 } }),
    mk('pool_by_day', 'pool', 'day'),
  ];
  const ests = {};
  for (const x of opps) {
    let i = defaultInputs(x, null);
    if (x.id === 'pool') i = withOverrides(i, { upfrontCents: 0 }, NOW);
    ests[x.id] = estimateOpportunity(x, i);
  }
  const r = optimize(opps, ests, { goal: 'max_net_income', constraints: { resourceCapacity: { parking: 1 } } });
  // entire_home baseline: 18000 x 16 = 288000/month, airbnb 15.5% = 44640 -> NOI 243360/month
  assert.equal(ests.entire_home.scenarios.baseline.noiCentsPerYear, 243360 * 12);
  // parking_spot baseline: 13000 x 0.75 = 9750, neighbor 4.9% = round(477.75) = 478 -> 9272/month
  assert.equal(ests.parking_spot.scenarios.baseline.noiCentsPerYear, 9272 * 12);
  assert.deepEqual(r.selected, ['entire_home', 'parking_spot']);
  assert.match(reasonOf(r, 'pool'), /Conflicts with entire_home/);
  assert.match(reasonOf(r, 'pool_by_day'), /Estimate unavailable/);
  assert.equal(r.naiveSumNoiCentsPerYear, (243360 + 9272 + 54400) * 12);
  assert.equal(r.confidence, 0.15);
});

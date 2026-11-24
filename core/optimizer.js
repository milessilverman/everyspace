// @ts-check
// Combination optimizer (docs/revenue-method.md §7): exhaustive search over feasible subsets, not a sum.
// Pure and deterministic: candidates are sorted by id, every subset is enumerated, ties break on
// higher confidence -> more preferred-category members -> fewer opportunities -> ids alphabetically.

import { SCENARIO_NAMES } from './data/scenarios.js';

/** @typedef {import('./types.js').Opportunity} Opportunity */
/** @typedef {import('./types.js').OpportunityEstimate} OpportunityEstimate */
/** @typedef {import('./types.js').OwnerGoal} OwnerGoal */
/** @typedef {import('./types.js').OwnerConstraints} OwnerConstraints */
/** @typedef {import('./types.js').OptimizationResult} OptimizationResult */
/** @typedef {import('./types.js').ScenarioName} ScenarioName */

export const MAX_SELECTABLE = 20;
export const GOALS = Object.freeze(['max_net_income', 'min_upfront', 'min_effort', 'privacy', 'fastest_payback']);
const MIN_EFFORT_DEFAULT = 2; // §7 min_effort
const PRIVACY_MAX_IMPACT = 1; // §7 privacy

/** @param {number} x */
function round1(x) { const a = Math.abs(x); const r = Math.floor(a * 10 + 0.5 + 1e-9) / 10; return r === 0 ? 0 : Math.sign(x) * r; }
/** @param {number} x */
function roundInt(x) { const a = Math.abs(x); const r = Math.floor(a + 0.5 + 1e-9); return r === 0 ? 0 : Math.sign(x) * r; }

/**
 * @param {Opportunity[]} opportunities
 * @param {Record<string, OpportunityEstimate>} estimatesById
 * @param {{goal: OwnerGoal, constraints?: OwnerConstraints, scenario?: ScenarioName}} options
 * @returns {OptimizationResult}
 */
export function optimize(opportunities, estimatesById, options) {
  const { goal, constraints = {}, scenario = 'baseline' } = options ?? /** @type {any} */ ({});
  if (!GOALS.includes(goal)) throw new Error(`optimize: unknown goal ${String(goal)} (expected one of ${GOALS.join(', ')})`);
  if (!SCENARIO_NAMES.includes(scenario)) throw new Error(`optimize: unknown scenario ${String(scenario)}`);
  if (!Array.isArray(opportunities)) throw new Error('optimize: opportunities must be an array');
  const estimates = estimatesById ?? {};
  const c = constraints;

  const opps = [...opportunities].sort((a, b) => cmpStr(a.id, b.id));
  for (let i = 1; i < opps.length; i++) if (opps[i].id === opps[i - 1].id) throw new Error(`optimize: duplicate opportunity id ${opps[i].id}`);
  const ids = new Set(opps.map((o) => o.id));

  // Symmetrised conflicts.
  /** @type {Map<string, Set<string>>} */
  const conflicts = new Map(opps.map((o) => [o.id, new Set()]));
  for (const o of opps) {
    for (const other of o.conflictsWith ?? []) {
      if (other === o.id || !ids.has(other)) continue;
      conflicts.get(o.id)?.add(other); conflicts.get(other)?.add(o.id);
    }
  }

  /** @param {string} id */
  const est = (id) => (Object.prototype.hasOwnProperty.call(estimates, id) ? estimates[id] : undefined);
  /** @param {string} id */
  const result = (id) => /** @type {NonNullable<OpportunityEstimate['scenarios']>} */ (est(id)?.scenarios)[scenario];

  let naive = 0;
  for (const o of opps) { const e = est(o.id); if (e?.available && e.scenarios) naive += e.scenarios[scenario].noiCentsPerYear; }

  const capacity = c.resourceCapacity ?? {};
  const preferred = new Set(c.preferredCategories ?? []);
  const excluded = new Set(c.excludedCategories ?? []);
  const effortCap = goal === 'min_effort' ? (c.maxEffort ?? MIN_EFFORT_DEFAULT) : c.maxEffort;
  const needsUpfront = goal === 'min_upfront' || goal === 'fastest_payback' || c.maxUpfrontCents !== undefined;

  /** @type {Array<{id:string, reason:string}>} */
  const rejected = [];
  /** @type {string[]} */
  const investments = [];
  /** @type {Opportunity[]} */
  const candidates = [];

  for (const o of opps) {
    const e = est(o.id);
    const reason = prefilter(o, e);
    if (reason) rejected.push({ id: o.id, reason }); else candidates.push(o);
  }

  /** @param {Opportunity} o @param {OpportunityEstimate|undefined} e @returns {string|null} */
  function prefilter(o, e) {
    if ((o.basis === 'permit' || o.basis === 'construction') && !c.includeInvestments) {
      investments.push(o.id);
      return `Investment (${o.basis}): evaluated separately, not part of the existing-asset combination`;
    }
    if (!e) return 'No estimate was provided';
    if (!e.available || !e.scenarios) return `Estimate unavailable: missing ${e.missing.join(', ') || 'required inputs'}`;
    const st = o.feasibility?.status ?? 'unknown';
    if (st === 'prohibited') return 'Prohibited by local rules';
    if (st === 'unknown' && !c.allowUnknownRegulatory) return 'Regulatory status unknown: check local rules (not selected unless you allow it)';
    if ((o.feasibility?.rules ?? []).some((r) => !r.verified) && !c.allowUnknownRegulatory) {
      return 'Local rules not verified yet: check local rules (not selected unless you allow it)';
    }
    if (excluded.has(o.categoryKey)) return `Category ${o.categoryKey} is excluded by you`;
    if (c.onlyPreferred && !preferred.has(o.categoryKey)) return `Category ${o.categoryKey} is not in your preferred categories`;
    if (effortCap !== undefined && o.effort > effortCap) {
      return `Effort ${o.effort} is above the limit of ${effortCap}${goal === 'min_effort' && c.maxEffort === undefined ? ' for the low-effort goal' : ''}`;
    }
    if (c.maxPrivacyImpact !== undefined && o.privacyImpact > c.maxPrivacyImpact) return `Privacy impact ${o.privacyImpact} is above your limit of ${c.maxPrivacyImpact}`;
    if (c.noStrangersInHome && o.strangersInHome) return 'Brings strangers into the home, which you ruled out';
    if (goal === 'privacy') {
      if (o.privacyImpact > PRIVACY_MAX_IMPACT) return `Privacy impact ${o.privacyImpact} is above ${PRIVACY_MAX_IMPACT} for the privacy goal`;
      if (o.strangersInHome) return 'Brings strangers into the home (privacy goal)';
    }
    if (needsUpfront && e.inputs.upfrontCents.tag === 'unavailable') return 'Start-up cost is unknown, so it cannot be checked against the upfront goal or limit';
    const r = e.scenarios[scenario];
    if (c.maxUpfrontCents !== undefined && r.upfrontCents > c.maxUpfrontCents) return `Start-up cost ${r.upfrontCents} cents is above your limit of ${c.maxUpfrontCents} cents`;
    for (const [res, n] of Object.entries(o.resourceUse ?? {})) {
      if (Object.prototype.hasOwnProperty.call(capacity, res) && n > capacity[res]) return `Needs ${n} ${res} but only ${capacity[res]} available`;
    }
    return null;
  }

  if (candidates.length > MAX_SELECTABLE) {
    throw new Error(`optimize: ${candidates.length} selectable opportunities exceed the limit of ${MAX_SELECTABLE} for exhaustive search`);
  }

  const n = candidates.length;
  const data = candidates.map((o, i) => {
    const r = result(o.id);
    let conflictMask = 0;
    candidates.forEach((p, j) => { if (conflicts.get(o.id)?.has(p.id)) conflictMask |= 1 << j; });
    return {
      o, i, noi: r.noiCentsPerYear, gross: r.grossCentsPerYear, upfront: r.upfrontCents,
      upfrontKnown: /** @type {OpportunityEstimate} */ (est(o.id)).inputs.upfrontCents.tag !== 'unavailable',
      conf: /** @type {OpportunityEstimate} */ (est(o.id)).confidence, conflictMask, pref: preferred.has(o.categoryKey) ? 1 : 0,
    };
  });
  const resources = [...new Set(candidates.flatMap((o) => Object.keys(o.resourceUse ?? {})))].filter((k) => Object.prototype.hasOwnProperty.call(capacity, k)).sort();

  /** @param {number} mask */
  function evaluate(mask) {
    let noi = 0; let upfront = 0; let conf = Infinity; let pref = 0; let count = 0;
    /** @type {Record<string, number>} */ const used = {};
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const d = data[i];
      if (d.conflictMask & mask) return null;
      for (const res of resources) used[res] = (used[res] ?? 0) + (d.o.resourceUse?.[res] ?? 0);
      noi += d.noi; upfront += d.upfront; conf = Math.min(conf, d.conf); pref += d.pref; count++;
    }
    for (const res of resources) if ((used[res] ?? 0) > capacity[res]) return null;
    if (!count) conf = 0;
    return { mask, noi, upfront, conf, pref, count };
  }

  /** Primary objective as [value, higherIsBetter]. @param {{noi:number, upfront:number, count:number}} s */
  function primary(s) {
    if (goal === 'min_upfront') return [s.noi - s.upfront];
    if (goal === 'fastest_payback') {
      // lower payback is better; nothing / non-positive NOI ranks last; zero upfront with positive NOI = 0 months
      const pb = s.noi > 0 ? s.upfront / (s.noi / 12) : Infinity;
      return [-pb, s.noi];
    }
    return [s.noi];
  }

  /** @param {any} a @param {any} b  negative when a is better */
  function better(a, b) {
    const pa = primary(a); const pb = primary(b);
    for (let k = 0; k < pa.length; k++) if (pa[k] !== pb[k]) return pa[k] > pb[k] ? -1 : 1;
    if (a.conf !== b.conf) return a.conf > b.conf ? -1 : 1;
    if (a.pref !== b.pref) return a.pref > b.pref ? -1 : 1;
    if (a.count !== b.count) return a.count < b.count ? -1 : 1;
    return cmpIdLists(maskIds(a.mask), maskIds(b.mask));
  }
  /** @param {number} mask */
  function maskIds(mask) { return data.filter((d) => mask & (1 << d.i)).map((d) => d.o.id); }

  let best = /** @type {any} */ (evaluate(0));
  const total = 2 ** n;
  for (let mask = 1; mask < total; mask++) {
    const s = evaluate(mask);
    if (s && better(s, best) < 0) best = s;
  }

  const selected = maskIds(best.mask);
  const selSet = new Set(selected);
  for (const d of data) {
    if (selSet.has(d.o.id)) continue;
    rejected.push({ id: d.o.id, reason: whyNotSelected(d) });
  }

  /** @param {typeof data[number]} d */
  function whyNotSelected(d) {
    const rivals = selected.filter((id) => conflicts.get(d.o.id)?.has(id));
    if (rivals.length) return `Conflicts with ${rivals.join(', ')}, which scores better for this goal`;
    for (const res of Object.keys(d.o.resourceUse ?? {})) {
      if (!resources.includes(res)) continue;
      const usedBy = data.filter((x) => selSet.has(x.o.id));
      const usedAmt = usedBy.reduce((t, x) => t + (x.o.resourceUse?.[res] ?? 0), 0);
      if (usedAmt + (d.o.resourceUse?.[res] ?? 0) > capacity[res]) {
        return `Not enough ${res}: ${capacity[res]} available and the selected ${usedBy.filter((x) => x.o.resourceUse?.[res]).map((x) => x.o.id).join(', ')} use ${usedAmt}`;
      }
    }
    if (d.noi <= 0) return `Net income is not positive in the ${scenario} scenario`;
    return `Not part of the best combination for ${goal}`;
  }

  const chosen = data.filter((d) => selSet.has(d.o.id));
  const noiYear = chosen.reduce((t, d) => t + d.noi, 0);
  const grossYear = chosen.reduce((t, d) => t + d.gross, 0);
  const upfront = chosen.reduce((t, d) => t + d.upfront, 0);
  const allUpfrontKnown = chosen.every((d) => d.upfrontKnown);
  rejected.sort((a, b) => cmpStr(a.id, b.id));

  return {
    goal,
    scenario,
    selected,
    rejected,
    totals: {
      noiCentsPerMonth: roundInt(noiYear / 12),
      noiCentsPerYear: noiYear,
      grossCentsPerYear: grossYear,
      upfrontCents: upfront,
      paybackMonths: allUpfrontKnown && upfront > 0 && noiYear > 0 ? round1(upfront / (noiYear / 12)) : null,
      effort: chosen.reduce((t, d) => t + d.o.effort, 0),
      privacyImpact: chosen.reduce((t, d) => Math.max(t, d.o.privacyImpact), 0),
    },
    investments: [...investments].sort(cmpStr),
    naiveSumNoiCentsPerYear: naive,
    confidence: chosen.length ? Math.min(...chosen.map((d) => d.conf)) : 0,
  };
}

/** @param {string} a @param {string} b */
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
/** @param {string[]} a @param {string[]} b */
function cmpIdLists(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) { const x = cmpStr(a[i], b[i]); if (x) return x; }
  return a.length - b.length;
}

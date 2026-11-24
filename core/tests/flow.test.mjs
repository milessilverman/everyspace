// End-to-end flow of the public estimator, pure (no browser, no network): the same pipeline the /estimate page runs,
// driven only by the recorded parcel fixtures. Address -> parcel -> profile -> opportunities -> estimates -> best combination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveAddress, BROWSER_GEOCODERS } from '../parcel.js';
import { applyOwnerCorrection, summarize as summarizeProfile } from '../profile.js';
import { identifyOpportunities, missingEvidence, defaultResourceCapacity } from '../opportunities.js';
import { defaultInputs, withOverrides, estimateOpportunity, summarize } from '../revenue.js';
import { optimize, GOALS } from '../optimizer.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/parcel/${n}`, import.meta.url), 'utf8'));
const NOW = '2026-11-24T12:00:00Z';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const isBuffered = (url) => url.includes('distance=');
const SCEN = ['conservative', 'baseline', 'optimistic'];

const VENICE = '99999 Venice Blvd, Los Angeles, CA 90034';
const SPRING_S = '200 S Spring St, Los Angeles, CA 90012';
const SPRING_N = '200 N Spring St, Los Angeles, CA 90012'; // Nominatim finds the SOUTH street: a different place

/** A Nominatim answer (jsonv2) for the recorded Spring St point. */
const nominatimSpring = () => {
  const [r] = fx('nominatim-la.json');
  return [{ ...r, lat: '34.051622610747', lon: '-118.245593523439', display_name: '200, South Spring Street, Los Angeles, California, 90012, United States',
    address: { ...r.address, house_number: '200', road: 'South Spring Street', postcode: '90012' } }];
};

/** Mock router in the browser's shape: Nominatim only (no Census), county service, Overpass. Anything else throws. */
function mockFetch() {
  const calls = [];
  const f = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('nominatim.openstreetmap.org')) return json(decodeURIComponent(u).includes('Spring') ? nominatimSpring() : fx('nominatim-la.json'));
    if (u.includes('lacounty.gov')) {
      if (decodeURIComponent(u).includes('-118.2455')) return json(isBuffered(u) ? fx('arcgis-la-buffer-spring-st-recorded.json') : fx('arcgis-empty.json'));
      return json(fx('arcgis-la-parcel.json'));
    }
    if (u.includes('overpass')) return json(decodeURIComponent(u).includes('34.0516') ? fx('overpass-no-features.json') : fx('overpass-la.json'));
    throw new Error(`unmocked request ${u}`);
  };
  f.calls = calls;
  return f;
}
/** Every lookup fails. */
const failingFetch = () => async () => json({}, 503);

const resolve = (address, f, extra = {}) => resolveAddress(address, { fetch: f, now: NOW, geocoders: BROWSER_GEOCODERS, nowMs: () => Date.parse(NOW), sleep: async () => {}, ...extra });

/** The page's pipeline, step for step. */
function pipeline(profile, { overrides = {}, includeInvestmentIdeas = false, goal = 'max_net_income', constraints = {}, scenario = 'baseline' } = {}) {
  const opps = identifyOpportunities(profile, { now: NOW, includeInvestmentIdeas });
  const estimates = {};
  for (const o of opps) {
    let inputs = defaultInputs(o, profile);
    if (overrides[o.id]) inputs = withOverrides(inputs, overrides[o.id], NOW);
    estimates[o.id] = estimateOpportunity(o, inputs);
  }
  const opt = optimize(opps, estimates, { goal, scenario, constraints: { allowUnknownRegulatory: true, resourceCapacity: defaultResourceCapacity(profile), ...constraints } });
  return { opps, estimates, opt };
}
const owner = (profile, pairs) => pairs.reduce((p, [k, v, u]) => applyOwnerCorrection(p, k, v, NOW, u), profile);
const ids = (opps) => opps.map((o) => o.id);

test('no test in this file may reach the real network', () => {
  globalThis.fetch = () => { throw new Error('real network is forbidden in tests'); };
});

// ---- (i) residential happy path -----------------------------------------------------------------------------------

test('(i) happy path: address -> parcel -> provenance-tagged profile -> opportunities -> three-scenario estimates -> combination', async () => {
  const f = mockFetch();
  const r = await resolve(VENICE, f);
  assert.equal(r.ok, true);
  assert.equal(r.needsConfirmation, undefined);
  assert.deepEqual(r.steps.map((s) => [s.step, s.ok]), [['geocode', true], ['parcel', true], ['buildings', true], ['pool', true], ['transit', true]]);
  assert.equal(f.calls.some((u) => u.includes('census.gov')), false, 'a browser never calls Census');

  const rows = summarizeProfile(r.profile);
  assert.ok(rows.length >= 20);
  for (const row of rows) { assert.ok(['measured', 'estimated', 'owner-confirmed', 'unavailable'].includes(row.tag)); assert.ok(['low', 'medium', 'high'].includes(row.confidenceLabel)); }
  const row = (k) => rows.find((x) => x.key === k);
  assert.equal(row('parcel_id').tag, 'measured');
  assert.equal(row('property_type').value, 'single_family');
  assert.equal(row('pool_present').tag, 'estimated');
  assert.equal(row('parking_spaces').tag, 'unavailable', 'parking is never invented');

  const { opps, estimates, opt } = pipeline(r.profile);
  assert.ok(opps.length >= 4, `found ${ids(opps)}`);
  assert.ok(ids(opps).includes('pool') && ids(opps).includes('backyard'));
  for (const o of opps) {
    const e = estimates[o.id];
    assert.equal(e.available, true, o.id);
    assert.deepEqual(Object.keys(e.scenarios), SCEN);
    assert.ok(e.scenarios.conservative.grossCentsPerYear <= e.scenarios.baseline.grossCentsPerYear, o.id);
    assert.ok(e.scenarios.baseline.grossCentsPerYear <= e.scenarios.optimistic.grossCentsPerYear, o.id);
    assert.equal(Number.isInteger(e.scenarios.baseline.noiCentsPerYear), true, 'integer cents');
  }
  assert.ok(opt.selected.length >= 1);
  const base = summarize(estimates, opt.selected, 'baseline');
  assert.equal(base.noiCentsPerYear, opt.totals.noiCentsPerYear, 'summarize and optimize agree on the baseline total');
  const cons = summarize(estimates, opt.selected, 'conservative'), optim = summarize(estimates, opt.selected, 'optimistic');
  assert.ok(cons.grossCentsPerYear < base.grossCentsPerYear && base.grossCentsPerYear < optim.grossCentsPerYear);
});

// ---- (ii) street mismatch -> confirm -> continue ------------------------------------------------------------------

test('(ii) street mismatch: nothing parcel-related is looked up until the owner confirms; then the flow continues', async () => {
  const f = mockFetch();
  const first = await resolve(SPRING_N, f);
  assert.equal(first.needsConfirmation, true);
  assert.equal(first.ok, false);
  assert.match(first.matchedAddress, /South Spring Street/);
  assert.equal(f.calls.some((u) => u.includes('lacounty') || u.includes('overpass')), false, 'no parcel or OSM request before confirmation');
  assert.deepEqual(Object.keys(first.profile.attributes).sort(), ['address', 'jurisdiction', 'location']);

  const confirmed = await resolve(SPRING_N, f, { confirmMatchedAddress: true });
  assert.equal(confirmed.needsConfirmation, undefined);
  assert.equal(f.calls.some((u) => u.includes('lacounty')), true, 'after confirmation the parcel service is asked');
  assert.equal(confirmed.ok, false, 'no parcel could be chosen by address');
  assert.equal(confirmed.candidates.length, 10, 'so the owner is asked to choose');
});

// ---- (iii) candidates -> pick by APN ------------------------------------------------------------------------------

test('(iii) buffered candidates: the owner picks a parcel by APN and the profile carries it as owner-confirmed', async () => {
  const f = mockFetch();
  const first = await resolve(SPRING_S, f);
  assert.equal(first.ok, false);
  assert.equal(first.needsConfirmation, undefined);
  assert.ok(first.candidates.length >= 2 && first.candidates.length <= 10);
  assert.deepEqual(Object.keys(first.candidates[0]).sort(), ['address', 'apn']);
  assert.equal(first.steps.find((s) => s.step === 'parcel').ok, false);

  const apn = '5149007006';
  assert.ok(first.candidates.some((c) => c.apn === apn));
  const picked = await resolve(SPRING_S, f, { parcelApn: apn });
  assert.equal(picked.ok, true);
  const id = picked.profile.attributes.parcel_id;
  assert.deepEqual([id.value, id.tag, id.confidence], [apn, 'owner-confirmed', 1]);
  assert.equal(picked.profile.attributes.property_type.value, 'commercial');

  const { opps, estimates } = pipeline(picked.profile);
  assert.ok(ids(opps).includes('entire_home') || opps.length > 0);
  for (const o of opps) assert.ok(estimates[o.id], o.id);
});

// ---- (iv) every lookup fails -> manual mode -----------------------------------------------------------------------

test('(iv) every lookup failing: nothing is invented, and owner-confirmed basics still give estimates', async () => {
  const r = await resolve(VENICE, failingFetch());
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirmation, undefined);
  assert.equal(r.candidates, undefined);
  assert.equal(r.steps[0].step, 'geocode');
  assert.equal(r.steps[0].ok, false);
  assert.match(r.steps[0].reason, /could not geocode/);
  for (const row of summarizeProfile(r.profile)) { assert.equal(row.tag, 'unavailable', row.key); assert.equal(row.value, null, row.key); }

  const empty = pipeline(r.profile);
  assert.deepEqual(empty.opps, [], 'with nothing known there are no opportunities, not made-up ones');
  assert.ok(missingEvidence(r.profile).length > 0, 'and the owner is asked instead');

  const p = owner(r.profile, [['property_type', 'single_family'], ['bedrooms', 3], ['pool_present', true], ['parking_spaces', 2], ['garage_present', true], ['yard_area_sqft', 1200, 'sqft']]);
  const { opps, estimates, opt } = pipeline(p);
  for (const k of ['pool', 'parking_spot', 'garage_storage', 'private_room', 'backyard']) assert.ok(ids(opps).includes(k), `${k} in ${ids(opps)}`);
  for (const o of opps) {
    assert.equal(o.evidence.every((k) => p.attributes[k].tag === 'owner-confirmed'), true, `${o.id} rests on owner-confirmed values`);
    if (o.id === 'parking_spot') continue;
    assert.equal(estimates[o.id].available, true, o.id);
  }
  // no default volume exists for parking, so no number is shown until the owner supplies one
  assert.equal(estimates.parking_spot.available, false);
  assert.equal(estimates.parking_spot.scenarios, null);
  assert.ok(estimates.parking_spot.missing.includes('unitsPerMonth'));
  const withVolume = pipeline(p, { overrides: { parking_spot: { unitsPerMonth: 60 } } });
  assert.equal(withVolume.estimates.parking_spot.available, true);
  assert.ok(opt.selected.length > 0);
  assert.equal(opt.totals.noiCentsPerYear > 0, true);
});

// ---- (v) owner correction changes the opportunity set -------------------------------------------------------------

test('(v) owner corrections (pool false, parking 2) change the opportunity set and the parking capacity', async () => {
  const r = await resolve(VENICE, mockFetch());
  const before = pipeline(r.profile);
  assert.ok(ids(before.opps).includes('pool'));
  assert.equal(ids(before.opps).includes('parking_spot'), false);
  assert.equal(defaultResourceCapacity(r.profile).parking, 0);

  const corrected = owner(r.profile, [['pool_present', false], ['parking_spaces', 2]]);
  const after = pipeline(corrected);
  assert.equal(ids(after.opps).includes('pool'), false, 'the pool is gone');
  assert.ok(ids(after.opps).includes('parking_spot'), 'the driveway spaces appear');
  assert.equal(defaultResourceCapacity(corrected).parking, 2);
  assert.equal(corrected.attributes.pool_present.tag, 'owner-confirmed');
  assert.equal(corrected.history.pool_present.length, 2, 'the automated value stays in the history');
  assert.notDeepEqual(ids(before.opps), ids(after.opps));
});

// ---- (vi) optimizer is never above the naive sum and never selects a conflicting pair ---------------------------

test('(vi) optimizer total <= naive sum, no selected pair conflicts, resources fit, for every goal', async () => {
  const r = await resolve(VENICE, mockFetch());
  const profile = owner(r.profile, [['parking_spaces', 2], ['garage_present', true], ['workspace_available', true], ['equipment_owned', ['kayak']]]);
  for (const includeInvestmentIdeas of [false, true]) {
    for (const goal of GOALS) {
      for (const unknownOk of [true, false]) {
        const { opps, estimates, opt } = pipeline(profile, { includeInvestmentIdeas, goal, constraints: { allowUnknownRegulatory: unknownOk } });
        const label = `${goal} unknownOk=${unknownOk} ideas=${includeInvestmentIdeas}`;
        assert.ok(opt.totals.noiCentsPerYear <= opt.naiveSumNoiCentsPerYear, label);
        const byId = Object.fromEntries(opps.map((o) => [o.id, o]));
        for (const a of opt.selected) for (const b of opt.selected) {
          if (a === b) continue;
          assert.equal(byId[a].conflictsWith.includes(b), false, `${label}: ${a} conflicts with ${b}`);
        }
        const cap = defaultResourceCapacity(profile);
        for (const res of Object.keys(cap)) assert.ok(opt.selected.reduce((t, id) => t + (byId[id].resourceUse[res] ?? 0), 0) <= cap[res], `${label}: ${res}`);
        if (!unknownOk) for (const id of opt.selected) assert.notEqual(byId[id].feasibility.status, 'unknown', label);
        const s = summarize(estimates, opt.selected, 'baseline');
        assert.equal(s.noiCentsPerYear, opt.totals.noiCentsPerYear, label);
      }
    }
  }
  // the realistic total is strictly lower than the naive sum when uses share space (pool, backyard, garden all use the yard)
  const base = pipeline(r.profile);
  assert.ok(base.opt.totals.noiCentsPerYear < base.opt.naiveSumNoiCentsPerYear);
});

// ---- (vii) default confidence is low -------------------------------------------------------------------------------

test('(vii) with default inputs every estimate is "low" confidence, in every flow', async () => {
  const happy = await resolve(VENICE, mockFetch());
  const manual = owner((await resolve(VENICE, failingFetch())).profile, [['property_type', 'multi_family'], ['units', 4], ['bedrooms', 4], ['parking_spaces', 3]]);
  const picked = await resolve(SPRING_S, mockFetch(), { parcelApn: '5149007006' });
  let n = 0;
  for (const profile of [happy.profile, manual, picked.profile]) {
    for (const includeInvestmentIdeas of [false, true]) {
      const { opps, estimates } = pipeline(profile, { includeInvestmentIdeas });
      for (const o of opps) {
        const e = estimates[o.id];
        if (!e.available) continue;
        n++;
        assert.equal(e.confidenceLabel, 'low', `${o.id}: ${e.confidence}`);
        assert.ok(e.confidence <= 0.2, `${o.id} defaults are capped at 0.2: ${e.confidence}`);
        assert.equal(e.inputs.priceCents.tag, 'estimated');
        assert.match(e.inputs.priceCents.source, /planning default \(uncited\)/);
      }
    }
  }
  assert.ok(n >= 10);
});

// ---- (viii) owner price + volume override -------------------------------------------------------------------------

test('(viii) an owner price+volume override raises confidence and narrows the scenario spread', async () => {
  const r = await resolve(VENICE, mockFetch());
  const base = pipeline(r.profile);
  const spread = (e) => (e.scenarios.optimistic.grossCentsPerYear - e.scenarios.conservative.grossCentsPerYear) / e.scenarios.baseline.grossCentsPerYear;
  const o = base.opps.find((x) => x.id === 'entire_home');
  assert.ok(o.feasibility.confidence > 0, 'this one has a rule on file, so confidence can rise');
  const over = { entire_home: { priceCents: 20000, unitsPerMonth: 10 }, pool: { priceCents: 4000, unitsPerMonth: 20 } };
  const after = pipeline(r.profile, { overrides: over });
  for (const id of ['entire_home', 'pool']) {
    const b = base.estimates[id], a = after.estimates[id];
    assert.equal(a.inputs.priceCents.tag, 'owner-confirmed');
    assert.equal(a.inputs.unitsPerMonth.tag, 'owner-confirmed');
    assert.ok(spread(a) < spread(b), `${id}: spread ${spread(a)} < ${spread(b)}`);
    assert.ok(a.confidence >= b.confidence, id);
    assert.ok(a.assumptions.every((x) => x.key !== 'priceCents' && x.key !== 'unitsPerMonth'), 'owner values are not listed as assumptions');
  }
  assert.ok(after.estimates.entire_home.confidence > base.estimates.entire_home.confidence, 'confidence rises where a rule is on file');
  // honest limit: where local rules are unknown, confidence is capped at 0.3 (the regulatory cap), not forced to 0
  assert.equal(after.opps.find((x) => x.id === 'pool').feasibility.status, 'unknown');
  assert.equal(after.estimates.pool.confidenceLabel, 'low');
  assert.equal(after.estimates.pool.confidence, 0.3);
  assert.ok(after.estimates.pool.confidence > base.estimates.pool.confidence, 'the owner\'s own price and volume count even where rules are unknown');
  assert.equal(after.estimates.pool.scenarios.baseline.grossCentsPerYear, 4000 * 20 * 12);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFeasibility, NO_RULES_NOTE, NOT_COVERED_NOTE, NO_CITY_NOTE, UNVERIFIED_NOTE, UNVERIFIED_CAP } from '../regulatory.js';
import { JURISDICTIONS, JURISDICTION_DEFAULTS } from '../data/jurisdictions.js';
import { CATEGORIES } from '../data/categories.js';

const NOW = '2026-11-24T00:00:00Z';
const S = (value, tag = 'measured', confidence = 0.9) => ({ value, tag, source: 'test', retrievedAt: null, confidence });
const LA = { country: 'US', state: 'CA', county: 'Los Angeles', city: 'Los Angeles' };
const prof = (j) => ({ attributes: j ? { jurisdiction: S(j) } : {}, history: {} });
const rule = (o) => ({ id: 'r', jurisdiction: null, categoryKeys: ['pool'], effect: 'allow', summary: 's', requirements: [], params: {}, verified: false, verifiedAt: null, sourceUrl: null, sourceRef: 'test', ...o });

test('no jurisdiction attribute => unknown, confidence 0, standard note', () => {
  const f = checkFeasibility('entire_home', prof(null), { now: NOW });
  assert.equal(f.status, 'unknown');
  assert.equal(f.confidence, 0);
  assert.equal(f.note, NO_RULES_NOTE);
});

test('unavailable jurisdiction attribute is treated as missing', () => {
  const p = { attributes: { jurisdiction: { value: null, tag: 'unavailable', source: 't', retrievedAt: null, confidence: 0 } }, history: {} };
  assert.equal(checkFeasibility('entire_home', p, { now: NOW }).status, 'unknown');
});

test('jurisdiction with no rules on file => unknown even though generic checklist exists', () => {
  const f = checkFeasibility('entire_home', prof({ state: 'TX', city: 'Austin' }), { now: NOW });
  assert.equal(f.status, 'unknown');
  assert.equal(f.note, NO_RULES_NOTE);
  assert.ok(f.requirements.includes('Host insurance'));
});

test('Los Angeles entire_home is restricted, unverified, confidence capped at 0.3', () => {
  const f = checkFeasibility('entire_home', prof(LA), { now: NOW });
  assert.equal(f.status, 'restricted');
  assert.ok(f.confidence <= UNVERIFIED_CAP && f.confidence > 0);
  // CHANGED: wording is now 'Rule text has not been verified against the official source.'
  assert.equal(f.note, UNVERIFIED_NOTE);
  assert.ok(f.rules.every((r) => r.verified === false));
  assert.ok(f.requirements.includes('Home-sharing registration number on every listing'));
  assert.ok(f.requirements.includes('Host insurance'));
});

test('LA pool: rule on file does not decide status', () => {
  const f = checkFeasibility('pool', prof(LA), { now: NOW });
  assert.equal(f.status, 'unknown');
  assert.equal(f.confidence, 0);
  assert.equal(f.note, 'Rules on file for this location do not cover this use; check with the city.');
  assert.ok(f.rules.some((r) => r.ruleId === 'us-ca-los-angeles/hourly-spaces'));
});

test('seeded data: every rule unverified with sourceRef, no sourceUrl', () => {
  for (const r of JURISDICTIONS) {
    assert.equal(r.verified, false, r.id);
    assert.equal(r.verifiedAt, null);
    assert.equal(r.sourceUrl, null);
    assert.match(r.sourceRef, /^(platform\/docs\/PLAN\.md|index\.html):\d+$/);
  }
});

test('defaults are unavailable, never a number', () => {
  for (const d of JURISDICTION_DEFAULTS) {
    assert.equal(d.taxRate.status, 'unavailable');
    assert.equal(d.taxRate.value, null);
    assert.equal(d.permitCentsPerYear.value, null);
  }
});

test('precedence: prohibit wins over restrict wins over allow within a level', () => {
  const j = { state: 'ZZ', city: 'Metro' };
  const base = { jurisdiction: j };
  const run = (effects) => checkFeasibility('pool', prof({ ...j }), { now: NOW, jurisdictions: effects.map((e, i) => rule({ ...base, id: 'x' + i, effect: e })) }).status;
  assert.equal(run(['allow', 'restrict']), 'restricted');
  assert.equal(run(['allow', 'restrict', 'prohibit']), 'prohibited');
  assert.equal(run(['allow']), 'feasible');
});

test('precedence: city beats county beats state beats generic', () => {
  const loc = { state: 'ZZ', county: 'Cty', city: 'Town' };
  const mk = (j, effect, id) => rule({ id, jurisdiction: j, effect });
  const st = (rules) => checkFeasibility('pool', prof(loc), { now: NOW, jurisdictions: rules }).status;
  assert.equal(st([mk({ state: 'ZZ' }, 'prohibit', 's'), mk({ state: 'ZZ', county: 'Cty' }, 'allow', 'c')]), 'feasible');
  assert.equal(st([mk({ state: 'ZZ', county: 'Cty' }, 'allow', 'c'), mk({ state: 'ZZ', county: 'Cty', city: 'Town' }, 'restrict', 't')]), 'restricted');
  assert.equal(st([mk(null, 'allow', 'g'), mk({ state: 'ZZ' }, 'prohibit', 's')]), 'prohibited');
});

test('rule for another city does not match', () => {
  const f = checkFeasibility('pool', prof({ state: 'ZZ', city: 'Town' }), { now: NOW, jurisdictions: [rule({ jurisdiction: { state: 'ZZ', city: 'Other' }, effect: 'prohibit' })] });
  assert.equal(f.status, 'unknown');
});

test('verified rule with recent verifiedAt lifts the cap; stale or missing date does not', () => {
  const j = { state: 'ZZ' };
  const mk = (extra) => checkFeasibility('pool', prof(j), { now: NOW, jurisdictions: [rule({ jurisdiction: j, verified: true, ...extra })] });
  assert.ok(mk({ verifiedAt: '2026-11-01T00:00:00Z' }).confidence > 0.3);
  assert.ok(mk({ verifiedAt: '2024-01-01T00:00:00Z' }).confidence <= 0.3);
  assert.ok(mk({ verifiedAt: null }).confidence <= 0.3);
});

test('requirements are de-duplicated union', () => {
  const j = { state: 'ZZ' };
  const f = checkFeasibility('pool', prof(j), { now: NOW, jurisdictions: [
    rule({ id: 'a', jurisdiction: j, requirements: ['A', 'B'] }), rule({ id: 'b', jurisdiction: j, requirements: ['B', 'C'] })] });
  assert.deepEqual(f.requirements, ['A', 'B', 'C']);
});

test('adding a jurisdiction needs only data (group-level rule, no code change)', () => {
  const rules = [...JURISDICTIONS, rule({ id: 'new/parking', jurisdiction: { state: 'NV', city: 'Reno' }, categoryKeys: undefined, groups: ['parking'], effect: 'prohibit', requirements: ['Permit X'] })];
  const f = checkFeasibility('rv_parking', prof({ state: 'NV', city: 'Reno' }), { now: NOW, jurisdictions: rules });
  assert.equal(f.status, 'prohibited');
  assert.ok(f.requirements.includes('Permit X'));
  assert.equal(checkFeasibility('pool', prof({ state: 'NV', city: 'Reno' }), { now: NOW, jurisdictions: rules }).status, 'unknown');
});

test('does not mutate inputs', () => {
  const p = prof(LA); Object.freeze(p.attributes); Object.freeze(p.attributes.jurisdiction);
  const rules = JSON.parse(JSON.stringify(JURISDICTIONS)); const snap = JSON.stringify(rules);
  checkFeasibility('entire_home', p, { now: NOW, jurisdictions: rules });
  assert.equal(JSON.stringify(rules), snap);
});

test('rules in output omit sourceUrl when null and carry it when present', () => {
  const j = { state: 'ZZ' };
  const f = checkFeasibility('pool', prof(j), { now: NOW, jurisdictions: [rule({ jurisdiction: j, sourceUrl: 'https://example.test/x' })] });
  assert.equal(f.rules[0].sourceUrl, 'https://example.test/x');
  const g = checkFeasibility('entire_home', prof(LA), { now: NOW });
  assert.ok(!('sourceUrl' in g.rules[0]));
});

test('every category with a checklist has a generic rule', () => {
  for (const c of CATEGORIES) {
    if (c.key === 'building') continue;
    assert.ok(JURISDICTIONS.some((r) => r.jurisdiction === null && r.categoryKeys?.includes(c.key)), c.key);
  }
});

// ---- jurisdiction normalisation (FIX-OPP) ----
const CENSUS_LA = { country: 'US', state: 'CA', countyFips: '06037', county: 'Los Angeles County', city: 'LOS ANGELES' };
const st = (j, key = 'entire_home', opts = {}) => checkFeasibility(key, prof(j), { now: NOW, ...opts });

test('city rule matches the Census spelling LOS ANGELES', () => {
  const f = st(CENSUS_LA);
  assert.equal(f.status, 'restricted');
  assert.ok(f.confidence > 0 && f.confidence <= UNVERIFIED_CAP);
  assert.ok(f.requirements.includes('Home-sharing registration number on every listing'));
});

test('city matching ignores case, outer and inner whitespace', () => {
  for (const city of ['LOS ANGELES', 'Los Angeles ', 'los angeles', '  Los   Angeles']) assert.equal(st({ ...LA, city }).status, 'restricted', JSON.stringify(city));
  assert.equal(st({ ...LA, city: 'Los Angeles Heights' }).status, 'unknown');
});

test('county matches with and without the word County', () => {
  for (const county of ['Los Angeles', 'Los Angeles County', 'los angeles county ', 'LOS ANGELES COUNTY']) assert.equal(st({ ...LA, county }).status, 'restricted', county);
  assert.equal(st({ ...LA, county: 'Orange County' }).status, 'unknown');
});

test('county FIPS matches when both sides carry it; a different FIPS does not', () => {
  const noName = { state: 'CA', countyFips: '06037', city: 'Los Angeles' };
  assert.equal(st(noName).status, 'restricted');
  assert.equal(st({ ...noName, county: 'Something Else' }).status, 'restricted', 'FIPS wins over a differing name');
  assert.equal(st({ ...noName, countyFips: '06059' }).status, 'unknown');
  // a rule that only carries a FIPS is county-scoped
  const rules = [rule({ id: 'f', jurisdiction: { state: 'CA', countyFips: '06037' }, effect: 'restrict' })];
  assert.equal(st({ state: 'CA', countyFips: '06037' }, 'pool', { jurisdictions: rules }).status, 'restricted');
  assert.equal(st({ state: 'CA', county: 'Los Angeles County' }, 'pool', { jurisdictions: rules }).status, 'unknown', 'FIPS-only rule cannot match by name');
});

test('state matching is case-insensitive', () => assert.equal(st({ ...LA, state: 'ca' }).status, 'restricted'));

test('no city: city-scoped rules are not applied and the note says why', () => {
  const f = st({ country: 'US', state: 'CA', countyFips: '06037', county: 'Los Angeles County' });
  assert.equal(f.status, 'unknown');
  assert.equal(f.confidence, 0);
  assert.equal(f.note, NO_CITY_NOTE);
  assert.equal(st({ ...LA, city: '   ' }).status, 'unknown');
  assert.equal(st({ ...LA, city: undefined }, 'pool').note, NO_CITY_NOTE);
});

test('no city but a county rule decides: status from the county, city omission noted', () => {
  const rules = [rule({ id: 'c', jurisdiction: { state: 'CA', countyFips: '06037' }, effect: 'prohibit', verified: true, verifiedAt: '2026-11-01T00:00:00Z' }),
    rule({ id: 'city', jurisdiction: { state: 'CA', city: 'Los Angeles' }, effect: 'allow' })];
  const f = st({ state: 'CA', countyFips: '06037' }, 'pool', { jurisdictions: rules });
  assert.equal(f.status, 'prohibited');
  assert.match(f.note, /city could not be determined/);
});

test('entire_home in Los Angeles is no longer unknown: restricted, confidence <= 0.3, requirements listed', () => {
  const f = st(CENSUS_LA);
  assert.notEqual(f.status, 'unknown');
  assert.ok(f.confidence <= 0.3);
  assert.ok(f.requirements.length >= 2);
  assert.equal(f.note, UNVERIFIED_NOTE);
});

test('feasibility wording: rules on file that do not cover the use', () => {
  for (const key of ['pool', 'parking_spot']) {
    const f = st(CENSUS_LA, key);
    assert.equal(f.status, 'unknown');
    assert.equal(f.confidence, 0);
    assert.equal(f.note, NOT_COVERED_NOTE);
    assert.ok(f.requirements.includes('Check the hourly-space rules with the City of Los Angeles'));
  }
  assert.equal(st(CENSUS_LA, 'backyard').note, NO_RULES_NOTE, 'no LA rule touches a backyard at all');
});

test('unverified matched rule keeps the 0.3 cap; verified rules lift it', () => {
  const j = { state: 'ZZ', county: 'Cty County' };
  const mk = (extra) => st({ state: 'ZZ', county: 'Cty' }, 'pool', { jurisdictions: [rule({ jurisdiction: { state: 'ZZ', county: 'Cty' }, ...extra })] });
  assert.equal(mk({}).confidence, 0.3);
  assert.equal(mk({}).note, UNVERIFIED_NOTE);
  assert.ok(mk({ verified: true, verifiedAt: '2026-11-01T00:00:00Z' }).confidence > 0.3);
  assert.equal(mk({ verified: true, verifiedAt: '2026-11-01T00:00:00Z' }).note, undefined);
  assert.ok(j);
});

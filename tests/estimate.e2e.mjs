// Public estimator e2e (Chromium via Playwright) with every external host answered from the recorded core fixtures.
// Anything else that leaves localhost is ABORTED and recorded, and the run fails. Never touches a real network.
// Run: node tests/estimate.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { resolveAddress, BROWSER_GEOCODERS } from '../core/parcel.js';
import { applyOwnerCorrection } from '../core/profile.js';
import { identifyOpportunities, defaultResourceCapacity } from '../core/opportunities.js';
import { defaultInputs, withOverrides, estimateOpportunity } from '../core/revenue.js';
import { optimize } from '../core/optimizer.js';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'); }
const { chromium } = pw;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = '/tmp/claude-0/-home-user/bbdf9db1-6a70-50d8-8c4a-2fe889e65e9c/scratchpad';
const FX = path.join(ROOT, 'core/tests/fixtures/parcel');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));

const VENICE = '99999 Venice Blvd, Los Angeles, CA 90034';
const SPRING_N = '200 N Spring St, Los Angeles, CA 90012';
const SPRING_S = '200 S Spring St, Los Angeles, CA 90012';
const FAIL = '1 Failville Rd, Nowhere, ZZ 00000';
const APN = '5149007006';

// ---- fixtures served to the page ---------------------------------------------------------------------------------
const nominatimSpring = () => {
  const [r] = fx('nominatim-la.json');
  return [{ ...r, lat: '34.051622610747', lon: '-118.245593523439', display_name: '200, South Spring Street, Los Angeles, California, 90012, United States',
    address: { ...r.address, house_number: '200', road: 'South Spring Street', postcode: '90012' } }];
};
/** Fixture answer for a mocked external URL, or null when the host is not one we mock. */
let override = null; // a scenario may replace one host's answer: (url, decodedUrl) => {status, body} | undefined
function answer(urlStr) {
  const u = new URL(urlStr);
  const dec = decodeURIComponent(urlStr);
  const o = override?.(urlStr, dec);
  if (o) return o;
  if (u.hostname === 'nominatim.openstreetmap.org') {
    const q = u.searchParams.get('q') ?? '';
    if (q.includes('Failville')) return { status: 503, body: { error: 'down' } };
    return { status: 200, body: q.includes('Spring') ? nominatimSpring() : fx('nominatim-la.json') };
  }
  if (u.hostname.endsWith('lacounty.gov')) {
    if (dec.includes('-118.2455')) return { status: 200, body: urlStr.includes('distance=') ? fx('arcgis-la-buffer-spring-st-recorded.json') : fx('arcgis-empty.json') };
    return { status: 200, body: fx('arcgis-la-parcel.json') };
  }
  if (u.hostname.includes('overpass')) return { status: 200, body: dec.includes('34.0516') ? fx('overpass-no-features.json') : fx('overpass-la.json') };
  return null;
}

// ---- the same pipeline, computed directly from /core (what the page must show) ------------------------------------
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const nodeFetch = async (url) => { const a = answer(String(url)); if (!a) throw new Error(`unmocked ${url}`); return json(a.body, a.status); };
const NOW = new Date().toISOString();
async function coreProfile(address, extra = {}) {
  return resolveAddress(address, { fetch: nodeFetch, now: NOW, geocoders: BROWSER_GEOCODERS, sleep: async () => {}, nowMs: () => Date.now(), ...extra });
}
function corePipeline(profile, { overrides = {}, includeInvestmentIdeas = false, goal = 'max_net_income', constraints = {} } = {}) {
  const now = new Date().toISOString();
  const opps = identifyOpportunities(profile, { now, includeInvestmentIdeas });
  const estimates = {};
  for (const o of opps) {
    let inputs = defaultInputs(o, profile);
    if (overrides[o.id]) inputs = withOverrides(inputs, overrides[o.id], now);
    estimates[o.id] = estimateOpportunity(o, inputs);
  }
  const opt = optimize(opps, estimates, { goal, scenario: 'baseline', constraints: { allowUnknownRegulatory: true, resourceCapacity: defaultResourceCapacity(profile), ...constraints } });
  return { opps, estimates, opt };
}
const owner = (p, pairs) => pairs.reduce((acc, [k, v]) => applyOwnerCorrection(acc, k, v, NOW), p);
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

// ---- static server --------------------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const URL_PAGE = `${ORIGIN}/estimate/`;

// ---- harness ----------------------------------------------------------------------------------------------------
const browser = await chromium.launch();
const failures = [];
let passed = 0;
const allRecs = [];
async function scenario(name, fn, viewport = { width: 1280, height: 900 }, dsf = 1, allowConsole = null) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: dsf });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const rec = { name, external: [], mocked: [], consoleErrors: [], pageErrors: [], localRequests: [] };
  allRecs.push(rec);
  page.on('console', (m) => { if (m.type() === 'error') rec.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e)));
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || url.startsWith('data:')) { rec.localRequests.push(url); return route.continue(); }
    const a = answer(url);
    if (!a) { rec.external.push(url); return route.abort('failed'); }
    rec.mocked.push(url);
    return route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body) });
  });
  try {
    await fn(page, rec, ctx);
    assert.deepEqual(rec.consoleErrors.filter((m) => !(allowConsole && allowConsole.test(m))), [], 'console errors');
    assert.deepEqual(rec.pageErrors, [], 'uncaught page errors');
    assert.deepEqual(rec.external, [], 'unmocked external requests');
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e}`);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
    try { await page.screenshot({ path: `${SHOTS}/estimate-fail-${failures.length}.png`, fullPage: true }); } catch { /* ignore */ }
  } finally { await ctx.close(); }
}

const text = async (page, sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();
const cents = async (page, sel) => Number(await page.locator(sel).first().getAttribute('data-cents'));
const baseYear = (id) => `[data-opp="${id}"][data-scenario="baseline"][data-period="year"]`;
async function search(page, address) {
  await page.fill('#address', address);
  await page.click('#address-submit');
}
async function happy(page, rec) {
  await page.goto(URL_PAGE);
  await search(page, VENICE);
  await page.waitForSelector('#profile-table');
}
async function setNum(page, sel, v) {
  await page.fill(sel, String(v));
  await page.locator(sel).blur();
}
/** every baseline-year figure on the page equals the one computed by /core */
async function assertMatchesCore(page, core, label) {
  const cards = await page.locator('[data-opp-card]').evaluateAll((els) => els.map((e) => e.getAttribute('data-opp-card')));
  assert.deepEqual([...cards].sort(), core.opps.map((o) => o.id).sort(), `${label}: same opportunities as core`);
  for (const o of core.opps) {
    const e = core.estimates[o.id];
    if (!e.available) { assert.equal(await page.locator(`[data-unavailable="${o.id}"]`).count(), 1, `${label}: ${o.id} says what is needed`); assert.equal(await page.locator(`[data-opp="${o.id}"]`).count(), 0, `${label}: ${o.id} shows no number`); continue; }
    for (const s of ['conservative', 'baseline', 'optimistic']) {
      assert.equal(await cents(page, `[data-opp="${o.id}"][data-scenario="${s}"][data-period="year"]`), e.scenarios[s].noiCentsPerYear, `${label}: ${o.id} ${s} year`);
      assert.equal(await cents(page, `[data-opp="${o.id}"][data-scenario="${s}"][data-period="month"]`), e.scenarios[s].noiCentsPerMonth, `${label}: ${o.id} ${s} month`);
    }
  }
}

console.log('estimate e2e');

await scenario('load: no request and no storage before submit; accessible shell', async (page, rec) => {
  await page.goto(URL_PAGE);
  await page.waitForSelector('#address');
  assert.equal(rec.mocked.length + rec.external.length, 0, 'no external request before submit');
  assert.equal(await page.locator('label[for="address"]').count(), 1);
  assert.equal(await page.getAttribute('#status', 'aria-live'), 'polite');
  assert.equal(await page.locator('#address').getAttribute('autocomplete'), 'off');
  // typing alone must not trigger lookups (no autocomplete)
  await page.type('#address', '99999 Venice Blv', { delay: 5 });
  await page.waitForTimeout(1300);
  assert.equal(rec.mocked.length + rec.external.length, 0, 'typing sends nothing');
  assert.match(await text(page, 'footer'), /Address search © OpenStreetMap contributors \(ODbL\) via Nominatim\. Parcel data: county assessor public services\. Buildings and pools: © OpenStreetMap contributors\./);
  assert.match(await text(page, 'footer'), /Nothing you enter here is saved\./);
  assert.equal(await page.locator('footer a[href="../host/"]').innerText(), 'Already renting? Manage your spaces in the Host Console');
});

await scenario('happy path: profile rows with provenance, three scenarios, numbers equal core, wording rules', async (page, rec) => {
  await happy(page, rec);
  const r = await coreProfile(VENICE);
  const core = corePipeline(r.profile);
  // lookups happened only after submit, via mocked hosts, no Census
  assert.ok(rec.mocked.some((u) => u.includes('nominatim')) && rec.mocked.some((u) => u.includes('lacounty')) && rec.mocked.some((u) => u.includes('overpass')));
  assert.equal(rec.mocked.some((u) => u.includes('census.gov')), false);
  // step log
  const log = await text(page, '#step-log');
  assert.match(log, /Address search from OpenStreetMap Nominatim/);
  assert.match(log, /Parcel record from LA County Assessor/);
  assert.equal(await page.locator('#step-log li').count(), 5);
  // provenance badges in words
  assert.equal(await text(page, 'tr[data-key="parcel_id"] .chip'), 'Measured');
  assert.equal(await text(page, 'tr[data-key="property_type"] .chip'), 'Estimated');
  assert.equal(await text(page, 'tr[data-key="pool_present"] .chip'), 'Estimated');
  assert.match(await text(page, 'tr[data-key="lot_area_sqft"]'), /sq ft.*Measured.*LA County Assessor/);
  assert.match(await text(page, 'tr[data-key="parcel_id"]'), /(High|Medium|Low) confidence/);
  assert.equal(await page.locator('#profile-table thead th').count(), 6);
  await page.click('details[data-dk="missing-attrs"] > summary');
  assert.match(await text(page, '#unavailable-table'), /Parking spaces.*Not available/);
  // note and wording
  assert.equal(await text(page, '#plan-note'), 'These are planning estimates, not promises. Prices and bookings are Everyspace planning defaults unless you enter your own.');
  const body = (await page.locator('body').innerText()).toLowerCase();
  assert.equal(/you will (earn|make|get)/.test(body), false, '"you will earn" never appears');
  assert.match(body, /could|estimate|planning/);
  // three scenario columns on every available card; the numbers equal core
  for (const o of core.opps) {
    const heads = await page.locator(`[data-scen-table="${o.id}"] thead th`).allInnerTexts();
    assert.deepEqual(heads.map((h) => h.toLowerCase()), ['net income', 'conservative', 'baseline', 'optimistic'], o.id);
  }
  await assertMatchesCore(page, core, 'happy');
  const pool = core.estimates.pool.scenarios.baseline.noiCentsPerYear;
  assert.equal(await text(page, baseYear('pool')), usd0.format(pool / 100), 'displayed money is the formatted core value');
  // breakdown and assumptions are present
  await page.click('details[data-dk="bd-pool"] > summary');
  assert.match(await text(page, 'details[data-dk="bd-pool"]'), /Gross income.*Listing-site fees.*Cleaning.*Net income/);
  assert.match(await text(page, 'details[data-dk="bd-pool"]'), /Not included/);
  await page.click('details[data-dk="as-pool"] > summary');
  const as = await text(page, 'details[data-dk="as-pool"]');
  assert.match(as, /Price per hour.*Estimated.*Everyspace planning default \(uncited\)/);
  assert.match(as, /Not included/);
  assert.equal(await page.locator('table[data-assumptions="pool"] tbody tr').count(), 12);
  // unknown local rules: plain words, never a green light
  assert.match(await text(page, '[data-opp-card="pool"]'), /Local rules not checked — confirm with your city/);
  assert.match(await text(page, '[data-opp-card="pool"] [data-confidence]'), /^Low: price and bookings are Everyspace planning defaults, not market data/);
  // groups
  assert.match(await text(page, '#g-now'), /What you have now/);
  assert.match(await text(page, '#g-later'), /Needs a permit or investment first/);
  assert.equal(await page.locator('#g-later ~ article [data-opp-card]').count() >= 0, true);
  assert.match(await text(page, '[data-opp-card="entire_home"]'), /Needs a permit first/);
  assert.match(await text(page, '[data-opp-card="entire_home"]'), /Allowed with conditions/);
  assert.match(await text(page, '#status'), /Property found\./);
  await page.click('#edit-bedrooms');
  await page.fill('#ed-bedrooms', '4');
  await page.click('#save-bedrooms');
  await page.waitForFunction(() => /Estimates updated: \d+ ways? to earn found\./.test(document.querySelector('#status').textContent));
});

await scenario('combination: caution by default, naive-vs-real sentence, goal change, constraints, investments apart', async (page, rec) => {
  await happy(page, rec);
  const r = await coreProfile(VENICE);
  const core = corePipeline(r.profile);
  assert.equal(await page.locator('#rules-caution').isVisible(), true, 'caution visible by default');
  assert.match(await text(page, '#rules-caution'), /local rules were not checked for the uses listed here/i);
  assert.equal(await page.locator('#only-known').isChecked(), false);
  const sel = async () => (await page.locator('#combo-selected li strong').allInnerTexts()).sort();
  const labelsOf = (opt, byId) => opt.selected.map((id) => byId[id].label).sort();
  const byId = Object.fromEntries(core.opps.map((o) => [o.id, o]));
  assert.deepEqual(await sel(), labelsOf(core.opt, byId), 'default goal matches core');
  // sentence from core numbers
  assert.match(await text(page, '#combo-naive'), /^Adding everything up would give \$[\d,]+, but some of these cannot run together .*, so the realistic total is \$[\d,]+\./);
  assert.equal(Number(await page.locator('#combo-naive [data-naive-cents]').getAttribute('data-naive-cents')), core.opt.naiveSumNoiCentsPerYear);
  assert.equal(Number(await page.locator('#combo-naive [data-real-cents]').getAttribute('data-real-cents')), core.opt.totals.noiCentsPerYear);
  assert.ok(core.opt.totals.noiCentsPerYear < core.opt.naiveSumNoiCentsPerYear);
  assert.ok(core.opt.eligibleIds.length > core.opt.selected.length, 'sentence only appears when something eligible was left out');
  assert.equal(await cents(page, '#combo-totals [data-scenario="baseline"][data-period="year"]'), core.opt.totals.noiCentsPerYear);
  assert.equal(await page.locator('#combo-totals thead th').count(), 4);
  assert.match(await text(page, '#combo-rejected'), /Conflicts with/);
  assert.match(await text(page, '#combo-investments'), /Needs a permit or investment \(not in the total above\)/);
  assert.match(await text(page, '#combo-investments'), /Entire home/i);
  // goal change alters the selection (and always equals core's)
  const before = await sel();
  let changed = false;
  for (const goal of ['privacy', 'min_effort', 'min_upfront', 'fastest_payback']) {
    await page.selectOption('#goal', goal);
    const c = corePipeline(r.profile, { goal });
    await page.waitForFunction((g) => document.querySelector('#goal').value === g, goal);
    assert.deepEqual(await sel(), labelsOf(c.opt, byId), `goal ${goal} matches core`);
    // the "adding everything up" sentence appears only when something eligible was left out, and shows core's numbers
    const left = c.opt.eligibleIds.some((id) => !c.opt.selected.includes(id));
    assert.equal(await page.locator('#combo-naive').count(), left && c.opt.selected.length ? 1 : 0, `goal ${goal}: sentence presence`);
    if (left && c.opt.selected.length) assert.equal(Number(await page.locator('#combo-naive [data-naive-cents]').getAttribute('data-naive-cents')), c.opt.naiveSumNoiCentsPerYear);
    if (JSON.stringify(await sel()) !== JSON.stringify(before)) changed = true;
  }
  assert.ok(changed, 'at least one goal selects a different set than the default');
  await page.selectOption('#goal', 'max_net_income');
  // "no strangers inside my home" removes the private room
  assert.ok((await sel()).includes('Private room'));
  await page.check('#no-strangers');
  await page.waitForFunction(() => !document.querySelector('#combo-selected')?.innerText.includes('Private room'));
  assert.deepEqual(await sel(), labelsOf(corePipeline(r.profile, { constraints: { noStrangersInHome: true } }).opt, byId));
  await page.uncheck('#no-strangers');
  // max upfront: unknown start-up costs are listed as left out, not guessed
  await page.fill('#max-upfront', '100');
  await page.locator('#max-upfront').blur();
  await page.waitForFunction(() => document.querySelector('#combo-rejected')?.innerText.includes('Start-up cost unknown: enter it to include this under your budget'));
  await page.fill('#max-upfront', '');
  await page.locator('#max-upfront').blur();
  // only rules on file -> caution goes away; nothing is selected because no rules are on file for these uses
  await page.check('#only-known');
  await page.waitForFunction(() => !document.querySelector('#rules-caution'));
  assert.equal(await page.locator('#rules-caution').count(), 0);
  assert.deepEqual(await sel(), labelsOf(corePipeline(r.profile, { constraints: { allowUnknownRegulatory: false } }).opt, byId));
  await page.uncheck('#only-known');
  await page.waitForSelector('#rules-caution');
  assert.equal(await page.locator('#combo-selected').count(), 1);
  // pointer to the Host Console
  assert.ok((await page.locator('a[href="../host/"]').count()) >= 3);
});

await scenario('editing: owner correction, answers, price override and investment ideas all recompute at once', async (page, rec) => {
  await happy(page, rec);
  const r = await coreProfile(VENICE);
  let p = r.profile;
  // 1. pool is wrong
  await page.click('#edit-pool_present');
  await page.selectOption('#ed-pool_present', 'no');
  await page.click('#save-pool_present');
  p = owner(p, [['pool_present', false]]);
  await page.waitForFunction(() => !document.querySelector('[data-opp-card="pool"]'));
  assert.equal(await text(page, 'tr[data-key="pool_present"] .chip'), 'You confirmed');
  assert.match(await text(page, 'tr[data-key="pool_present"]'), /No.*You confirmed.*Owner/);
  await assertMatchesCore(page, corePipeline(p), 'after pool=false');
  // 2. parking spaces: fill in an unavailable row; parking has no default volume, so it asks for it instead of guessing
  await page.click('details[data-dk="missing-attrs"] > summary');
  await page.click('#edit-parking_spaces');
  await page.fill('#ed-parking_spaces', '2');
  await page.press('#ed-parking_spaces', 'Enter');
  p = owner(p, [['parking_spaces', 2]]);
  await page.waitForSelector('[data-unavailable="parking_spot"]');
  assert.equal(await page.locator('[data-opp="parking_spot"]').count(), 0, 'no number while volume is unknown');
  assert.match(await text(page, '[data-unavailable="parking_spot"]'), /No estimate yet\. We need: hours rented per month/);
  await assertMatchesCore(page, corePipeline(p), 'parking, no volume');
  await page.fill('#need-parking_spot-unitsPerMonth', '60');
  await page.click('#need-save-parking_spot-unitsPerMonth');
  const ov = { parking_spot: { unitsPerMonth: 60 } };
  await page.waitForSelector(baseYear('parking_spot'));
  await assertMatchesCore(page, corePipeline(p, { overrides: ov }), 'parking with owner volume');
  // 3. owner price on private room: number equals core with the same override, confidence wording changes
  await page.click('details[data-dk="as-private_room"] > summary');
  await page.click('#ei-edit-private_room-priceCents');
  await page.fill('#ei-private_room-priceCents', '150');
  await page.click('#ei-save-private_room-priceCents');
  ov.private_room = { priceCents: 15000 };
  await page.waitForFunction(() => document.querySelector('tr[data-input="priceCents"] .chip')?.textContent && [...document.querySelectorAll('[data-assumptions="private_room"] tr[data-input="priceCents"] .chip')].some((c) => c.textContent === 'You confirmed'));
  await assertMatchesCore(page, corePipeline(p, { overrides: ov }), 'after price override');
  assert.match(await text(page, '[data-assumptions="private_room"] tr[data-input="priceCents"]'), /\$150\.00.*You confirmed.*Owner/);
  await page.click('#ei-reset-private_room-priceCents');
  delete ov.private_room;
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-assumptions="private_room"] tr[data-input="priceCents"] .chip')].some((c) => c.textContent === 'You confirmed'));
  await assertMatchesCore(page, corePipeline(p, { overrides: ov }), 'after reset');
  // 4. a question: "yes" adds that idea
  await page.click('details[data-dk="questions"] > summary');
  assert.match(await text(page, 'details[data-dk="questions"] > summary'), /^More things you could rent \(\d+ questions?\)$/);
  assert.equal(await page.locator('[data-opp-card="workspace"]').count(), 0);
  await page.selectOption('#q-workspace_available', 'yes');
  p = owner(p, [['workspace_available', true]]);
  await page.waitForSelector('[data-opp-card="workspace"]');
  await assertMatchesCore(page, corePipeline(p, { overrides: ov }), 'after answering a question');
  assert.match(await text(page, 'tr[data-key="workspace_available"]'), /Yes.*You confirmed/);
  // 5. investment ideas
  const beforeCount = await page.locator('[data-opp-card]').count();
  await page.check('#include-investments');
  await page.waitForFunction((n) => document.querySelectorAll('[data-opp-card]').length > n, beforeCount);
  await assertMatchesCore(page, corePipeline(p, { overrides: ov, includeInvestmentIdeas: true }), 'with investment ideas');
  assert.ok(await page.locator('[data-opp-card="adu"]').count() === 1, 'an ADU idea needs building work');
  assert.match(await text(page, '[data-opp-card="adu"]'), /Needs building work first/);
  // invalid input is refused with a spoken message and changes nothing
  await page.click('#edit-bedrooms');
  await page.fill('#ed-bedrooms', '-4');
  await page.click('#save-bedrooms');
  assert.match(await text(page, '#status'), /Enter a number that is zero or more/);
  await page.click('#cancel-bedrooms');
});

await scenario('mismatch: confirmation is asked before any parcel lookup; Yes continues; candidates are picked by address', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, SPRING_N);
  await page.waitForSelector('#confirm-yes');
  assert.match(await text(page, '#h-confirm ~ p'), /We found: 200 South Spring Street, Los Angeles, CA 90012\. Is this your property\?/);
  assert.equal(rec.mocked.some((u) => u.includes('lacounty') || u.includes('overpass')), false, 'no parcel request before confirmation');
  assert.match(await text(page, '#status'), /We found 200 South Spring Street/);
  // No: back to editing the address
  await page.click('#confirm-no');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'address');
  assert.equal(await page.locator('#confirm-yes').count(), 0);
  // search again, Yes
  await page.click('#address-submit');
  await page.waitForSelector('#confirm-yes');
  await page.click('#confirm-yes');
  await page.waitForSelector('#cand-none');
  assert.ok(rec.mocked.some((u) => u.includes('lacounty')), 'now the parcel service is asked');
  const rows = await page.locator('[data-act="pick"]').count();
  assert.equal(rows, 10);
  assert.match(await text(page, '#h-cands ~ ul'), /145 S SPRING ST LOS ANGELES CA 90012 \(parcel 5149001003\)/);
  assert.match(await text(page, '#step-log'), /Parcel record from parcel service registry.*no parcel at this point/);
  // pick one by APN
  await page.click(`#pick-${APN}`);
  await page.waitForSelector('#profile-table');
  assert.equal(await text(page, 'tr[data-key="parcel_id"] .chip'), 'You confirmed');
  assert.match(await text(page, 'tr[data-key="parcel_id"]'), new RegExp(APN));
  const r = await coreProfile(SPRING_N, { confirmMatchedAddress: true, parcelApn: APN });
  assert.equal(r.ok, true);
  await assertMatchesCore(page, corePipeline(r.profile), 'picked parcel');
});

await scenario('candidates: "None of these" -> manual basics keep what the geocoder found, and estimates still work', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, SPRING_S);
  await page.waitForSelector('#cand-none');
  assert.equal(await page.locator('#confirm-yes').count(), 0, 'no mismatch for the S street');
  await page.click('#cand-none');
  await page.waitForSelector('#manual-basics');
  assert.match(await text(page, 'tr[data-key="address"]'), /200 South Spring Street.*Measured/);
  assert.match(await text(page, 'tr[data-key="jurisdiction"]'), /Los Angeles, CA/);
  assert.equal(await page.locator('#manual-basics').isVisible(), true);
  assert.match(await text(page, '#manual-basics'), /Choose a property type to see ideas/);
  await page.selectOption('#basic-property_type', 'multi_family');
  await page.waitForFunction(() => document.querySelector('#basic-property_type').value === 'multi_family');
  await setNum(page, '#basic-bedrooms', 4);
  await page.waitForSelector('[data-opp-card]');
  const r = await coreProfile(SPRING_S);
  const p = owner(r.profile, [['property_type', 'multi_family'], ['bedrooms', 4]]);
  await assertMatchesCore(page, corePipeline(p), 'manual after candidates');
  assert.match(await text(page, 'tr[data-key="property_type"]'), /Multi-family.*You confirmed/);
});

await scenario('manual mode: every lookup fails, the log says why, owner basics still give estimates', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, FAIL);
  await page.waitForSelector('#manual-basics');
  assert.match(await text(page, '#step-log'), /Failed Address search from OpenStreetMap Nominatim could not geocode: Nominatim: HTTP 503/);
  assert.match(await text(page, '#status'), /could not look up your property.*Enter the basics/i);
  assert.equal(await page.locator('[data-opp-card]').count(), 0);
  assert.equal(await page.locator('#combo-selected').count(), 0);
  assert.match(await text(page, '#combo-empty'), /No combination fits/);
  assert.ok(await page.locator('details[data-dk="missing-attrs"]').evaluate((d) => d.open), 'unavailable rows are open and invite filling in');
  // the basics: type, bedrooms, lot size (optional), yard, pool, parking, garage
  await page.selectOption('#basic-property_type', 'single_family');
  await page.waitForFunction(() => document.querySelector('#basic-property_type').value === 'single_family');
  await setNum(page, '#basic-bedrooms', 3);
  await page.waitForFunction(() => document.querySelector('#basic-bedrooms').value === '3');
  await page.selectOption('#basic-yard', 'yes');
  await page.waitForFunction(() => document.querySelector('#basic-yard').value === 'yes');
  assert.match(await text(page, '#manual-basics'), /Add a rough yard size to see yard ideas/);
  await setNum(page, '#basic-yard_area_sqft', 800);
  await page.waitForFunction(() => document.querySelector('#basic-yard_area_sqft').value === '800');
  await page.selectOption('#basic-pool_present', 'yes');
  await page.waitForFunction(() => document.querySelector('#basic-pool_present').value === 'yes');
  await setNum(page, '#basic-parking_spaces', 2);
  await page.waitForFunction(() => document.querySelector('#basic-parking_spaces').value === '2');
  await page.selectOption('#basic-garage_present', 'yes');
  await page.waitForSelector('[data-opp-card="garage_storage"]');
  const r = await coreProfile(FAIL);
  assert.equal(r.ok, false);
  const p = owner(r.profile, [['property_type', 'single_family'], ['bedrooms', 3], ['yard_area_sqft', 800], ['pool_present', true], ['parking_spaces', 2], ['garage_present', true]]);
  const core = corePipeline(p);
  await assertMatchesCore(page, core, 'manual');
  for (const k of ['pool', 'backyard', 'private_room', 'garage_storage', 'parking_spot']) assert.equal(await page.locator(`[data-opp-card="${k}"]`).count(), 1, k);
  assert.deepEqual((await page.locator('#combo-selected li strong').allInnerTexts()).sort(), core.opt.selected.map((id) => core.opps.find((o) => o.id === id).label).sort());
  assert.match(await text(page, 'tr[data-key="pool_present"]'), /Yes.*You confirmed/);
  // yard "no" is a confirmed zero, and removes yard ideas
  await page.selectOption('#basic-yard', 'no');
  await page.waitForFunction(() => !document.querySelector('[data-opp-card="backyard"]'));
  await assertMatchesCore(page, corePipeline(owner(p, [['yard_area_sqft', 0]])), 'yard no');
  // "enter details myself" works with no network call at all
  const mockedBefore = rec.mocked.length;
  await page.click('#manual-start');
  assert.match(await text(page, '#status'), /You have corrections on this page\. Starting again discards them/, 'owner corrections are not dropped silently');
  assert.ok(await page.locator('[data-opp-card]').count() > 0, 'first press changes nothing');
  await page.click('#manual-start');
  await page.waitForSelector('#manual-basics');
  assert.equal(rec.mocked.length, mockedBefore);
  assert.equal(await page.locator('[data-opp-card]').count(), 0);
}, { width: 1280, height: 900 }, 1, /^Failed to load resource: the server responded with a status of 503/); // the mocked Nominatim outage itself

await scenario('privacy and accessibility: nothing stored, labelled controls, keyboard, no autocomplete', async (page, rec, ctx) => {
  await happy(page, rec);
  await page.click('details[data-dk="questions"] > summary');
  await page.click('details[data-dk="as-pool"] > summary');
  const unlabeled = await page.evaluate(() => [...document.querySelectorAll('input, select')].filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.closest('label')).map((el) => el.id || el.outerHTML.slice(0, 60)));
  assert.deepEqual(unlabeled, [], 'every control has a label');
  const tables = await page.evaluate(() => [...document.querySelectorAll('table')].filter((t) => !t.querySelector('th')).length);
  assert.equal(tables, 0, 'every table has headers');
  assert.equal(await page.locator('main h1').count(), 1);
  // keyboard: Tab reaches the first edit button and Enter opens the editor
  await page.focus('#edit-address');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#ed-address');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ed-address');
  await page.keyboard.press('Escape');
  await page.click('#cancel-address');
  // storage
  const stored = await page.evaluate(async () => ({
    local: localStorage.length, session: sessionStorage.length, cookie: document.cookie,
    idb: (await indexedDB.databases?.())?.length ?? 0, caches: (await caches.keys()).length,
  }));
  assert.deepEqual(stored, { local: 0, session: 0, cookie: '', idb: 0, caches: 0 });
  assert.deepEqual(await ctx.cookies(), []);
  // the only external requests are the three lookup hosts, all GET with no body
  for (const u of rec.mocked) assert.match(new URL(u).hostname, /^(nominatim\.openstreetmap\.org|public\.gis\.lacounty\.gov|overpass[\w.-]*)$/);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /google|analytics|cdn|gtag|fonts/.test(e.name)).length), 0);
});

await scenario('mobile 390px: no horizontal scroll at any stage; screenshot', async (page, rec) => {
  await page.goto(URL_PAGE);
  const fits = async (label) => {
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
    assert.ok(m.sw <= m.cw && m.bw <= m.cw, `${label}: scrollWidth ${m.sw}/${m.bw} > ${m.cw}`);
  };
  await fits('start');
  await search(page, SPRING_N);
  await page.waitForSelector('#confirm-yes');
  await fits('confirm');
  await page.click('#confirm-yes');
  await page.waitForSelector('#cand-none');
  await fits('candidates');
  await page.fill('#address', VENICE);
  await page.click('#address-submit');
  await page.waitForSelector('#profile-table');
  await page.click('details[data-dk="missing-attrs"] > summary');
  await page.click('details[data-dk="questions"] > summary');
  await page.click('details[data-dk="as-pool"] > summary');
  await page.click('details[data-dk="bd-pool"] > summary');
  await page.click('#include-investments');
  await page.waitForSelector('[data-opp-card="adu"]');
  await fits('results');
  await page.click('#edit-pool_present');
  await fits('editing');
  await page.click('#cancel-pool_present');
  await page.click('details[data-dk="questions"] > summary'); // close questions again for a shorter screenshot
  await page.click('details[data-dk="missing-attrs"] > summary');
  await page.screenshot({ path: `${SHOTS}/estimate-phone.png`, fullPage: true });
}, { width: 390, height: 844 }, 2);

await scenario('desktop screenshot of the results state', async (page, rec) => {
  await happy(page, rec);
  await page.click('details[data-dk="bd-pool"] > summary');
  await page.click('details[data-dk="as-pool"] > summary');
  await page.screenshot({ path: `${SHOTS}/estimate-desktop.png`, fullPage: true });
}, { width: 1280, height: 900 }, 2);

await scenario('dark mode renders (colour scheme follows the console)', async (page, rec) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await happy(page, rec);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(bg, 'rgb(11, 16, 22)');
  await page.screenshot({ path: `${SHOTS}/estimate-dark.png`, fullPage: false });
});


// ---- address entry: malformed input, markup, double submit, failure messages (audit additions) ----------------------
const PWN = '<img src=x onerror=window.__pwn=1>';
const noPwn = async (page, label) => {
  assert.equal(await page.evaluate(() => window.__pwn), undefined, `${label}: injected handler did not run`);
  assert.equal(await page.locator('img[src="x"]').count(), 0, `${label}: no injected <img> element`);
};
const nominatimQs = (rec) => rec.mocked.filter((u) => u.includes('nominatim')).map((u) => new URL(u).searchParams.get('q'));

await scenario('arrival URLs: no address, empty, malformed and very long values never break the page', async (page, rec) => {
  for (const suffix of ['', '#address=', '?address=', '#address=%20%20', '#foo=bar']) {
    await page.goto('about:blank');
    await page.goto(URL_PAGE + suffix);
    await page.waitForSelector('#address');
    assert.equal(await page.locator('#profile-table, #confirm-yes, #cand-none').count(), 0, `nothing runs for "${suffix}"`);
    assert.equal(rec.mocked.length, 0, `no request for "${suffix}"`);
  }
  // a malformed escape is searched as the text it is (arrival counts as a submit) and must not crash the page
  await page.goto('about:blank'); // a hash-only change would not reload the page
  await page.goto(URL_PAGE + '#address=%E0%A4%A');
  await page.waitForSelector('#profile-table, #manual-basics, #confirm-yes, #cand-none');
  await page.goto('about:blank');
  await page.goto(URL_PAGE + '#address=' + 'x'.repeat(5000));
  await page.waitForSelector('#profile-table, #manual-basics, #confirm-yes, #cand-none');
  const qs = nominatimQs(rec);
  assert.ok(qs.length >= 1 && qs.every((q) => q.length <= 300), `address is capped at 300 characters (${qs.map((q) => q.length)})`);
  assert.equal(await page.evaluate(() => location.hash + location.search), '', 'arrival address removed from the URL');
  assert.equal(await page.getAttribute('#address', 'maxlength'), '300');
});

await scenario('markup in the typed address is shown as text and never runs', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, PWN);
  await page.waitForSelector('#profile-table, #manual-basics, #confirm-yes, #cand-none');
  await noPwn(page, 'typed address');
  // the same through the homepage fragment path
  await page.goto('about:blank');
  await page.goto(URL_PAGE + '#address=' + encodeURIComponent(PWN));
  await page.waitForSelector('#profile-table, #manual-basics, #confirm-yes, #cand-none');
  await noPwn(page, 'fragment address');
});

await scenario('markup in a looked-up parcel record (situs address, use type) is escaped', async (page, rec) => {
  override = (url) => {
    if (!new URL(url).hostname.endsWith('lacounty.gov')) return undefined;
    if (url.includes('-118.2455') && url.includes('distance=')) {
      const body = fx('arcgis-la-buffer-spring-st-recorded.json');
      body.features[0].attributes.SitusFullAddress = `145 S SPRING ST ${PWN}`;
      return { status: 200, body };
    }
    if (!url.includes('-118.2455')) {
      const body = fx('arcgis-la-parcel.json');
      body.features[0].attributes.UseType = PWN;
      body.features[0].attributes.UseDescription = PWN;
      return { status: 200, body };
    }
    return undefined;
  };
  try {
    await page.goto(URL_PAGE);
    await search(page, SPRING_S);
    await page.waitForSelector('#cand-none');
    assert.match(await text(page, '#h-cands ~ ul'), /<img src=x onerror=window\.__pwn=1>/, 'candidate address is visible as text');
    await noPwn(page, 'candidate list');
    await page.goto(URL_PAGE);
    await search(page, VENICE);
    await page.waitForSelector('#profile-table');
    await noPwn(page, 'profile table');
    assert.match(await text(page, 'tr[data-key="use_type"]'), /<img src=x/, 'use type shown as text');
    await page.click('#edit-use_type');
    assert.match(await page.inputValue('#ed-use_type'), /<img src=x/, 'editor value is the literal text');
    await noPwn(page, 'text editor');
  } finally { override = null; }
});

await scenario('double submit and submit during a lookup: one lookup, the first address wins', async (page, rec) => {
  await page.goto(URL_PAGE);
  await page.fill('#address', VENICE);
  await page.evaluate(() => { const f = document.getElementById('address-form'); f.requestSubmit(); f.requestSubmit(); f.requestSubmit(); });
  await page.waitForSelector('#profile-table');
  await page.waitForTimeout(500);
  assert.equal(nominatimQs(rec).length, 1, 'geocoded once');
  // change the address mid-lookup and press "enter details myself": ignored, the running lookup is not clobbered
  await page.fill('#address', FAIL);
  await page.evaluate(() => { document.getElementById('address-form').requestSubmit(); document.getElementById('manual-start').click(); document.getElementById('address-form').requestSubmit(); });
  await page.waitForSelector('#manual-basics');
  assert.equal(nominatimQs(rec).filter((q) => q.includes('Failville')).length, 1, 'second address looked up once');
  assert.match(await text(page, '#step-log'), /Failed Address search/);
}, { width: 1280, height: 900 }, 1, /^Failed to load resource: the server responded with a status of 503/);

await scenario('lookup failure messaging: geocoder down, request aborted, parcel service down (partial)', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, FAIL);
  await page.waitForSelector('#manual-basics');
  assert.match(await text(page, '#status'), /could not look up your property/i);
  assert.match(await text(page, '#step-log'), /Failed Address search.*HTTP 503/);
  // the parcel service answers with an error: found address, failed parcel, the page says which step failed and still lets the owner continue
  override = (url) => (new URL(url).hostname.endsWith('lacounty.gov') ? { status: 500, body: { error: 'down' } } : undefined);
  try {
    await page.goto(URL_PAGE);
    await search(page, VENICE);
    await page.waitForSelector('#manual-basics');
    assert.match(await text(page, '#step-log'), /Found Address search/);
    assert.match(await text(page, '#step-log'), /Failed Parcel record/);
    assert.match(await text(page, '#h-profile'), /Your property/);
    assert.equal(await page.locator('[data-opp-card]').count(), 0, 'no invented ways to earn');
  } finally { override = null; }
}, { width: 1280, height: 900 }, 1, /^Failed to load resource: the server responded with a status of (503|500)/);

await scenario('reload mid-flow starts clean and the page says nothing is saved', async (page, rec) => {
  await happy(page, rec);
  assert.match(await text(page, '#session-note'), /Nothing is saved\. If you reload or leave this page, everything you entered here is cleared/);
  await page.reload();
  await page.waitForSelector('#address');
  assert.equal(await page.locator('#profile-table').count(), 0);
  assert.equal(await page.inputValue('#address'), '');
  assert.match(await text(page, 'main'), /Nothing you enter here is saved\./);
});

await scenario('a second search does not silently discard owner corrections', async (page, rec) => {
  await happy(page, rec);
  await page.click('#edit-bedrooms');
  await setNum(page, '#ed-bedrooms', 7);
  await page.click('#save-bedrooms');
  await page.waitForFunction(() => /7/.test(document.querySelector('tr[data-key="bedrooms"] .val')?.textContent ?? ''));
  const before = nominatimQs(rec).length;
  await page.click('#address-submit');
  assert.match(await text(page, '#status'), /You have corrections on this page\. Starting again discards them/);
  assert.equal(nominatimQs(rec).length, before, 'first press sends nothing');
  assert.match(await text(page, 'tr[data-key="bedrooms"]'), /7.*You confirmed/, 'correction still there');
  await page.click('#address-submit');
  await page.waitForFunction((n) => document.querySelector('#profile-table') && !/You confirmed/.test(document.querySelector('tr[data-key="bedrooms"]')?.textContent ?? ''), before);
  assert.equal(nominatimQs(rec).length, before + 1, 'second press searches again');
});

// zero unmocked external requests across every scenario
const totalExternal = allRecs.flatMap((r) => r.external);
if (totalExternal.length) failures.push(`unmocked external requests: ${totalExternal.join(', ')}`);

await browser.close();
server.close();
console.log(`\n${passed} scenario(s) passed, ${failures.length} failure(s)`);
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

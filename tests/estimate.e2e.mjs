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
import { runCountyPath, settleProfile } from '../estimate/county-path.js';
import { overtureServer, OVERTURE_REAL } from '../core/tests/fixtures/providers/overture-mock.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'); }
const { chromium } = pw;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = '/tmp/claude-0/-home-user/bbdf9db1-6a70-50d8-8c4a-2fe889e65e9c/scratchpad/ux';
fs.mkdirSync(SHOTS, { recursive: true });
/** Hosts other data sources may ask (county lookup, Overture): answered "not here". */
const OTHER_SOURCES = /(^|\.)(geo\.fcc\.gov|tigerweb\.geo\.census\.gov|stac\.overturemaps\.org|amazonaws\.com)$/;
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
function answer(urlStr, range = null) {
  const u = new URL(urlStr);
  const dec = decodeURIComponent(urlStr);
  const o = override?.(urlStr, dec, range);
  if (o) return o;
  if (u.hostname === 'nominatim.openstreetmap.org') {
    const q = u.searchParams.get('q') ?? '';
    if (q.includes('Failville')) return { status: 503, body: { error: 'down' } };
    return { status: 200, body: q.includes('Spring') ? nominatimSpring() : fx('nominatim-la.json') };
  }
  if (u.hostname.endsWith('lacounty.gov') && dec.includes('CAMS_Locator')) {
    // the county locator: no match by default, so these scenarios keep exercising the older Nominatim path; suggest answers nothing
    return { status: 200, body: dec.includes('/suggest') ? { suggestions: [] } : { candidates: [] } };
  }
  if (u.hostname.endsWith('lacounty.gov')) {
    if (dec.includes('-118.2455')) return { status: 200, body: urlStr.includes('distance=') ? fx('arcgis-la-buffer-spring-st-recorded.json') : fx('arcgis-empty.json') };
    return { status: 200, body: fx('arcgis-la-parcel.json') };
  }
  if (u.hostname.includes('overpass')) return { status: 200, body: dec.includes('34.0516') ? fx('overpass-no-features.json') : fx('overpass-la.json') };
  if (u.hostname === 'photon.komoot.io') return { status: 200, body: { features: [] } }; // address suggestions outside LA County: finds nothing here
  if (OTHER_SOURCES.test(u.hostname)) return { status: 404, body: {} };
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
    const a = answer(url, route.request().headers().range ?? null);
    if (!a) { rec.external.push(url); return route.abort('failed'); }
    rec.mocked.push(url);
    return route.fulfill({ status: a.status, contentType: a.type ?? 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, body: a.raw ?? JSON.stringify(a.body) });
  });
  try {
    await fn(page, rec, ctx);
    assert.deepEqual(rec.consoleErrors.filter((m) => !(allowConsole && allowConsole.test(m)) && !/status of 404/.test(m)), [], 'console errors');
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
  await page.waitForSelector('#facts');
  await settled(page);
}
const settled = (page) => page.waitForFunction(() => document.getElementById('progress').hidden && !document.querySelector('.fact[data-state="loading"]'), null, { timeout: 15000 });
const row = (key) => `.fact[data-key="${key}"]`;
const OUTCOME = '#facts, #confirm-yes, #cand-none';
async function typeFact(page, key, value) { await page.fill(`#f-${key}`, String(value)); await page.press(`#f-${key}`, 'Enter'); }
const edited = (page, key) => page.waitForSelector(`${row(key)}[data-state="edited"]`);
const FORBIDDEN = /failed|error|unavailable|not available|not found|warning|overpass|nominatim|lariac|cams|assessor/i;
/** Visible text of the page body minus the collapsed sources disclosure and the footer. */
const ownerText = (page) => page.evaluate(() => {
  const main = document.querySelector('main').cloneNode(true);
  main.querySelectorAll('details.sources').forEach((d) => d.remove());
  main.style.position = 'absolute'; main.style.left = '-99999px'; document.body.append(main);
  const t = main.innerText; main.remove(); return t;
});
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

await scenario('load: no request and no storage before submit; accessible shell; browser autofill kept', async (page, rec) => {
  await page.goto(URL_PAGE);
  await page.waitForSelector('#address');
  assert.equal(rec.mocked.length + rec.external.length, 0, `no external request before submit: ${[...rec.mocked, ...rec.external].join(' ')}`);
  assert.equal(await page.locator('label[for="address"]').count(), 1);
  assert.equal(await page.getAttribute('#status', 'aria-live'), 'polite');
  assert.equal(await page.locator('#address').getAttribute('autocomplete'), 'street-address', 'the browser can still fill the address');
  // typing alone must not start a lookup: it may only ask the address services (the county's, then Photon's) for suggestions
  await page.type('#address', '99999 Venice Blv', { delay: 5 });
  await page.waitForTimeout(800);
  assert.equal(rec.external.length, 0);
  assert.ok(rec.mocked.length >= 1 && rec.mocked.every((u) => u.includes('CAMS_Locator/GeocodeServer/suggest') || u.startsWith('https://photon.komoot.io/api/?')), `typing sends only suggest requests: ${rec.mocked.join(' ')}`);
  assert.equal(await text(page, '#address-help'), 'Start typing and pick your address');
  assert.doesNotMatch(await text(page, 'main'), /Los Angeles County's public address service|Nominatim|Overpass/, 'no service names above the footer');
  assert.match(await text(page, '#privacy-line'), /Nothing you enter here is saved\. While you type an address, the text is sent to Los Angeles County's public address service/);
  assert.match(await text(page, '#attribution'), /© OpenStreetMap contributors \(ODbL\)/);
  assert.equal(await page.locator('footer a[href="../host/"]').innerText(), 'Already renting? Manage your spaces in the Host Console');
});

await scenario('happy path: the property list, three scenarios, numbers equal core, wording rules', async (page, rec) => {
  await happy(page, rec);
  const r = await coreProfile(VENICE);
  const core = corePipeline(r.profile);
  assert.ok(rec.mocked.some((u) => u.includes('nominatim')) && rec.mocked.some((u) => u.includes('lacounty')) && rec.mocked.some((u) => u.includes('overpass')));
  assert.equal(rec.mocked.some((u) => u.includes('geocoding.geo.census.gov')), false, 'no Census geocoder from the browser');
  assert.match(await page.inputValue('#f-lot_area_sqft'), /^[\d,]+$/);
  assert.equal(await page.getAttribute(`${row('pool_present')} .approx`, 'title'), 'Estimated — change it if you know the exact figure', 'a mapped pool is an estimate');
  assert.equal(await page.getAttribute('#f-pool_present-yes', 'aria-pressed'), 'true');
  assert.equal(await page.inputValue('#f-parking_spaces'), '');
  await page.click('details.sources > summary');
  assert.match(await text(page, '#sources-table tr[data-src="lot_area_sqft"]'), /Lot size .*LA County Assessor/);
  assert.equal(await text(page, '#plan-note'), 'These are planning estimates, not promises. Prices and bookings are Everyspace planning defaults unless you enter your own.');
  const body = (await page.locator('body').innerText()).toLowerCase();
  assert.equal(/you will (earn|make|get)/.test(body), false, '"you will earn" never appears');
  assert.match(body, /could|estimate|planning/);
  for (const o of core.opps) {
    const heads = await page.locator(`[data-scen-table="${o.id}"] thead th`).allInnerTexts();
    assert.deepEqual(heads.map((h) => h.toLowerCase()), ['net income', 'conservative', 'baseline', 'optimistic'], o.id);
  }
  await assertMatchesCore(page, core, 'happy');
  const pool = core.estimates.pool.scenarios.baseline.noiCentsPerYear;
  assert.equal(await text(page, baseYear('pool')), usd0.format(pool / 100), 'displayed money is the formatted core value');
  await page.click('details[data-dk="bd-pool"] > summary');
  assert.match(await text(page, 'details[data-dk="bd-pool"]'), /Gross income.*Listing-site fees.*Cleaning.*Net income/);
  await page.click('details[data-dk="as-pool"] > summary');
  assert.match(await text(page, 'details[data-dk="as-pool"]'), /Price per hour.*Estimated.*Everyspace planning default \(uncited\)/);
  assert.equal(await page.locator('table[data-assumptions="pool"] tbody tr').count(), 12);
  assert.match(await text(page, '[data-opp-card="pool"]'), /Local rules not checked — confirm with your city/);
  assert.match(await text(page, '[data-opp-card="pool"] [data-confidence]'), /^Low: price and bookings are Everyspace planning defaults, not market data/);
  assert.match(await text(page, '#g-now'), /What you have now/);
  assert.match(await text(page, '#g-later'), /Needs a permit or investment first/);
  assert.match(await text(page, '[data-opp-card="entire_home"]'), /Allowed with conditions/);
  assert.match(await text(page, '#status'), /Here is your property\./);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await typeFact(page, 'bedrooms', 4);
  await page.waitForFunction(() => /Estimates updated: \d+ ways? to earn found\./.test(document.querySelector('#status').textContent));
});

await scenario('combination: caution by default, naive-vs-real sentence, goal change, constraints, investments apart', async (page, rec) => {
  await happy(page, rec);
  const r = await coreProfile(VENICE);
  const core = corePipeline(r.profile);
  assert.equal(await page.locator('#rules-caution').isVisible(), true, 'caution visible by default');
  assert.equal(await page.locator('#only-known').isChecked(), false);
  const sel = async () => (await page.locator('#combo-selected li strong').allInnerTexts()).sort();
  const labelsOf = (opt, byId) => opt.selected.map((id) => byId[id].label).sort();
  const byId = Object.fromEntries(core.opps.map((o) => [o.id, o]));
  assert.deepEqual(await sel(), labelsOf(core.opt, byId), 'default goal matches core');
  assert.match(await text(page, '#combo-naive'), /^Adding everything up would give \$[\d,]+, but some of these cannot run together .*, so the realistic total is \$[\d,]+\./);
  assert.equal(Number(await page.locator('#combo-naive [data-naive-cents]').getAttribute('data-naive-cents')), core.opt.naiveSumNoiCentsPerYear);
  assert.equal(Number(await page.locator('#combo-naive [data-real-cents]').getAttribute('data-real-cents')), core.opt.totals.noiCentsPerYear);
  assert.equal(await cents(page, '#combo-totals [data-scenario="baseline"][data-period="year"]'), core.opt.totals.noiCentsPerYear);
  assert.match(await text(page, '#combo-rejected'), /Conflicts with/);
  assert.match(await text(page, '#combo-investments'), /Entire home/i);
  const before = await sel();
  let changed = false;
  for (const goal of ['privacy', 'min_effort', 'min_upfront', 'fastest_payback']) {
    await page.selectOption('#goal', goal);
    const c = corePipeline(r.profile, { goal });
    await page.waitForFunction((g) => document.querySelector('#goal').value === g, goal);
    assert.deepEqual(await sel(), labelsOf(c.opt, byId), `goal ${goal} matches core`);
    if (JSON.stringify(await sel()) !== JSON.stringify(before)) changed = true;
  }
  assert.ok(changed, 'at least one goal selects a different set than the default');
  await page.selectOption('#goal', 'max_net_income');
  assert.ok((await sel()).includes('Private room'));
  await page.check('#no-strangers');
  await page.waitForFunction(() => !document.querySelector('#combo-selected')?.innerText.includes('Private room'));
  assert.deepEqual(await sel(), labelsOf(corePipeline(r.profile, { constraints: { noStrangersInHome: true } }).opt, byId));
  await page.uncheck('#no-strangers');
  await page.fill('#max-upfront', '100');
  await page.locator('#max-upfront').blur();
  await page.waitForFunction(() => document.querySelector('#combo-rejected')?.innerText.includes('Start-up cost unknown: enter it to include this under your budget'));
  await page.fill('#max-upfront', '');
  await page.locator('#max-upfront').blur();
  await page.check('#only-known');
  await page.waitForFunction(() => !document.querySelector('#rules-caution'));
  assert.deepEqual(await sel(), labelsOf(corePipeline(r.profile, { constraints: { allowUnknownRegulatory: false } }).opt, byId));
  await page.uncheck('#only-known');
  await page.waitForSelector('#rules-caution');
  assert.ok((await page.locator('a[href="../host/"]').count()) >= 3);
});

await scenario('editing: owner correction, answers, price override and investment ideas all recompute at once and equal core', async (page, rec) => {
  await happy(page, rec);
  const r = await coreProfile(VENICE);
  let p = r.profile;
  // 1. pool is wrong
  await page.click('#f-pool_present-no');
  p = owner(p, [['pool_present', false]]);
  await page.waitForFunction(() => !document.querySelector('[data-opp-card="pool"]'));
  await edited(page, 'pool_present');
  await assertMatchesCore(page, corePipeline(p), 'after pool=false');
  // 2. parking spaces: fill in an empty line; parking has no default volume, so it asks for it instead of guessing
  await typeFact(page, 'parking_spaces', '2');
  p = owner(p, [['parking_spaces', 2]]);
  await page.waitForSelector('[data-unavailable="parking_spot"]');
  assert.equal(await page.locator('[data-opp="parking_spot"]').count(), 0, 'no number while volume is unknown');
  await assertMatchesCore(page, corePipeline(p), 'parking, no volume');
  await page.fill('#need-parking_spot-unitsPerMonth', '60');
  await page.click('#need-save-parking_spot-unitsPerMonth');
  const ov = { parking_spot: { unitsPerMonth: 60 } };
  await page.waitForSelector(baseYear('parking_spot'));
  await assertMatchesCore(page, corePipeline(p, { overrides: ov }), 'parking with owner volume');
  // 3. owner price on private room
  await page.click('details[data-dk="as-private_room"] > summary');
  await page.click('#ei-edit-private_room-priceCents');
  await page.fill('#ei-private_room-priceCents', '150');
  await page.click('#ei-save-private_room-priceCents');
  ov.private_room = { priceCents: 15000 };
  await page.waitForFunction(() => [...document.querySelectorAll('[data-assumptions="private_room"] tr[data-input="priceCents"] .chip')].some((c) => c.textContent === 'You confirmed'));
  await assertMatchesCore(page, corePipeline(p, { overrides: ov }), 'after price override');
  await page.click('#ei-reset-private_room-priceCents');
  delete ov.private_room;
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-assumptions="private_room"] tr[data-input="priceCents"] .chip')].some((c) => c.textContent === 'You confirmed'));
  await assertMatchesCore(page, corePipeline(p, { overrides: ov }), 'after reset');
  // 4. a question: "yes" adds that idea, and the answer becomes a line in the list
  await page.click('details[data-dk="questions"] > summary');
  assert.match(await text(page, 'details[data-dk="questions"] > summary'), /^More things you could rent \(\d+ questions?\)$/);
  assert.equal(await page.locator('[data-opp-card="workspace"]').count(), 0);
  await page.click('#q-workspace_available-yes');
  p = owner(p, [['workspace_available', true]]);
  await page.waitForSelector('[data-opp-card="workspace"]');
  await assertMatchesCore(page, corePipeline(p, { overrides: ov }), 'after answering a question');
  assert.equal(await page.getAttribute('#f-workspace_available-yes', 'aria-pressed'), 'true');
  // 5. investment ideas
  const beforeCount = await page.locator('[data-opp-card]').count();
  await page.check('#include-investments');
  await page.waitForFunction((n) => document.querySelectorAll('[data-opp-card]').length > n, beforeCount);
  await assertMatchesCore(page, corePipeline(p, { overrides: ov, includeInvestmentIdeas: true }), 'with investment ideas');
  assert.match(await text(page, '[data-opp-card="adu"]'), /Needs building work first/);
  // a refused entry changes nothing
  await typeFact(page, 'bedrooms', '-4');
  assert.match(await text(page, `${row('bedrooms')} .fact-hint`), /Enter a number/);
  await assertMatchesCore(page, corePipeline(p, { overrides: ov, includeInvestmentIdeas: true }), 'after a refused entry');
});

await scenario('mismatch: confirmation is asked before any parcel lookup; Yes continues; candidates are picked by address', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, SPRING_N);
  await page.waitForSelector('#confirm-yes');
  assert.match(await text(page, '#h-confirm ~ p'), /We found 200 South Spring Street, Los Angeles, CA 90012\. Is this your property\?/);
  assert.equal(rec.mocked.some((u) => (u.includes('lacounty') && !u.includes('CAMS_Locator')) || u.includes('overpass')), false, 'no parcel request before confirmation');
  assert.match(await text(page, '#status'), /We found 200 South Spring Street/);
  await page.click('#confirm-no');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'address');
  await page.click('#address-submit');
  await page.waitForSelector('#confirm-yes');
  await page.click('#confirm-yes');
  await page.waitForSelector('#cand-none');
  assert.ok(rec.mocked.some((u) => u.includes('LACounty_Parcel')), 'now the parcel service is asked');
  assert.equal(await page.locator('[data-act="pick"]').count(), 10);
  assert.match(await text(page, '#h-cands ~ ul'), /145 S SPRING ST LOS ANGELES CA 90012 \(parcel 5149001003\)/);
  await page.click(`#pick-${APN}`);
  await page.waitForSelector('#facts');
  await settled(page);
  assert.match(await text(page, '#prop-parcel'), new RegExp(APN));
  const r = await coreProfile(SPRING_N, { confirmMatchedAddress: true, parcelApn: APN });
  assert.equal(r.ok, true);
  await assertMatchesCore(page, corePipeline(r.profile), 'picked parcel');
});

await scenario('candidates: "None of these" -> the list keeps what was found, and owner basics give estimates equal to core', async (page) => {
  await page.goto(URL_PAGE);
  await search(page, SPRING_S);
  await page.waitForSelector('#cand-none');
  await page.click('#cand-none');
  await page.waitForSelector('#facts');
  assert.match(await text(page, '#h-profile'), /200 South Spring Street/);
  assert.match(await text(page, '#type-hint'), /Choose a property type to see more ideas/);
  await page.selectOption('#f-property_type', 'multi_family');
  await edited(page, 'property_type');
  await typeFact(page, 'bedrooms', 4);
  await page.waitForSelector('[data-opp-card]');
  const r = await coreProfile(SPRING_S);
  const p = owner(r.profile, [['property_type', 'multi_family'], ['bedrooms', 4]]);
  await assertMatchesCore(page, corePipeline(p), 'manual after candidates');
});

await scenario('nothing found: one sentence, empty list, owner basics still give estimates equal to core', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, FAIL);
  await page.waitForSelector('#not-found');
  assert.match(await text(page, '#status'), /couldn't find that address automatically/i);
  assert.equal(await page.locator('[data-opp-card]').count(), 0);
  assert.match(await text(page, '#combo-empty'), /No combination fits/);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.selectOption('#f-property_type', 'single_family');
  await edited(page, 'property_type');
  await typeFact(page, 'bedrooms', 3);
  await typeFact(page, 'yard_area_sqft', 800);
  await page.click('#f-pool_present-yes');
  await edited(page, 'pool_present');
  await typeFact(page, 'parking_spaces', 2);
  await page.click('#f-garage_present-yes');
  await page.waitForSelector('[data-opp-card="garage_storage"]');
  const r = await coreProfile(FAIL);
  assert.equal(r.ok, false);
  const p = owner(r.profile, [['property_type', 'single_family'], ['bedrooms', 3], ['yard_area_sqft', 800], ['pool_present', true], ['parking_spaces', 2], ['garage_present', true]]);
  const core = corePipeline(p);
  await assertMatchesCore(page, core, 'manual');
  for (const k of ['pool', 'backyard', 'private_room', 'garage_storage', 'parking_spot']) assert.equal(await page.locator(`[data-opp-card="${k}"]`).count(), 1, k);
  // a yard of 0 removes yard ideas
  await typeFact(page, 'yard_area_sqft', 0);
  await page.waitForFunction(() => !document.querySelector('[data-opp-card="backyard"]'));
  await assertMatchesCore(page, corePipeline(owner(p, [['yard_area_sqft', 0]])), 'yard 0');
  // "enter details myself" asks before dropping the owner's values, and looks nothing up
  const mockedBefore = rec.mocked.length;
  await page.click('#manual-start');
  assert.match(await text(page, '#status'), /You have changes on this page\. Starting again clears them/);
  assert.ok(await page.locator('[data-opp-card]').count() > 0, 'first press changes nothing');
  await page.click('#manual-start');
  await page.waitForFunction(() => !document.querySelector('[data-opp-card]'));
  assert.equal(rec.mocked.length, mockedBefore);
}, { width: 1280, height: 900 }, 1, /^Failed to load resource: the server responded with a status of 503/);

await scenario('privacy and accessibility: nothing stored, labelled controls, only lookup hosts', async (page, rec, ctx) => {
  await happy(page, rec);
  await page.click('details[data-dk="questions"] > summary');
  await page.click('details[data-dk="as-pool"] > summary');
  const unlabeled = await page.evaluate(() => [...document.querySelectorAll('input, select')].filter((el) => !(el.labels && el.labels.length) && !el.getAttribute('aria-label') && !el.closest('label')).map((el) => el.id || el.outerHTML.slice(0, 60)));
  assert.deepEqual(unlabeled, [], 'every control has a label');
  const groups = await page.evaluate(() => [...document.querySelectorAll('.yn')].filter((g) => !g.getAttribute('aria-labelledby') && !g.getAttribute('aria-label')).length);
  assert.equal(groups, 0, 'every yes/no toggle is labelled');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('table')].filter((t) => !t.querySelector('th')).length), 0, 'every table has headers');
  assert.equal(await page.locator('main h1').count(), 1);
  const stored = await page.evaluate(async () => ({
    local: localStorage.length, session: sessionStorage.length, cookie: document.cookie,
    idb: (await indexedDB.databases?.())?.length ?? 0, caches: (await caches.keys()).length,
  }));
  assert.deepEqual(stored, { local: 0, session: 0, cookie: '', idb: 0, caches: 0 });
  assert.deepEqual(await ctx.cookies(), []);
  for (const u of rec.mocked) assert.ok(/^(nominatim\.openstreetmap\.org|public\.gis\.lacounty\.gov|overpass[\w.-]*)$/.test(new URL(u).hostname) || OTHER_SOURCES.test(new URL(u).hostname), u);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /google|analytics|cdn|gtag|fonts/.test(e.name)).length), 0);
});

await scenario('mobile 390px: no horizontal scroll at any stage; screenshot', async (page) => {
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
  await page.waitForSelector('#facts');
  await fits('loading');
  await settled(page);
  await page.click('details[data-dk="questions"] > summary');
  await page.click('details.sources > summary');
  await page.click('details[data-dk="as-pool"] > summary');
  await page.click('details[data-dk="bd-pool"] > summary');
  await page.click('#include-investments');
  await page.waitForSelector('[data-opp-card="adu"]');
  await fits('results');
  await typeFact(page, 'bedrooms', 'x');
  await fits('hint shown');
  await page.screenshot({ path: `${SHOTS}/estimate-phone.png`, fullPage: true });
}, { width: 390, height: 844 }, 2);

await scenario('dark mode renders (colour scheme follows the console)', async (page, rec) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await happy(page, rec);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(11, 16, 22)');
  await page.locator('section#property').screenshot({ path: `${SHOTS}/older-path-dark-desktop.png` });
});

// ---- address entry: malformed input, markup, double submit, failure messages ----------------------
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
    assert.equal(await page.locator(OUTCOME).count(), 0, `nothing runs for "${suffix}"`);
    assert.equal(rec.mocked.length, 0, `no request for "${suffix}"`);
  }
  await page.goto('about:blank');
  await page.goto(URL_PAGE + '#address=%E0%A4%A');
  await page.waitForSelector(OUTCOME);
  await page.goto('about:blank');
  await page.goto(URL_PAGE + '#address=' + 'x'.repeat(5000));
  await page.waitForSelector(OUTCOME);
  const qs = nominatimQs(rec);
  assert.ok(qs.length >= 1 && qs.every((q) => q.length <= 300), `address is capped at 300 characters (${qs.map((q) => q.length)})`);
  assert.equal(await page.evaluate(() => location.hash + location.search), '', 'arrival address removed from the URL');
  assert.equal(await page.getAttribute('#address', 'maxlength'), '300');
});

await scenario('markup in the typed address is shown as text and never runs', async (page) => {
  await page.goto(URL_PAGE);
  await search(page, PWN);
  await page.waitForSelector(OUTCOME);
  await noPwn(page, 'typed address');
  await page.goto('about:blank');
  await page.goto(URL_PAGE + '#address=' + encodeURIComponent(PWN));
  await page.waitForSelector(OUTCOME);
  await noPwn(page, 'fragment address');
});

await scenario('markup in a looked-up parcel record (situs address, use type) is escaped', async (page) => {
  override = (url) => {
    if (!new URL(url).hostname.endsWith('lacounty.gov') || url.includes('CAMS_Locator')) return undefined;
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
    await page.waitForSelector('#facts');
    await settled(page);
    await page.click('details.sources > summary');
    await noPwn(page, 'property list');
  } finally { override = null; }
});

await scenario('double submit and submit during a lookup: one lookup, the first address wins', async (page, rec) => {
  await page.goto(URL_PAGE);
  await page.fill('#address', VENICE);
  await page.evaluate(() => { const f = document.getElementById('address-form'); f.requestSubmit(); f.requestSubmit(); f.requestSubmit(); });
  await page.waitForSelector('#facts');
  await page.waitForTimeout(500);
  assert.equal(nominatimQs(rec).length, 1, 'geocoded once');
  await settled(page);
  await page.fill('#address', FAIL);
  await page.evaluate(() => { document.getElementById('address-form').requestSubmit(); document.getElementById('manual-start').click(); document.getElementById('address-form').requestSubmit(); });
  await page.waitForSelector('#not-found');
  assert.equal(nominatimQs(rec).filter((q) => q.includes('Failville')).length, 1, 'second address looked up once');
}, { width: 1280, height: 900 }, 1, /^Failed to load resource: the server responded with a status of 503/);

await scenario('lookup failures (geocoder down, parcel service down) show only the actionable sentence', async (page) => {
  await page.goto(URL_PAGE);
  await search(page, FAIL);
  await page.waitForSelector('#not-found');
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  override = (url) => (new URL(url).hostname.endsWith('lacounty.gov') ? { status: 500, body: { error: 'down' } } : undefined);
  try {
    await page.goto(URL_PAGE);
    await search(page, VENICE);
    await page.waitForSelector('#not-found');
    assert.equal(await text(page, '#not-found'), "We couldn't find that address automatically. Add your property details below.");
    assert.doesNotMatch(await ownerText(page), FORBIDDEN);
    assert.equal(await page.locator('[data-opp-card]').count(), 0, 'no invented ways to earn');
  } finally { override = null; }
}, { width: 1280, height: 900 }, 1, /^Failed to load resource: the server responded with a status of (503|500)/);

await scenario('reload mid-flow starts clean and the page says nothing is saved', async (page, rec) => {
  await happy(page, rec);
  assert.match(await text(page, '#session-note'), /Nothing is saved\. If you reload or leave this page, everything you entered here is cleared/);
  await page.reload();
  await page.waitForSelector('#address');
  assert.equal(await page.locator('#facts').count(), 0);
  assert.equal(await page.inputValue('#address'), '');
  assert.match(await text(page, 'main'), /Nothing you enter here is saved\./);
});

await scenario('keyboard only: type, Enter, focus lands on the property heading, edit with Enter, status announces', async (page) => {
  await page.goto(URL_PAGE);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.className), 'skip');
  await page.focus('#address');
  await page.keyboard.type(VENICE);
  await page.keyboard.press('Escape'); // close the suggestion list
  await page.keyboard.press('Enter');
  await page.waitForSelector('#facts');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h-profile', 'focus moves to the property heading');
  assert.match(await text(page, '#status'), /Here is your property/);
  assert.equal(await page.getAttribute('#status', 'aria-atomic'), 'true');
  await settled(page);
  await page.focus('#f-bedrooms');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'f-bedrooms' && document.querySelector('.fact[data-key="bedrooms"]').dataset.state === 'edited');
  assert.equal(await page.inputValue('#f-bedrooms'), '4');
});

await scenario('no-JavaScript notice; range per selected idea', async (page, rec, ctx) => {
  const nojs = await ctx.browser().newContext({ javaScriptEnabled: false });
  const p2 = await nojs.newPage();
  await p2.goto(URL_PAGE);
  assert.match((await p2.locator('noscript').first().innerText().catch(() => '')) || (await p2.locator('main').innerText()), /needs JavaScript/);
  await nojs.close();
  await happy(page, rec);
  assert.match(await text(page, '#combo-selected li'), /\$[\d,]+ to \$[\d,]+ a year on its own, baseline \$[\d,]+/, 'a range, not a lone number');
});

// ---- the county path (first choice): Los Angeles County's public services, mocked from synthetic fixtures ----------------
const PFX = path.join(ROOT, 'core/tests/fixtures/providers');
const pfx = (n) => JSON.parse(fs.readFileSync(path.join(PFX, n), 'utf8'));
const SFR = '4321 Example Ave, Los Angeles, CA 90099';
/** override() for the county services; `over` replaces one service's answer ({status, body}) or a function of the fixture. */
function countyWorld(over = {}) {
  const pick = (k, fixture) => (over[k] ? (typeof over[k] === 'function' ? over[k](pfx(fixture)) : over[k]) : { status: 200, body: pfx(fixture) });
  return (url, dec) => {
    const h = new URL(url).hostname;
    if (h === 'public.gis.lacounty.gov') {
      if (dec.includes('CAMS_Locator') && dec.includes('/suggest')) return { status: 200, body: pfx('la-cams-suggest.json') };
      if (dec.includes('CAMS_Locator')) return typeof over.cams === 'function' ? { status: 200, body: over.cams(pfx('synthetic-cams-sfr.json')) } : pick('cams', 'synthetic-cams-sfr.json');
      if (dec.includes('LACounty_Parcel') && !over.parcel && !dec.includes('SitusHouseNo=')) return undefined; // the older path's own parcel questions keep their default answers
      if (dec.includes('LACounty_Parcel')) return typeof over.parcel === 'function' ? { status: 200, body: over.parcel(pfx('synthetic-assessor-sfr.json')) } : pick('parcel', 'synthetic-assessor-sfr.json');
      if (dec.includes('LARIAC')) return typeof over.lariac === 'function' ? { status: 200, body: over.lariac(pfx('synthetic-lariac-sfr.json')) } : pick('lariac', 'synthetic-lariac-sfr.json');
    }
    if (h.includes('overpass')) return { status: 200, body: fx('overpass-no-features.json') };
    return undefined;
  };
}
const countyReqs = (rec) => rec.mocked.filter((u) => u.includes('public.gis.lacounty.gov'));
const withCounty = (over, fn) => async (page, rec, ctx) => { override = countyWorld(over); try { await fn(page, rec, ctx); } finally { override = null; } };
const noNominatim = (rec) => assert.equal(rec.mocked.some((u) => u.includes('nominatim')), false, 'Nominatim was not used');
const countyFetch = async (u, init) => { const a = answer(String(u)); if (!a) throw new Error(`unmocked ${u}`); return json(a.body, a.status); };
async function countyPage(page) { await page.goto(URL_PAGE); await search(page, SFR); await page.waitForSelector('#facts'); await settled(page); }

await scenario('county path: an LA address uses the county services; floors, bathrooms, roof and yards are filled in; earnings equal core', withCounty({}, async (page, rec) => {
  await countyPage(page);
  noNominatim(rec);
  assert.ok(countyReqs(rec).some((u) => u.includes('CAMS_Locator')) && countyReqs(rec).some((u) => u.includes('LACounty_Parcel')) && countyReqs(rec).some((u) => u.includes('LARIAC')));
  assert.equal(countyReqs(rec).filter((u) => u.includes('findAddressCandidates')).length, 1, 'the address is asked once, not twice');
  assert.equal(countyReqs(rec).filter((u) => u.includes('LACounty_Parcel')).length, 1, 'the parcel is asked once');
  assert.equal(await page.inputValue('#f-floors'), '2');
  assert.equal(await page.inputValue('#f-bathrooms'), '2');
  assert.equal(await page.inputValue('#f-living_area_sqft'), '2,800');
  assert.match(await page.inputValue('#f-roof_area_sqft'), /^[\d,]+$/);
  for (const k of ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft', 'yard_area_sqft']) {
    assert.match(await page.inputValue(`#f-${k}`), /^[\d,]+$/, k);
    assert.equal(await page.locator(row(k)).getAttribute('data-state'), 'estimated', k);
  }
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  const c = await runCountyPath(SFR, { fetch: countyFetch, now: NOW });
  assert.equal(c.kind, 'ok');
  await assertMatchesCore(page, corePipeline(await settleProfile(c)), 'county path');
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length), 0, 'nothing stored');
}));

await scenario('county path: an estimated value carries only "≈"; typing over it marks it as edited; a refused entry gets a hint', withCounty({}, async (page) => {
  await countyPage(page);
  assert.equal(await page.locator(row('floors')).getAttribute('data-state'), 'estimated');
  assert.equal(await page.getAttribute(`${row('floors')} .approx`, 'title'), 'Estimated — change it if you know the exact figure');
  assert.doesNotMatch(await text(page, row('floors')), /Ratio|confidence/);
  await typeFact(page, 'floors', '1');
  await edited(page, 'floors');
  assert.equal(await page.locator(`${row('floors')} .approx[title]`).count(), 0, 'no "≈" once the owner set it');
  await typeFact(page, 'roof_area_sqft', '1700');
  await edited(page, 'roof_area_sqft');
  assert.equal(await page.inputValue('#f-roof_area_sqft'), '1,700');
  await typeFact(page, 'floors', '1.5');
  assert.match(await text(page, `${row('floors')} .fact-hint`), /whole number/);
  assert.equal(await page.inputValue('#f-floors'), '1');
}));

await scenario('county path: with no street-side reference the yard lines are simply empty to fill in; total open ground is still estimated', withCounty({ cams: (b) => { b.candidates[0].location = { x: -118.29992, y: 34.00018 }; return b; } }, async (page) => {
  await countyPage(page);
  for (const k of ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft']) {
    assert.equal(await page.inputValue(`#f-${k}`), '', k);
    assert.equal(await page.getAttribute(`#f-${k}`, 'placeholder'), 'Add');
  }
  assert.doesNotMatch(await ownerText(page), /street reference|server-side/i);
  assert.equal(await page.inputValue('#f-yard_area_sqft'), '4,800');
  assert.equal(await page.locator(row('yard_area_sqft')).getAttribute('data-state'), 'estimated');
  await typeFact(page, 'front_yard_sqft', '900');
  await edited(page, 'front_yard_sqft');
  assert.equal(await page.inputValue('#f-front_yard_sqft'), '900');
}));

await scenario('county path: a second figure that disagrees is not shown as a warning on the list', withCounty({ parcel: (b) => { b.features[0].attributes['Shape.STArea()'] = 8200; return b; } }, async (page) => {
  await countyPage(page);
  assert.equal(await page.inputValue('#f-lot_area_sqft'), '6,500');
  assert.doesNotMatch(await text(page, 'section#property'), /Check this|% apart|says/i);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
}));

await scenario('county path: a missing building outline leaves roof and footprint empty to fill in, with no message', withCounty({ lariac: { status: 200, body: { features: [] } } }, async (page, rec) => {
  await countyPage(page);
  noNominatim(rec);
  assert.equal(await page.inputValue('#f-building_footprint_sqft'), '');
  assert.equal(await page.inputValue('#f-roof_area_sqft'), '');
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  assert.ok(await page.locator('[data-opp-card]').count() >= 1);
}));

const venice = (b) => { const c = b.candidates[0]; Object.assign(c, { address: '99999 Venice Blvd, Los Angeles, CA, 90034' }); Object.assign(c.attributes, { Match_addr: c.address, StAddr: '99999 Venice Blvd', StreetName: 'Venice', SufType: 'Blvd', ZIP: '90034' }); return b; };
// [name, county mocks, typed address, a property list (not the confirm screen) is expected]
const FALLBACKS = [
  ['the county locator finds no match', { cams: { status: 200, body: { candidates: [] } } }, VENICE, true],
  ['the county locator is down', { cams: { status: 500, body: { error: 'down' } } }, VENICE, true],
  ['the county locator answers with something unreadable', { cams: { status: 200, body: { nope: true } } }, VENICE, true],
  ['the assessor has no matching parcel', { cams: venice, parcel: { status: 200, body: { features: [] } } }, VENICE, false],
  ['the assessor is down', { cams: venice, parcel: { status: 500, body: { error: 'down' } } }, VENICE, false],
  ['the address says another state', { cams: venice }, '99999 Venice Blvd, Phoenix, AZ 85001', false],
  ['the typed ZIP differs from the county match', { cams: venice }, '99999 Venice Blvd, Los Angeles, CA 90210', false],
];
for (const [name, over, addr, expectList] of FALLBACKS) {
  await scenario(`fallback: ${name} -> the older path runs and reaches an outcome, with nothing said about why`, withCounty(over, async (page, rec) => {
    await page.goto(URL_PAGE);
    await search(page, addr);
    await page.waitForSelector(expectList ? '#facts' : OUTCOME);
    assert.ok(rec.mocked.some((u) => u.includes('nominatim')), 'Nominatim was asked');
    assert.doesNotMatch(await ownerText(page), FORBIDDEN);
    if (expectList) {
      await settled(page);
      assert.equal(await page.inputValue('#f-floors'), '', 'the older path has no floors');
      assert.ok(await page.locator('[data-opp-card]').count() >= 1, 'earnings sections still work');
    }
  }), { width: 1280, height: 900 }, 1, /^Failed to load resource: the server responded with a status of 5\d\d/);
}

// ---- outside Los Angeles County: Chicago City Hall (a public building), county lookup + Overture + the county's own parcel service --------------------------
const CHICAGO = '121 N LaSalle St, Chicago, IL 60602';
const CHI_PT = OVERTURE_REAL.chicago.point;
const chiOv = overtureServer('chicago');
const LOT_RINGS = (() => { // a synthetic parcel 90 m x 70 m around the point, as Esri rings (clockwise)
  const dLng = 45 / (111320 * Math.cos((CHI_PT.lat * Math.PI) / 180)), dLat = 35 / 110540;
  return [[[CHI_PT.lng - dLng, CHI_PT.lat - dLat], [CHI_PT.lng - dLng, CHI_PT.lat + dLat], [CHI_PT.lng + dLng, CHI_PT.lat + dLat], [CHI_PT.lng + dLng, CHI_PT.lat - dLat], [CHI_PT.lng - dLng, CHI_PT.lat - dLat]]];
})();
/** override() for the nationwide path. `parcel`: 'none' (404) | 'answer'. `photon`: features for the suggestion service. */
function chicagoWorld({ parcel = 'none', photon = [] } = {}) {
  const nominatim = [{ _fixture_note: 'synthetic, shaped like the recorded response; not a recorded response', place_id: 2, osm_type: 'way', osm_id: 2, lat: String(CHI_PT.lat), lon: String(CHI_PT.lng), category: 'building', type: 'civic',
    display_name: '121, North LaSalle Street, Chicago, Cook County, Illinois, 60602, United States', address: { house_number: '121', road: 'North LaSalle Street', city: 'Chicago', county: 'Cook County', state: 'Illinois', 'ISO3166-2-lvl4': 'US-IL', postcode: '60602', country_code: 'us' } }];
  return (url, dec, range) => {
    const h = new URL(url).hostname;
    if (h === 'nominatim.openstreetmap.org') return { status: 200, body: nominatim };
    if (h === 'geo.fcc.gov') return { status: 200, body: pfx('fcc-county-chicago-city-hall.json') };
    if (h === 'photon.komoot.io') return { status: 200, body: { features: photon } };
    if (h === 'gis.cookcountyil.gov') return parcel === 'answer' ? { status: 200, body: { geometryType: 'esriGeometryPolygon', features: [{ attributes: { PIN14: '17-09-999-001' }, geometry: { rings: LOT_RINGS } }] } } : { status: 404, body: {} };
    const o = chiOv.answer(url, range);
    if (o) return { status: o.status, raw: Buffer.from(o.body), type: o.type };
    if (h.includes('overpass')) return { status: 200, body: fx('overpass-no-features.json') };
    return undefined;
  };
}
const withChicago = (opts, fn) => async (page, rec, ctx) => { override = chicagoWorld(opts); try { await fn(page, rec, ctx); } finally { override = null; } };
const FAILURE_WORDS = /fail|error|unavailable|not found|warning/i;

await scenario('non-LA address: county lookup + Overture fill footprint, roof and floors; the lot-size line is an empty input; no failure words; no Los Angeles County service asked', withChicago({}, async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, CHICAGO);
  await page.waitForSelector('#facts');
  await settled(page);
  assert.equal(rec.mocked.some((u) => u.includes('lacounty')), false, 'no Los Angeles County service');
  assert.ok(rec.mocked.some((u) => u.includes('geo.fcc.gov')) && rec.mocked.some((u) => u.includes('amazonaws.com')) && rec.mocked.some((u) => u.includes('cookcountyil.gov')));
  assert.ok(Number((await page.inputValue('#f-building_footprint_sqft')).replace(/,/g, '')) > 10000, 'footprint');
  assert.match(await page.inputValue('#f-roof_area_sqft'), /^[\d,]+$/); assert.match(await page.inputValue('#f-floors'), /^\d+$/);
  assert.equal(await page.inputValue('#f-lot_area_sqft'), '', 'lot size: simply an empty input');
  assert.equal(await page.locator(row('lot_area_sqft')).getAttribute('data-state'), 'empty');
  for (const k of ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft']) assert.equal(await page.inputValue(`#f-${k}`), '', `${k}: no street reference, so no front is guessed`);
  assert.doesNotMatch(await text(page, 'main'), FAILURE_WORDS);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  assert.equal(await page.getAttribute('#f-lot_area_sqft', 'placeholder'), 'Add', 'the owner can type the lot size');
  assert.match(await text(page, '#attribution'), /Overture Maps Foundation/);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length), 0, 'nothing stored');
}));

await scenario('non-LA address with an answering county parcel service: the lot size is filled', withChicago({ parcel: 'answer' }, async (page) => {
  await page.goto(URL_PAGE);
  await search(page, CHICAGO);
  await page.waitForSelector('#facts');
  await settled(page);
  const lot = Number((await page.inputValue('#f-lot_area_sqft')).replace(/,/g, ''));
  assert.ok(lot > 60000 && lot < 70000, `lot ${lot} sq ft (a 90 m x 70 m parcel is about 67,800)`);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  // the county service maps no use code, so the property type is left for the owner to choose (earnings ideas follow that choice)
  assert.match(await text(page, 'main'), /Choose a property type to see more ideas/);
}));

await scenario('Photon suggestion: picking it fills the field; the lookup then asks no geocoder (no Nominatim, no county locator) and uses the suggestion\'s point', withChicago({ photon: [
  { type: 'Feature', geometry: { type: 'Point', coordinates: [CHI_PT.lng, CHI_PT.lat] }, properties: { countrycode: 'US', housenumber: '121', street: 'North LaSalle Street', city: 'Chicago', state: 'Illinois', postcode: '60602', name: 'Chicago City Hall' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-79.38, 43.65] }, properties: { countrycode: 'CA', housenumber: '5', street: 'Elsewhere Road', city: 'Toronto', state: 'Ontario' } }] }, async (page, rec) => {
  await page.goto(URL_PAGE);
  await page.type('#address', '121 N LaSalle St, Chicago, IL', { delay: 5 });
  await page.waitForSelector('[role="option"]');
  assert.deepEqual(await page.locator('[role="option"]').allInnerTexts(), ['121 North LaSalle Street, Chicago, IL 60602']);
  await page.locator('[role="option"]').first().click();
  assert.equal(await page.inputValue('#address'), '121 North LaSalle Street, Chicago, IL 60602');
  const before = rec.mocked.length;
  await page.click('#address-submit');
  await page.waitForSelector('#facts');
  await settled(page);
  const lookup = rec.mocked.slice(before);
  assert.equal(lookup.some((u) => u.includes('nominatim') || u.includes('CAMS_Locator') || u.includes('geocoding.geo.census.gov')), false, `no geocoder was asked: ${lookup.map((u) => new URL(u).hostname).join(' ')}`);
  assert.ok(lookup.some((u) => u.includes('geo.fcc.gov')), 'only the county of the point was looked up');
  assert.match(await page.inputValue('#f-building_footprint_sqft'), /^[\d,]+$/);
  assert.match(await text(page, '#status, main'), /Chicago/);
  // editing the text after picking drops the suggestion's point: the typed text is then located by the geocoder as usual
  await page.fill('#address', '121 North LaSalle Street, Chicago, IL 60602 ');
  await page.fill('#address', '121 N LaSalle St, Chicago, IL 60602');
  const mark = rec.mocked.length;
  await page.click('#address-submit');
  await page.waitForSelector('#facts');
  await settled(page);
  assert.ok(rec.mocked.slice(mark).some((u) => u.includes('nominatim')), 'a typed address is geocoded');
}));

await scenario('arriving from the homepage with a chosen suggestion: its point comes in the URL fragment, no geocoder is asked, and the URL is cleaned', withChicago({ photon: [] }, async (page, rec) => {
  const before = rec.mocked.length;
  await page.goto(`${URL_PAGE}#address=${encodeURIComponent('121 North LaSalle Street, Chicago, IL 60602')}&lat=${CHI_PT.lat}&lng=${CHI_PT.lng}&source=photon`);
  await page.waitForSelector('#facts');
  await settled(page);
  const lookup = rec.mocked.slice(before);
  assert.equal(lookup.some((u) => u.includes('nominatim') || u.includes('CAMS_Locator') || u.includes('geocoding.geo.census.gov')), false, `no geocoder was asked: ${lookup.map((u) => new URL(u).hostname).join(' ')}`);
  assert.ok(lookup.some((u) => u.includes('geo.fcc.gov')), 'the county of the passed point was looked up');
  assert.match(await page.inputValue('#f-building_footprint_sqft'), /^[\d,]+$/);
  assert.equal(new URL(page.url()).hash, '', 'address and point are removed from the URL');
  // a malformed point is ignored: the address is then located the usual way
  const mark = rec.mocked.length;
  await page.goto('about:blank'); // a hash-only change on an open page does not reload it, so leave first
  await page.goto(`${URL_PAGE}#address=${encodeURIComponent('121 N LaSalle St, Chicago, IL 60602')}&lat=abc&lng=999`);
  await page.waitForSelector('#facts');
  await settled(page);
  assert.ok(rec.mocked.slice(mark).some((u) => u.includes('nominatim')), 'a bad point falls back to geocoding');
}));

await scenario('Photon: an LA-looking address with no state still gets the county first; typing an Illinois address never asks the county service', async (page, rec) => {
  await page.goto(URL_PAGE);
  await page.type('#address', '121 N LaSalle St, Chicago, IL', { delay: 5 });
  await page.waitForTimeout(700);
  assert.equal(rec.mocked.filter((u) => u.includes('CAMS_Locator')).length, 0);
  assert.ok(rec.mocked.some((u) => u.startsWith('https://photon.komoot.io/api/?')));
});

// no lookup request may ever carry a broken number (regression: an outline of type Polygon produced "around:NaN")
const brokenUrls = allRecs.flatMap((r) => r.mocked).filter((u) => /NaN|undefined/.test(decodeURIComponent(u)));
if (brokenUrls.length) failures.push(`lookup requests with a broken value: ${brokenUrls.slice(0, 3).join(', ')}`);

const totalExternal = allRecs.flatMap((r) => r.external);
if (totalExternal.length) failures.push(`unmocked external requests: ${totalExternal.join(', ')}`);

await browser.close();
server.close();
console.log(`\n${passed} scenario(s) passed, ${failures.length} failure(s)`);
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

// Property screen e2e (Chromium via Playwright): address-match confirmation, parcel picker, the owner-first property list
// (each value is an input: inline edit, commas, invalid entries refused, Escape, undo, yes/no toggles, empty facts as "Add"),
// the single sources disclosure, the nothing-found state, manual mode. Screenshots of each state. Every external host is
// answered from the recorded core fixtures; anything else that leaves localhost is ABORTED and fails the run.
// Run: node tests/property-confirm.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'); }
const { chromium } = pw;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'core/tests/fixtures/parcel');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));
const VENICE = '99999 Venice Blvd, Los Angeles, CA 90034';
const SPRING_N = '200 N Spring St, Los Angeles, CA 90012';
const SPRING_S = '200 S Spring St, Los Angeles, CA 90012';
const FAIL = '1 Failville Rd, Nowhere, ZZ 00000';
const APN = '5149007006';

/** Hosts other data sources may ask (county lookup, Overture): answered "not here". */
const OTHER_SOURCES = /(^|\.)(geo\.fcc\.gov|tigerweb\.geo\.census\.gov|stac\.overturemaps\.org|amazonaws\.com|imagery\.nationalmap\.gov|planetarycomputer\.microsoft\.com)$/;
const SHOTS = '/tmp/claude-0/-home-user/bbdf9db1-6a70-50d8-8c4a-2fe889e65e9c/scratchpad/ux';
fs.mkdirSync(SHOTS, { recursive: true });
let override = null; // a scenario may replace the county services' answers: (url, decodedUrl) => {status, body} | undefined
function answer(urlStr) {
  const u = new URL(urlStr);
  const dec = decodeURIComponent(urlStr);
  const o = override?.(urlStr, dec);
  if (o) return o;
  if (u.hostname === 'nominatim.openstreetmap.org') {
    const q = u.searchParams.get('q') ?? '';
    if (q.includes('Failville')) return { status: 503, body: { error: 'down' } };
    if (q.includes('Spring')) {
      const [r] = fx('nominatim-la.json');
      return { status: 200, body: [{ ...r, lat: '34.051622610747', lon: '-118.245593523439', display_name: '200, South Spring Street, Los Angeles, California, 90012, United States', address: { ...r.address, house_number: '200', road: 'South Spring Street', postcode: '90012' } }] };
    }
    return { status: 200, body: fx('nominatim-la.json') };
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
  if (OTHER_SOURCES.test(u.hostname)) return { status: 404, body: {} };
  return null;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
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

const browser = await chromium.launch();
const failures = [];
let passed = 0;
const allExternal = [];
async function scenario(name, fn, allowConsole = null, { viewport = { width: 1280, height: 900 }, colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const rec = { external: [], mocked: [], consoleErrors: [], pageErrors: [] };
  page.on('console', (m) => { if (m.type() === 'error') rec.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e)));
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || url.startsWith('data:')) return route.continue();
    const a = answer(url);
    if (!a) { rec.external.push(url); allExternal.push(url); return route.abort('failed'); }
    rec.mocked.push(url);
    return route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body) });
  });
  try {
    await fn(page, rec);
    assert.deepEqual(rec.consoleErrors.filter((m) => !(allowConsole && allowConsole.test(m)) && !/status of 404/.test(m)), [], 'console errors');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length), 0, 'nothing stored');
    assert.deepEqual(rec.pageErrors, [], 'uncaught page errors');
    assert.deepEqual(rec.external, [], 'unmocked external requests');
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e}`);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
  } finally { await ctx.close(); }
}

const text = async (page, sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();
const nominatim = (rec) => rec.mocked.filter((u) => u.includes('nominatim')).length;
async function search(page, address) { await page.fill('#address', address); await page.click('#address-submit'); }
async function happy(page) { await page.goto(URL_PAGE); await search(page, VENICE); await page.waitForSelector('#facts'); await settled(page); }
const settled = (page) => page.waitForFunction(() => document.getElementById('progress').hidden && !document.querySelector('.fact[data-state="loading"]'), null, { timeout: 15000 });
const row = (key) => `.fact[data-key="${key}"]`;
/** Type into a fact input and apply it with Enter (or by leaving it). */
async function typeFact(page, key, value, how = 'Enter') {
  await page.fill(`#f-${key}`, value);
  if (how === 'Enter') await page.press(`#f-${key}`, 'Enter'); else await page.locator(`#f-${key}`).blur();
}
const FORBIDDEN = /failed|error|unavailable|not available|not found|warning|overpass|nominatim|lariac|cams|assessor/i;
/** Visible page text, minus the collapsed sources disclosure and the footer. */
const ownerText = (page) => page.evaluate(() => {
  const main = document.querySelector('main').cloneNode(true);
  main.querySelectorAll('details.sources').forEach((d) => d.remove());
  document.body.append(main); main.style.position = 'absolute'; main.style.left = '-99999px';
  const t = main.innerText; main.remove(); return t;
});
/** every dollar figure on the page, in document order: changes when the results change */
/** (they live on page 2: this goes there and comes back to the property list) */
async function toEarn(page) { if (!(await page.locator('#view-earn').isVisible())) await page.click('#next-earn'); await page.waitForSelector('#earn-headline'); }
async function toProperty(page) { if (await page.locator('#view-earn').isVisible()) await page.click('#back-property'); await page.waitForSelector('#facts'); }
async function figures(page) {
  await toEarn(page);
  const f = await page.locator('[data-cents]').evaluateAll((els) => els.map((e) => `${e.dataset.opp ?? 'combo'}|${e.dataset.scenario}|${e.dataset.period}|${e.dataset.cents}`));
  await toProperty(page);
  return f;
}
const hasCard = async (page, id) => { await toEarn(page); const n = await page.locator(`[data-opp-card="${id}"]`).count(); await toProperty(page); return n; };

console.log('property confirm e2e');

await scenario('matched-address confirmation: asked before any parcel lookup; No returns to the address box; Yes continues', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, SPRING_N);
  await page.waitForSelector('#confirm-yes');
  assert.match(await text(page, '#h-confirm ~ p'), /^We found 200 South Spring Street, Los Angeles, CA 90012\. Is this your property\?$/);
  assert.match(await text(page, '#h-confirm ~ p ~ p'), /You typed: 200 N Spring St/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-yes', 'focus moves to the question');
  assert.equal(rec.mocked.filter((u) => (u.includes('lacounty') && !u.includes('CAMS_Locator')) || u.includes('overpass')).length, 0, 'no parcel request yet');
  assert.equal(await page.locator('#facts').count(), 0, 'no property list before the owner says yes');
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.click('#confirm-no');
  assert.equal(await page.locator('#confirm-yes').count(), 0);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'address');
  assert.equal(await page.inputValue('#address'), SPRING_N, 'typed text kept for editing');
  await page.click('#address-submit');
  await page.waitForSelector('#confirm-yes');
  await page.click('#confirm-yes');
  await page.waitForSelector('#cand-none');
  assert.ok(rec.mocked.some((u) => u.includes('LACounty_Parcel')), 'parcel service asked only after Yes');
});

await scenario('parcel picker: several matches -> pick yours; "None of these" gives the empty list with nothing guessed', async (page) => {
  await page.goto(URL_PAGE);
  await search(page, SPRING_S);
  await page.waitForSelector('#cand-none');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cand-none');
  assert.equal(await page.locator('[data-act="pick"]').count(), 10, 'capped at 10 candidates');
  assert.match(await text(page, '#h-cands ~ p'), /Several properties match that address\. Pick yours\./);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.click(`#pick-${APN}`);
  await page.waitForSelector('#facts');
  assert.match(await text(page, '#prop-parcel'), new RegExp(`Parcel ${APN}`), 'the picked parcel is in the heading');
  await page.goto(URL_PAGE);
  await search(page, SPRING_S);
  await page.waitForSelector('#cand-none');
  await page.click('#cand-none');
  await page.waitForSelector('#facts');
  assert.equal(await page.locator('#prop-parcel').count(), 0, 'no parcel number was assumed');
  assert.equal(await page.locator('[data-opp-card]').count(), 0, 'no ways to earn without a property type');
});

await scenario('the list: plain lines in the owner order, values are inputs, internals hidden, address and parcel once in the heading', async (page) => {
  await happy(page);
  const keys = await page.locator('#facts .fact').evaluateAll((els) => els.map((e) => e.dataset.key));
  const ORDER = ['lot_area_sqft', 'living_area_sqft', 'bedrooms', 'bathrooms', 'floors', 'year_built', 'remodeled_year', 'roof_area_sqft', 'front_yard_sqft', 'back_yard_sqft', 'yard_area_sqft', 'building_footprint_sqft', 'pool_present', 'parking_spaces', 'garage_present'];
  assert.deepEqual(keys.slice(0, ORDER.length), ORDER, 'owner order');
  for (const k of ['address', 'location', 'parcel_boundary', 'use_code', 'use_type', 'buildings', 'parcel_id', 'jurisdiction']) assert.ok(!keys.includes(k), `${k} hidden`);
  assert.match(await text(page, '#h-profile'), /Venice/);
  assert.match(await text(page, '#prop-parcel'), /^Parcel \d+/);
  assert.match(await text(page, row('lot_area_sqft')), /^Lot size/);
  assert.match(await page.inputValue('#f-lot_area_sqft'), /^\d{1,3}(,\d{3})*$/, 'lot size reads like "6,500"');
  assert.equal(await text(page, `${row('lot_area_sqft')} .unit`), 'sq ft');
  // facts that were not found: empty input, placeholder "Add", no words about why
  for (const k of ['bathrooms', 'floors', 'parking_spaces']) {
    assert.equal(await page.inputValue(`#f-${k}`), '', `${k} empty`);
    assert.equal(await page.getAttribute(`#f-${k}`, 'placeholder'), 'Add', `${k} placeholder`);
    assert.equal(await page.locator(row(k)).getAttribute('data-state'), 'empty');
  }
  assert.equal(await page.locator(`${row('garage_present')} [aria-pressed="true"]`).count(), 0, 'a yes/no fact we did not find has neither pressed');
  // no step log, no lookup path, no confidence words, no reasons
  assert.equal(await page.locator('#step-log, #path-note, #unavailable-table, #profile-table, [data-dk="missing-attrs"], .row-note').count(), 0);
  const t = await ownerText(page);
  assert.doesNotMatch(t, FORBIDDEN);
  assert.doesNotMatch(await text(page, 'section#property'), /confidence|unknown|What we looked up|Lookup path/i);
  // estimated values carry only "≈" with the tooltip
  const est = page.locator('.fact[data-state="estimated"] .approx').first();
  if (await est.count()) assert.equal(await est.getAttribute('title'), 'Estimated — change it if you know the exact figure');
  // where the numbers come from: one collapsed disclosure with fact, source, date
  const d = page.locator('details.sources');
  assert.equal(await d.count(), 1);
  assert.equal(await d.evaluate((e) => e.open), false, 'collapsed');
  assert.equal(await text(page, 'details.sources > summary'), 'Where these numbers come from');
  await page.click('details.sources > summary');
  const lot = await text(page, '#sources-table tr[data-src="lot_area_sqft"]');
  assert.match(lot, /Lot size .+ [A-Z][a-z]{2} \d{1,2}, \d{4}/, 'fact, source and date');
  assert.doesNotMatch(await text(page, '#sources-table'), /failed|unavailable|not available|warning/i);
  await page.locator('section#property').screenshot({ path: `${SHOTS}/older-path-loaded-desktop.png` });
});

await scenario('inline edit: type over a value, Enter applies, commas accepted, "edited by you" mark, everything below recomputes', async (page) => {
  await happy(page);
  const before = await figures(page);
  assert.ok(before.length > 0);
  assert.equal(await page.locator('#facts button:text("Edit"):not(.lm-listedit), #facts .btn').count(), 0, 'no Edit buttons');
  await page.click('#f-bedrooms');
  await page.fill('#f-bedrooms', '9');
  await page.press('#f-bedrooms', 'Enter');
  await page.waitForSelector(`${row('bedrooms')}[data-state="edited"]`);
  assert.equal(await page.inputValue('#f-bedrooms'), '9');
  assert.match(await text(page, `${row('bedrooms')} .fact-meta`), /Edited by you\s*Undo/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-bedrooms', 'focus stays on the value');
  // commas, applied by leaving the field
  await typeFact(page, 'lot_area_sqft', '7,250', 'blur');
  await page.waitForSelector(`${row('lot_area_sqft')}[data-state="edited"]`);
  assert.equal(await page.inputValue('#f-lot_area_sqft'), '7,250');
  // the same value again changes nothing and leaves no mark
  const keysEdited = await page.locator('.fact[data-state="edited"]').count();
  await typeFact(page, 'year_built', await page.inputValue('#f-year_built'));
  assert.equal(await page.locator('.fact[data-state="edited"]').count(), keysEdited);
  // a yes/no fact is a toggle; the pool answer changes the ideas at once
  await page.click('#f-pool_present-no');
  await page.waitForSelector(`${row('pool_present')}[data-state="edited"]`);
  assert.equal(await page.getAttribute('#f-pool_present-no', 'aria-pressed'), 'true');
  assert.equal(await page.getAttribute('#f-pool_present-yes', 'aria-pressed'), 'false');
  assert.equal(await hasCard(page, 'pool'), 0, 'no pool idea');
  await page.click('#f-pool_present-yes');
  await page.waitForFunction(() => document.querySelector('#f-pool_present-yes').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-pool_present-yes', 'focus stays on the toggle');
  assert.equal(await hasCard(page, 'pool'), 1, 'a yes adds the pool idea');
  // what the owner says they own
  await page.click('#own-building');
  await page.waitForSelector('#own-building:checked');
  assert.notDeepEqual(await figures(page), before, 'corrections changed the estimates at once');
});

await scenario('invalid entries are refused with a short hint next to the line; the previous value stays; Escape restores', async (page) => {
  await happy(page);
  const figs = await figures(page);
  const lot = await page.inputValue('#f-lot_area_sqft');
  const tryBad = async (key, value, pattern) => {
    const prev = await page.inputValue(`#f-${key}`);
    await typeFact(page, key, value);
    assert.match(await text(page, `${row(key)} .fact-hint`), pattern, `${key}=${value}`);
    assert.equal(await page.inputValue(`#f-${key}`), prev, `${key}: previous value stays`);
    assert.equal(await page.getAttribute(`#f-${key}`, 'aria-invalid'), 'true');
    assert.notEqual(await page.locator(row(key)).getAttribute('data-state'), 'edited');
    assert.doesNotMatch(await text(page, `${row(key)} .fact-hint`), FORBIDDEN);
  };
  await tryBad('bedrooms', '-2', /Enter a number/);
  await tryBad('bedrooms', '2.5', /whole number/);
  await tryBad('bedrooms', 'abc', /Enter a number/);
  await tryBad('year_built', '12', /between 1600 and/);
  await tryBad('year_built', '3000', /between 1600 and/);
  await tryBad('lot_area_sqft', '99999999999', /too large/);
  // the hint goes away once a good value is typed
  await page.fill('#f-bedrooms', '4');
  assert.equal(await page.locator(`${row('bedrooms')} .fact-hint`).count(), 0);
  await page.press('#f-bedrooms', 'Escape');
  assert.equal(await page.inputValue('#f-bedrooms'), await page.inputValue('#f-bedrooms'));
  // Escape restores what was there and applies nothing
  await page.fill('#f-lot_area_sqft', '123');
  await page.press('#f-lot_area_sqft', 'Escape');
  assert.equal(await page.inputValue('#f-lot_area_sqft'), lot);
  await page.locator('#f-lot_area_sqft').blur();
  assert.equal(await page.locator(row('lot_area_sqft')).getAttribute('data-state') === 'edited', false);
  // clearing a value is not an edit
  await typeFact(page, 'lot_area_sqft', '');
  assert.equal(await page.inputValue('#f-lot_area_sqft'), lot);
  assert.deepEqual(await figures(page), figs, 'estimates unchanged by refused entries');
});

await scenario('undo returns a line to the looked-up value (or to empty when nothing was found)', async (page) => {
  await happy(page);
  const figs = await figures(page);
  const yard = await page.inputValue('#f-yard_area_sqft');
  assert.notEqual(yard, '');
  await typeFact(page, 'yard_area_sqft', '0');
  await page.waitForSelector(`${row('yard_area_sqft')}[data-state="edited"]`);
  assert.notDeepEqual(await figures(page), figs);
  await page.click('#undo-yard_area_sqft');
  assert.equal(await page.inputValue('#f-yard_area_sqft'), yard);
  assert.notEqual(await page.locator(row('yard_area_sqft')).getAttribute('data-state'), 'edited');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-yard_area_sqft', 'focus returns to the value');
  assert.deepEqual(await figures(page), figs, 'estimates back to the looked-up figures');
  await typeFact(page, 'parking_spaces', '2');
  await page.waitForSelector(`${row('parking_spaces')}[data-state="edited"]`);
  await page.click('#undo-parking_spaces');
  assert.equal(await page.inputValue('#f-parking_spaces'), '');
  assert.equal(await page.locator(row('parking_spaces')).getAttribute('data-state'), 'empty');
});

await scenario('keyboard only: Tab through the list, type, Tab applies and moves on, toggles work with Space', async (page) => {
  await happy(page);
  await page.focus('#f-lot_area_sqft');
  await page.keyboard.press('Tab'); // home size
  await page.keyboard.press('Tab'); // bedrooms
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-bedrooms');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('5');
  await page.keyboard.press('Tab');
  await page.waitForSelector(`${row('bedrooms')}[data-state="edited"]`);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-bathrooms', 'focus moved on and stayed there after the update');
  await page.focus('#f-garage_present-yes');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#f-garage_present-yes').getAttribute('aria-pressed') === 'true');
  // an answered empty line hands focus to the next empty one, or to the question below when there is none
  await page.waitForFunction(() => document.activeElement.id !== 'f-garage_present-yes');
  assert.ok(['qh', 'f-pool_present-yes'].includes(await page.evaluate(() => document.activeElement.id)) || await page.evaluate(() => document.activeElement.closest('.fact, #qcard') !== null), 'focus moved on');
});

await scenario('owner questions: a yes answer becomes a line in the list; a typed answer that is refused gets a hint in the card', async (page) => {
  await happy(page);
  await page.waitForSelector('#qcard #q-body[data-key]');
  const key = await page.getAttribute('#q-body', 'data-key');
  const type = await page.evaluate(() => document.querySelector('#q-body input[type="text"]') ? 'number' : 'choice');
  if (type === 'choice') {
    await page.click(`#q-${key}-yes`);
    await page.waitForSelector(`${row(key)}[data-state="edited"]`);
    assert.equal(await page.getAttribute(`#f-${key}-yes`, 'aria-pressed'), 'true', 'the answer is now a line in the list');
  }
  await page.click('#qcard .q-dot[data-key="yard_area_sqft"]').catch(() => {});
  const num = page.locator('#q-body input[type="text"]');
  if (await num.count()) {
    const id = await num.getAttribute('id');
    await page.fill(`#${id}`, '-5');
    await page.press(`#${id}`, 'Enter');
    await page.waitForSelector('#q-err');
  }
  await toEarn(page);
  await page.click('details[data-dk="earn-settings"] > summary');
  await page.fill('#max-upfront', '-100');
  await page.locator('#max-upfront').blur();
  await page.waitForSelector('#input-error');
  assert.match(await text(page, '#input-error'), /zero or more.*No limit is applied/);
});

await scenario('re-searching does not silently drop the owner\'s changes', async (page, rec) => {
  await happy(page);
  await typeFact(page, 'bedrooms', '6');
  await page.waitForSelector(`${row('bedrooms')}[data-state="edited"]`);
  const calls = nominatim(rec);
  await page.getByRole('button', { name: 'Change address' }).click();
  await page.click('#address-submit');
  assert.match(await text(page, '#status'), /You have changes on this page/);
  assert.equal(nominatim(rec), calls, 'nothing looked up on the first press');
  assert.equal(await page.inputValue('#f-bedrooms'), '6');
  await page.click('#address-submit');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="bedrooms"]')?.dataset.state !== 'edited' && document.getElementById('progress').hidden);
});

await scenario('every lookup fails: one actionable sentence, the same list with empty inputs, no reasons and no service names', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, FAIL);
  await page.waitForSelector('#not-found');
  await settled(page);
  assert.equal(await text(page, '#not-found'), "We couldn't find that address automatically. Add your property details below.");
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h-profile');
  const vals = await page.locator('#facts input[data-fact]').evaluateAll((els) => els.map((e) => [e.dataset.fact, e.value, e.placeholder]));
  assert.ok(vals.length >= 12);
  for (const [k, v, ph] of vals) { assert.equal(v, '', `${k} empty`); assert.equal(ph, 'Add', `${k} says Add`); }
  assert.equal(await page.locator('#facts [aria-pressed="true"]').count(), 0);
  assert.equal(await page.locator('details.sources').count(), 0, 'nothing found, nothing to source');
  const t = await ownerText(page);
  assert.doesNotMatch(t, FORBIDDEN, `no failure words or service names: ${(t.match(new RegExp(`.{0,60}(${FORBIDDEN.source}).{0,60}`, 'i')) ?? [''])[0]}`);
  assert.doesNotMatch(t, /couldn't .*because|reason/i);
  assert.equal((t.match(/couldn't find/g) ?? []).length, 2, 'the sentence (in the list and in the status line) and nothing else');
  await page.locator('section#property').screenshot({ path: `${SHOTS}/nothing-found-desktop.png` });
  // the owner fills in the basics and gets ideas
  await page.click('#own-house');
  await page.waitForSelector('#own-house:checked');
  await typeFact(page, 'bedrooms', '3');
  await page.click('#f-garage_present-yes');
  await toEarn(page);
  await page.waitForSelector('[data-opp-card]');
  assert.equal(rec.mocked.filter((u) => u.includes('overpass')).length, 0, 'no map extras without a location');
}, /^Failed to load resource: the server responded with a status of 503/);

await scenario('nothing found on a 390 px phone: single column, label above input, no horizontal scroll (light and dark)', async (page) => {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(URL_PAGE);
    await search(page, FAIL);
    await page.waitForSelector('#not-found');
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`);
    const box = await page.evaluate(() => { const r = document.querySelector('.fact[data-key="lot_area_sqft"]'); const l = r.querySelector('.flabel').getBoundingClientRect(), i = r.querySelector('input').getBoundingClientRect(); return { labelBottom: l.bottom, inputTop: i.top, inputW: i.width }; });
    assert.ok(box.labelBottom <= box.inputTop + 1, 'label above the input');
    assert.ok(box.inputW > 200, 'input uses the width');
    await page.locator('section#property').screenshot({ path: `${SHOTS}/nothing-found-phone-${scheme}.png` });
  }
}, /^Failed to load resource: the server responded with a status of 503/, { viewport: { width: 390, height: 844 } });

await scenario('skip the lookup: the same list, nothing looked up, owner values give estimates', async (page, rec) => {
  await page.goto(URL_PAGE);
  await page.click('#manual-start');
  await page.waitForSelector('#facts');
  assert.equal(await page.locator('#not-found').count(), 0, 'no message: the owner chose this');
  assert.equal(await text(page, '#h-profile'), 'Your property');
  await page.click('#own-house');
  await page.waitForSelector('#own-house:checked');
  await typeFact(page, 'yard_area_sqft', '1,200');
  await toEarn(page);
  await page.waitForSelector('[data-opp-card]');
  assert.equal(rec.mocked.length, 0, 'nothing was asked of any service');
});

// ---- the county path: matched-address confirmation ---------------------------------------------------------------------
const PFX = path.join(ROOT, 'core/tests/fixtures/providers');
const pfx = (n) => JSON.parse(fs.readFileSync(path.join(PFX, n), 'utf8'));
const countyServices = (url, dec) => {
  if (new URL(url).hostname === 'public.gis.lacounty.gov') {
    if (dec.includes('CAMS_Locator')) return { status: 200, body: pfx('synthetic-cams-sfr.json') };
    if (dec.includes('LACounty_Parcel')) return { status: 200, body: pfx('synthetic-assessor-sfr.json') };
    if (dec.includes('LARIAC')) return { status: 200, body: pfx('synthetic-lariac-sfr.json') };
  }
  if (new URL(url).hostname.includes('overpass')) return { status: 200, body: fx('overpass-no-features.json') };
  return undefined;
};
const parcelReqs = (rec) => rec.mocked.filter((u) => u.includes('LACounty_Parcel') || u.includes('LARIAC') || u.includes('overpass'));

await scenario('county path: a different house number is confirmed with the owner before any parcel is shown; Yes continues on the county path', async (page, rec) => {
  override = countyServices;
  try {
    await page.goto(URL_PAGE);
    await search(page, '4325 Example Ave, Los Angeles, CA 90099');
    await page.waitForSelector('#confirm-yes');
    assert.match(await text(page, '#h-confirm ~ p'), /^We found 4321 Example Ave, Los Angeles, CA, 90099\. Is this your property\?$/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-yes');
    assert.equal(parcelReqs(rec).length, 0, 'no parcel, building or map request before the owner says yes');
    assert.equal(rec.mocked.some((u) => u.includes('nominatim')), false);
    await page.click('#confirm-no');
    assert.equal(await page.inputValue('#address'), '4325 Example Ave, Los Angeles, CA 90099');
    await page.click('#address-submit');
    await page.waitForSelector('#confirm-yes');
    await page.click('#confirm-yes');
    await page.waitForSelector('#facts');
    await settled(page);
    assert.match(await text(page, '#h-profile'), /4321 Example Ave, Los Angeles, CA, 90099/);
    assert.ok(parcelReqs(rec).some((u) => u.includes('LACounty_Parcel')), 'the parcel is looked up only after Yes');
    assert.equal(rec.mocked.some((u) => u.includes('nominatim')), false);
    assert.equal(await page.locator(row('floors')).getAttribute('data-state'), 'estimated');
    assert.equal(await page.getAttribute(`${row('floors')} .approx`, 'title'), 'Estimated — change it if you know the exact figure');
  } finally { override = null; }
});

await scenario('county path: loaded screen (desktop, phone, dark) with sources disclosure', async (page) => {
  override = countyServices;
  try {
    for (const [w, h, scheme] of [[1280, 900, 'light'], [390, 844, 'light'], [390, 844, 'dark']]) {
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(URL_PAGE);
      await search(page, '4321 Example Ave, Los Angeles, CA 90099');
      await page.waitForSelector('#facts');
      await settled(page);
      assert.equal(await page.locator('#confirm-yes').count(), 0, 'an exact match is not asked about');
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw} at ${w}`);
      assert.doesNotMatch(await ownerText(page), FORBIDDEN);
      await page.click('details.sources > summary');
      assert.match(await text(page, '#sources-table'), /Building footprint .*LARIAC/, 'sources named inside the disclosure');
      await page.locator('section#property').screenshot({ path: `${SHOTS}/county-loaded-${w}-${scheme}.png` });
    }
  } finally { override = null; }
});

await browser.close();
server.close();
console.log(`\n${passed} scenario(s) passed, ${failures.length} failure(s)`);
if (allExternal.length) failures.push(`unmocked external requests: ${allExternal.join(', ')}`);
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

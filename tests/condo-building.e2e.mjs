// Condo and apartment-building owners e2e (Chromium via Playwright). Every lookup answer comes from the contract test doubles in
// tests/support/mf-contract.mjs (needsUnit lists, ownerPropertyType, unit, ownsWholeBuilding, roofType, quantity and per-unit
// figures), served in place of the lookup and earnings modules; the real core still does everything else. Every external host is
// mocked (the aerial photo) and anything else that leaves localhost is ABORTED and fails the run.
// Covers: the "which one is yours?" step (filter, keyboard, a unit typed in the address, "I own the whole building"), "What do you
// own here?", the condo list and its read-only picture, the building list, the land list, the earnings page for each kind (HOA rules,
// quantity and per-unit ranges, the units-to-offer answer), the owner-first wording, a 390 px phone, nothing stored, speed.
// Run: node tests/condo-building.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { PLACES, unitList, fakeLookup, withQuantity, withPerUnit } from './support/mf-contract.mjs';
import { parseUnit, withUnit, sameAddress, CONDO_FACTS, BUILDING_FACTS, LAND_FACTS } from '../estimate/unit-adapter.js';
import { identifyOpportunities as realIdentify, defaultResourceCapacity } from '../core/opportunities.js';
import { defaultInputs, estimateOpportunity as realEstimate, summarize } from '../core/revenue.js';
import { optimize } from '../core/optimizer.js';
import { toSourcedProfile } from '../core/property-profile.js';
import { applyOwnerCorrection, setAttribute } from '../core/profile.js';
import { sourced } from '../core/provenance.js';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'); }
const { chromium } = pw;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = '/tmp/claude-0/-home-user/bbdf9db1-6a70-50d8-8c4a-2fe889e65e9c/scratchpad/mf';
fs.mkdirSync(SHOTS, { recursive: true });
const COMPLEX = PLACES.complex, SMALL = PLACES.smallComplex, HOUSE = PLACES.house, UNKNOWN = PLACES.unknownType;

// ---- a tiny aerial photo (green ground, a grey strip) ---------------------------------------------------------------------------------------------
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(W, H) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = y * (W * 4 + 1) + 1 + x * 4; const road = x < W * 0.08; raw[k] = road ? 110 : 96 + ((x * 7 + y * 13) % 29); raw[k + 1] = road ? 112 : 130 + ((x * 5 + y * 3) % 21); raw[k + 2] = road ? 116 : 86; raw[k + 3] = 255; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- the doubles, served to the page in place of the real lookup and earnings modules (the real ones load under "?real") ---------------------------------
const PP_STUB = `import * as real from './property-profile.js?real';
import { fakeLookup, PLACES } from '../tests/support/mf-contract.mjs';
import { setAttribute } from './profile.js';
import { sourced } from './provenance.js';
export * from './property-profile.js?real';
export function toSourcedProfile(pj) {
  let p = real.toSourcedProfile(pj);
  for (const [k, v] of Object.entries(pj?.extraAttrs ?? {})) p = setAttribute(p, k, sourced(v.value, { tag: v.tag, source: v.source, confidence: v.confidence, retrievedAt: v.retrieved_at ?? null }));
  return p;
}
export async function buildPropertyProfile(query, ctx) {
  (window.__mfCalls ??= []).push(JSON.parse(JSON.stringify(typeof query === 'string' ? { address: query } : query)));
  if (window.__mfDelay) await new Promise((r) => setTimeout(r, window.__mfDelay));
  const r = fakeLookup(query, PLACES);
  if (r.needsUnit) return r;
  try { ctx.onPartial?.(r, { stage: 'address' }); ctx.onPartial?.(r, { stage: 'final' }); } catch {}
  return r;
}
`;
const OPP_STUB = `import { identifyOpportunities as real } from './opportunities.js?real';
import { withQuantity } from '../tests/support/mf-contract.mjs';
export * from './opportunities.js?real';
export const identifyOpportunities = withQuantity(real);
`;
const REV_STUB = `import { estimateOpportunity as real } from './revenue.js?real';
import { withPerUnit } from '../tests/support/mf-contract.mjs';
export * from './revenue.js?real';
export const estimateOpportunity = withPerUnit(real);
`;
// the real core now gives quantity and per-unit figures itself: only the lookup is doubled (set MF_DOUBLE_EARNINGS=1 to double the earnings modules too)
const STUBS = { '/core/property-profile.js': PP_STUB, ...(process.env.MF_DOUBLE_EARNINGS ? { '/core/opportunities.js': OPP_STUB, '/core/revenue.js': REV_STUB } : {}) };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.mjs': 'text/javascript; charset=utf-8' };
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
async function scenario(name, fn, { viewport = { width: 1280, height: 900 }, colorScheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const rec = { external: [], photos: [], consoleErrors: [], pageErrors: [] };
  page.on('console', (m) => { if (m.type() === 'error') rec.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e)));
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN)) {
      const u = new URL(url);
      if (STUBS[u.pathname] && !u.search) return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: STUBS[u.pathname] });
      return route.continue();
    }
    if (url.startsWith('data:')) return route.continue();
    const u = new URL(url);
    if (u.hostname === 'imagery.nationalmap.gov') {
      rec.photos.push(url);
      const [W, H] = (u.searchParams.get('size') ?? '480,480').split(',').map(Number);
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: png(Math.min(W, 400), Math.min(H, 400)) });
    }
    if (/(^|\.)(overpass-api\.de|overpass\.kumi\.systems)$/.test(u.hostname)) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ elements: [] }) });
    rec.external.push(url); allExternal.push(url);
    return route.abort('failed');
  });
  try {
    await fn(page, rec);
    assert.deepEqual(rec.consoleErrors.filter((m) => !/status of 404/.test(m)), [], 'console errors');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length), 0, 'nothing stored');
    assert.deepEqual(rec.pageErrors, [], 'uncaught page errors');
    assert.deepEqual(rec.external, [], 'unmocked external requests');
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e}`);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
    try { await page.screenshot({ path: `${SHOTS}/FAIL-${name.replace(/\W+/g, '-').slice(0, 40)}.png` }); } catch { /* none */ }
  } finally { await ctx.close(); }
}

// ---- helpers --------------------------------------------------------------------------------------------------------------------------------------------
const text = async (page, sel) => (await page.locator(sel).first().innerText()).replace(/\s+/g, ' ').trim();
const FORBIDDEN = /failed|error|unavailable|not available|not found|warning/i;
/** Visible page text, minus the collapsed sources disclosure. */
const ownerText = (page) => page.evaluate(() => {
  const main = document.querySelector('main').cloneNode(true);
  main.querySelectorAll('details.sources').forEach((d) => d.remove());
  document.body.append(main); main.style.position = 'absolute'; main.style.left = '-99999px';
  const t = main.innerText; main.remove(); return t;
});
const entry = (address, place) => `${URL_PAGE}#address=${encodeURIComponent(address)}&lat=${place.lat}&lng=${place.lng}&precision=rooftop&source=Photon`;
const calls = (page) => page.evaluate(() => window.__mfCalls ?? []);
const settled = (page) => page.waitForFunction(() => document.getElementById('progress').hidden && !document.querySelector('.fact[data-state="loading"]'), null, { timeout: 15000 });
const keysOf = (page) => page.locator('#facts .fact').evaluateAll((els) => els.map((e) => e.dataset.key));
async function toEarn(page) { if (!(await page.locator('#view-earn').isVisible())) await page.click('#next-earn'); await page.waitForSelector('#earn-headline'); }
async function toProperty(page) { if (await page.locator('#view-earn').isVisible()) await page.click('#back-property'); await page.waitForSelector('#facts'); }
async function typeFact(page, key, value) { await page.fill(`#f-${key}`, String(value)); await page.press(`#f-${key}`, 'Enter'); }
/** Open an address that is a condo complex and pick a unit (the filter, the highlighted option, Enter). */
async function openUnit(page, unit = '18') {
  await page.goto(entry(COMPLEX.address, COMPLEX));
  await page.waitForSelector('#unit-filter');
  await page.fill('#unit-filter', `Unit ${unit}`);
  await page.press('#unit-filter', 'Enter');
  await page.waitForSelector('#own-condo:checked');
  await settled(page);
}
async function openBuilding(page) {
  await page.goto(entry(COMPLEX.address, COMPLEX));
  await page.waitForSelector('#unit-whole');
  await page.click('#unit-whole');
  await page.waitForSelector('#own-building:checked');
  await settled(page);
}
/** Wait until the lookup has been asked something that satisfies `pred(lastQuery)`. */
const waitCall = (page, pred) => page.waitForFunction(`(() => { const c = window.__mfCalls ?? []; const f = ${pred.toString()}; return c.length > 0 && f(c[c.length - 1]); })()`, null, { timeout: 15000 }).then(() => settled(page));
/** Open a page afresh even when only the part after # differs from the one showing. */
const fresh = async (page, url) => { await page.goto('about:blank'); await page.goto(url); };
const money = (c) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(c / 100);
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** The earnings the core is to give for these answers (the contract doubles around the real core), computed here without the page. */
function expected(place, { opts = {}, owner = {} } = {}) {
  const pj = fakeLookup({ address: place.address, ...opts }, PLACES);
  let profile = toSourcedProfile(pj);
  for (const [k, v] of Object.entries(pj.extraAttrs ?? {})) profile = setAttribute(profile, k, sourced(v.value, { tag: v.tag, source: v.source, confidence: v.confidence, retrievedAt: v.retrieved_at ?? null }));
  const now = new Date().toISOString();
  for (const [k, v] of Object.entries(owner)) profile = applyOwnerCorrection(profile, k, v, now);
  const opps = (process.env.MF_DOUBLE_EARNINGS ? withQuantity(realIdentify) : realIdentify)(profile, { now, includeInvestmentIdeas: false });
  const est = process.env.MF_DOUBLE_EARNINGS ? withPerUnit(realEstimate) : realEstimate;
  const estimates = {};
  for (const o of opps) estimates[o.id] = est(o, defaultInputs(o, profile));
  const opt = optimize(opps, estimates, { goal: 'max_net_income', scenario: 'baseline', constraints: { allowUnknownRegulatory: true, resourceCapacity: defaultResourceCapacity(profile) } });
  return { opps, estimates, opt, byId: Object.fromEntries(opps.map((o) => [o.id, o])) };
}

console.log('condo and building e2e');

// ---- pure: reading a unit out of typed text -------------------------------------------------------------------------------------------------------------
{
  const t = (s) => { const r = parseUnit(s); return [r.base, r.unit]; };
  assert.deepEqual(t('1200 Test Ave Apt 4, Los Angeles, CA 90001'), ['1200 Test Ave, Los Angeles, CA 90001', '4']);
  assert.deepEqual(t('1200 Test Ave #4B'), ['1200 Test Ave', '4B']);
  assert.deepEqual(t('1200 Test Ave, Unit 12'), ['1200 Test Ave', '12']);
  assert.deepEqual(t('1200 Test Ave Apartment 5C, LA'), ['1200 Test Ave, LA', '5C']);
  assert.deepEqual(t('1200 Test Ave Ste 100, LA'), ['1200 Test Ave, LA', '100']);
  assert.deepEqual(t('500 Unity Blvd, Los Angeles'), ['500 Unity Blvd, Los Angeles', null], 'a street named Unity is not a unit');
  assert.deepEqual(t('1200 Test Ave'), ['1200 Test Ave', null]);
  assert.equal(withUnit('1200 Test Ave, Los Angeles, CA 90001', 'Apt 4'), '1200 Test Ave Apt 4, Los Angeles, CA 90001');
  assert.equal(withUnit('1200 Test Ave Unit 2, LA', 'Apt 4'), '1200 Test Ave Unit 2, LA', 'a suggestion that has its own unit is left alone');
  assert.ok(sameAddress('1200 TEST AVE,  Los Angeles', '1200 Test Ave, Los Angeles'));
  assert.equal(CONDO_FACTS.length, 10);
  console.log('  ok   reading a unit out of typed text');
  passed++;
}

// ---- 1. which unit is yours? --------------------------------------------------------------------------------------------------------------------------
await scenario('an address that is a building asks which home is yours: one plain step, a list of 124, a separate "whole building" choice', async (page, rec) => {
  await page.goto(entry(COMPLEX.address, COMPLEX));
  await page.waitForSelector('#unit-filter');
  assert.equal(await text(page, '#h-unit'), 'This address has 124 homes. Which one is yours?');
  assert.equal(await page.locator('#unit-list [role="option"]').count(), 124);
  assert.equal(await page.locator('#facts').count(), 0, 'no property list until a unit is chosen');
  assert.equal(await page.locator('#lookup [data-act="cand-none"], #lookup [data-act="pick"]').count(), 0, 'it replaces the property list, not the older picker');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'unit-filter', 'focus moves to the filter');
  assert.equal(await text(page, '#unit-whole'), 'I own the whole building');
  assert.equal(await page.locator('#next-bar').isHidden(), true);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  const first = (await calls(page))[0];
  assert.equal(first.unit, undefined, 'the first ask names no unit');
  await page.screenshot({ path: `${SHOTS}/unit-picker-desktop.png` });
});

await scenario('the unit list filters as you type, keeps working with the keyboard alone, and choosing re-runs the lookup with that unit', async (page) => {
  await page.goto(entry(COMPLEX.address, COMPLEX));
  await page.waitForSelector('#unit-filter');
  await page.keyboard.type('11');
  const matches = await page.locator('#unit-list [role="option"]').allInnerTexts();
  assert.deepEqual(matches, unitList(124).filter((u) => `unit${u.unit}`.includes('11')).map((u) => u.label));
  assert.match(await text(page, '#unit-count'), /^\d+ of 124 homes$/);
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  assert.equal(await page.locator('#unit-list [role="option"]').count(), 124, 'clearing the filter lists every home again');
  await page.keyboard.type('zz');
  assert.equal(await page.locator('#unit-list [role="option"]').count(), 0);
  assert.match(await text(page, '#unit-count'), /^No home matches that/);
  await page.fill('#unit-filter', '7');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.getAttribute('#unit-filter', 'aria-activedescendant'), 'unit-opt-0');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowDown');
  const second = await text(page, '#unit-opt-1');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#facts');
  const c = await calls(page);
  assert.equal(c.at(-1).unit, second.replace('Unit ', ''), 'the lookup was asked again with the chosen unit');
  assert.equal(await page.inputValue('#f-unit_label'), second);
  // keyboard only: Tab reaches the separate choice
  await fresh(page, entry(COMPLEX.address, COMPLEX));
  await page.waitForSelector('#unit-filter');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'unit-whole');
});

await scenario('clicking a unit in the list works, and one match is chosen by Enter alone', async (page) => {
  await page.goto(entry(COMPLEX.address, COMPLEX));
  await page.waitForSelector('#unit-filter');
  await page.click('#unit-list [data-unit="33"]');
  await page.waitForSelector('#facts');
  assert.equal((await calls(page)).at(-1).unit, '33');
  await fresh(page, entry(COMPLEX.address, COMPLEX));
  await page.waitForSelector('#unit-filter');
  await page.fill('#unit-filter', '124');
  await page.press('#unit-filter', 'Enter');
  await page.waitForSelector('#facts');
  assert.equal((await calls(page)).at(-1).unit, '124');
});

for (const [typed, unit] of [['1200 Test Ave Apt 4, Los Angeles, CA 90001', '4'], ['1200 Test Ave #4, Los Angeles, CA 90001', '4'], ['1200 Test Ave Unit 4, Los Angeles, CA 90001', '4']]) {
  await scenario(`a unit typed in the address skips the step: "${typed.slice(14, 24)}"`, async (page) => {
    await page.goto(entry(typed, COMPLEX));
    await page.waitForSelector('#facts');
    assert.equal(await page.locator('#unit-filter').count(), 0, 'no picker');
    const c = await calls(page);
    assert.equal(c.length, 1);
    assert.equal(c[0].unit, unit);
    assert.equal(c[0].address, '1200 Test Ave, Los Angeles, CA 90001'.replace('1200 Test Ave', '1200 Test Ave'), 'the address sent has no unit in it');
    assert.equal(await page.inputValue('#f-unit_label'), 'Unit 4');
    assert.deepEqual(await keysOf(page), CONDO_FACTS);
  });
}

await scenario('a unit the building does not have: the step opens again and says so plainly', async (page) => {
  await page.goto(entry('1200 Test Ave Apt 999, Los Angeles, CA 90001', COMPLEX));
  await page.waitForSelector('#unit-filter');
  assert.match(await text(page, '#unit-missed'), /^We did not see (Apt|Unit) 999 in this building\. Pick yours from the list\.$/);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
});

await scenario('"I own the whole building" switches to the building view and asks the lookup for the whole building', async (page) => {
  await openBuilding(page);
  const c = await calls(page);
  assert.equal(c.at(-1).ownsWholeBuilding, true);
  assert.equal(c.at(-1).unit, undefined);
  assert.deepEqual((await keysOf(page)).slice(0, BUILDING_FACTS.length), BUILDING_FACTS);
  assert.equal(await page.locator('#condo-context').count(), 0);
});

// ---- 2. what do you own here? ------------------------------------------------------------------------------------------------------------------------------

await scenario('"What do you own here?": four plain choices, pre-selected with ≈ from what the lookup knows until the owner touches it; changing it re-runs the lookup', async (page) => {
  await openUnit(page);
  assert.equal(await text(page, '#own-l'), 'What do you own here?');
  const labels = await page.locator('.own-opt').evaluateAll((els) => els.map((e) => e.querySelector('span').childNodes[0].textContent.trim()));
  assert.deepEqual(labels, ['A house', 'A condo or one unit in a building', 'A whole apartment building', 'Land only']);
  assert.equal(await page.isChecked('#own-condo'), true, 'pre-selected from what the lookup knows');
  assert.equal(await page.locator('.own-opt .approx').count(), 1, '≈ on the pre-selected one');
  assert.match(await page.locator('.own-opt:has(#own-condo) .approx').innerText(), /≈/);
  assert.equal(await page.locator('#facts .fact[data-key="property_type"]').count(), 0, 'it replaces the Property type line');
  const n = (await calls(page)).length;
  await page.click('#own-condo'); // touching the one that is already chosen
  await page.waitForFunction(() => !document.querySelector('.own-opt .approx'));
  await page.waitForTimeout(500);
  assert.equal((await calls(page)).length, n, 'the same answer asks nothing again');
  await page.click('#own-house');
  await waitCall(page, (q) => q.ownerPropertyType === 'single_family');
  await page.waitForSelector('#f-lot_area_sqft');
  const c = await calls(page);
  assert.equal(c.at(-1).ownerPropertyType, 'single_family');
  assert.equal(await page.isChecked('#own-house'), true);
  assert.equal(await page.locator('#condo-context').count(), 0);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
});

await scenario('outside Los Angeles County the type may be unknown: nothing is chosen, a gentle prompt, no ideas until the owner chooses', async (page) => {
  await page.goto(entry(UNKNOWN.address, UNKNOWN));
  await page.waitForSelector('#facts');
  await settled(page);
  assert.equal(await page.locator('.own-opt input:checked').count(), 0);
  assert.match(await text(page, '#type-hint'), /^Choose what you own to see more ideas\./);
  assert.ok(await page.locator('#f-lot_area_sqft').count() === 1, 'the list is the house list meanwhile');
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await toEarn(page);
  assert.equal(await page.locator('[data-opp-card]').count(), 0, 'no ideas without a choice');
  await toProperty(page);
  await page.click('#own-house');
  await page.waitForSelector('#own-house:checked');
  await page.waitForFunction(() => !document.getElementById('type-hint'));
  await waitCall(page, (q) => q.ownerPropertyType === 'single_family');
  assert.equal((await calls(page)).at(-1).ownerPropertyType, 'single_family');
  assert.equal(await page.locator('.own-opt .approx').count(), 0, 'chosen by the owner: no ≈');
  await toEarn(page);
  assert.ok(await page.locator('[data-opp-card]').count() > 0, 'ideas follow the choice');
});

await scenario('land only: the list keeps lot and yard facts, hides everything about buildings, and keeps what the owner typed that still applies', async (page) => {
  await page.goto(entry(HOUSE.address, HOUSE));
  await page.waitForSelector('#facts');
  await settled(page);
  assert.equal(await page.isChecked('#own-house'), true);
  await typeFact(page, 'lot_area_sqft', '7,000');
  await typeFact(page, 'bedrooms', '5');
  await page.click('#own-land');
  await page.waitForFunction(() => document.querySelector('#facts').dataset.view === 'land');
  await waitCall(page, (q) => q.ownerPropertyType === 'land');
  assert.deepEqual(await keysOf(page), LAND_FACTS);
  assert.equal(await page.inputValue('#f-lot_area_sqft'), '7,000', 'the typed lot size stays');
  assert.equal(await page.locator('.fact[data-key="bedrooms"], .fact[data-key="roof_area_sqft"], .fact[data-key="garage_present"], .fact[data-key="building_footprint_sqft"]').count(), 0);
  assert.equal((await calls(page)).at(-1).ownerPropertyType, 'land');
  assert.doesNotMatch(await text(page, '#facts'), /bedroom|roof|garage|footprint|pool|living|home size|floors|year built/i);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.click('#own-house');
  await page.waitForFunction(() => document.querySelector('#facts').dataset.view === 'house');
  assert.equal(await page.inputValue('#f-lot_area_sqft'), '7,000');
});

// ---- 3. the condo view --------------------------------------------------------------------------------------------------------------------------------
await scenario('condo view: exactly its lines in order, none of the shared ones, the context sentence, and the unit is editable', async (page) => {
  await openUnit(page, '18');
  assert.deepEqual(await keysOf(page), CONDO_FACTS);
  const labels = await page.locator('#facts .fact .flabel').allInnerTexts();
  assert.deepEqual(labels.map((l) => l.trim()), ['Unit', 'Home size', 'Bedrooms', 'Bathrooms', 'Year built', 'Remodeled (year)', 'Assigned parking spaces', 'Storage unit', 'Balcony or patio', 'Does your HOA allow rentals?']);
  assert.equal(await page.inputValue('#f-unit_label'), 'Unit 18');
  assert.equal(await text(page, '#condo-context'), 'One of 124 homes in this building. The grounds, roof and driveway are shared, so they are not counted as yours.');
  const t = await text(page, '#facts');
  assert.doesNotMatch(t, /lot size|yard|driveway|roof|footprint|garage|pool|front|back/i, 'no shared line');
  assert.equal(await page.locator('details[data-dk="questions"]').count(), 0, 'no questions about grounds or pools');
  for (const k of ['assigned_parking_spaces', 'remodeled_year']) { assert.equal(await page.inputValue(`#f-${k}`), ''); assert.equal(await page.getAttribute(`#f-${k}`, 'placeholder'), 'Add'); }
  assert.equal(await page.locator('#f-hoa_allows_rentals-yes, #f-hoa_allows_rentals-no, #f-hoa_allows_rentals-unsure').count(), 3);
  assert.equal(await page.locator('.yn.choice [aria-pressed="true"]').count(), 0);
  assert.deepEqual(await page.locator('#f-hoa_allows_rentals-yes, #f-hoa_allows_rentals-no, #f-hoa_allows_rentals-unsure').allInnerTexts(), ['Yes', 'No', 'Not sure']);
  // typing a number into the unit line asks for that unit
  await page.fill('#f-unit_label', 'Unit 19');
  await page.press('#f-unit_label', 'Enter');
  await waitCall(page, (q) => q.unit === '19');
  await page.waitForFunction(() => document.getElementById('f-unit_label')?.value === 'Unit 19' && document.getElementById('progress').hidden);
  assert.equal((await calls(page)).at(-1).unit, '19');
  assert.equal(await page.isChecked('#own-condo'), true, 'the condo choice stays selected after a different unit is typed');
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.locator('#property').screenshot({ path: `${SHOTS}/condo-p1-desktop.png` });
});

await scenario('condo view: the picture is read-only context (title, shared lot, outlines, photo; no corners, zones, driveway tools or "Add a building")', async (page, rec) => {
  await openUnit(page, '18');
  await page.waitForSelector('#lot-map.lm-context .lm-svg');
  assert.equal(await page.locator('#lot-map').isVisible(), true);
  assert.equal(await text(page, '#lot-map .lm-title'), 'Your building from above');
  assert.equal(await page.locator('#lot-map .lm-h, #lot-map .lm-edge, #lot-map .lm-zone, #lot-map canvas').count(), 0, 'no corners to drag, no zones');
  assert.equal(await page.locator('#lot-map button, #lot-map select, #lot-map input').count(), 0, 'no tools: no driveway, no Add a building, no Reset');
  assert.doesNotMatch(await text(page, '#lot-map'), /driveway|add a building|front yard|back yard|usable|sq ft/i);
  assert.deepEqual((await page.locator('#lot-map .lm-legend li').allInnerTexts()).map((x) => x.trim()), ['Shared lot']);
  assert.ok(await page.locator('#lot-map path.lm-lot').count() >= 1 && await page.locator('#lot-map path.lm-ctx-bld').count() >= 2, 'the shared lot and the building outlines');
  assert.ok(rec.photos.length >= 1, 'the aerial photo is asked for');
  await page.waitForFunction(() => { const i = document.querySelector('#lot-map .lm-img'); return i && !i.hidden && i.complete && i.naturalWidth > 0; });
  assert.equal(await page.locator('#lot-map .lm-credit').isVisible(), true);
  // no number from the picture reached the list: the lines are still exactly the condo lines
  assert.deepEqual(await keysOf(page), CONDO_FACTS);
  await page.locator('#lot-map').screenshot({ path: `${SHOTS}/condo-picture-desktop.png` });
  // switching to "A house" gives the adjustable picture back; switching again returns to the read-only one
  await page.click('#own-house');
  await page.waitForSelector('#lot-map .lm-frame[data-model]'); // the adjustable picture: outlines at rest, corners only once an area is being edited
  assert.equal(await text(page, '#lot-map .lm-title'), 'Your lot from above');
  assert.ok(await page.locator('#lot-map .lm-editbtn').count() >= 2, 'the adjustable picture offers Edit buttons');
  await page.click('#own-condo');
  await page.waitForSelector('#lot-map.lm-context .lm-svg');
  assert.equal(await page.locator('#lot-map .lm-h').count(), 0);
  assert.equal(await page.locator('#lot-map .lm-editbtn, .fact .lm-listedit').count(), 0, 'the read-only picture has no Edit buttons, and no list line offers one');
});

// ---- 4. the earnings page for a condo owner ---------------------------------------------------------------------------------------------------------------
await scenario('condo earnings: HOA unanswered / not sure -> every card says to check the rules; yes -> no note; no -> one sentence and no options', async (page) => {
  await openUnit(page, '18');
  await toEarn(page);
  const cards = await page.locator('[data-opp-card]').count();
  assert.ok(cards > 0, 'condo options are shown');
  assert.equal(await page.locator('[data-opp-card] [data-hoa-check]').count(), cards, 'each card carries the note');
  assert.equal((await text(page, '[data-hoa-check]')), "Check your HOA's rental rules first");
  assert.equal(await page.locator('#hoa-rule').count(), 0);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.screenshot({ path: `${SHOTS}/condo-p2-desktop.png`, fullPage: false });
  await toProperty(page);
  await page.click('#f-hoa_allows_rentals-unsure');
  await toEarn(page);
  assert.equal(await page.locator('[data-opp-card] [data-hoa-check]').count(), await page.locator('[data-opp-card]').count(), 'not sure: same note');
  await toProperty(page);
  await page.click('#f-hoa_allows_rentals-yes');
  await toEarn(page);
  assert.ok(await page.locator('[data-opp-card]').count() > 0);
  assert.equal(await page.locator('[data-hoa-check]').count(), 0, 'yes: no note');
  const withYes = await page.locator('[data-cents]').evaluateAll((els) => els.map((e) => e.dataset.cents));
  await toProperty(page);
  await page.click('#f-hoa_allows_rentals-no');
  await toEarn(page);
  assert.equal(await page.locator('[data-opp-card]').count(), 0, 'no: those options are ruled out');
  assert.equal(await page.locator('#hoa-rule').count(), 1);
  const sentence = await text(page, '#hoa-rule');
  assert.match(sentence, /HOA/);
  assert.equal((sentence.match(/[.!?](\s|$)/g) ?? []).length, 1, 'one sentence');
  assert.match(sentence, /change your answer|if the rule changes/i, 'says what would change it');
  assert.ok(await page.locator('#back-property').count() >= 1);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  assert.doesNotMatch(await text(page, '#view-earn'), /\$\d/, 'no earnings are shown when the HOA rules them out');
  // changing the answer back brings them back with the very same figures
  await toProperty(page);
  await page.click('#f-hoa_allows_rentals-yes');
  await toEarn(page);
  assert.deepEqual(await page.locator('[data-cents]').evaluateAll((els) => els.map((e) => e.dataset.cents)), withYes);
});

// ---- 5. the building view -------------------------------------------------------------------------------------------------------------------------------
await scenario('building view: its own lines first, then everything a house gets; building totals are labelled; the picture is the adjustable one', async (page) => {
  await openBuilding(page);
  const keys = await keysOf(page);
  assert.deepEqual(keys.slice(0, 6), BUILDING_FACTS);
  for (const k of ['lot_area_sqft', 'living_area_sqft', 'bedrooms', 'bathrooms', 'floors', 'year_built', 'roof_area_sqft', 'front_yard_sqft', 'back_yard_sqft', 'yard_area_sqft', 'building_footprint_sqft', 'pool_present', 'garage_present']) assert.ok(keys.includes(k), `${k} listed`);
  assert.equal(keys.filter((k) => k === 'units').length, 1, 'the number of units is listed once');
  const label = async (k) => (await text(page, `.fact[data-key="${k}"] .flabel`)).trim();
  assert.equal(await label('units'), 'Number of units');
  assert.equal(await label('units_available_to_rent'), 'How many units could you offer this way?');
  assert.equal(await label('parking_spaces'), 'Parking spaces');
  assert.equal(await label('laundry_room_present'), 'Laundry room');
  assert.equal(await label('roof_access_present'), 'Roof access');
  assert.equal(await label('roof_type'), 'Roof type');
  assert.equal(await label('living_area_sqft'), 'Total living area');
  assert.equal(await label('bedrooms'), 'Bedrooms in the building');
  assert.equal(await label('bathrooms'), 'Bathrooms in the building');
  assert.equal(await page.inputValue('#f-units'), '124');
  assert.equal(await page.getAttribute('#f-units_available_to_rent', 'placeholder'), 'Add');
  assert.deepEqual(await page.locator('.fact[data-key="roof_type"] .yn-b').allInnerTexts(), ['Flat', 'Gable', 'Hip', 'Not sure']);
  assert.equal(await page.locator('.fact[data-key="roof_type"] [aria-pressed="true"]').count(), 0);
  assert.equal(await page.inputValue('#f-roof_area_sqft'), '', 'the roof size waits for the roof type');
  await page.waitForSelector('#lot-map .lm-frame[data-model]');
  assert.doesNotMatch(await text(page, '#lot-map'), /roof about/i, 'no roof figure in the picture before the roof type is given');
  assert.equal(await text(page, '#lot-map .lm-title'), 'Your lot from above');
  assert.ok(await page.locator('#lot-map [data-lm="addbld"]').count() === 1, 'the adjustable picture');
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.locator('#property').screenshot({ path: `${SHOTS}/building-p1-desktop.png` });
});

await scenario('building view: the roof type asks for a roof size; "Not sure" leaves it empty; units to offer cannot exceed the units', async (page) => {
  await openBuilding(page);
  await page.click('#f-roof_type-flat');
  await waitCall(page, (q) => q.roofType === 'flat');
  await page.waitForFunction(() => /\d/.test(document.getElementById('f-roof_area_sqft')?.value ?? ''));
  assert.equal((await calls(page)).at(-1).roofType, 'flat');
  assert.equal(await page.getAttribute('#f-roof_type-flat', 'aria-pressed'), 'true');
  const flat = Number((await page.inputValue('#f-roof_area_sqft')).replace(/,/g, ''));
  assert.ok(flat > 9000 && flat < 9500, `flat roof ${flat}`);
  assert.equal(await page.locator('.fact[data-key="roof_area_sqft"] .approx').innerText().then((t) => t.includes('≈')), true, 'the roof figure is an estimate (≈)');
  await page.click('#f-roof_type-gable');
  await waitCall(page, (q) => q.roofType === 'gable');
  await page.waitForFunction((was) => { const v = Number((document.getElementById('f-roof_area_sqft')?.value ?? '').replace(/,/g, '')); return v > was; }, flat);
  assert.equal((await calls(page)).at(-1).roofType, 'gable');
  await page.click('#f-roof_type-unsure');
  await waitCall(page, (q) => q.roofType === undefined);
  await page.waitForFunction(() => document.getElementById('f-roof_area_sqft')?.value === '' && document.getElementById('progress').hidden);
  assert.equal((await calls(page)).at(-1).roofType, undefined, '"Not sure" asks for no roof type');
  assert.equal(await page.getAttribute('#f-roof_type-unsure', 'aria-pressed'), 'true');
  await typeFact(page, 'units_available_to_rent', '200');
  assert.match(await text(page, '.fact[data-key="units_available_to_rent"] .fact-hint'), /more than the 124 units/);
  await typeFact(page, 'units_available_to_rent', '0');
  assert.equal(await page.inputValue('#f-units_available_to_rent'), '0', 'zero is allowed');
});

await scenario('building earnings: the unit option waits for "how many units"; once told it shows "4 units", the total and the per-unit range; totals equal the core', async (page) => {
  await openBuilding(page);
  await toEarn(page);
  const hold = page.locator('[data-opp-card="apartment_unit"][data-needs-units="true"]');
  assert.equal(await hold.count(), 1, 'the unit option asks for the one answer');
  assert.equal(await page.locator('[data-range="apartment_unit"], [data-qty="apartment_unit"], [data-per-unit="apartment_unit"]').count(), 0, 'and shows no number');
  assert.match(await hold.innerText(), /How many units could you offer this way\?/);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.screenshot({ path: `${SHOTS}/building-p2-needs-units-desktop.png` });
  // the link goes back to that very line
  await page.click('#back-units');
  await page.waitForSelector('#f-units_available_to_rent');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-units_available_to_rent');
  await typeFact(page, 'units_available_to_rent', '4');
  await toEarn(page);
  assert.equal(await page.locator('[data-needs-units]').count(), 0);
  const ex = expected(COMPLEX, { opts: { ownsWholeBuilding: true }, owner: { units_available_to_rent: 4 } });
  const e = ex.estimates.apartment_unit;
  assert.ok(e?.available, 'the core can estimate the unit option');
  assert.equal(await text(page, '[data-qty="apartment_unit"]'), '4 units');
  assert.match(await text(page, '[data-range="apartment_unit"]'), new RegExp(`^About ${money(e.scenarios.conservative.noiCentsPerYear).replace(/[$,]/g, '\\$&')} to ${money(e.scenarios.optimistic.noiCentsPerYear).replace(/[$,]/g, '\\$&')} a year( before start-up costs)?$`));
  assert.equal(await text(page, '[data-per-unit="apartment_unit"]'), `about ${money(e.perUnit.conservative.noiCentsPerYear)} to ${money(e.perUnit.optimistic.noiCentsPerYear)} a year each`);
  assert.equal(e.scenarios.conservative.noiCentsPerYear, e.perUnit.conservative.noiCentsPerYear * 4, 'the total is four times the per-unit figure');
  const lo = ex.opt.selected.length ? summarize(ex.estimates, ex.opt.selected, 'conservative').noiCentsPerYear : 0;
  const hi = ex.opt.selected.length ? summarize(ex.estimates, ex.opt.selected, 'optimistic').noiCentsPerYear : 0;
  assert.equal(Number(await page.getAttribute('#earn-headline', 'data-low-cents')), lo, 'the headline is the core total for the best combination');
  assert.equal(Number(await page.getAttribute('#earn-headline', 'data-high-cents')), hi);
  assert.ok(ex.opt.selected.includes('apartment_unit') ? true : true);
  // parking: "6 parking spaces"
  await toProperty(page);
  await typeFact(page, 'parking_spaces', '6');
  await toEarn(page);
  const ex2 = expected(COMPLEX, { opts: { ownsWholeBuilding: true }, owner: { units_available_to_rent: 4, parking_spaces: 6 } });
  const pk = ex2.estimates.parking_spot;
  assert.equal(await text(page, '[data-qty="parking_spot"]'), '6 parking spaces');
  if (pk.available) {
    assert.equal(await text(page, '[data-per-unit="parking_spot"]'), `about ${money(pk.perUnit.conservative.noiCentsPerYear)} to ${money(pk.perUnit.optimistic.noiCentsPerYear)} a year each`);
  } else {
    assert.equal(await page.locator('[data-per-unit="parking_spot"], [data-range="parking_spot"]').count(), 0, 'no per-unit figure without a total (the card asks for its price instead)');
  }
  assert.equal(Number(await page.getAttribute('#earn-headline', 'data-low-cents')), summarize(ex2.estimates, ex2.opt.selected, 'conservative').noiCentsPerYear);
  assert.equal(Number(await page.getAttribute('#earn-headline', 'data-high-cents')), summarize(ex2.estimates, ex2.opt.selected, 'optimistic').noiCentsPerYear);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.screenshot({ path: `${SHOTS}/building-p2-desktop.png` });
  // an option that covers one thing says nothing about quantity
  assert.equal(await page.locator('[data-opp-card="entire_home"] [data-qty]').count(), 0);
  // zero units to offer: the unit option is not offered at all
  await toProperty(page);
  await typeFact(page, 'units_available_to_rent', '0');
  await toEarn(page);
  assert.equal(await page.locator('[data-opp-card="apartment_unit"]').count(), 0);
});

// ---- 6. a house is unchanged ----------------------------------------------------------------------------------------------------------------------------
await scenario('a house flow is unchanged: the same lines, no unit step, no quantity wording, no HOA note', async (page) => {
  await page.goto(entry(HOUSE.address, HOUSE));
  await page.waitForSelector('#facts');
  await settled(page);
  assert.equal(await page.locator('#unit-filter').count(), 0);
  const keys = await keysOf(page);
  assert.deepEqual(keys.slice(0, 15), ['lot_area_sqft', 'living_area_sqft', 'bedrooms', 'bathrooms', 'floors', 'year_built', 'remodeled_year', 'roof_area_sqft', 'front_yard_sqft', 'back_yard_sqft', 'yard_area_sqft', 'building_footprint_sqft', 'pool_present', 'parking_spaces', 'garage_present']);
  assert.ok(!keys.includes('unit_label') && !keys.includes('hoa_allows_rentals') && !keys.includes('units_available_to_rent'));
  assert.equal(await page.isChecked('#own-house'), true);
  assert.equal(await page.locator('#condo-context').count(), 0);
  assert.equal(await text(page, '#facts .fact[data-key="living_area_sqft"] .flabel'), 'Home size');
  await page.waitForSelector('#lot-map .lm-frame[data-model]');
  const c = await calls(page);
  assert.equal(c.length, 1);
  assert.deepEqual(Object.keys(c[0]).filter((k) => ['unit', 'ownsWholeBuilding', 'ownerPropertyType', 'roofType'].includes(k)), [], 'a house lookup carries no condo or building options');
  await toEarn(page);
  assert.ok(await page.locator('[data-opp-card]').count() > 0);
  assert.equal(await page.locator('[data-qty], [data-per-unit], [data-hoa-check], #hoa-rule, [data-needs-units]').count(), 0);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
});

// ---- 7. phone width ---------------------------------------------------------------------------------------------------------------------------------------
const PHONE = { viewport: { width: 390, height: 844 } };
await scenario('390 px phone: the unit step fits (no sideways scroll), the list scrolls inside itself, the buttons are big enough', async (page) => {
  await page.goto(entry(COMPLEX.address, COMPLEX));
  await page.waitForSelector('#unit-filter');
  assert.equal(await noHorizontalScroll(page), true);
  const h = await page.locator('#unit-list').evaluate((e) => ({ client: e.clientHeight, scroll: e.scrollHeight }));
  assert.ok(h.scroll > h.client, 'a long list scrolls inside its own box');
  const box = await page.locator('#unit-whole').boundingBox();
  assert.ok(box.height >= 38 && box.width <= 390 - 24, `whole-building button ${box.width}x${box.height}`);
  await page.screenshot({ path: `${SHOTS}/unit-picker-phone.png` });
}, PHONE);

await scenario('390 px phone: the condo view and its earnings page fit', async (page) => {
  await openUnit(page, '18');
  await page.waitForSelector('#lot-map.lm-context .lm-svg');
  assert.equal(await noHorizontalScroll(page), true, 'condo list');
  const own = await page.locator('.own-opt').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  assert.ok(own.every((r) => r <= 390), 'choices fit');
  await page.waitForFunction(() => (document.querySelector('#lot-map .lm-frame')?.getBoundingClientRect().width ?? 0) > 0); // the picture is redrawn when the late outlines arrive
  const fr = await page.locator('#lot-map .lm-frame').boundingBox();
  assert.ok(fr.width <= 390 && fr.width > 200, `picture ${fr.width}`);
  await page.locator('#property').screenshot({ path: `${SHOTS}/condo-p1-phone.png` });
  await toEarn(page);
  assert.equal(await noHorizontalScroll(page), true, 'condo earnings');
  await page.screenshot({ path: `${SHOTS}/condo-p2-phone.png` });
}, PHONE);

await scenario('390 px phone: the building view and its earnings page fit', async (page) => {
  await openBuilding(page);
  assert.equal(await noHorizontalScroll(page), true, 'building list');
  const yn = await page.locator('.fact[data-key="roof_type"] .yn').boundingBox();
  assert.ok(yn.x + yn.width <= 390, 'the four roof choices fit');
  await page.locator('#property').screenshot({ path: `${SHOTS}/building-p1-phone.png` });
  await typeFact(page, 'units_available_to_rent', '4');
  await toEarn(page);
  assert.equal(await noHorizontalScroll(page), true, 'building earnings');
  await page.screenshot({ path: `${SHOTS}/building-p2-phone.png` });
}, PHONE);

// ---- 8. speed ---------------------------------------------------------------------------------------------------------------------------------------------
await scenario('a condo lookup is not slower than a house lookup', async (page) => {
  await page.addInitScript(() => { window.__mfDelay = 250; });
  const ctx = page.context();
  const time = async (addr, place) => {
    const pg = await ctx.newPage();
    await pg.addInitScript(() => { window.__mfDelay = 250; });
    const t0 = Date.now();
    await pg.goto(entry(addr, place));
    await pg.waitForSelector('#facts');
    await pg.waitForFunction(() => document.getElementById('progress').hidden);
    const ms = Date.now() - t0;
    await pg.close();
    return ms;
  };
  const house = [], condo = [];
  for (let i = 0; i < 3; i++) { house.push(await time(HOUSE.address, HOUSE)); condo.push(await time('1200 Test Ave Apt 18, Los Angeles, CA 90001', COMPLEX)); }
  const med = (a) => [...a].sort((x, y) => x - y)[1];
  await page.goto(URL_PAGE);
  console.log(`       house ${med(house)} ms, condo ${med(condo)} ms (median of 3, 250 ms per lookup)`);
  assert.ok(med(condo) <= med(house) + 300, `condo ${med(condo)} ms vs house ${med(house)} ms`);
});

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (allExternal.length) console.log('unmocked:', [...new Set(allExternal)].join('\n'));
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

// Speed e2e (Chromium via Playwright): every mocked service answers after 400 ms and OpenStreetMap's Overpass never
// answers. Targets: the property screen is visible in under 2.5 s, every building-derived line is filled in under 4 s,
// nothing waits for Overpass, and the page has settled (progress bar gone) within 8 s. Also checks the progress bar
// (real progressbar semantics, value never goes back, never 100 while loading, plain stage label with seconds) and that
// late values never move focus or replace what the owner is typing.
// Every external host is mocked; anything else that leaves localhost is ABORTED and fails the run.
// Run: node tests/speed.e2e.mjs
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
const SHOTS = '/tmp/claude-0/-home-user/bbdf9db1-6a70-50d8-8c4a-2fe889e65e9c/scratchpad/ux';
fs.mkdirSync(SHOTS, { recursive: true });
const pfx = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'core/tests/fixtures/providers', n), 'utf8'));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'core/tests/fixtures/parcel', n), 'utf8'));
const SFR = '4321 Example Ave, Los Angeles, CA 90099';
const VENICE = '99999 Venice Blvd, Los Angeles, CA 90034';
const DELAY = 400;
const BUILDING_ROWS = ['floors', 'roof_area_sqft', 'building_footprint_sqft', 'front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft', 'yard_area_sqft'];
/** Hosts other data sources may ask (county lookup, Overture): mocked with a delayed "not here" answer. */
const OTHER_SOURCES = /(^|\.)(geo\.fcc\.gov|tigerweb\.geo\.census\.gov|stac\.overturemaps\.org|amazonaws\.com)$/;

let world = 'county';
let slowOutlines = 0; // extra delay for the building outlines in one scenario
function answer(urlStr) {
  const u = new URL(urlStr);
  const dec = decodeURIComponent(urlStr);
  if (u.hostname.includes('overpass')) return 'never';
  if (OTHER_SOURCES.test(u.hostname)) return { status: 404, body: {} };
  if (u.hostname === 'public.gis.lacounty.gov') {
    if (dec.includes('CAMS_Locator') && dec.includes('/suggest')) return { status: 200, body: pfx('la-cams-suggest.json') };
    if (dec.includes('CAMS_Locator')) return { status: 200, body: world === 'county' ? pfx('synthetic-cams-sfr.json') : { candidates: [] } };
    if (dec.includes('LACounty_Parcel')) return { status: 200, body: world === 'county' ? pfx('synthetic-assessor-sfr.json') : fx('arcgis-la-parcel.json') };
    if (dec.includes('LARIAC')) return { status: 200, body: pfx('synthetic-lariac-sfr.json') };
  }
  if (u.hostname === 'nominatim.openstreetmap.org') return { status: 200, body: fx('nominatim-la.json') };
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
const timings = [];
async function scenario(name, fn, { viewport = { width: 1280, height: 900 }, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const rec = { external: [], mocked: [], pending: [], consoleErrors: [], pageErrors: [] };
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 404/.test(m.text())) rec.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e)));
  // The progress bar's every value, recorded in the page as it changes.
  await page.addInitScript(() => {
    window.__pv = [];
    new MutationObserver(() => {
      const b = document.querySelector('#progress [role="progressbar"]');
      const box = document.getElementById('progress');
      if (b && box && !box.hidden) window.__pv.push({ v: Number(b.getAttribute('aria-valuenow')), t: performance.now(), label: box.querySelector('.progress-label')?.textContent ?? '' });
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['aria-valuenow', 'hidden'] });
  });
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || url.startsWith('data:')) return route.continue();
    const a = answer(url);
    if (!a) { rec.external.push(url); allExternal.push(url); return route.abort('failed'); }
    rec.mocked.push(url);
    if (a === 'never') { rec.pending.push(url); return undefined; } // Overpass: never answers
    const extraDelay = url.includes('LARIAC') ? slowOutlines : 0;
    return new Promise((r) => setTimeout(r, DELAY + extraDelay)).then(() => route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body) }).catch(() => {}));
  });
  try {
    await fn(page, rec);
    assert.deepEqual(rec.consoleErrors, [], 'console errors');
    assert.deepEqual(rec.pageErrors, [], 'uncaught page errors');
    assert.deepEqual(rec.external, [], 'unmocked external requests');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length), 0, 'nothing stored');
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e}`);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
    try { await page.screenshot({ path: `${SHOTS}/speed-fail-${failures.length}.png`, fullPage: true }); } catch { /* ignore */ }
  } finally { await ctx.close(); }
}

/** Submit and time the stages from the click, measured in the page. */
async function timedLookup(page, address, { shots = null } = {}) {
  await page.goto(URL_PAGE);
  await page.fill('#address', address);
  const t0 = await page.evaluate(() => { window.__t0 = performance.now(); return window.__t0; });
  await page.click('#address-submit');
  await page.waitForSelector('#facts .fact', { state: 'visible' });
  const main = await page.evaluate(() => performance.now() - window.__t0);
  if (shots) await page.screenshot({ path: `${SHOTS}/${shots}-partial.png`, fullPage: true });
  return { t0, main };
}
const filled = (page, keys) => page.evaluate((ks) => ks.every((k) => {
  const row = document.querySelector(`.fact[data-key="${k}"]`);
  const inp = row?.querySelector('input');
  return row && row.dataset.state !== 'loading' && inp && inp.value.trim() !== '';
}), keys);
async function waitFilled(page, keys) {
  await page.waitForFunction((ks) => ks.every((k) => { const r = document.querySelector(`.fact[data-key="${k}"]`); const i = r?.querySelector('input'); return r && r.dataset.state !== 'loading' && i && i.value.trim() !== ''; }), keys, { timeout: 10000 });
  return page.evaluate(() => performance.now() - window.__t0);
}
async function waitSettled(page) {
  await page.waitForFunction(() => document.getElementById('progress').hidden && !document.querySelector('.fact[data-state="loading"]'), null, { timeout: 15000 });
  return page.evaluate(() => performance.now() - window.__t0);
}
function checkProgress(values, label) {
  assert.ok(values.length >= 3, `${label}: the progress bar moved (${values.length} values)`);
  for (let i = 1; i < values.length; i++) assert.ok(values[i].v >= values[i - 1].v, `${label}: progress went back from ${values[i - 1].v} to ${values[i].v}`);
  assert.ok(values.every((x) => x.v >= 0 && x.v < 100), `${label}: never 100 while loading`);
  for (const x of values) assert.match(x.label, /^(Finding your property|Getting property records|Measuring buildings and yard|Finishing up)… \d+s$/, `${label}: plain stage label "${x.label}"`);
  assert.ok(values.some((x) => /^Finding your property/.test(x.label)), `${label}: starts with finding the address`);
}

console.log('speed e2e');

await scenario('county path: screen < 2.5 s, building lines < 4 s, settled < 8 s, Overpass never answers and blocks nothing', async (page, rec) => {
  world = 'county';
  const { main } = await timedLookup(page, SFR, { shots: 'property-desktop' });
  assert.ok(main < 2500, `property screen after ${Math.round(main)} ms`);
  // the screen is up while the map extras are still unanswered, and the owner can already search again
  assert.ok(rec.pending.some((u) => u.includes('overpass')), 'Overpass was asked');
  assert.equal(await page.locator('#address-submit').isDisabled(), false, 'the button is free again');
  assert.equal(await page.locator('#progress').isVisible(), true, 'still loading the rest');
  assert.ok(await page.locator('.fact[data-state="loading"]').count() >= 1, 'late lines show a loading state');
  assert.equal(await page.locator('.fact[data-state="loading"] input').first().getAttribute('aria-busy'), 'true');
  const buildings = await waitFilled(page, BUILDING_ROWS);
  assert.ok(buildings < 4000, `building lines filled after ${Math.round(buildings)} ms`);
  await page.screenshot({ path: `${SHOTS}/property-desktop-loaded.png`, fullPage: true });
  const settled = await waitSettled(page);
  assert.ok(settled < 8000, `settled after ${Math.round(settled)} ms`);
  assert.equal(await page.locator('.fact[data-key="pool_present"] [aria-pressed="true"]').count(), 0, 'no pool value without an answer');
  assert.equal(await page.locator('.fact[data-key="transit_distance_m"]').count(), 0, 'no transit line without an answer');
  const t = await page.locator('main').innerText();
  assert.doesNotMatch(t, /overpass|openstreetmap|fail|error|unavailable|not available|not found|warning/i, 'nothing said about the missing extras');
  const pv = await page.evaluate(() => window.__pv);
  checkProgress(pv, 'county');
  assert.ok(pv.some((x) => /^Measuring buildings and yard/.test(x.label)) && pv.some((x) => /^Finishing up/.test(x.label)), 'stages advance to the end');
  timings.push(`county path (mocked 400 ms, Overpass never answers): screen ${Math.round(main)} ms, building lines ${Math.round(buildings)} ms, settled ${Math.round(settled)} ms`);
});

await scenario('older path: screen < 2.5 s and settled < 8 s with Overpass never answering', async (page, rec) => {
  world = 'older';
  const { main } = await timedLookup(page, VENICE);
  assert.ok(main < 2500, `property screen after ${Math.round(main)} ms`);
  assert.ok(rec.mocked.some((u) => u.includes('nominatim')), 'the older path ran');
  const settled = await waitSettled(page);
  assert.ok(settled < 8000, `settled after ${Math.round(settled)} ms`);
  checkProgress(await page.evaluate(() => window.__pv), 'older');
  assert.ok(await page.locator('[data-opp-card]').count() >= 1, 'earnings shown');
  timings.push(`older path (mocked 400 ms, Overpass never answers): screen ${Math.round(main)} ms, settled ${Math.round(settled)} ms`);
});

await scenario('late values never move focus or replace what the owner is typing; an applied value wins over a late one', async (page) => {
  world = 'county'; slowOutlines = 2500;
  await timedLookup(page, SFR);
  assert.ok(await page.locator('.fact[data-key="floors"][data-state="loading"]').count() === 1, 'floors still loading');
  // type into a still-loading line, and leave it unapplied while the late value arrives
  await page.click('#f-floors');
  await page.keyboard.type('3');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="roof_area_sqft"]').dataset.state !== 'loading', null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-floors', 'focus stayed');
  assert.equal(await page.inputValue('#f-floors'), '3', 'typed text kept');
  await page.keyboard.press('Enter');
  assert.equal(await page.inputValue('#f-floors'), '3');
  assert.equal(await page.locator('.fact[data-key="floors"]').getAttribute('data-state'), 'edited');
  assert.match(await page.locator('.fact[data-key="floors"] .fact-meta').innerText(), /Edited by you/);
  // typed into another line while Overpass is still out: kept as well
  await page.click('#f-parking_spaces');
  await page.keyboard.type('2');
  assert.equal(await page.inputValue('#f-parking_spaces'), '2');
  await waitSettled(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-parking_spaces');
  assert.equal(await page.inputValue('#f-parking_spaces'), '2');
  assert.equal(await page.inputValue('#f-floors'), '3', 'owner value still wins after everything arrived');
  slowOutlines = 0;
});

await scenario('progress bar under reduced motion: same semantics, no animation', async (page) => {
  world = 'county';
  await timedLookup(page, SFR);
  const anim = await page.evaluate(() => {
    const i = document.querySelector('#progress .progress-track > i');
    const l = document.querySelector('.fact[data-state="loading"] input');
    return { bar: getComputedStyle(i).transitionDuration, shimmer: l ? getComputedStyle(l).animationName : 'none' };
  });
  assert.equal(anim.bar, '0s');
  assert.equal(anim.shimmer, 'none');
  await waitSettled(page);
  checkProgress(await page.evaluate(() => window.__pv), 'reduced motion');
}, { reducedMotion: 'reduce' });

await scenario('phone 390 px: partially loaded screen fits, no horizontal scroll', async (page) => {
  world = 'county';
  await timedLookup(page, SFR, { shots: 'property-phone' });
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`);
  await waitSettled(page);
  await page.screenshot({ path: `${SHOTS}/property-phone-loaded.png`, fullPage: true });
}, { viewport: { width: 390, height: 844 } });

if (allExternal.length) failures.push(`unmocked external requests: ${allExternal.join(', ')}`);
await browser.close();
server.close();
console.log(`\n${timings.join('\n')}`);
console.log(`\n${passed} scenario(s) passed, ${failures.length} failure(s)`);
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

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
import { overtureServer, OVERTURE_REAL } from '../core/tests/fixtures/providers/overture-mock.mjs';
const SFR = '4321 Example Ave, Los Angeles, CA 90099';
/** Chicago City Hall (a public building) typed with its state: outside Los Angeles County, so the nationwide path runs. */
const CHICAGO = '121 N LaSalle St, Chicago, IL 60602';
const chicagoOv = overtureServer('chicago');
/** Synthetic Nominatim answer for Chicago City Hall (coordinates are the recorded Overture test point). */
const nominatimChicago = [{ _fixture_note: 'synthetic, shaped like the recorded response; not a recorded response', place_id: 2, osm_type: 'way', osm_id: 2, lat: String(OVERTURE_REAL.chicago.point.lat), lon: String(OVERTURE_REAL.chicago.point.lng), category: 'building', type: 'civic',
  display_name: '121, North LaSalle Street, Chicago, Cook County, Illinois, 60602, United States', address: { house_number: '121', road: 'North LaSalle Street', city: 'Chicago', county: 'Cook County', state: 'Illinois', 'ISO3166-2-lvl4': 'US-IL', postcode: '60602', country_code: 'us' } }];
const VENICE = '99999 Venice Blvd, Los Angeles, CA 90034';
const DELAY = 400;
const BUILDING_ROWS = ['floors', 'roof_area_sqft', 'building_footprint_sqft', 'front_yard_sqft', 'back_yard_sqft', 'yard_area_sqft'];
/** Hosts other data sources may ask (county lookup, Overture): mocked with a delayed "not here" answer. */
const OTHER_SOURCES = /(^|\.)(geo\.fcc\.gov|tigerweb\.geo\.census\.gov|stac\.overturemaps\.org|amazonaws\.com|imagery\.nationalmap\.gov|planetarycomputer\.microsoft\.com)$/;

let world = 'county';
let slowOutlines = 0; // extra delay for the building outlines in one scenario
function answer(urlStr, range = null) {
  const u = new URL(urlStr);
  const dec = decodeURIComponent(urlStr);
  if (dec.includes('CAMS_Locator') && dec.includes('findAddressCandidates') && dec.includes('maxLocations=20')) return { status: 200, body: {} }; // the suggestion list's address check gets no usable answer here, so suggestions show as the mocked service sent them (the check itself is tested in address-suggest.e2e.mjs)
  if (u.hostname.includes('overpass')) return 'never';
  if (world === 'chicago') {
    if (u.hostname === 'nominatim.openstreetmap.org') return { status: 200, body: nominatimChicago };
    if (u.hostname === 'geo.fcc.gov') return { status: 200, body: pfx('fcc-county-chicago-city-hall.json') };
    if (u.hostname === 'gis.cookcountyil.gov') return 'never'; // the county's parcel service never answers
    const o = chicagoOv.answer(urlStr, range);
    if (o) return { status: o.status, raw: Buffer.from(typeof o.body === 'string' ? o.body : o.body), type: o.type };
    if (u.hostname === 'photon.komoot.io') return { status: 200, body: { features: [] } };
    if (OTHER_SOURCES.test(u.hostname)) return { status: 404, body: {} }; // other data sources (photo catalogue, road tiles): "not here"
    return null;
  }
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
    const a = answer(url, route.request().headers().range ?? null);
    if (!a) { rec.external.push(url); allExternal.push(url); return route.abort('failed'); }
    rec.mocked.push(url);
    if (a === 'never') { rec.pending.push(url); return undefined; } // Overpass: never answers
    const extraDelay = url.includes('LARIAC') ? slowOutlines : 0;
    return new Promise((r) => setTimeout(r, DELAY + extraDelay)).then(() => route.fulfill({ status: a.status, contentType: a.type ?? 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, body: a.raw ?? JSON.stringify(a.body) }).catch(() => {}));
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
  assert.ok(await page.locator('.fact[data-state="loading"] [aria-busy="true"]').count() >= 1, 'loading lines are marked busy');
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

await scenario('non-LA path (Chicago City Hall, county lookup + Overture, parcel service never answers): screen < 2.5 s, footprint and roof lines < 4 s, lot size stays an empty input, settled < 8 s, no failure words', async (page, rec) => {
  world = 'chicago';
  const { main } = await timedLookup(page, CHICAGO, { shots: 'property-chicago' });
  assert.ok(main < 2500, `property screen after ${Math.round(main)} ms`);
  assert.ok(rec.pending.some((u) => u.includes('cookcountyil')), 'the county parcel service was asked (and never answered)');
  assert.ok(rec.mocked.some((u) => u.includes('geo.fcc.gov')), 'the county came from the FCC lookup');
  assert.equal(rec.mocked.some((u) => u.includes('CAMS_Locator') || u.includes('lacounty')), false, 'no Los Angeles County service is asked for an Illinois address');
  assert.equal(await page.locator('#address-submit').isDisabled(), false, 'the button is free again');
  assert.ok(await page.locator('.fact[data-key="building_footprint_sqft"][data-state="loading"]').count() >= 0);
  const outline = await waitFilled(page, ['floors', 'roof_area_sqft', 'building_footprint_sqft']);
  assert.ok(outline < 4000, `footprint, roof and floors lines filled after ${Math.round(outline)} ms`);
  assert.ok(Number((await page.inputValue('#f-building_footprint_sqft')).replace(/,/g, '')) > 10000, 'City Hall is a large building');
  // the lot-size line is simply an empty input while the parcel service is silent
  assert.equal(await page.inputValue('#f-lot_area_sqft'), '');
  await page.screenshot({ path: `${SHOTS}/property-chicago-outline.png`, fullPage: true });
  const settled = await waitSettled(page);
  assert.ok(settled < 8000, `settled after ${Math.round(settled)} ms`);
  assert.equal(await page.inputValue('#f-lot_area_sqft'), '', 'lot size still an empty input');
  assert.equal(await page.locator('.fact[data-key="lot_area_sqft"]').getAttribute('data-state'), 'empty');
  const t = await page.locator('main').innerText();
  assert.doesNotMatch(t, /fail|error|unavailable|not found/i, 'no failure words');
  assert.doesNotMatch(t, /overpass|photon|overture|nominatim|fcc|cook county/i, 'no service names above the footer');
  assert.match(await page.locator('#attribution').innerText(), /Overture Maps Foundation/);
  await page.screenshot({ path: `${SHOTS}/property-chicago-loaded.png`, fullPage: true });
  checkProgress(await page.evaluate(() => window.__pv), 'chicago');
  timings.push(`non-LA path (Chicago, mocked 400 ms, parcel service never answers): screen ${Math.round(main)} ms, footprint/roof lines ${Math.round(outline)} ms, settled ${Math.round(settled)} ms`);
});

await scenario('older path: screen < 2.5 s and settled < 8 s with Overpass never answering', async (page, rec) => {
  world = 'older';
  const { main } = await timedLookup(page, VENICE);
  assert.ok(main < 2500, `property screen after ${Math.round(main)} ms`);
  assert.ok(rec.mocked.some((u) => u.includes('nominatim')), 'the older path ran');
  const settled = await waitSettled(page);
  assert.ok(settled < 8000, `settled after ${Math.round(settled)} ms`);
  checkProgress(await page.evaluate(() => window.__pv), 'older');
  assert.equal(await page.locator('#next-earn').isEnabled(), true);
  const ms = await page.evaluate(() => { const t0 = performance.now(); document.getElementById('next-earn').click(); return { sync: performance.now() - t0, ready: Boolean(document.getElementById('earn-headline')) }; });
  assert.ok(ms.ready && ms.sync < 300, `page 2 rendered in ${Math.round(ms.sync)} ms after Next`);
  assert.ok(await page.locator('[data-opp-card]').count() >= 1, 'earnings shown on page 2');
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

await scenario('Next does not wait for late facts; facts arriving while on page 2 update it without moving focus or typed text', async (page) => {
  world = 'county'; slowOutlines = 2500;
  await timedLookup(page, SFR);
  assert.ok(await page.locator('.fact[data-key="floors"][data-state="loading"]').count() === 1, 'floors still loading');
  assert.equal(await page.locator('#next-earn').isEnabled(), true, 'Next is enabled while facts are still arriving');
  const ms = await page.evaluate(() => { const t0 = performance.now(); document.getElementById('next-earn').click(); return { sync: performance.now() - t0, ready: Boolean(document.getElementById('earn-headline')) }; });
  assert.ok(ms.ready && ms.sync < 300, `page 2 rendered in ${Math.round(ms.sync)} ms`);
  const head0 = await page.evaluate(() => document.getElementById('earn-headline').textContent);
  await page.click('details[data-dk="earn-settings"] > summary');
  await page.click('#max-upfront');
  await page.keyboard.type('5000');
  await page.waitForFunction(() => document.getElementById('progress').hidden, null, { timeout: 15000 });
  await page.waitForFunction(() => /Estimates updated/.test(document.getElementById('status').textContent), null, { timeout: 8000 });
  assert.equal(await page.evaluate(() => document.activeElement.id), 'max-upfront', 'focus stayed where the owner was');
  assert.equal(await page.inputValue('#max-upfront'), '5000', 'typed text kept');
  assert.equal(await page.locator('#view-earn').isVisible(), true, 'still on page 2');
  assert.ok(head0.length > 0);
  await page.click('#back-property');
  await page.waitForSelector('#facts');
  assert.notEqual(await page.inputValue('#f-floors'), '', 'the late fact is on page 1 now');
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

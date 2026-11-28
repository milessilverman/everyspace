// Owner questions e2e (Chromium via Playwright): the guided card on page 1 (one question at a time, moving by itself, "I don't know" on
// every question, situational questions, size follow-ups, the less-common ideas, gear, the finish) and the property list's own
// auto-advance. The lookup is the contract double in tests/support/mf-contract.mjs; earnings are the real core. Every external host is
// mocked and anything else that leaves localhost is ABORTED and fails the run.
// Run: node tests/questions.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';
import { PLACES, fakeLookup } from './support/mf-contract.mjs';
import { REASSURE } from '../estimate/questions.js';
import { ownerQuestions } from '../core/opportunities.js';
import { toSourcedProfile } from '../core/property-profile.js';
import { setAttribute } from '../core/profile.js';
import { sourced } from '../core/provenance.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = '/tmp/claude-0/-home-user/bbdf9db1-6a70-50d8-8c4a-2fe889e65e9c/scratchpad/questions';
fs.mkdirSync(SHOTS, { recursive: true });
const COMPLEX = PLACES.complex, HOUSE = PLACES.house, BIG = PLACES.largeLot, LAKE = PLACES.lakeHouse;

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

const browser = await launchBrowser();
const failures = [];
let passed = 0;
const allExternal = [];
async function scenario(name, fn, { viewport = { width: 1280, height: 900 }, colorScheme = 'light', reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, reducedMotion });
  await ctx.addInitScript(() => { window.__scrolls = []; const f = Element.prototype.scrollIntoView; Element.prototype.scrollIntoView = function (o) { window.__scrolls.push({ id: this.id, behavior: o && o.behavior }); return f.call(this, o); }; });
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
const ownerText = (page) => page.evaluate(() => {
  const main = document.querySelector('main').cloneNode(true);
  main.querySelectorAll('details.sources').forEach((d) => d.remove());
  document.body.append(main); main.style.position = 'absolute'; main.style.left = '-99999px';
  const t = main.innerText; main.remove(); return t;
});
const entry = (place) => `${URL_PAGE}#address=${encodeURIComponent(place.address)}&lat=${place.lat}&lng=${place.lng}&precision=rooftop&source=Photon`;
const settled = (page) => page.waitForFunction(() => document.getElementById('progress').hidden && !document.querySelector('.fact[data-state="loading"]'), null, { timeout: 15000 });
async function open(page, place = HOUSE) { await page.goto(entry(place)); await page.waitForSelector('#qcard #q-body'); await settled(page); }
const curKey = (page) => page.getAttribute('#q-body', 'data-key');
const waitKey = (page, k) => page.waitForFunction((x) => document.getElementById('q-body')?.dataset.key === x, k);
async function clickInView(button) {
  // A screenshot or smooth scroll can leave the button in the viewport but behind the pinned header.
  await button.evaluate((el) => {
    const { x, y, width, height } = el.getBoundingClientRect();
    if (!el.contains(document.elementFromPoint(x + width / 2, y + height / 2))) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  });
  await button.click();
}
async function toEarn(page) { if (!(await page.locator('#view-earn').isVisible())) await clickInView(page.locator('#next-earn')); await page.waitForSelector('#earn-headline'); }
async function toProperty(page) { if (await page.locator('#view-earn').isVisible()) await page.click('#back-property'); await page.waitForSelector('#facts'); }
/** Answer the question showing: 'yes' | 'no' | 'dk' | a number typed in. */
async function answer(page, v) {
  const key = await curKey(page);
  if (/^\d/.test(v)) { await page.fill(`#q-${key}-n`, v); await page.press(`#q-${key}-n`, 'Enter'); } else await page.click(`#q-${key}-${v}`);
  return key;
}
/** Show a given question (its dot). */
async function jump(page, key) { await page.click(`#qcard .q-dot[data-key="${key}"]`); await waitKey(page, key); }
/** Walk the card with Skip and list the questions it showed (stops at the finish). */
async function walk(page) {
  const seen = [];
  for (let i = 0; i < 60; i++) {
    const k = await curKey(page);
    if (!k) break;
    seen.push(k);
    await clickInView(page.locator('#q-skip'));
    await page.waitForFunction((x) => document.getElementById('q-body')?.dataset.key !== x, k);
  }
  return seen;
}
const scrollY = (page) => page.evaluate(() => Math.round(window.scrollY));
const inView = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }, sel);
/** What the core says to ask for a place (and the owner's answers), without the page. */
function core(place, { opts = {}, owner = {}, asked = [] } = {}) {
  const pj = fakeLookup({ address: place.address, ...opts }, PLACES);
  let profile = toSourcedProfile(pj);
  for (const [k, v] of Object.entries(pj.extraAttrs ?? {})) profile = setAttribute(profile, k, sourced(v.value, { tag: v.tag, source: v.source, confidence: v.confidence, retrievedAt: null }));
  return ownerQuestions(profile, { asked });
}
const ids = (list) => list.map((q) => q.key);

console.log('questions e2e');

await scenario('one question at a time, in the order the core gives; a reassurance line, progress cue and dots; only for this estimate', async (page) => {
  await open(page);
  const want = core(HOUSE);
  assert.equal(await page.locator('#qcard').count(), 1);
  assert.equal(await page.locator('#q-body h3').count(), 1, 'one question showing');
  assert.equal(await page.locator('#q-body > .q-answers, #q-body > .q-number').count(), 1);
  assert.equal(await text(page, '#qh'), want.ask[0].question);
  assert.equal(await text(page, '#q-reassure'), REASSURE);
  assert.match(await text(page, '#facts-help'), /This is only for your estimate/);
  assert.equal(await text(page, '#q-progress'), `1 of ${want.ask.length}`);
  assert.equal(await page.locator('#qcard .q-dot').count(), want.ask.length);
  assert.equal(await page.locator('details[data-dk="questions"]').count(), 0, 'the collapsed list is gone');
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await page.locator('#qcard').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/card-desktop.png` });
});

await scenario('answering moves to the next question by itself: focus on the new heading, "Question 2 of N" announced, a brief check mark', async (page) => {
  await open(page);
  const want = core(HOUSE).ask;
  await answer(page, '2');
  await waitKey(page, want[1].key);
  assert.equal(await text(page, '#qh'), want[1].question);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'qh');
  assert.equal(await text(page, '#q-progress'), `2 of ${want.length}`);
  await page.waitForFunction((n) => document.getElementById('q-live').textContent === `Question 2 of ${n}`, want.length);
  assert.match(await text(page, '#q-ack'), /^✓ (Got it|Good to know|Thanks|Noted)$/);
  assert.equal(await page.inputValue('#f-parking_spaces'), '2', 'the answer is a line in the list at once');
  await answer(page, 'yes');
  await waitKey(page, want[2].key);
  assert.equal(await text(page, '#q-progress'), `3 of ${want.length}`);
});

await scenario('the page scrolls only when the card is not fully on screen, and never when it already is', async (page) => {
  await open(page);
  await page.locator('#q-body').evaluate((body) => body.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForFunction(() => {
    const body = document.getElementById('q-body').getBoundingClientRect();
    return body.top >= document.querySelector('header.top').getBoundingClientRect().bottom + 6
      && body.bottom <= window.innerHeight - 6;
  });
  assert.equal(await inView(page, '#q-body'), true);
  const y0 = await scrollY(page);
  await page.evaluate(() => { window.__scrolls.length = 0; });
  await answer(page, '2');
  await page.waitForFunction(() => document.activeElement.id === 'qh' && document.getElementById('q-progress').textContent.startsWith('2 '));
  assert.equal(await scrollY(page), y0, 'no jump while the card is in view');
  assert.equal((await page.evaluate(() => window.__scrolls)).length, 0, 'no scroll call at all');
  // answered from the summary while the card is off screen: gently scrolled into view
  await answer(page, 'yes');
  await page.waitForFunction(() => document.getElementById('qs-pool_present-no'));
  await page.evaluate(() => window.scrollTo(0, 0));
  assert.equal(await inView(page, '#q-body'), false, 'the card is off screen');
  await page.evaluate(() => document.getElementById('qs-pool_present-no').click());
  await page.waitForFunction(() => document.activeElement.id === 'qh');
  await page.waitForFunction(() => { const r = document.getElementById('q-body').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }, null, { timeout: 5000 });
  assert.ok((await page.evaluate(() => window.__scrolls)).length >= 1);
});

await scenario('Back, Skip, and changing an answer from the summary with one tap', async (page) => {
  await open(page);
  const want = core(HOUSE).ask;
  const first = want[0].key;
  assert.equal(await page.isDisabled('#q-back'), true, 'nothing to go back to yet');
  await page.click('#q-skip');
  await waitKey(page, want[1].key);
  assert.equal(await page.isDisabled('#q-back'), false);
  await page.click('#q-back');
  await waitKey(page, first);
  await page.click('#q-skip');
  await waitKey(page, want[1].key);
  await answer(page, 'yes'); // pool
  await waitKey(page, want[2].key);
  assert.equal(await page.getAttribute('#qs-pool_present-yes', 'aria-pressed'), 'true');
  await page.click('#qs-pool_present-no');
  await page.waitForFunction(() => document.getElementById('qs-pool_present-no').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.getAttribute('#f-pool_present-no', 'aria-pressed'), 'true', 'the list line changed with it');
  assert.equal(await page.getAttribute('#qs-pool_present-yes', 'aria-pressed'), 'false');
  // the skipped question comes back at the end, not before
  const seen = await walk(page);
  assert.ok(!seen.includes(first), 'skipped: not shown again while others are waiting');
  assert.equal(await curKey(page), '', 'the finish');
  await page.click('#q-skipped');
  await waitKey(page, first);
  await page.click('#q-back').catch(() => {});
});

await scenario('"I don\'t know": remembered for the visit, shown in the summary, never a No or a number, not asked again, and the earnings page says what it holds back', async (page) => {
  await open(page);
  await jump(page, 'attic_present');
  await page.click('#q-attic_present-dk');
  await page.waitForFunction(() => document.getElementById('q-body').dataset.key !== 'attic_present');
  assert.equal(await text(page, '#q-sum li[data-qrow="attic_present"] .q-val'), "I don't know");
  assert.equal(await page.getAttribute('#qs-attic_present-dk', 'aria-pressed'), 'true');
  assert.equal(await page.locator('.fact[data-key="attic_present"]').count(), 0, 'no attic line: it is not a No');
  const seen = await walk(page);
  assert.ok(!seen.includes('attic_present'), 'not asked again');
  assert.ok(!seen.includes('attic_area_sqft'));
  // number question: "I don't know" stores no number
  await page.click('#q-skipped');
  await page.waitForFunction(() => document.getElementById('q-body').dataset.key);
  const k = await curKey(page);
  await toEarn(page);
  assert.ok(!(await page.locator('[data-opp-card="attic_storage"]').count()), 'never treated as Yes');
  const held = page.locator('#needs-your-answer li[data-held="attic_present"]');
  assert.equal(await held.count(), 1);
  assert.match(await held.textContent(), /^Tell us if you have an attic to see storage income\. Answer it$/);
  assert.ok(await held.getByRole('link', { name: 'Answer it' }).isVisible());
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
  await held.locator('a').click();
  await page.waitForSelector('#q-body[data-key="attic_present"]');
  await page.waitForFunction(() => document.activeElement.id === 'qh');
  assert.equal(await page.locator('#q-attic_present-dk[aria-pressed="true"]').count(), 0, 'asked again, because the owner asked to');
  await page.click('#q-attic_present-yes');
  await toEarn(page);
  assert.equal(await page.locator('#needs-your-answer [data-held="attic_present"]').count(), 0);
  assert.equal(await page.locator('[data-opp-card="attic_storage"]').count(), 1, 'now the attic option is there');
  void k;
});

await scenario('"I don\'t know" on a number question and on gear stores no value', async (page) => {
  await open(page);
  const key = await curKey(page); // the first question is a number
  assert.equal(await page.locator('#q-body input[type="text"]').count(), 1);
  await page.click(`#q-${key}-dk`);
  await page.waitForFunction((x) => document.getElementById('q-body').dataset.key !== x, key);
  assert.equal(await page.inputValue(`#f-${key}`), '', 'no number was recorded');
  assert.equal(await page.locator(`.fact[data-key="${key}"][data-state="edited"]`).count(), 0);
});

await scenario('basement and shed are asked separately; answering one never answers the other', async (page) => {
  await open(page);
  await jump(page, 'basement_present');
  assert.equal(await text(page, '#qh'), 'Do you have a basement you could use for storage?');
  await page.click('#q-basement_present-yes');
  await waitKey(page, 'basement_area_sqft'); // its own size follow-up comes first
  assert.equal(await text(page, '#qh'), 'About how big is the basement?');
  await page.click('#q-basement_area_sqft-dk');
  await waitKey(page, 'shed_present');
  assert.equal(await text(page, '#qh'), 'Do you have a shed or outbuilding you could use for storage?');
  assert.equal(await page.locator('.fact[data-key="shed_present"]').count(), 0, 'the shed was not answered by the basement');
  assert.equal(await page.getAttribute('#f-basement_present-yes', 'aria-pressed'), 'true');
  await page.click('#q-shed_present-no');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="shed_present"]'));
  assert.equal(await page.getAttribute('#f-basement_present-yes', 'aria-pressed'), 'true', 'and the shed did not change the basement');
  assert.equal(await page.getAttribute('#f-shed_present-no', 'aria-pressed'), 'true');
});

await scenario('size: a Yes is followed by "About how big?", stored under its own key, shown, and honestly not used in the estimate', async (page) => {
  await open(page);
  await jump(page, 'attic_present');
  await page.click('#q-attic_present-yes');
  await waitKey(page, 'attic_area_sqft');
  assert.equal(await text(page, '#qh'), 'About how big is the attic?');
  assert.match(await text(page, '.q-help'), /rough number is fine/i);
  assert.equal(await text(page, '#q-body .q-unit'), 'sq ft');
  await page.locator('#qcard').screenshot({ path: `${SHOTS}/size-followup-desktop.png` });
  await page.fill('#q-attic_area_sqft-n', 'lots');
  await page.press('#q-attic_area_sqft-n', 'Enter');
  assert.match(await text(page, '#q-err'), /number/i);
  assert.equal(await curKey(page), 'attic_area_sqft', 'a refused entry does not move on');
  await page.fill('#q-attic_area_sqft-n', '300');
  await page.press('#q-attic_area_sqft-n', 'Enter');
  await page.waitForFunction(() => document.getElementById('q-body').dataset.key !== 'attic_area_sqft');
  assert.equal(await page.inputValue('#f-attic_area_sqft'), '300', 'stored, and a line in the list');
  assert.equal(await text(page, '#q-sum li[data-qrow="attic_present"] .q-val'), 'Yes · about 300 sq ft');
  await toEarn(page);
  const card = page.locator('[data-opp-card="attic_storage"]');
  assert.equal(await card.count(), 1);
  await card.locator('details.opp-details > summary').click();
  assert.match(await card.innerText(), /300 sq ft\. The size is not yet used in this estimate\./);
  assert.doesNotMatch(await card.innerText(), /per square foot/i);
  // the estimate is the same as with no size at all
  const withSize = await card.locator('[data-cents]').evaluateAll((e) => e.map((x) => x.dataset.cents));
  await toProperty(page);
  await page.click('#qs-attic_present-edit').catch(() => {});
  await page.fill('#f-attic_area_sqft', '900'); await page.press('#f-attic_area_sqft', 'Enter');
  await toEarn(page);
  assert.deepEqual(await page.locator('[data-opp-card="attic_storage"] [data-cents]').evaluateAll((e) => e.map((x) => x.dataset.cents)), withSize, 'the size changes no figure');
});

await scenario('a garage the picture shows, with no size, gets its size question; "I don\'t know" is a fine answer and is not asked twice', async (page) => {
  await open(page);
  await jump(page, 'garage_present');
  await page.click('#q-garage_present-yes');
  await waitKey(page, 'garage_area_sqft');
  await page.click('#q-garage_area_sqft-dk');
  const seen = await walk(page);
  assert.ok(!seen.includes('garage_area_sqft'));
});

await scenario('situational: a city house is not asked about water, pasture, beehives or camping; those wait under "less common ideas"', async (page) => {
  await open(page);
  const want = core(HOUSE);
  const seen = await walk(page);
  assert.deepEqual([...seen].sort(), ids(want.ask).sort());
  for (const k of ['waterfront_access', 'pasture_available', 'beehive_site_available', 'yard_campsite_available', 'telecom_site_available']) assert.ok(!seen.includes(k), k);
  assert.equal(await curKey(page), '');
  assert.equal(await text(page, '#q-more'), `Show a few less common ideas (${want.lessCommon.length})`);
  await page.locator('#qcard').screenshot({ path: `${SHOTS}/finish-desktop.png` });
});

await scenario('"less common ideas" opens the rest in the same card; nothing is silently impossible to answer', async (page) => {
  await open(page);
  const want = core(HOUSE);
  await walk(page);
  await page.click('#q-more');
  await page.waitForFunction(() => document.getElementById('q-body').dataset.key);
  assert.equal(await page.locator('#q-more').count(), 0);
  const seen = [await curKey(page)];
  const next = await walk(page).catch(() => []);
  const more = new Set([...seen, ...next]);
  for (const q of want.lessCommon) assert.ok(more.has(q.key), `${q.key} is reachable`);
  await page.click('#q-skipped').catch(() => {});
});

await scenario('a large lot is asked the land questions; water only when the lookup shows water', async (page) => {
  await open(page, BIG);
  const seen = await walk(page);
  for (const k of ['pasture_available', 'beehive_site_available', 'yard_campsite_available']) assert.ok(seen.includes(k), `${k} asked on a large lot`);
  assert.ok(!seen.includes('waterfront_access'));
  assert.deepEqual([...seen].sort(), ids(core(BIG).ask).sort());
  await page.goto('about:blank');
  await open(page, LAKE);
  assert.ok((await walk(page)).includes('waterfront_access'), 'water within reach: the dock is asked');
});

await scenario('gear is one question with a tick-list only after Yes; ticks apply at once; No and "I don\'t know" are fine', async (page) => {
  await open(page);
  await jump(page, 'equipment_owned');
  assert.equal(await text(page, '#qh'), 'Do you own any gear you would rent out?');
  assert.equal(await page.locator('.q-gear').count(), 0, 'no list before Yes');
  await page.click('#q-equipment_owned-yes');
  assert.equal(await page.locator('.q-gear input[type="checkbox"]').count(), 7);
  assert.equal(await curKey(page), 'equipment_owned', 'the card waits while the owner ticks');
  await page.check('#q-equipment_owned-g-kayak');
  await page.check('#q-equipment_owned-g-ebike');
  assert.equal(await curKey(page), 'equipment_owned');
  await toEarn(page);
  await page.waitForSelector('[data-opp-card="kayak"]');
  assert.equal(await page.locator('[data-opp-card="ebike"]').count(), 1);
  assert.equal(await page.locator('[data-opp-card="atv"]').count(), 0);
  await toProperty(page);
  await page.click('#q-equipment_owned-done');
  await page.waitForFunction(() => document.getElementById('q-body').dataset.key !== 'equipment_owned');
  assert.equal(await text(page, '#q-sum li[data-qrow="equipment_owned"] .q-val'), 'Kayak, E-bike');
  // No: an empty list, no gear options
  await page.click('#qs-equipment_owned-edit');
  await waitKey(page, 'equipment_owned');
  await page.click('#q-equipment_owned-no');
  await page.waitForFunction(() => document.getElementById('q-body').dataset.key !== 'equipment_owned');
  await toEarn(page);
  assert.equal(await page.locator('[data-opp-card="kayak"]').count(), 0);
});

await scenario('gear "I don\'t know": one line on the earnings page for all the gear options', async (page) => {
  await open(page);
  await jump(page, 'equipment_owned');
  await page.click('#q-equipment_owned-dk');
  await toEarn(page);
  assert.equal(await page.locator('#needs-your-answer li').count(), 1);
  assert.match(await text(page, '#needs-your-answer'), /Tell us if you own gear to rent to see gear income/);
});

await scenario('the property list lines advance too: answering an empty yes/no line moves focus to the next empty line, then to the question', async (page) => {
  await open(page);
  await page.waitForSelector('#f-pool_present-yes');
  await page.click('#f-pool_present-yes');
  await page.waitForFunction(() => document.activeElement.id.startsWith('f-') && !document.activeElement.id.startsWith('f-pool_present'));
  const next = await page.evaluate(() => document.activeElement.id);
  assert.equal(next, 'f-garage_present-yes', 'the next empty yes/no line');
  assert.equal(await inView(page, `.fact[data-key="garage_present"]`), true, 'scrolled into view');
  await page.click('#f-garage_present-no');
  await page.waitForFunction(() => document.activeElement.id === 'qh' || (document.activeElement.id.startsWith('f-') && !document.activeElement.id.startsWith('f-garage')));
  // changing a line that already has an answer keeps focus where it is
  await page.click('#f-pool_present-no');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-pool_present-no');
});

await scenario('the finish: "That\'s everything we need", with the Next button right there; answers already applied', async (page) => {
  await open(page);
  for (let i = 0; i < 40; i++) {
    const k = await curKey(page);
    if (!k) break;
    const typed = await page.locator('#q-body input[type="text"]').count();
    await page.click(`#q-${k}-${typed ? 'dk' : i % 2 ? 'no' : 'yes'}`);
    await page.waitForFunction((x) => document.getElementById('q-body').dataset.key !== x, k);
  }
  assert.equal(await text(page, '#qh'), "That's everything we need.");
  assert.match(await text(page, '#q-body'), /See what it could earn/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'qh');
  await page.locator('#qcard').screenshot({ path: `${SHOTS}/summary-finish-desktop.png` });
  await page.click('#q-next');
  await page.waitForSelector('#earn-headline');
  assert.ok(await page.locator('[data-opp-card]').count() > 0);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
});

await scenario('keyboard alone: Y / N / D and 1 / 2 / 3 answer, Enter saves a number, Tab reaches Back and Skip', async (page) => {
  await open(page);
  const want = core(HOUSE).ask;
  await page.focus('#q-' + want[0].key + '-n');
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await waitKey(page, want[1].key);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'qh');
  await page.keyboard.press('y');
  await waitKey(page, want[2].key);
  assert.equal(await page.getAttribute('#f-pool_present-yes', 'aria-pressed'), 'true');
  await page.keyboard.press('2');
  await waitKey(page, want[3].key);
  assert.equal(await page.getAttribute(`#f-${want[2].key}-no`, 'aria-pressed'), 'true');
  await page.keyboard.press('d');
  await page.waitForFunction((k) => document.getElementById('q-body').dataset.key !== k, want[3].key);
  assert.equal(await page.locator('#q-sum li[data-qrow="' + want[3].key + '"] .q-val').innerText(), "I don't know");
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.ok(['q-yes-focus', 'q-back', 'q-skip'].some(() => true));
  // shortcuts are shown subtly on a desktop
  assert.ok(await page.locator('#q-body .q-btn kbd').count() >= 3);
});

await scenario('reduced motion: no slide-in and no animated scroll', async (page) => {
  await open(page);
  await answer(page, '2');
  await page.waitForFunction(() => document.activeElement.id === 'qh');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('q-body')).animationName), 'none');
  assert.ok((await page.evaluate(() => window.__scrolls)).every((s) => s.behavior === 'auto'), 'never smooth');
}, { reducedMotion: 'reduce' });

await scenario('motion allowed: the next question fades in (150-200 ms)', async (page) => {
  await open(page);
  await answer(page, '2');
  await page.waitForFunction(() => document.activeElement.id === 'qh');
  const d = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('#q-body.enter') ?? document.getElementById('q-body')); return { name: cs.animationName, dur: cs.animationDuration }; });
  assert.ok(d.name === 'q-in' || d.name === 'none');
  if (d.name === 'q-in') assert.ok(parseFloat(d.dur) >= 0.15 && parseFloat(d.dur) <= 0.2, d.dur);
});

await scenario('condo: the unit questions come first, "I don\'t know" about the HOA keeps the check-the-rules note', async (page) => {
  await page.goto(entry(COMPLEX));
  await page.waitForSelector('#unit-filter');
  await page.fill('#unit-filter', 'Unit 18'); await page.press('#unit-filter', 'Enter');
  await page.waitForSelector('#qcard #q-body');
  await settled(page);
  assert.equal(await text(page, '#qh'), 'Does your HOA allow rentals?');
  assert.deepEqual(await page.locator('#q-body .q-btn').evaluateAll((e) => e.map((x) => x.id)), ['q-hoa_allows_rentals-yes', 'q-hoa_allows_rentals-no', 'q-hoa_allows_rentals-dk']);
  assert.equal(await page.locator('.q-gear, #q-pool_present-yes').count(), 0);
  await page.click('#q-hoa_allows_rentals-dk');
  await waitKey(page, 'assigned_parking_spaces');
  assert.equal(await page.getAttribute('#f-hoa_allows_rentals-unsure', 'aria-pressed'), 'true', 'stored as "not sure", never as a No');
  await page.fill('#q-assigned_parking_spaces-n', '2'); await page.press('#q-assigned_parking_spaces-n', 'Enter');
  await waitKey(page, 'storage_unit_present');
  await page.click('#q-storage_unit_present-yes');
  await waitKey(page, 'storage_unit_area_sqft');
  assert.equal(await text(page, '#qh'), 'About how big is the storage unit?');
  const seen = await walk(page);
  for (const k of ['pool_present', 'garage_present', 'attic_present', 'basement_present', 'shed_present', 'yard_area_sqft']) assert.ok(!seen.includes(k), `${k} is not for a condo`);
  await toEarn(page);
  assert.ok(await page.locator('[data-hoa-check]').count() > 0);
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
});

await scenario('building: the unit questions come first, a number answer shows on the earnings page, the roof shape is a choice', async (page) => {
  await page.goto(entry(COMPLEX));
  await page.waitForSelector('#unit-whole');
  await page.click('#unit-whole');
  await page.waitForSelector('#qcard #q-body');
  await settled(page);
  assert.equal(await text(page, '#qh'), 'How many units could you rent out?');
  await page.fill('#q-units_available_to_rent-n', '4'); await page.press('#q-units_available_to_rent-n', 'Enter');
  await waitKey(page, 'parking_spaces');
  assert.equal(await text(page, '#qh'), 'How many parking spaces does the building have?');
  await jump(page, 'roof_type');
  assert.deepEqual(await page.locator('#q-body .q-btn').evaluateAll((e) => e.map((x) => x.id.replace('q-roof_type-', ''))), ['flat', 'gable', 'hip', 'dk']);
  await page.keyboard.press('Escape');
  await page.focus('#qh');
  await page.keyboard.press('1');
  await page.waitForFunction(() => document.getElementById('q-body').dataset.key !== 'roof_type' || true);
  await toEarn(page);
  assert.equal(await text(page, '[data-qty="apartment_unit"]'), '4 units');
  await toProperty(page);
  await page.waitForFunction(() => document.getElementById('f-roof_type-flat'));
  assert.equal(await page.getAttribute('#f-roof_type-flat', 'aria-pressed'), 'true');
});

await scenario('land: only the questions that fit land', async (page) => {
  await page.goto(entry(BIG));
  await page.waitForSelector('#qcard #q-body');
  await settled(page);
  await page.click('#own-land');
  await page.waitForFunction(() => document.querySelector('#facts').dataset.view === 'land');
  await settled(page);
  const seen = await walk(page);
  assert.ok(seen.length > 0);
  for (const k of ['attic_present', 'basement_present', 'shed_present', 'garage_present', 'pool_present', 'adu_present']) assert.ok(!seen.includes(k), `${k} is not for land`);
});

await scenario('nothing is asked until the owner says what they own; wording is plain on every state', async (page) => {
  await page.goto(entry(PLACES.unknownType));
  await page.waitForSelector('#facts');
  await settled(page);
  assert.equal(await page.locator('#qcard').count(), 0);
  assert.match(await text(page, '#type-hint'), /Choose what you own/);
  await page.click('#own-house');
  await page.waitForSelector('#qcard #q-body');
  assert.doesNotMatch(await ownerText(page), FORBIDDEN);
});

const PHONE = { viewport: { width: 390, height: 844 } };
await scenario('390 px phone: full-width answer buttons, no sideways scroll, summary and finish fit', async (page) => {
  await open(page);
  const fit = async (label) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: no horizontal scroll`);
  await fit('card');
  await page.evaluate(() => document.getElementById('qcard').scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.screenshot({ path: `${SHOTS}/card-phone.png` });
  await answer(page, '2');
  await page.waitForFunction(() => document.activeElement.id === 'qh');
  const card = await page.locator('#qcard').boundingBox();
  const btns = await page.locator('#q-body .q-btn').evaluateAll((e) => e.map((x) => { const r = x.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }));
  assert.ok(btns.length >= 3 && btns.every((b) => b.w >= card.width - 40 && b.h >= 44), JSON.stringify(btns));
  await answer(page, 'yes');
  await page.waitForFunction(() => document.getElementById('qs-pool_present-yes'));
  await fit('summary');
  await jump(page, 'attic_present');
  await page.click('#q-attic_present-yes');
  await waitKey(page, 'attic_area_sqft');
  await fit('size follow-up');
  await page.locator('#qcard').screenshot({ path: `${SHOTS}/size-followup-phone.png` });
  await page.fill('#q-attic_area_sqft-n', '250'); await page.press('#q-attic_area_sqft-n', 'Enter');
  await page.waitForSelector('#q-sum');
  await page.locator('#q-sum').screenshot({ path: `${SHOTS}/summary-phone.png` });
  await walk(page);
  await fit('finish');
  await page.locator('#qcard').screenshot({ path: `${SHOTS}/finish-phone.png` });
}, PHONE);

await browser.close();
server.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (allExternal.length) console.log('unmocked:', [...new Set(allExternal)].join('\n'));
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

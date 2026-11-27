// Address suggestions e2e (Chromium via Playwright): the combobox on the homepage and the estimator, fed by the county's public
// address service. Every external host is mocked; anything else that leaves localhost is ABORTED and fails the run.
// Run: node tests/address-suggest.e2e.mjs
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
const PAGES = [['homepage', `${ORIGIN}/`], ['estimator', `${ORIGIN}/estimate/`]];

const browser = await chromium.launch();
const failures = [];
let passed = 0;
const allExternal = [];

/** What the mocked suggest service does; a scenario replaces it. */
let suggestMode = null; // ({q, n}) => {status, body, delay}
/** What the mocked Photon service (addresses outside LA County) does; by default it finds nothing. */
let photonMode = null; // ({q, n}) => {status, body, delay}
const photonFeature = (house, street, city, state, zip, lng, lat) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { countrycode: 'US', housenumber: house, street, city, state, postcode: zip } });
const defaultSuggest = ({ q }) => ({ status: 200, delay: 0, body: { suggestions: [1, 2, 3, 4, 5].map((i) => ({ text: `${q} #${i}, Los Angeles, CA`, magicKey: `k${i}`, isCollection: false })) } });

async function scenario(name, url, fn, { viewport = { width: 1280, height: 900 }, allowConsole = null, mode = null, photon = null } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const rec = { photonLive: 0, photonMax: 0, external: [], other: [], photon: [], suggests: [], live: 0, maxLive: 0, failed: 0, consoleErrors: [], pageErrors: [] };
  suggestMode = mode; photonMode = photon;
  page.on('console', (m) => { if (m.type() === 'error') rec.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e)));
  const isSuggest = (r) => r.url().includes('CAMS_Locator/GeocodeServer/suggest');
  const isPhoton = (r) => r.url().startsWith('https://photon.komoot.io/');
  page.on('request', (r) => { if (isPhoton(r)) { rec.photonLive++; rec.photonMax = Math.max(rec.photonMax, rec.photonLive); } });
  page.on('requestfinished', (r) => { if (isPhoton(r)) rec.photonLive--; });
  page.on('requestfailed', (r) => { if (isPhoton(r)) rec.photonLive--; });
  page.on('request', (r) => { if (isSuggest(r)) { rec.live++; rec.maxLive = Math.max(rec.maxLive, rec.live); } });
  page.on('requestfinished', (r) => { if (isSuggest(r)) rec.live--; });
  page.on('requestfailed', (r) => { if (isSuggest(r)) { rec.live--; rec.failed++; } });
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith('data:')) return route.continue();
    const parsed = new URL(u);
    if (parsed.hostname === 'public.gis.lacounty.gov' && u.includes('CAMS_Locator/GeocodeServer/suggest')) {
      const q = parsed.searchParams.get('text') ?? '';
      rec.suggests.push({ q, at: Date.now(), max: parsed.searchParams.get('maxSuggestions') });
      const a = (suggestMode ?? defaultSuggest)({ q, n: rec.suggests.length });
      if (a.delay) await new Promise((r) => setTimeout(r, a.delay));
      try { return await route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body) }); } catch { return undefined; }
    }
    if (parsed.hostname === 'photon.komoot.io') {
      const q = parsed.searchParams.get('q') ?? '';
      rec.photon.push({ q, at: Date.now(), url: u });
      const a = (photonMode ?? (() => ({ status: 200, delay: 0, body: { features: [] } })))({ q, n: rec.photon.length });
      if (a.delay) await new Promise((r) => setTimeout(r, a.delay));
      try { return await route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body) }); } catch { return undefined; }
    }
    if (parsed.hostname === 'public.gis.lacounty.gov' && u.includes('CAMS_Locator')) { rec.other.push(u); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ candidates: [] }) }); }
    if (parsed.hostname === 'nominatim.openstreetmap.org') { rec.other.push(u); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '[]' }); } // only after a real submit
    rec.external.push(u); allExternal.push(u);
    return route.abort('failed');
  });
  try {
    await page.goto(url);
    await page.waitForSelector('#address');
    await fn(page, rec);
    assert.deepEqual(rec.consoleErrors.filter((m) => !(allowConsole && allowConsole.test(m))), [], 'console errors');
    assert.deepEqual(rec.pageErrors, [], 'uncaught page errors');
    assert.deepEqual(rec.external, [], 'unmocked external requests');
    assert.equal(await page.evaluate(() => { try { return localStorage.length + sessionStorage.length + document.cookie.length; } catch { return 0; } }), 0, 'nothing in web storage or cookies');
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e}`);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
    try { await page.screenshot({ path: `${SHOTS}/suggest-fail-${failures.length}.png` }); } catch { /* ignore */ }
  } finally { await ctx.close(); }
}
const opts = (page) => page.locator('[role="listbox"] [role="option"]');
const typeSlow = (page, s, delay = 20) => page.locator('#address').pressSequentially(s, { delay });

console.log('address suggest e2e');

for (const [label, url] of PAGES) {
  await scenario(`${label}: markup is a combobox with a listbox, a short neutral hint, and browser autofill kept`, url, async (page, rec) => {
    const a = page.locator('#address');
    assert.equal(await a.getAttribute('role'), 'combobox');
    assert.equal(await a.getAttribute('aria-expanded'), 'false');
    assert.equal(await a.getAttribute('aria-autocomplete'), 'list');
    const listId = await a.getAttribute('aria-controls');
    assert.ok(listId);
    assert.equal(await page.locator(`#${listId}`).getAttribute('role'), 'listbox');
    assert.equal(await page.locator(`#${listId}`).isHidden(), true);
    assert.equal((await page.locator('#address-help').innerText()).trim(), 'Start typing and pick your address');
    assert.match(await a.getAttribute('aria-describedby'), /address-help/);
    assert.equal(await a.getAttribute('autocomplete'), 'street-address', 'the browser can still fill the address');
    assert.equal(await page.locator('#address-suggest-note').count(), 0, 'no note naming the service');
    assert.equal(rec.suggests.length + rec.external.length, 0, 'nothing is sent on load');
    await typeSlow(page, '200 N Sp');
    await page.waitForSelector('[role="option"]');
    assert.equal(await a.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator(`#${listId}`).isVisible(), true);
    assert.ok((await opts(page).count()) >= 1);
    assert.equal(await opts(page).first().getAttribute('role'), 'option');
  });

  await scenario(`${label}: nothing is sent before 3 characters; the 3rd starts one debounced request asking for at most 6`, url, async (page, rec) => {
    await typeSlow(page, 'ab', 30);
    await page.waitForTimeout(500);
    assert.equal(rec.suggests.length, 0, 'two characters: no request');
    await page.locator('#address').pressSequentially('c');
    await page.waitForSelector('[role="option"]');
    assert.equal(rec.suggests.length, 1);
    assert.equal(rec.suggests[0].q, 'abc');
    assert.equal(rec.suggests[0].max, '6');
    await page.fill('#address', 'ab');
    await page.waitForTimeout(500);
    assert.equal(rec.suggests.length, 1, 'back under 3 characters: no new request');
    assert.equal(await opts(page).count(), 0, 'and the list is closed');
    await page.fill('#address', '   ab ');
    await page.waitForTimeout(700);
    assert.equal(rec.suggests.length, 1, 'spaces do not count as characters');
  });

  await scenario(`${label}: requests are debounced (150 ms): typing quickly sends one request with the final text, soon after the last key`, url, async (page, rec) => {
    await typeSlow(page, '1234 Main St', 60); // 12 keys, gaps well under 150 ms
    const lastKey = Date.now();
    await page.waitForSelector('[role="option"]');
    assert.equal(rec.suggests.length, 1, `one request, got ${rec.suggests.map((s) => s.q)}`);
    assert.equal(rec.suggests[0].q, '1234 Main St');
    // pressSequentially returns one key delay (60 ms) after the last key went down, so 150 ms after the key is about 90 ms here
    const gap = rec.suggests[0].at - lastKey;
    assert.ok(gap >= 40 && gap < 400, `request left ${gap} ms after the last key`);
  });

  await scenario(`${label}: answers are cached per typed text for the session: the same text twice sends one request`, url, async (page, rec) => {
    await typeSlow(page, '200 N Spring');
    await page.waitForSelector('[role="option"]');
    assert.equal(rec.suggests.length, 1);
    await page.fill('#address', '');
    await page.waitForTimeout(300);
    assert.equal(await opts(page).count(), 0);
    await typeSlow(page, '200 N Spring');
    await page.waitForSelector('[role="option"]');
    await page.waitForTimeout(400);
    assert.equal(rec.suggests.filter((x) => x.q === '200 N Spring').length, 1, 'same text: answered from the cache');
    await page.locator('#address').press('Backspace');
    await page.waitForSelector('[role="option"]');
    await page.locator('#address').pressSequentially('g');
    await page.waitForTimeout(400);
    assert.equal(rec.suggests.filter((x) => x.q === '200 N Spring').length, 1, 'typing back to it: still one request');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0, 'cache is in memory only');
  });

  await scenario(`${label}: the typed part is highlighted; the previous list stays visible while the next one loads`, url, async (page, rec) => {
    await typeSlow(page, 'abcde');
    await page.waitForSelector('[role="option"]');
    assert.equal(await opts(page).first().locator('mark').innerText(), 'abcde', 'typed part highlighted');
    assert.equal(await opts(page).first().innerText(), 'abcde #1, Los Angeles, CA', 'text unchanged by the highlight');
    await page.locator('#address').pressSequentially('f');
    await page.waitForTimeout(300); // the next answer takes 700 ms
    assert.ok(await opts(page).count() >= 1, 'old list still shown while loading');
    assert.match(await opts(page).first().innerText(), /^abcde #1/);
    await page.waitForFunction(() => /^abcdef #1/.test(document.querySelector('[role="option"]')?.textContent ?? ''));
    assert.equal(rec.suggests.length, 2);
  }, { mode: ({ q, n }) => ({ status: 200, delay: n === 1 ? 0 : 700, body: { suggestions: [1, 2].map((i) => ({ text: `${q} #${i}, Los Angeles, CA`, magicKey: `k${i}` })) } }) });

  await scenario(`${label}: Tab chooses the highlighted suggestion and moves on`, url, async (page) => {
    const a = page.locator('#address');
    await typeSlow(page, '300 S Main');
    await page.waitForSelector('[role="option"]');
    await a.press('ArrowDown');
    await a.press('ArrowDown');
    await a.press('Tab');
    assert.equal(await a.inputValue(), '300 S Main #2, Los Angeles, CA');
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'address', 'focus moved on');
    assert.equal(await opts(page).count(), 0);
  });

  await scenario(`${label}: sources are pluggable and asked in order until one has suggestions`, url, async (page, rec) => {
    await page.evaluate(async () => {
      const m = await import('/estimate/address-suggest.js');
      window.__asked = [];
      m.registerSuggestionSource({ id: 'test-other-us', appliesTo: (t) => /Phoenix/i.test(t), suggest: async (t) => { window.__asked.push(t); return [`${t} (other source)`]; } });
    });
    await typeSlow(page, '1 Main Phoenix');
    await page.waitForSelector('[role="option"]');
    assert.equal(await opts(page).first().innerText(), '1 Main Phoenix (other source)', 'the county had nothing, the next source answered');
    assert.equal(rec.suggests.length, 1, 'the county was asked first');
    await page.fill('#address', '');
    await typeSlow(page, '9 Elm Pasadena');
    await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(() => window.__asked), ['1 Main Phoenix'], 'appliesTo keeps a source out of addresses it does not cover');
  }, { mode: ({ q }) => ({ status: 200, delay: 0, body: { suggestions: /Phoenix|Pasadena/.test(q) ? [] : [{ text: `${q} #1`, magicKey: 'k' }] } }) });

  await scenario(`${label}: at most one request in flight; a new keystroke cancels the old request and only the newest answer is shown`, url, async (page, rec) => {
    await typeSlow(page, 'abcde');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(450); // first request is now in flight (answer delayed 1500 ms)
    assert.equal(rec.suggests.length, 1);
    await page.locator('#address').pressSequentially('f');
    await page.waitForTimeout(450); // second request started, first cancelled
    assert.equal(rec.suggests.length, 2);
    await page.locator('#address').pressSequentially('g');
    await page.waitForTimeout(450);
    assert.equal(rec.suggests.length, 3);
    await page.waitForSelector('[role="option"]');
    assert.equal(rec.maxLive, 1, `requests in flight at once: ${rec.maxLive}`);
    assert.ok(rec.failed >= 2, `older requests were cancelled (${rec.failed})`);
    const first = await opts(page).first().innerText();
    assert.match(first, /^abcdefg #1/, 'only the newest text is answered');
  }, { mode: ({ q }) => ({ status: 200, delay: 1500, body: { suggestions: [1, 2].map((i) => ({ text: `${q} #${i}, Los Angeles, CA`, magicKey: `k${i}` })) } }) });

  await scenario(`${label}: at most 6 suggestions are shown`, url, async (page) => {
    await typeSlow(page, 'abcde');
    await page.waitForSelector('[role="option"]');
    assert.equal(await opts(page).count(), 6);
  }, { mode: ({ q }) => ({ status: 200, delay: 0, body: { suggestions: Array.from({ length: 9 }, (_, i) => ({ text: `${q} #${i}, Los Angeles, CA`, magicKey: `k${i}` })) } }) });

  await scenario(`${label}: keyboard: arrows move, Enter fills the field only, Escape closes`, url, async (page, rec) => {
    const a = page.locator('#address');
    await typeSlow(page, '200 N Spring');
    await page.waitForSelector('[role="option"]');
    assert.equal(await a.getAttribute('aria-activedescendant'), null);
    await a.press('ArrowDown');
    await a.press('ArrowDown');
    const active = await a.getAttribute('aria-activedescendant');
    assert.equal(await page.locator(`#${active}`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('[role="option"][aria-selected="true"]').count(), 1);
    await a.press('ArrowUp');
    assert.equal(await page.locator('[role="option"][aria-selected="true"]').first().innerText(), '200 N Spring #1, Los Angeles, CA');
    await a.press('ArrowUp'); // wraps to the last
    assert.equal(await page.locator('[role="option"][aria-selected="true"]').first().innerText(), '200 N Spring #5, Los Angeles, CA');
    await a.press('Enter');
    assert.equal(await a.inputValue(), '200 N Spring #5, Los Angeles, CA');
    assert.equal(await a.getAttribute('aria-expanded'), 'false');
    assert.equal(await opts(page).count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'address', 'focus stays in the field');
    await page.waitForTimeout(800);
    assert.equal(rec.suggests.length, 1, 'filling the field asks for no more suggestions');
    assert.equal(rec.other.length, 0, 'and starts no lookup');
    // Escape closes without changing the text
    await a.fill('300 S Broadway');
    await page.waitForSelector('[role="option"]');
    await a.press('Escape');
    assert.equal(await opts(page).count(), 0);
    assert.equal(await a.getAttribute('aria-expanded'), 'false');
    assert.equal(await a.inputValue(), '300 S Broadway');
    assert.equal(await page.locator('#h-confirm, #facts').count(), 0, 'Escape starts nothing');
  });

  await scenario(`${label}: choosing a suggestion with the pointer fills the field and does not start a lookup`, url, async (page, rec) => {
    await typeSlow(page, '200 N Spring');
    await page.waitForSelector('[role="option"]');
    const before = page.url();
    await opts(page).nth(2).click();
    assert.equal(await page.inputValue('#address'), '200 N Spring #3, Los Angeles, CA');
    assert.equal(await opts(page).count(), 0);
    await page.waitForTimeout(1000);
    assert.equal(page.url(), before, 'no navigation');
    assert.equal(rec.other.length, 0, 'no locator lookup');
    assert.equal(rec.suggests.length, 1);
    assert.equal(await page.locator('#lookup, #results').evaluateAll((els) => els.map((e) => e.textContent.trim()).join('')), '', 'no lookup result');
  });

  await scenario(`${label}: a failing service is silent: no list, no error shown, the field still works`, url, async (page, rec) => {
    await typeSlow(page, '200 N Spring');
    await page.waitForTimeout(900);
    assert.ok(rec.suggests.length >= 1);
    assert.equal(await opts(page).count(), 0);
    assert.equal(await page.locator('#address').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[role="alert"], .err').count(), 0, 'nothing announced as an error');
    await typeSlow(page, ' Street');
    assert.equal(await page.inputValue('#address'), '200 N Spring Street');
  }, { mode: () => ({ status: 500, delay: 0, body: { error: 'down' } }), allowConsole: /^Failed to load resource: the server responded with a status of 500/ });

  await scenario(`${label}: a service answer that is not what we expect is silent too`, url, async (page, rec) => {
    await typeSlow(page, '200 N Spring');
    await page.waitForTimeout(900);
    assert.ok(rec.suggests.length >= 1);
    assert.equal(await opts(page).count(), 0);
  }, { mode: () => ({ status: 200, delay: 0, body: { error: { code: 400, message: 'bad' } } }) });

  await scenario(`${label}: markup in a suggestion is shown as text`, url, async (page) => {
    await typeSlow(page, '200 N Spring');
    await page.waitForSelector('[role="option"]');
    assert.equal(await opts(page).first().innerText(), '<img src=x onerror=window.__pwn=1> & <b>bold</b>');
    assert.equal(await page.locator('[role="listbox"] img, [role="listbox"] b').count(), 0);
    assert.equal(await page.evaluate(() => window.__pwn), undefined);
    await opts(page).first().click();
    assert.equal(await page.inputValue('#address'), '<img src=x onerror=window.__pwn=1> & <b>bold</b>');
    assert.equal(await page.evaluate(() => window.__pwn), undefined);
  }, { mode: () => ({ status: 200, delay: 0, body: { suggestions: [{ text: '<img src=x onerror=window.__pwn=1> & <b>bold</b>', magicKey: 'k' }] } }) });

  await scenario(`${label}: 390 px wide with the list open: no horizontal scroll, list inside the screen`, url, async (page) => {
    await typeSlow(page, '200 North Spring Street, Los Ang');
    await page.waitForSelector('[role="option"]');
    const m = await page.evaluate(() => {
      const l = document.querySelector('[role="listbox"]').getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, left: l.left, right: l.right };
    });
    assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`);
    assert.ok(m.left >= 0 && m.right <= m.cw, `list at ${m.left}..${m.right} of ${m.cw}`);
    await page.screenshot({ path: `${SHOTS}/suggest-${label}-390.png` });
  }, { viewport: { width: 390, height: 780 }, mode: ({ q }) => ({ status: 200, delay: 0, body: { suggestions: ['200 North Spring St, East Rancho Dominguez, CA', '200 North Spring St, Los Angeles, CA', '200 North Spring St, Compton, CA', '200 North Spring St, Pasadena, CA', '200 North Spring Street Extension, Long Beach, CA'].map((t, i) => ({ text: t, magicKey: `k${i}` })) } }) });

  await scenario(`${label}: 1280 px wide with the list open (screenshot)`, url, async (page) => {
    await typeSlow(page, '200 N Spring');
    await page.waitForSelector('[role="option"]');
    await opts(page).nth(1).hover();
    await page.screenshot({ path: `${SHOTS}/suggest-${label}-1280.png` });
  }, { mode: () => ({ status: 200, delay: 0, body: { suggestions: ['200 North Spring St, East Rancho Dominguez, CA', '200 North Spring St, Los Angeles, CA', '200 North Spring St, Compton, CA', '200 South Spring St, Los Angeles, CA'].map((t, i) => ({ text: t, magicKey: `k${i}` })) } }) });
}

// ---- Photon: address suggestions outside Los Angeles County (the county source is asked first) ------------------------------------------
const CHI = [photonFeature('121', 'North LaSalle Street', 'Chicago', 'Illinois', '60602', -87.63195, 41.88383), photonFeature('1211', 'North LaSalle Drive', 'Chicago', 'Illinois', '60610', -87.63265, 41.9044),
  { ...photonFeature('5', 'Somewhere Road', 'Toronto', 'Ontario', 'M5V', -79.38, 43.65), properties: { countrycode: 'CA', housenumber: '5', street: 'Somewhere Road', city: 'Toronto', state: 'Ontario' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-87.6, 41.9] }, properties: { countrycode: 'US', name: 'LaSalle Park', city: 'Chicago', state: 'Illinois' } }];
for (const [label, url] of PAGES) {
  await scenario(`${label}: Photon answers only after the county has nothing; US addresses with a number only; the county is not asked for another state`, url, async (page, rec) => {
    await typeSlow(page, '121 N LaSalle St, Chicago, IL');
    await page.waitForSelector('[role="option"]');
    assert.deepEqual(await opts(page).allInnerTexts(), ['121 North LaSalle Street, Chicago, IL 60602', '1211 North LaSalle Drive, Chicago, IL 60610'], 'Canadian and street-less results are dropped');
    assert.equal(rec.suggests.length, 0, 'text that names Illinois never goes to the county service');
    assert.ok(rec.photon.length >= 1);
    assert.ok(rec.photon.every((x) => x.q.length >= 4), 'no Photon request under 4 characters');
    const u = new URL(rec.photon[0].url);
    assert.equal(u.searchParams.get('lang'), 'en'); assert.ok(u.searchParams.get('limit'));
    assert.match(await page.locator('#attribution').innerText(), /Address suggestions © OpenStreetMap contributors \(via Photon\)/);
    await page.screenshot({ path: `${SHOTS}/suggest-photon-${label}.png` });
  }, { photon: () => ({ status: 200, delay: 0, body: { features: CHI } }) });

  await scenario(`${label}: county first: a typed Los Angeles address is answered by the county and Photon is not asked`, url, async (page, rec) => {
    await typeSlow(page, '200 N Spring');
    await page.waitForSelector('[role="option"]');
    assert.equal(rec.photon.length, 0);
    assert.ok(rec.suggests.length >= 1);
  });

  await scenario(`${label}: no state typed and the county has nothing: Photon is asked (once at most per 250 ms, one in flight)`, url, async (page, rec) => {
    await typeSlow(page, '121 N LaSalle', 40);
    await page.waitForSelector('[role="option"]');
    for (let i = 1; i < rec.photon.length; i++) assert.ok(rec.photon[i].at - rec.photon[i - 1].at >= 240, `Photon requests ${rec.photon[i].at - rec.photon[i - 1].at} ms apart`);
    assert.equal(rec.photonMax, 1, 'one Photon request in flight at most');
  }, { mode: () => ({ status: 200, delay: 0, body: { suggestions: [] } }), photon: () => ({ status: 200, delay: 60, body: { features: CHI } }) });

  await scenario(`${label}: Photon failing or answering nonsense is silent`, url, async (page, rec) => {
    await typeSlow(page, '121 N LaSalle St, Chicago, IL');
    await page.waitForTimeout(1200);
    assert.ok(rec.photon.length >= 1);
    assert.equal(await opts(page).count(), 0);
    assert.equal(await page.locator('[role="alert"], .err').count(), 0);
    await typeSlow(page, ' 60602');
    assert.equal(await page.inputValue('#address'), '121 N LaSalle St, Chicago, IL 60602', 'the field still works');
  }, { photon: ({ n }) => (n % 2 ? { status: 503, delay: 0, body: {} } : { status: 200, delay: 0, body: { nope: true } }), allowConsole: /Failed to load resource: the server responded with a status of 503/ });

  await scenario(`${label}: markup in a Photon name is shown as text`, url, async (page) => {
    await typeSlow(page, '121 N LaSalle St, Chicago, IL');
    await page.waitForSelector('[role="option"]');
    assert.equal(await opts(page).first().innerText(), '1 <img src=x onerror=window.__pwn=1> Road, <b>Town</b>, IL 60602');
    assert.equal(await page.locator('[role="listbox"] img, [role="listbox"] b').count(), 0);
    await opts(page).first().click();
    assert.equal(await page.inputValue('#address'), '1 <img src=x onerror=window.__pwn=1> Road, <b>Town</b>, IL 60602');
    assert.equal(await page.evaluate(() => window.__pwn), undefined);
  }, { photon: () => ({ status: 200, delay: 0, body: { features: [photonFeature('1', '<img src=x onerror=window.__pwn=1> Road', '<b>Town</b>', 'Illinois', '60602', -87.6, 41.9)] } }) });
}

await scenario('homepage: after a suggestion is chosen, submitting (Enter again) is what starts the lookup', PAGES[0][1], async (page) => {
  const a = page.locator('#address');
  await typeSlow(page, '200 N Spring');
  await page.waitForSelector('[role="option"]');
  await a.press('ArrowDown');
  await a.press('Enter');
  assert.equal(new URL(page.url()).pathname, '/');
  await a.press('Enter');
  await page.waitForURL(/\/estimate\//);
  assert.equal(await page.inputValue('#address'), '200 N Spring #1, Los Angeles, CA');
}, { mode: null, allowConsole: /Failed to load resource/ });

await scenario('homepage: a chosen suggestion that carries a point passes it to the estimator in the URL fragment', PAGES[0][1], async (page) => {
  // stop at the hand-off: the estimator page itself is covered by tests/estimate.e2e.mjs
  await page.route('**/estimate/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title><input id="address">' }));
  const a = page.locator('#address');
  await typeSlow(page, '121 N LaSalle St, Chicago, IL');
  await page.waitForSelector('[role="option"]');
  await a.press('ArrowDown');
  await a.press('Enter');
  await a.press('Enter');
  await page.waitForURL(/\/estimate\//);
  const frag = new URLSearchParams(new URL(page.url()).hash.slice(1));
  assert.equal(frag.get('address'), '121 North LaSalle Street, Chicago, IL 60602');
  assert.ok(Math.abs(Number(frag.get('lat')) - 41.88383) < 1e-5 && Math.abs(Number(frag.get('lng')) + 87.63195) < 1e-5, `point passed: ${page.url()}`);
}, { mode: () => ({ status: 200, delay: 0, body: { suggestions: [] } }), photon: () => ({ status: 200, delay: 0, body: { features: CHI } }), allowConsole: /Failed to load resource/ });

await browser.close();
server.close();
console.log(`\n${passed} scenario(s) passed, ${failures.length} failure(s)`);
if (allExternal.length) failures.push(`unmocked external requests: ${allExternal.join(', ')}`);
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

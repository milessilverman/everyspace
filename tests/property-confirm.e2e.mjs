// Property confirm screen e2e (Chromium via Playwright): address-match confirmation, parcel picker, the "Your property"
// table (value, source tag, date, confidence), owner corrections, rejected edits, manual mode. Every external host is
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
async function scenario(name, fn, allowConsole = null) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
    assert.deepEqual(rec.consoleErrors.filter((m) => !(allowConsole && allowConsole.test(m))), [], 'console errors');
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
async function happy(page) { await page.goto(URL_PAGE); await search(page, VENICE); await page.waitForSelector('#profile-table'); }
/** every dollar figure on the page, in document order: changes when the results change */
const figures = (page) => page.locator('[data-cents]').evaluateAll((els) => els.map((e) => `${e.dataset.opp ?? 'combo'}|${e.dataset.scenario}|${e.dataset.period}|${e.dataset.cents}`));

console.log('property confirm e2e');

await scenario('matched-address confirmation: asked before any parcel lookup; No returns to the address box; Yes continues', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, SPRING_N);
  await page.waitForSelector('#confirm-yes');
  assert.match(await text(page, '#h-confirm ~ p'), /We found: 200 South Spring Street, Los Angeles, CA 90012\. Is this your property\?/);
  assert.match(await text(page, '#h-confirm ~ p ~ p'), /You typed: 200 N Spring St/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-yes', 'focus moves to the question');
  assert.equal(rec.mocked.filter((u) => (u.includes('lacounty') && !u.includes('CAMS_Locator')) || u.includes('overpass')).length, 0, 'no parcel request yet');
  assert.equal(await page.locator('#profile-table').count(), 0, 'no profile before the owner says yes');
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

await scenario('parcel candidates: pick by address marks the parcel as owner-confirmed; "None of these" goes to manual with no guess', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, SPRING_S);
  await page.waitForSelector('#cand-none');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'cand-none');
  assert.equal(await page.locator('[data-act="pick"]').count(), 10, 'capped at 10 candidates');
  assert.equal(await page.locator('#profile-table').count(), 0, 'nothing chosen for the owner');
  // no address-less candidate can be picked without an APN, and every row names its parcel
  assert.match(await text(page, '#h-cands ~ ul'), /\(parcel \d+\)/);
  await page.click(`#pick-${APN}`);
  await page.waitForSelector('#profile-table');
  assert.match(await text(page, 'tr[data-key="parcel_id"]'), new RegExp(`${APN}.*You confirmed`));
  // None of these (fresh page): manual basics, address kept, nothing guessed about the parcel
  await page.goto(URL_PAGE);
  await search(page, SPRING_S);
  await page.waitForSelector('#cand-none');
  await page.click('#cand-none');
  await page.waitForSelector('#manual-basics');
  assert.equal(await page.locator('tr[data-key="parcel_id"] .chip').innerText().catch(() => 'absent') === 'You confirmed', false, 'no parcel number was assumed');
  assert.equal(await page.locator('[data-opp-card]').count(), 0, 'no ways to earn without a property type');
});

await scenario('profile rows show value, source tag, date and confidence; unavailable rows say why', async (page) => {
  await happy(page);
  const rows = await page.locator('#profile-table tbody tr[data-key]').evaluateAll((trs) => trs.map((tr) => ({ key: tr.dataset.key, cells: [...tr.children].map((c) => c.innerText.replace(/\s+/g, ' ').trim()) })));
  assert.ok(rows.length >= 6, `has rows (${rows.length})`);
  for (const r of rows) {
    const [label, value, tag, source, conf, change] = r.cells;
    assert.ok(label && value, `${r.key}: label and value`);
    assert.match(tag, /^(Measured|Estimated|You confirmed)$/, `${r.key}: source tag`);
    assert.ok(source.length > 3, `${r.key}: source named`);
    assert.match(source, /[A-Z][a-z]{2} \d{1,2}, \d{4}/, `${r.key}: retrieval date shown`);
    assert.match(conf, /^(Low|Medium|High) confidence$/, `${r.key}: confidence in words`);
    assert.match(change, /^(Edit|Not editable here)$/, `${r.key}: edit control`);
  }
  await page.click('details[data-dk="missing-attrs"] > summary');
  const miss = await page.locator('#unavailable-table tbody tr').evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.innerText.replace(/\s+/g, ' ').trim())));
  assert.ok(miss.length > 0);
  for (const [label, tag, why, fill] of miss) { assert.equal(tag, 'Not available', label); assert.ok(why.length > 3, `${label}: says why`); assert.match(fill, /^(Fill in|Not editable here)$/, label); }
});

await scenario('an owner correction is marked "You confirmed", keeps its date and changes the results', async (page) => {
  await happy(page);
  const before = await figures(page);
  assert.ok(before.length > 0);
  assert.doesNotMatch(await text(page, 'tr[data-key="bedrooms"]'), /You confirmed/);
  await page.click('#edit-bedrooms');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ed-bedrooms', 'focus in the editor');
  await page.fill('#ed-bedrooms', '9');
  await page.press('#ed-bedrooms', 'Enter');
  await page.waitForFunction(() => /You confirmed/.test(document.querySelector('tr[data-key="bedrooms"]')?.textContent ?? ''));
  const row = await text(page, 'tr[data-key="bedrooms"]');
  assert.match(row, /9/);
  assert.match(row, /You confirmed/);
  assert.match(row, /[A-Z][a-z]{2} \d{1,2}, \d{4}/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'edit-bedrooms', 'focus returns to the edit button');
  assert.match(await text(page, '#status'), /Estimates updated/);
  // edit twice: the second edit starts from the corrected value; cancel changes nothing
  await page.click('#edit-bedrooms');
  assert.equal(await page.inputValue('#ed-bedrooms'), '9');
  await page.fill('#ed-bedrooms', '2');
  await page.click('#cancel-bedrooms');
  assert.match(await text(page, 'tr[data-key="bedrooms"]'), /9.*You confirmed/);
  await page.click('#edit-bedrooms');
  await page.fill('#ed-bedrooms', '2');
  await page.click('#save-bedrooms');
  await page.waitForFunction(() => /\b2\b/.test(document.querySelector('tr[data-key="bedrooms"] .val')?.textContent ?? ''));
  // a yes/no correction and a text correction
  await page.click('#edit-pool_present');
  await page.selectOption('#ed-pool_present', 'no');
  await page.click('#save-pool_present');
  await page.waitForFunction(() => /No/.test(document.querySelector('tr[data-key="pool_present"] .val')?.textContent ?? ''));
  assert.match(await text(page, 'tr[data-key="pool_present"]'), /You confirmed/);
  assert.notDeepEqual(await figures(page), before, 'a corrected value (no pool) changes the estimates at once');
  assert.equal(await page.locator('[data-opp-card="pool"]').count(), 0, 'the pool idea is gone');
});

await scenario('invalid edits are rejected with a message next to the field and change nothing', async (page) => {
  await happy(page);
  const snapshot = await text(page, '#profile-table');
  const figs = await figures(page);
  const tryEdit = async (key, value, pattern) => {
    await page.click(`#edit-${key}`);
    const sel = `#ed-${key}`;
    if (value === 'NaN') await page.evaluate((s) => { document.querySelector(s).value = 'abc'; }, sel); // a number box refuses letters: its value reads as empty
    else await page.fill(sel, value);
    await page.click(`#save-${key}`);
    assert.match(await text(page, '.inline-err'), pattern, `${key}=${value}`);
    assert.equal(await page.getAttribute(sel, 'aria-invalid'), 'true');
    assert.match(await text(page, '#status'), pattern);
    assert.equal(await page.locator('#status.err').count(), 1, 'status styled as an error');
    assert.ok(await page.locator(sel).isVisible(), 'editor stays open for another try');
    await page.click(`#cancel-${key}`);
  };
  await tryEdit('bedrooms', '-2', /zero or more/);
  await tryEdit('bedrooms', '2.5', /whole number/);
  await tryEdit('bedrooms', '', /zero or more/);
  await tryEdit('bedrooms', 'NaN', /zero or more/);
  await tryEdit('year_built', '12', /between 1600 and/);
  await tryEdit('year_built', '3000', /between 1600 and/);
  await tryEdit('lot_area_sqft', '99999999999', /too large/);
  await tryEdit('address', '', /Type a value/);
  await page.click('#edit-jurisdiction');
  await page.fill('#ed-jurisdiction-state', '1');
  await page.click('#save-jurisdiction');
  assert.match(await text(page, '.inline-err'), /two-letter state/);
  await page.click('#cancel-jurisdiction');
  assert.equal(await text(page, '#profile-table'), snapshot, 'table unchanged by rejected edits');
  assert.deepEqual(await figures(page), figs, 'estimates unchanged by rejected edits');
  assert.equal(await page.locator('#profile-table .chip:text("You confirmed")').count(), (snapshot.match(/You confirmed/g) ?? []).length);
});

await scenario('invalid answers to the owner questions are rejected visibly and not stored', async (page) => {
  await happy(page);
  await page.click('details[data-dk="questions"] > summary');
  const numeric = await page.locator('#results input[data-change="number"]').first();
  const id = await numeric.getAttribute('id');
  await page.fill(`#${id}`, '-5');
  await page.locator(`#${id}`).blur();
  await page.waitForSelector('.inline-err');
  assert.match(await text(page, '#status'), /zero or more/);
  const key = await numeric.getAttribute('data-key');
  assert.doesNotMatch(await text(page, `tr[data-key="${key}"]`).catch(() => ''), /-5/);
  // max-upfront: negative is refused with a message and ignored
  await page.fill('#max-upfront', '-100');
  await page.locator('#max-upfront').blur();
  await page.waitForSelector('#input-error');
  assert.match(await text(page, '#input-error'), /zero or more.*No limit is applied/);
  assert.equal(await page.inputValue('#max-upfront'), '');
});

await scenario('re-searching does not silently overwrite an owner correction', async (page, rec) => {
  await happy(page);
  await page.click('#edit-bedrooms');
  await page.fill('#ed-bedrooms', '6');
  await page.click('#save-bedrooms');
  await page.waitForFunction(() => /\b6\b/.test(document.querySelector('tr[data-key="bedrooms"] .val')?.textContent ?? ''));
  const calls = nominatim(rec);
  await page.click('#address-submit');
  assert.match(await text(page, '#status'), /You have corrections on this page/);
  assert.equal(nominatim(rec), calls, 'nothing looked up on the first press');
  assert.match(await text(page, 'tr[data-key="bedrooms"]'), /6.*You confirmed/);
  await page.click('#address-submit');
  await page.waitForFunction(() => !/You confirmed/.test(document.querySelector('tr[data-key="bedrooms"]')?.textContent ?? 'You confirmed'));
  assert.equal(nominatim(rec), calls + 1, 'the second press searches again, as warned');
});

await scenario('manual mode reaches results using only owner-entered values', async (page, rec) => {
  await page.goto(URL_PAGE);
  await search(page, FAIL);
  await page.waitForSelector('#manual-basics');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'h-profile');
  const tags = async () => (await page.locator('#profile-table tbody tr[data-key] .chip').allInnerTexts());
  assert.deepEqual(await tags(), [], 'nothing is known before the owner types');
  assert.match(await text(page, '#profile-table'), /Nothing was found yet/);
  await page.selectOption('#basic-property_type', 'single_family');
  await page.waitForFunction(() => document.querySelector('#basic-property_type').value === 'single_family');
  await page.fill('#basic-bedrooms', '3');
  await page.locator('#basic-bedrooms').blur();
  await page.waitForFunction(() => document.querySelector('#basic-bedrooms').value === '3');
  await page.selectOption('#basic-garage_present', 'yes');
  await page.waitForSelector('[data-opp-card]');
  const t = await tags();
  assert.ok(t.length >= 3 && t.every((x) => x === 'You confirmed'), `only owner values: ${t}`);
  const cards = await page.locator('[data-opp-card]').count();
  assert.ok(cards >= 1);
  assert.equal(rec.mocked.filter((u) => (u.includes('lacounty') && !u.includes('CAMS_Locator')) || u.includes('overpass')).length, 0, 'no parcel or building request in manual mode (only the county locator was asked, as the first choice)');
}, /^Failed to load resource: the server responded with a status of 503/);

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

await scenario('county path: a different house number is confirmed with the owner before any parcel is shown; No edits, Yes continues on the county path', async (page, rec) => {
  override = countyServices;
  try {
    await page.goto(URL_PAGE);
    await search(page, '4325 Example Ave, Los Angeles, CA 90099');
    await page.waitForSelector('#confirm-yes');
    assert.match(await text(page, '#h-confirm ~ p'), /We found: 4321 Example Ave, Los Angeles, CA, 90099\. Is this your property\?/);
    assert.match(await text(page, '#h-confirm ~ p ~ p'), /You typed: 4325 Example Ave.*house number|You typed: 4325 Example Ave/);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-yes');
    assert.equal(parcelReqs(rec).length, 0, 'no parcel, building or map request before the owner says yes');
    assert.equal(await page.locator('#profile-table').count(), 0);
    assert.equal(rec.mocked.some((u) => u.includes('nominatim')), false);
    await page.click('#confirm-no');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'address');
    assert.equal(await page.inputValue('#address'), '4325 Example Ave, Los Angeles, CA 90099');
    await page.click('#address-submit');
    await page.waitForSelector('#confirm-yes');
    await page.click('#confirm-yes');
    await page.waitForSelector('#profile-table');
    assert.match(await text(page, 'tr[data-key="address"]'), /4321 Example Ave, Los Angeles, CA, 90099.*LA County/);
    assert.match(await text(page, '#path-note'), /Lookup path: used Los Angeles County's public services/);
    assert.ok(parcelReqs(rec).some((u) => u.includes('LACounty_Parcel')), 'the parcel is looked up only after Yes');
    assert.equal(rec.mocked.some((u) => u.includes('nominatim')), false);
    assert.equal(await text(page, 'tr[data-key="floors"] .chip'), 'Estimated');
  } finally { override = null; }
});

await scenario('county path: an exact match is not asked about; the matched address is still shown on its row', async (page, rec) => {
  override = countyServices;
  try {
    await page.goto(URL_PAGE);
    await search(page, '4321 Example Ave, Los Angeles, CA 90099');
    await page.waitForSelector('#profile-table');
    assert.equal(await page.locator('#confirm-yes').count(), 0);
    assert.match(await text(page, 'tr[data-key="address"]'), /4321 Example Ave, Los Angeles, CA, 90099/);
    assert.match(await text(page, 'tr[data-key="jurisdiction"]'), /Los Angeles/);
  } finally { override = null; }
});

await browser.close();
server.close();
console.log(`\n${passed} scenario(s) passed, ${failures.length} failure(s)`);
if (allExternal.length) failures.push(`unmocked external requests: ${allExternal.join(', ')}`);
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

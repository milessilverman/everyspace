// Homepage e2e (Chromium via Playwright). Every external host is answered from the recorded core fixtures; anything else
// that leaves localhost is ABORTED and recorded, and the run fails. Never touches a real network.
// Run: node tests/home.e2e.mjs
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
const DEMO = 'https://milessilverman.github.io/everyspace-demo/';

function answer(urlStr) {
  const u = new URL(urlStr);
  const dec = decodeURIComponent(urlStr);
  if (u.hostname === 'nominatim.openstreetmap.org') return { status: 200, body: fx('nominatim-la.json') };
  if (u.hostname.endsWith('lacounty.gov')) return { status: 200, body: fx('arcgis-la-parcel.json') };
  if (u.hostname.includes('overpass')) return { status: 200, body: dec.includes('34.0516') ? fx('overpass-no-features.json') : fx('overpass-la.json') };
  return null;
}

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

const browser = await chromium.launch();
const failures = [];
let passed = 0;
const allExternal = [];
async function scenario(name, fn, { viewport = { width: 1280, height: 900 }, javaScriptEnabled = true } = {}) {
  const ctx = await browser.newContext({ viewport, javaScriptEnabled });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const rec = { external: [], mocked: [], consoleErrors: [], pageErrors: [], local: [] };
  page.on('console', (m) => { if (m.type() === 'error') rec.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e)));
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || url.startsWith('data:')) { rec.local.push(url); return route.continue(); }
    const a = answer(url);
    if (!a) { rec.external.push(url); allExternal.push(url); return route.abort('failed'); }
    rec.mocked.push(url);
    return route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body) });
  });
  try {
    await fn(page, rec, ctx);
    assert.deepEqual(rec.consoleErrors, [], 'console errors');
    assert.deepEqual(rec.pageErrors, [], 'uncaught page errors');
    assert.deepEqual(rec.external, [], 'unmocked external requests');
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e}`);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
  } finally { await ctx.close(); }
}
const storageEmpty = (page) => page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === '');
const nominatimCalls = (rec) => rec.mocked.filter((u) => u.includes('nominatim')).length;

console.log('home e2e');

await scenario('homepage renders: no console errors, no requests off localhost, nothing stored', async (page, rec) => {
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('#address');
  assert.equal(await page.locator('h1').innerText(), 'How much more could your property be earning?');
  assert.equal(await page.locator('form').count(), 1);
  assert.equal(await page.locator('label[for="address"]').count(), 1);
  assert.equal(await page.getAttribute('#address', 'autocomplete'), 'street-address');
  assert.equal(await page.getAttribute('#address', 'required'), '');
  assert.equal(rec.external.length + rec.mocked.length, 0, 'no external or mocked request');
  assert.ok(rec.local.every((u) => !/everyspace\.html/.test(u)));
  assert.equal(await storageEmpty(page), true, 'no storage or cookies');
  assert.match(await page.title(), /Everyspace/);
});

await scenario('footer links and attribution', async (page) => {
  await page.goto(`${ORIGIN}/`);
  assert.equal(await page.getAttribute('footer a:text("See the earlier demo")', 'href'), DEMO);
  assert.equal(await page.getAttribute('footer a:text("Manage your spaces")', 'href'), 'host/');
  assert.match(await page.locator('footer').innerText(), /Address search © OpenStreetMap contributors \(ODbL\) via Nominatim\. Parcel data: county assessor public services\. Buildings and pools: © OpenStreetMap contributors\./);
});

await scenario('submit goes to the estimator: lookup runs once, profile shows, address leaves the URL', async (page, rec) => {
  await page.goto(`${ORIGIN}/`);
  await page.fill('#address', VENICE);
  await page.press('#address', 'Enter');
  await page.waitForURL(/\/estimate\//);
  await page.waitForSelector('#profile-table');
  assert.equal(await page.inputValue('#address'), VENICE);
  assert.equal(nominatimCalls(rec), 1, 'geocoded once');
  assert.ok(!page.url().includes('address') && !page.url().includes('Venice'), `address removed from URL: ${page.url()}`);
  assert.equal(await page.evaluate(() => location.hash + location.search), '');
  assert.equal(await page.locator('a:text("Start over")').getAttribute('href'), '../');
  assert.equal(await storageEmpty(page), true);
  await page.waitForTimeout(400);
  assert.equal(nominatimCalls(rec), 1, 'still once');
});

await scenario('without JavaScript the form is a GET to estimate/?address=, which auto-runs', async (page, rec, ctx) => {
  await page.goto(`${ORIGIN}/`);
  await page.fill('#address', VENICE);
  await page.press('#address', 'Enter');
  await page.waitForURL(/\/estimate\/\?address=/);
  assert.equal(new URL(page.url()).searchParams.get('address'), VENICE);
  assert.equal(rec.mocked.length, 0, 'homepage made no lookup');
  const url = page.url();
  const js = await ctx.browser().newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await js.newPage();
  const r2 = { mocked: [], external: [] };
  await js.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN) || u.startsWith('data:')) return route.continue();
    const a = answer(u);
    if (!a) { r2.external.push(u); return route.abort('failed'); }
    r2.mocked.push(u);
    return route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body) });
  });
  await p2.goto(url);
  await p2.waitForSelector('#profile-table');
  assert.equal(r2.mocked.filter((u) => u.includes('nominatim')).length, 1, 'lookup ran once');
  assert.deepEqual(r2.external, []);
  assert.equal(await p2.evaluate(() => location.search + location.hash), '');
  await js.close();
}, { javaScriptEnabled: false });

await scenario('390 px wide: no horizontal scroll', async (page) => {
  await page.goto(`${ORIGIN}/`);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, left: document.querySelector('h1').getBoundingClientRect().left }));
  assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`);
  assert.equal(m.left, 16, '16 px gutter');
}, { viewport: { width: 390, height: 800 } });

await scenario('dark mode follows the colour scheme', async (page) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${ORIGIN}/`);
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(11, 16, 22)');
});

await scenario('old everyspace.html redirects to the demo', async (page) => {
  const html = fs.readFileSync(path.join(ROOT, 'everyspace.html'), 'utf8');
  assert.match(html, new RegExp(`http-equiv="refresh"[^>]*${DEMO.replace(/[.]/g, '\\.')}`));
  assert.ok(html.split('\n').length < 25);
});

await browser.close();
server.close();
console.log(`\n${passed} scenario(s) passed, ${failures.length} failure(s)`);
if (allExternal.length) failures.push(`unmocked external requests: ${allExternal.join(', ')}`);
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

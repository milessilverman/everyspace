// Navigation e2e (Chromium via Playwright): home <-> estimator <-> Host Console, footer links, the old everyspace.html
// redirect, wrong URLs, back/forward, and every internal link of the public pages, served both at a domain root and under
// the GitHub Pages project sub-path /everyspace/. No real network: lookup hosts are answered from fixtures, the Host
// Console's CDN and font requests are stubbed, everything else off localhost is aborted and fails the run.
// Run: node tests/navigation.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FX = path.join(ROOT, 'core/tests/fixtures/parcel');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n), 'utf8'));
const VENICE = '99999 Venice Blvd, Los Angeles, CA 90034';
const DEMO = 'https://milessilverman.github.io/everyspace-demo/';

function answer(urlStr) {
  const u = new URL(urlStr);
  const dec = decodeURIComponent(urlStr);
  if (u.hostname === 'nominatim.openstreetmap.org') return { json: fx('nominatim-la.json') };
  if (u.hostname.endsWith('lacounty.gov') && dec.includes('CAMS_Locator')) return { json: dec.includes('/suggest') ? { suggestions: [] } : { candidates: [] } };
  if (u.hostname.endsWith('lacounty.gov')) return { json: fx('arcgis-la-parcel.json') };
  if (u.hostname.includes('overpass')) return { json: dec.includes('34.0516') ? fx('overpass-no-features.json') : fx('overpass-la.json') };
  if (/(^|\.)(geo\.fcc\.gov|tigerweb\.geo\.census\.gov|stac\.overturemaps\.org|amazonaws\.com|imagery\.nationalmap\.gov|planetarycomputer\.microsoft\.com)$/.test(u.hostname)) return { json: {}, status: 404 }; // other data sources: "not here"
  return null;
}
// What the Host Console asks the outside world for: fonts and the Supabase script. Only its sign-in screen is asserted.
const SUPABASE_STUB = `window.supabase={createClient(){return{from(){throw new Error('no data in this test')},rpc:async()=>({data:null,error:null}),auth:{getSession:async()=>({data:{session:null}}),signOut:async()=>{},onAuthStateChange(cb){setTimeout(()=>cb('INITIAL_SESSION',null),0);return{data:{subscription:{unsubscribe(){}}}}}}}}};`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
/** Static server that behaves like GitHub Pages: optional sub-path, directory URLs without a slash are 301-redirected, no directory listing, plain 404. */
function makeServer(prefix) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = decodeURIComponent(u.pathname);
    if (prefix) { if (p === prefix) { res.writeHead(301, { location: `${prefix}/` }); res.end(); return; } if (!p.startsWith(`${prefix}/`)) { res.writeHead(404); res.end('not found'); return; } p = p.slice(prefix.length); }
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || /(^|\/)(node_modules|\.git)(\/|$)/.test(p)) { res.writeHead(404); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!p.endsWith('/')) { res.writeHead(301, { location: `${prefix}${p}/${u.search}` }); res.end(); return; }
      const idx = path.join(file, 'index.html');
      if (!fs.existsSync(idx)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME['.html'] }); fs.createReadStream(idx).pipe(res); return;
    }
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const rootServer = makeServer(''), subServer = makeServer('/everyspace');
const ROOT_ORIGIN = await listen(rootServer);
const SUB_ORIGIN = await listen(subServer);
const SITES = [{ name: 'domain root', origin: ROOT_ORIGIN, base: '' }, { name: 'sub-path /everyspace/', origin: SUB_ORIGIN, base: '/everyspace' }];

const browser = await launchBrowser();
const failures = [];
let passed = 0;
const allExternal = [];
async function scenario(name, fn) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const rec = { external: [], mocked: [], consoleErrors: [], pageErrors: [], blocked: [] };
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) rec.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => rec.pageErrors.push(String(e)));
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ROOT_ORIGIN) || url.startsWith(SUB_ORIGIN) || url.startsWith('data:')) return route.continue();
    const u = new URL(url);
    if (url.startsWith(DEMO)) { rec.blocked.push(url); return route.abort('blockedbyclient'); } // the earlier demo is never loaded
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('@supabase/supabase-js')) return route.fulfill({ contentType: 'application/javascript', body: SUPABASE_STUB });
    if (u.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    if (u.hostname === 'fonts.gstatic.com') return route.abort('failed');
    const a = answer(url);
    if (!a) { rec.external.push(url); allExternal.push(url); return route.abort('failed'); }
    rec.mocked.push(url);
    return route.fulfill({ status: a.status ?? 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.json) });
  });
  try {
    await fn(page, rec, ctx);
    assert.deepEqual(rec.consoleErrors.filter((m) => !/Failed to load resource/.test(m)), [], 'console errors');
    assert.deepEqual(rec.pageErrors, [], 'uncaught page errors');
    assert.deepEqual(rec.external, [], 'unmocked external requests');
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e}`);
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`);
  } finally { await ctx.close(); }
}
const status = (url) => new Promise((resolve, reject) => { http.get(url, (res) => { res.resume(); resolve({ status: res.statusCode, location: res.headers.location }); }).on('error', reject); });
const pathOf = (page) => new URL(page.url()).pathname;

console.log('navigation e2e');

for (const { name, origin, base } of SITES) {
  await scenario(`[${name}] home -> estimator -> Start over -> home; address leaves the URL; back and forward`, async (page, rec) => {
    await page.goto(`${origin}${base}/`);
    await page.fill('#address', VENICE);
    await page.press('#address', 'Enter');
    await page.waitForURL(`${origin}${base}/estimate/`);
    await page.waitForSelector('#facts');
    assert.equal(await page.evaluate(() => location.hash + location.search), '');
    // Start over -> homepage with an empty box
    await page.click('a:text("Start over")');
    await page.waitForURL(`${origin}${base}/`);
    assert.equal(await page.inputValue('#address'), '');
    // back to the estimator: either a restored page or a fresh empty one, never a broken one
    await page.goBack();
    await page.waitForURL(`${origin}${base}/estimate/`);
    await page.waitForSelector('#address');
    assert.equal(await page.locator('#address-submit').isVisible(), true);
    assert.equal(await page.evaluate(() => location.hash + location.search), '');
    // back again: the homepage (the estimator entry replaced its own URL, it did not add history entries)
    await page.goBack();
    await page.waitForURL(`${origin}${base}/`);
    await page.waitForSelector('#home-form');
    await page.goForward();
    await page.waitForURL(`${origin}${base}/estimate/`);
    await page.waitForSelector('#address-form');
    assert.equal(rec.mocked.filter((u) => u.includes('nominatim')).length <= 1, true, 'history navigation never triggers a new lookup');
  });

  await scenario(`[${name}] estimator -> Host Console (header and footer links) lands on /host/ and shows sign-in`, async (page) => {
    await page.goto(`${origin}${base}/estimate/`);
    assert.equal(await page.getAttribute('header a:text("Host Console")', 'href'), '../host/');
    await page.click('header a:text("Host Console")');
    await page.waitForURL(`${origin}${base}/host/`);
    await page.waitForSelector('#authForm');
    assert.match(await page.locator('#app h1').innerText(), /Sign in/);
    await page.goBack();
    await page.waitForURL(`${origin}${base}/estimate/`);
    await page.click('footer a:has-text("Host Console")');
    await page.waitForURL(`${origin}${base}/host/`);
    await page.waitForSelector('#authForm');
    // and from the homepage
    await page.goto(`${origin}${base}/`);
    await page.getByRole('link', { name: 'Manage your spaces' }).click();
    await page.waitForURL(`${origin}${base}/host/`);
    await page.waitForSelector('#authForm');
  });

  await scenario(`[${name}] results page: Host Console link and footer links resolve`, async (page) => {
    await page.goto(`${origin}${base}/estimate/`);
    await page.fill('#address', VENICE);
    await page.click('#address-submit');
    await page.waitForSelector('#facts');
    const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    assert.ok(hrefs.includes('../host/') && hrefs.includes('../'), 'internal links present');
    for (const h of hrefs) {
      const abs = new URL(h, page.url()).href;
      if (!abs.startsWith(origin)) { assert.match(abs, /^https:\/\//, `external link uses https: ${abs}`); continue; }
      const r = await status(abs);
      assert.ok(r.status === 200, `${h} -> ${abs}: HTTP ${r.status}`);
    }
  });

  await scenario(`[${name}] every internal link, stylesheet and script of the public pages resolves (no 404)`, async (page) => {
    const pages = ['/', '/estimate/', '/everyspace.html', '/host/'];
    const seen = new Set();
    for (const p of pages) {
      let refs;
      if (p === '/everyspace.html') { // meta-refreshes away at once: read its links from the file instead of the live page
        const html = fs.readFileSync(path.join(ROOT, 'everyspace.html'), 'utf8');
        refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => new URL(m[1], `${origin}${base}/everyspace.html`).href);
      } else {
        await page.goto(`${origin}${base}${p}`);
        refs = await page.evaluate(() => [...document.querySelectorAll('a[href], link[href], script[src], img[src]')].map((e) => e.href || e.src));
      }
      for (const ref of refs) {
        if (!ref.startsWith(origin) || seen.has(ref)) continue;
        seen.add(ref);
        const r = await status(ref.replace(/#.*$/, ''));
        assert.equal(r.status, 200, `${p} links to ${ref}: HTTP ${r.status}`);
      }
    }
    // the estimator's ES module graph (core/ files) loads from the same sub-path
    await page.goto(`${origin}${base}/estimate/`);
    await page.waitForSelector('#address');
    const moduleUrls = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.js$/.test(n)));
    assert.ok(moduleUrls.some((u) => u.endsWith(`${base}/core/parcel.js`)), `core/parcel.js loaded from ${base}/core/`);
    for (const u of moduleUrls) assert.ok(u.startsWith(`${origin}${base}/`), `script from the site: ${u}`);
    assert.ok(seen.size >= 5, `checked ${seen.size} internal URLs`);
  });

  await scenario(`[${name}] wrong URLs: what a visitor gets`, async (page) => {
    const get = async (p) => status(`${origin}${base}${p}`);
    assert.deepEqual(await get('/estimate'), { status: 301, location: `${base}/estimate/` }, '/estimate redirects to the slash URL (GitHub Pages does too)');
    assert.equal((await get('/index.html')).status, 200);
    assert.equal((await get('/estimate/index.html')).status, 200);
    assert.equal((await get('/everyspace.html')).status, 200);
    assert.equal((await get('/demo')).status, 404, '/demo does not exist in this repository (404)');
    assert.equal((await get('/estimate/nothing')).status, 404);
    // /estimate without the slash works in the browser through the redirect, with working relative links
    await page.goto(`${origin}${base}/estimate`);
    assert.equal(pathOf(page), `${base}/estimate/`);
    await page.waitForSelector('#address-form');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.card')).borderTopLeftRadius), '14px', 'stylesheet applied');
    // /estimate/index.html: relative links still work
    await page.goto(`${origin}${base}/estimate/index.html`);
    await page.waitForSelector('#address-form');
    await page.click('a:text("Start over")');
    await page.waitForURL(`${origin}${base}/`);
    // /index.html: the form posts to estimate/ relative to it
    await page.goto(`${origin}${base}/index.html`);
    await page.fill('#address', VENICE);
    await page.press('#address', 'Enter');
    await page.waitForURL(`${origin}${base}/estimate/`);
  });
}

await scenario('everyspace.html redirects to the earlier demo (target asserted, external site never loaded)', async (page, rec) => {
  const html = fs.readFileSync(path.join(ROOT, 'everyspace.html'), 'utf8');
  assert.match(html, new RegExp(`http-equiv="refresh" content="0; url=${DEMO.replace(/[.]/g, '\\.')}"`));
  assert.match(html, new RegExp(`rel="canonical" href="${DEMO.replace(/[.]/g, '\\.')}"`));
  const nav = page.waitForRequest((r) => r.url().startsWith(DEMO), { timeout: 10000 });
  await page.goto(`${ROOT_ORIGIN}/everyspace.html`).catch(() => {});
  const req = await nav;
  assert.equal(req.url(), DEMO, 'the browser navigates to the demo URL');
  assert.deepEqual(rec.blocked.filter((u) => u !== DEMO), [], 'nothing else of the demo requested');
  assert.equal(html.includes('href="./"'), true, 'page offers a way back to Everyspace');
  assert.doesNotMatch(html.replace(/(https:\/\/)?milessilverman\.github\.io\/everyspace-demo\/?/g, ''), /demo/i, 'no "demo" wording on the page except the address it points to');
});

await scenario('homepage and estimator links to the Host Console', async (page) => {
  await page.goto(`${ROOT_ORIGIN}/`);
  assert.equal(await page.getByRole('link', { name: 'See the earlier demo' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Manage your spaces' }).getAttribute('href'), 'host/');
  await page.goto(`${ROOT_ORIGIN}/estimate/`);
  assert.equal(await page.locator('footer a').count(), 1);
  assert.equal(await page.getAttribute('footer a', 'href'), '../host/');
  assert.doesNotMatch(await page.locator('body').innerText(), /demo/i, 'no demo wording on the estimator');
});

await browser.close();
rootServer.close(); subServer.close();
console.log(`\n${passed} scenario(s) passed, ${failures.length} failure(s)`);
if (allExternal.length) failures.push(`unmocked external requests: ${allExternal.join(', ')}`);
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

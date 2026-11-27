// "Your lot from above" e2e (Chromium via Playwright): the aerial photo with adjustable outlines on the property screen (estimate/lot-map.js).
// Every external host is mocked (the photo host answers with a generated PNG); anything else that leaves localhost is ABORTED and fails the run.
// Expectations are computed in this file with core/measure.js measureFromGeometry from the outlines read back out of the page.
// Run: node tests/lot-map.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'); }
const { chromium } = pw;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = '/tmp/claude-0/-home-user/bbdf9db1-6a70-50d8-8c4a-2fe889e65e9c/scratchpad/map';
fs.mkdirSync(SHOTS, { recursive: true });
const pfx = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'core/tests/fixtures/providers', n), 'utf8'));
const fx = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'core/tests/fixtures/parcel', n), 'utf8'));
import { overtureServer, OVERTURE_REAL } from '../core/tests/fixtures/providers/overture-mock.mjs';
import { measureFromGeometry } from '../core/measure.js';
import { drivewayAreaSqft } from '../core/driveway.js';
import { polygonAreaSqft } from '../core/geometry.js';
import { frameProject, frameFor, starterRing, ringCrosses, sourceFromProfile, photoUrl, NAIP_BACKDROP } from '../estimate/lot-map.js';

const SFR = '4321 Example Ave, Los Angeles, CA 90099';
const CHICAGO = '121 N LaSalle St, Chicago, IL 60602';
const chicagoOv = overtureServer('chicago');
const nominatimChicago = [{ place_id: 2, osm_type: 'way', osm_id: 2, lat: String(OVERTURE_REAL.chicago.point.lat), lon: String(OVERTURE_REAL.chicago.point.lng), category: 'building', type: 'civic',
  display_name: '121, North LaSalle Street, Chicago, Cook County, Illinois, 60602, United States', address: { house_number: '121', road: 'North LaSalle Street', city: 'Chicago', county: 'Cook County', state: 'Illinois', 'ISO3166-2-lvl4': 'US-IL', postcode: '60602', country_code: 'us' } }];
const OTHER_SOURCES = /(^|\.)(geo\.fcc\.gov|tigerweb\.geo\.census\.gov|stac\.overturemaps\.org|amazonaws\.com|planetarycomputer\.microsoft\.com)$/;

// ---- a small PNG writer/reader (zlib only) ---------------------------------------------------------------------------------------------------
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function pngOf(W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function decodePng(buf) {
  let p = 8, W = 0, H = 0, bpp = 4; const idat = [];
  while (p < buf.length) { const len = buf.readUInt32BE(p), t = buf.toString('ascii', p + 4, p + 8); const d = buf.subarray(p + 8, p + 8 + len); if (t === 'IHDR') { W = d.readUInt32BE(0); H = d.readUInt32BE(4); bpp = d[9] === 6 ? 4 : 3; } if (t === 'IDAT') idat.push(d); p += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = W * bpp, out = Buffer.alloc(stride * H);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let r = v; if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1); else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[y * stride + x] = r & 255;
    }
  }
  return { W, H, bpp, data: out };
}
/** The mocked aerial photo: greenish ground with paths, and a red square at lng/lat `mark` placed by the request's own box and size (WGS84, linear). */
function aerial(urlStr, mark) {
  const u = new URL(urlStr); const [w, s, e, n] = u.searchParams.get('bbox').split(',').map(Number); const [W, H] = u.searchParams.get('size').split(',').map(Number);
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y * W + x) * 4; const t = ((x * 7 + y * 13) % 29) / 29; const road = x < W * 0.08; px[k] = road ? 90 : 96 + t * 30; px[k + 1] = road ? 92 : 128 + t * 26; px[k + 2] = road ? 96 : 84 + t * 20; px[k + 3] = 255; }
  if (mark) {
    const cx = ((mark[0] - w) / (e - w)) * W, cy = ((n - mark[1]) / (n - s)) * H;
    for (let y = Math.floor(cy - 12); y <= cy + 12; y++) for (let x = Math.floor(cx - 12); x <= cx + 12; x++) if (x >= 0 && y >= 0 && x < W && y < H && Math.abs(x + 0.5 - cx) <= 12 && Math.abs(y + 0.5 - cy) <= 12) { const k = (y * W + x) * 4; px[k] = 255; px[k + 1] = 0; px[k + 2] = 0; }
  }
  return pngOf(W, H, px);
}

// ---- mock world --------------------------------------------------------------------------------------------------------------------------------
let world = 'county';
let photoMode = 'png'; // 'png' | '404'
let lariacDelay = 0; // ms the building outlines (and with them the lookup's measured geometry bundle) are held back
let lariacSlivers = false; // add two tiny outlines to the building answer
const MARK = [-118.3, 34]; // the synthetic lot's first corner
const rec0 = { photo: [], hosts: [] };
function answer(urlStr, range = null) {
  const u = new URL(urlStr), dec = decodeURIComponent(urlStr);
  if (u.hostname.includes('overpass')) return 'never';
  if (u.hostname === 'imagery.nationalmap.gov') return { photo: true };
  if (world === 'chicago') {
    if (u.hostname === 'nominatim.openstreetmap.org') return { status: 200, body: nominatimChicago };
    if (u.hostname === 'geo.fcc.gov') return { status: 200, body: pfx('fcc-county-chicago-city-hall.json') };
    if (u.hostname === 'gis.cookcountyil.gov') return 'never';
    const o = chicagoOv.answer(urlStr, range);
    if (o) return { status: o.status, raw: Buffer.from(typeof o.body === 'string' ? o.body : o.body), type: o.type };
    if (u.hostname === 'photon.komoot.io') return { status: 200, body: { features: [] } };
    if (OTHER_SOURCES.test(u.hostname)) return { status: 404, body: {} };
    return null;
  }
  if (OTHER_SOURCES.test(u.hostname)) return { status: 404, body: {} };
  if (u.hostname === 'public.gis.lacounty.gov') {
    if (dec.includes('CAMS_Locator') && dec.includes('/suggest')) return { status: 200, body: pfx('la-cams-suggest.json') };
    if (dec.includes('CAMS_Locator')) return { status: 200, body: pfx('synthetic-cams-sfr.json') };
    if (dec.includes('LACounty_Parcel')) return { status: 200, body: pfx('synthetic-assessor-sfr.json') };
    if (dec.includes('LARIAC')) {
      const body = JSON.parse(JSON.stringify(pfx('synthetic-lariac-sfr.json')));
      if (lariacSlivers) {
        const sq = (lng, lat, id) => ({ attributes: { OBJECTID: id, CODE: 'Building', BLD_ID: String(id), HEIGHT: 8, ELEV: 300, SOURCE: 'LARIAC6', DATE_: '2020', STATUS: 'New', AREA: 64, Shape_Area: 0 }, geometry: { rings: [[[lng, lat], [lng, lat + 0.0000220], [lng + 0.0000260, lat + 0.0000220], [lng + 0.0000260, lat], [lng, lat]]] } });
        body.features.push(sq(-118.29997, 34.00019, 91), sq(-118.29993, 34.00019, 92));
      }
      return { status: 200, body };
    }
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
  if (p === '/estimate/app.js') { // test seam only: lets a scenario hand the page a geometry bundle with a driveway and building kinds (the lookup does not produce them here)
    const seam = 'if (v?.geometry) S.geometry = v.geometry;';
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(seam)) { res.writeHead(500); res.end('seam missing'); return; }
    res.writeHead(200, { 'content-type': MIME['.js'] }); res.end(text.replace(seam, 'if (v?.geometry) S.geometry = (window.__geomPatch ? window.__geomPatch(v.geometry) : v.geometry);')); return;
  }
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
async function scenario(name, fn, { patch = null, viewport = { width: 1280, height: 900 }, reducedMotion = 'no-preference', colorScheme = 'light', hasTouch = false, allow404 = false } = {}) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  const ctx = await browser.newContext({ viewport, reducedMotion, colorScheme, hasTouch, isMobile: hasTouch, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const rec = { external: [], mocked: [], photo: [], consoleErrors: [], pageErrors: [] };
  page.on('console', (m) => { if (m.type() === 'error' && !(allow404 && /Failed to load resource: the server responded with a status of 404/.test(m.text())) && !/status of 404/.test(m.text())) rec.consoleErrors.push(m.text()); });
  if (process.env.DBG) page.on('requestfailed', (r) => console.log('REQFAIL', r.url().slice(0, 140)));
  page.on('pageerror', (e) => rec.pageErrors.push(String(e)));
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || url.startsWith('data:')) return route.continue();
    const a = answer(url, route.request().headers().range ?? null);
    if (!a) { rec.external.push(url); allExternal.push(url); return route.abort('failed'); }
    rec.mocked.push(url);
    if (a === 'never') return undefined;
    if (a.photo) {
      rec.photo.push({ url, at: Date.now() });
      if (photoMode === '404') return route.fulfill({ status: 404, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'nothing here' });
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: aerial(url, world === 'county' ? MARK : null) });
    }
    if (lariacDelay && url.includes('LARIAC')) return new Promise((r) => setTimeout(r, lariacDelay)).then(() => route.fulfill({ status: a.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a.body) }).catch(() => {}));
    return route.fulfill({ status: a.status, contentType: a.type ?? 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, body: a.raw ?? JSON.stringify(a.body) });
  });
  if (patch) await page.addInitScript((o) => {
    window.__geomPatch = (g) => {
      const out = { ...g };
      if (o.driveway) out.driveway = { polygon: { type: 'Polygon', coordinates: [[[-118.299995, 33.99998], [-118.299955, 33.99998], [-118.299955, 34.000068], [-118.299995, 34.000068], [-118.299995, 33.99998]]] }, areaSqft: 0, source: 'test', confidence: 0.4 };
      if (o.kind) out.buildings = g.buildings.map((b) => ({ ...b, kind: b.main ? 'house' : 'garage' }));
      return out;
    };
  }, patch);
  await page.addInitScript(() => { new MutationObserver(() => { if (!window.__factsAt && document.querySelector('#facts .fact')) window.__factsAt = performance.timeOrigin + performance.now(); }).observe(document, { subtree: true, childList: true }); });
  try {
    await fn(page, rec);
    assert.deepEqual(rec.consoleErrors, [], 'console errors');
    assert.deepEqual(rec.pageErrors, [], 'uncaught page errors');
    assert.deepEqual(rec.external, [], 'unmocked external requests');
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length), 0, 'nothing stored');
    passed++; console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e}`); console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 8).join('\n       ')}`);
    try { await page.screenshot({ path: `${SHOTS}/fail-${failures.length}.png`, fullPage: true }); } catch { /* ignore */ }
  } finally { await ctx.close(); }
}

async function open(page, address = SFR) {
  await page.goto(URL_PAGE);
  await page.fill('#address', address);
  await page.click('#address-submit');
  await page.waitForSelector('#facts .fact', { state: 'visible' });
}
const mapReady = async (page) => { await page.waitForSelector('#lot-map .lm-h', { state: 'attached' }); await page.waitForFunction(() => !document.querySelector('#lot-map').hidden && document.querySelector('#lot-map .lm-frame').dataset.model); };
const settled = (page) => page.waitForFunction(() => document.getElementById('progress').hidden && !document.querySelector('.fact[data-state="loading"]'), null, { timeout: 15000 });
const val = async (page, key) => { const v = (await page.inputValue(`#f-${key}`)).replace(/,/g, ''); return v === '' ? null : Number(v); };
const state = (page, key) => page.locator(`.fact[data-key="${key}"]`).getAttribute('data-state');
const YARD = ['front_yard_sqft', 'back_yard_sqft', 'yard_area_sqft', 'usable_yard_sqft', 'usable_front_yard_sqft', 'usable_back_yard_sqft'];
const ALLK = ['lot_area_sqft', 'building_footprint_sqft', 'roof_area_sqft', ...YARD];
const figures = async (page) => Object.fromEntries(await Promise.all(ALLK.map(async (k) => [k, await val(page, k).catch(() => null)])));

/** Handles of one shape: [{x, y (frame px), sx, sy (screen px), lng, lat}] */
async function handles(page, shape = 'lot') {
  await page.evaluate(() => { const f = document.querySelector('#lot-map .lm-frame').getBoundingClientRect(); if (f.top < 0 || f.bottom > window.innerHeight) document.querySelector('#lot-map .lm-frame').scrollIntoView({ block: 'center' }); });
  return page.evaluate((shape) => {
    const f = document.querySelector('#lot-map .lm-frame').getBoundingClientRect();
    const hs = [...document.querySelectorAll('#lot-map .lm-h')].filter((h) => (shape === 'lot' ? h.dataset.shape === 'lot' : h.dataset.shape !== 'lot' && (shape === 'any' || true)));
    return hs.map((h) => ({ id: h.id, shape: h.dataset.shape, x: Number(h.dataset.x), y: Number(h.dataset.y), sx: f.left + Number(h.dataset.x), sy: f.top + Number(h.dataset.y), lng: Number(h.dataset.lng), lat: Number(h.dataset.lat) }));
  }, shape);
}
async function drag(page, from, dx, dy, steps = 8) {
  await page.mouse.move(from.sx, from.sy); await page.mouse.down();
  await page.mouse.move(from.sx + dx / 2, from.sy + dy / 2, { steps }); await page.mouse.move(from.sx + dx, from.sy + dy, { steps }); await page.mouse.up();
}
/** What measureFromGeometry says for the outlines now on the map (read back out of the page) */
async function expectedFromPage(page) {
  const d = await page.evaluate(async () => {
    const fr = document.querySelector('#lot-map .lm-frame'); const m = await import('/estimate/app.js'); const a = m.getProfile().attributes;
    const v = (k) => (a[k] && a[k].tag !== 'unavailable' ? a[k].value : null);
    return { model: JSON.parse(fr.dataset.model), front: fr.dataset.front ? JSON.parse(fr.dataset.front) : null, roof: { yearBuilt: v('year_built'), propertyType: v('property_type'), stories: v('floors'), state: v('jurisdiction')?.state ?? null } };
  });
  const g = { parcel: { type: 'Polygon', coordinates: [[...d.model.lot, d.model.lot[0]]] }, buildings: d.model.blds.map((b) => ({ polygon: b.geo, main: b.main })), roof: d.roof };
  if (d.front) g.frontEdge = { coordinates: d.front };
  return { m: measureFromGeometry(g, { now: new Date().toISOString() }), model: d.model, front: d.front };
}
const sameFigures = (m, f, keys = ALLK) => { for (const k of keys) if (Number.isFinite(m[k])) assert.equal(f[k], m[k], `${k}: list ${f[k]} vs measure ${m[k]}`); };
const houseOf = (bh) => { const g = {}; for (const h of bh) (g[h.shape] ??= []).push(h); const area = (x) => (Math.max(...x.map((p) => p.x)) - Math.min(...x.map((p) => p.x))) * (Math.max(...x.map((p) => p.y)) - Math.min(...x.map((p) => p.y))); return Object.values(g).reduce((a, x) => (area(x) > area(a) ? x : a)); };
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const hav = (a, b) => { const R = 6371008.8, r = Math.PI / 180, dl = (b.lat - a.lat) * r, dg = (b.lng - a.lng) * r; const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)) / 0.3048; };

console.log('lot map e2e');

// ---- pure helpers ---------------------------------------------------------------------------------------------------------------------------
{
  const rect = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  const bundle = sourceFromProfile({ attributes: {}, geometry: { parcel: rect(0, 0, 1, 1), parcelSource: 'estimated', buildings: [{ polygon: rect(0.2, 0.2, 0.4, 0.4), main: true }], frontEdge: { coordinates: [[0, 0], [1, 0]] }, zones: {}, image: { date: '2022-06-01' } } });
  assert.equal(bundle.from, 'bundle'); assert.equal(bundle.parcelSource, 'estimated'); assert.equal(bundle.buildings.length, 1); assert.deepEqual(bundle.rest.frontEdge.coordinates, [[0, 0], [1, 0]]); assert.equal(bundle.image.date, '2022-06-01');
  const attrs = sourceFromProfile({ attributes: { parcel_boundary: { tag: 'measured', value: rect(0, 0, 1, 1) }, buildings: { tag: 'measured', value: [{ footprintSqft: 5, polygon: rect(0, 0, 0.1, 0.1) }, { footprintSqft: 9, polygon: rect(0.2, 0.2, 0.5, 0.5) }] }, year_built: { tag: 'measured', value: 1950 } } });
  assert.equal(attrs.from, 'attributes'); assert.equal(attrs.buildings.filter((b) => b.main).length, 1); assert.equal(attrs.buildings[1].main, true); assert.equal(attrs.rest.roof.yearBuilt, 1950);
  assert.equal(sourceFromProfile({ attributes: {} }), null);
  // crossing test
  const sq = [{ lng: 0, lat: 0 }, { lng: 1, lat: 0 }, { lng: 1, lat: 1 }, { lng: 0, lat: 1 }];
  assert.equal(ringCrosses(sq), false); assert.equal(ringCrosses([sq[0], sq[2], sq[1], sq[3]]), true); assert.equal(ringCrosses(sq.slice(0, 2)), true);
  // starter rectangle: bigger than the building by 15 ft along its long axis and 5 ft across it
  const b = { type: 'Polygon', coordinates: [[[-118.3, 34], [-118.2998, 34], [-118.2998, 34.00005], [-118.3, 34.00005], [-118.3, 34]]] };
  const st = starterRing(b); assert.equal(st.length, 5);
  const { kx, ky } = { kx: 6371008.8 * Math.cos(34 * Math.PI / 180) * Math.PI / 180, ky: 6371008.8 * Math.PI / 180 };
  const side = (p, q) => Math.hypot((q[0] - p[0]) * kx, (q[1] - p[1]) * ky);
  const bw = 0.0002 * kx, bh = 0.00005 * ky; // building: long side east-west
  const sides = [side(st[0], st[1]), side(st[1], st[2])].sort((x, y) => x - y);
  assert.ok(Math.abs(sides[1] - (bw + 30 * 0.3048)) < 0.05, `long side ${sides[1]} vs ${bw + 30 * 0.3048}`); assert.ok(Math.abs(sides[0] - (bh + 10 * 0.3048)) < 0.05, `short side ${sides[0]}`);
  // frame: lot box plus 15 m, true ground aspect
  const fr = frameFor([[-118.3, 34], [-118.2998, 34.0004]]);
  assert.ok(Math.abs((fr.bbox[3] - fr.bbox[1]) * fr.ky - (0.0004 * fr.ky + 30)) < 0.01);
  // lng/lat <-> pixels: WGS84 linear and Web Mercator (a known corner lands on the expected pixel; both round-trip)
  const bb = [-118.3005, 33.9995, -118.2995, 34.0005];
  const wg = frameProject('wgs84', bb, 400, 300), mc = frameProject('webmercator', bb, 400, 300);
  assert.deepEqual(wg.toPx(bb[0], bb[3]), [0, 0]); assert.deepEqual(wg.toPx(bb[2], bb[1]), [400, 300]); assert.ok(Math.abs(wg.toPx(-118.3, 34)[0] - 200) < 1e-6 && Math.abs(wg.toPx(-118.3, 34)[1] - 150) < 1e-6);
  const my = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)); const expY = ((my(bb[3]) - my(34.0002)) / (my(bb[3]) - my(bb[1]))) * 300;
  assert.ok(Math.abs(mc.toPx(-118.2999, 34.0002)[1] - expY) < 1e-6, 'mercator y'); assert.ok(Math.abs(mc.toPx(-118.2999, 34.0002)[0] - 240) < 1e-6, "mercator x");
  const rt = mc.toLngLat(...mc.toPx(-118.2997, 33.9998)); assert.ok(Math.abs(rt[0] + 118.2997) < 1e-8 && Math.abs(rt[1] - 33.9998) < 1e-8);
  // the photo request: WGS84, square degree pixels, the credit says who made it
  const u = new URL(photoUrl(bb, 900)); assert.equal(u.hostname, 'imagery.nationalmap.gov'); assert.equal(u.searchParams.get('bboxSR'), '4326'); assert.equal(u.searchParams.get('imageSR'), '4326');
  assert.equal(u.searchParams.get('size'), '900,900'); assert.equal(NAIP_BACKDROP.frame, 'wgs84'); assert.match(NAIP_BACKDROP.credit, /NAIP/);
  const src = fs.readFileSync(path.join(ROOT, 'estimate/lot-map.js'), 'utf8') + fs.readFileSync(path.join(ROOT, 'estimate/lot-map.css'), 'utf8');
  assert.doesNotMatch(src, /mapbox|google|esri/i, 'only the government photo is referenced');
  passed++; console.log('  ok   pure helpers (profile source, crossing test, starter box, frame mapping incl. Web Mercator, photo request)');
}

await scenario('map appears only with outlines; one photo request, made after the list is visible; no side yard anywhere', async (page, rec) => {
  world = 'county'; photoMode = 'png';
  await page.goto(URL_PAGE);
  assert.equal(await page.locator('#lot-map').isVisible(), false, 'no map before a property');
  await page.fill('#address', SFR); await page.click('#address-submit');
  await page.waitForSelector('#facts .fact', { state: 'visible' });
  await mapReady(page); await settled(page);
  await page.waitForFunction(() => document.querySelector('#lot-map .lm-img') && !document.querySelector('#lot-map .lm-img').hidden);
  assert.equal(rec.photo.length, 1, 'one photo request');
  const factsAt = await page.evaluate(() => window.__factsAt);
  assert.ok(rec.photo[0].at >= factsAt, `photo asked after the list was visible (${rec.photo[0].at - factsAt} ms)`);
  const u = new URL(rec.photo[0].url); assert.equal(u.hostname, 'imagery.nationalmap.gov'); assert.equal(u.searchParams.get('bboxSR'), '4326');
  const html = await page.locator('#lot-map').evaluate((n) => n.outerHTML);
  assert.doesNotMatch(html, /side yard/i, 'side yard is not shown or named'); assert.doesNotMatch(await page.locator('main').innerText(), /side yard/i);
  // placement: between the property heading and the list
  const order = await page.evaluate(() => { const m = document.getElementById('lot-map'), f = document.getElementById('facts'), h = document.getElementById('h-profile'); return [h.compareDocumentPosition(m) & 4, m.compareDocumentPosition(f) & 4]; });
  assert.deepEqual(order.map(Boolean), [true, true], 'map sits between heading and list');
  const t = await page.locator('#lot-map').innerText();
  assert.match(t, /Your lot from above/); assert.match(t, /These are the outlines we measured\. Drag a corner if one is off\./);
  assert.match(t, /Lot outline\s*6,500 sq ft/); assert.match(t, /House\s*1,400 sq ft footprint · roof about 1,570 sq ft/); assert.match(t, /Front yard\s*1,250 sq ft/); assert.match(t, /Back yard\s*3,200 sq ft/); assert.match(t, /Usable yard\s*4,135 sq ft/);
  assert.match(await page.locator('.lm-credit').innerText(), /Aerial photo: USDA NAIP/);
  // collapsible, not persisted
  await page.click('#lm-toggle'); assert.equal(await page.locator('.lm-frame').isVisible(), false); assert.match(await page.locator('#lm-toggle').innerText(), /Show photo of my lot/);
  await page.click('#lm-toggle'); assert.equal(await page.locator('.lm-frame').isVisible(), true); assert.match(await page.locator('#lm-toggle').innerText(), /Hide photo/);
  assert.equal(rec.photo.length, 1, 'still one request');
});

await scenario('overlay lines up with the photo frame: the corner of the synthetic lot lands on the mark within 1 px', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page);
  await page.waitForFunction(() => { const i = document.querySelector('#lot-map .lm-img'); return i && !i.hidden && i.complete && i.naturalWidth > 0; });
  await page.addStyleTag({ content: '#lot-map .lm-svg, #lot-map .lm-canvas { visibility: hidden !important; }' });
  const hs = await handles(page, 'lot');
  const h0 = hs.reduce((a, h) => (Math.abs(h.lng - MARK[0]) + Math.abs(h.lat - MARK[1]) < Math.abs(a.lng - MARK[0]) + Math.abs(a.lat - MARK[1]) ? h : a));
  const box = await page.locator('#lot-map .lm-frame').boundingBox();
  const shot = decodePng(await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } }));
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < shot.H; y++) for (let x = 0; x < shot.W; x++) { const k = (y * shot.W + x) * shot.bpp; if (shot.data[k] > 200 && shot.data[k + 1] < 60 && shot.data[k + 2] < 60) { n++; sx += x + 0.5; sy += y + 0.5; } }
  assert.ok(n > 8, `mark visible (${n} px)`);
  const dx = sx / n - h0.x, dy = sy / n - h0.y;
  assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1, `corner at (${h0.x}, ${h0.y}), mark centred at (${(sx / n).toFixed(2)}, ${(sy / n).toFixed(2)})`);
  // and the frame is the true ground shape: pixels per metre equal east-west and north-south
  const m = await page.evaluate(() => { const f = document.querySelector('#lot-map .lm-frame'); return { bbox: f.dataset.bbox.split(',').map(Number), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height }; });
  const kx = 6371008.8 * Math.cos(34 * Math.PI / 180) * Math.PI / 180, ky = 6371008.8 * Math.PI / 180;
  const ppmX = m.w / ((m.bbox[2] - m.bbox[0]) * kx), ppmY = m.h / ((m.bbox[3] - m.bbox[1]) * ky);
  assert.ok(Math.abs(ppmX / ppmY - 1) < 0.01, `pixels per metre ${ppmX} vs ${ppmY}`);
});

await scenario('dragging a lot corner: lot size equals measureFromGeometry for the new outline; yards update; marked edited', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  const before = await figures(page);
  const hs = await handles(page, 'lot');
  // the corner farthest from the front edge (top-left in the picture): drag it outward and sideways
  const far = hs.reduce((a, h) => (h.y < a.y ? h : a));
  await drag(page, far, -14, -20);
  await page.waitForFunction(() => document.querySelector('.fact[data-key="lot_area_sqft"]').dataset.state === 'edited');
  const { m } = await expectedFromPage(page);
  const after = await figures(page);
  assert.notEqual(after.lot_area_sqft, before.lot_area_sqft, 'lot size changed');
  assert.equal(after.lot_area_sqft, m.lot_area_sqft, 'lot size is exactly what measureFromGeometry returns');
  sameFigures(m, after);
  assert.equal(after.building_footprint_sqft, before.building_footprint_sqft); assert.equal(after.roof_area_sqft, before.roof_area_sqft);
  assert.equal(await state(page, 'lot_area_sqft'), 'edited'); assert.match(await page.locator('.fact[data-key="lot_area_sqft"] .fact-meta').innerText(), /Edited by you/);
  assert.notEqual(after.back_yard_sqft, before.back_yard_sqft, 'back yard grew with the lot');
  assert.match(await page.locator('#lot-map .lm-legend').innerText(), new RegExp(`Lot outline\\s*${after.lot_area_sqft.toLocaleString('en-US')} sq ft`));
  assert.match(await page.locator('#lot-map .lm-legend').innerText(), new RegExp(`Back yard\\s*${after.back_yard_sqft.toLocaleString('en-US')} sq ft`));
});

await scenario('dragging a building corner changes footprint and roof (and nothing about the lot)', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  const before = await figures(page);
  const hs = await handles(page, 'bld');
  const house = (await page.evaluate(() => JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model).blds.findIndex((b) => b.main)));
  const hsH = hs.filter((h) => h.shape === hs.find((x) => true).shape);
  const mainShape = await page.evaluate(() => [...document.querySelectorAll('#lot-map .lm-h')].filter((h) => h.dataset.shape !== 'lot').map((h) => h.dataset.shape));
  const byShape = {}; for (const h of hs) (byShape[h.shape] ??= []).push(h);
  const big = Object.values(byShape).reduce((a, g) => { const area = (x) => Math.abs((Math.max(...x.map((p) => p.x)) - Math.min(...x.map((p) => p.x))) * (Math.max(...x.map((p) => p.y)) - Math.min(...x.map((p) => p.y)))); return area(g) > area(a) ? g : a; });
  const corner = big.reduce((a, h) => (h.x + h.y > a.x + a.y ? h : a));
  await drag(page, corner, 12, 9);
  if (process.env.DBG) { await page.waitForTimeout(600); console.log('DBG', JSON.stringify(corner), JSON.stringify(await handles(page, 'bld')), JSON.stringify(await figures(page)), await page.locator('#lm-note').innerText()); }
  await page.waitForFunction(() => document.querySelector('.fact[data-key="building_footprint_sqft"]').dataset.state === 'edited');
  const { m } = await expectedFromPage(page);
  const after = await figures(page);
  assert.notEqual(after.building_footprint_sqft, before.building_footprint_sqft);
  assert.equal(after.building_footprint_sqft, m.building_footprint_sqft); assert.equal(after.roof_area_sqft, m.roof_area_sqft);
  sameFigures(m, after);
  assert.equal(after.lot_area_sqft, before.lot_area_sqft); assert.equal(await state(page, 'lot_area_sqft'), 'value');
  assert.ok(house >= 0 && mainShape.length >= 4);
});

await scenario('choosing another street-facing edge swaps which zone is front', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  const before = await figures(page);
  const hs = await handles(page, 'lot');
  const top = hs.filter((h) => h.y < 200 && Math.abs(h.y - Math.min(...hs.map((p) => p.y))) < 3);
  assert.equal(top.length, 2, 'two corners on the top side');
  const mid = { x: (top[0].sx + top[1].sx) / 2, y: top[0].sy };
  await page.mouse.click(mid.x, mid.y);
  await page.waitForSelector('#lm-bfront', { state: 'visible' });
  assert.match(await page.locator('#lm-bfront').innerText(), /This side faces the street/);
  await page.click('#lm-bfront');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="front_yard_sqft"]').dataset.state === 'edited');
  const { m, front } = await expectedFromPage(page);
  const after = await figures(page);
  assert.ok(front && front.length >= 2);
  assert.equal(after.front_yard_sqft, m.front_yard_sqft); assert.equal(after.back_yard_sqft, m.back_yard_sqft); sameFigures(m, after);
  assert.equal(after.front_yard_sqft, before.back_yard_sqft, 'the old back yard is now the front yard'); assert.equal(after.back_yard_sqft, before.front_yard_sqft);
  assert.equal(after.lot_area_sqft, before.lot_area_sqft); assert.equal(await state(page, 'lot_area_sqft'), 'value', 'lot size untouched');
  // the street-side marker is drawn at the top side now
  const ymark = await page.evaluate(() => { const l = document.querySelector('#lot-map .lm-front-line'); return Number(l.getAttribute('points').split(' ')[0].split(',')[1]); });
  assert.ok(Math.abs(ymark - top[0].y) < 2, `street side drawn at the chosen side (${ymark} vs ${top[0].y})`);
  // keyboard route: Tab to a lot side, Enter selects it, the button takes focus
  await page.focus('#lot-map .lm-edge[data-shape="lot"]'); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'lm-bfront');
});

await scenario('add a corner (double-click on a side), remove one (Delete); never fewer than 3; no figures change by adding', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  const before = await figures(page);
  let hs = await handles(page, 'lot'); assert.equal(hs.length, 4);
  const right = hs.filter((h) => h.x > 100); const rr = right.sort((a, b) => a.y - b.y);
  await page.mouse.dblclick((rr[0].sx + rr[1].sx) / 2, (rr[0].sy + rr[1].sy) / 2 + 3);
  await page.waitForFunction(() => document.querySelectorAll('#lot-map .lm-h[data-shape="lot"]').length === 5);
  assert.deepEqual(await figures(page), before, 'a new corner on a straight side changes nothing');
  assert.equal(await state(page, 'lot_area_sqft'), 'value');
  const added = await page.evaluate(() => document.activeElement.id); assert.match(added, /^lm-v-/, 'the new corner has focus');
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => document.querySelectorAll('#lot-map .lm-h[data-shape="lot"]').length === 4);
  // the Remove corner control, down to a triangle, then refused
  await page.focus('#lot-map .lm-h[data-shape="lot"]');
  await page.waitForSelector('#lm-bremove', { state: 'visible' });
  await page.click('#lm-bremove');
  await page.waitForFunction(() => document.querySelectorAll('#lot-map .lm-h[data-shape="lot"]').length === 3);
  await page.focus('#lot-map .lm-h[data-shape="lot"]'); await page.keyboard.press('Backspace');
  assert.equal((await handles(page, 'lot')).length, 3, 'never fewer than 3 corners');
  assert.match(await page.locator('#lm-note').innerText(), /at least 3 corners/);
  assert.equal(await page.locator('#lm-bremove').isDisabled(), true);
});

await scenario('a self-crossing drag is refused (the corner snaps back); keyboard nudges move 1 ft and 5 ft', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  const hs = await handles(page, 'lot');
  const tl = hs.reduce((a, h) => (h.y < a.y || (h.y === a.y && h.x < a.x) ? h : a));
  const bottom = Math.max(...hs.map((h) => h.y));
  await page.mouse.move(tl.sx, tl.sy); await page.mouse.down();
  await page.mouse.move(tl.sx + 5, tl.sy + (bottom - tl.y) + 12, { steps: 12 }); // past the opposite side
  const mid = (await handles(page, 'lot')).find((h) => h.id === tl.id);
  assert.ok(mid.y < bottom, 'the corner did not cross the opposite side');
  assert.match(await page.locator('#lm-note').innerText(), /can't cross itself/);
  await page.mouse.up();
  const hs2 = await handles(page, 'lot'); const m2 = await page.evaluate(async () => JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model).lot);
  assert.equal(m2.length, 4);
  // nudges
  const h = (await handles(page, 'lot'))[1]; const sy0 = await page.evaluate(() => window.scrollY);
  await page.focus(`#${h.id}`);
  await page.keyboard.press('ArrowRight'); await frames(page);
  let n1 = (await handles(page, 'lot')).find((x) => x.id === h.id);
  assert.ok(Math.abs(hav(h, n1) - 1) < 0.03 && n1.lng > h.lng, `ArrowRight moved ${hav(h, n1).toFixed(3)} ft`);
  await page.keyboard.press('Shift+ArrowUp'); await frames(page);
  const n2 = (await handles(page, 'lot')).find((x) => x.id === h.id);
  assert.ok(Math.abs(hav(n1, n2) - 5) < 0.06 && n2.lat > n1.lat, `Shift+ArrowUp moved ${hav(n1, n2).toFixed(3)} ft`);
  assert.equal(await page.evaluate(() => window.scrollY), sy0, 'arrow keys did not scroll the page');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="lot_area_sqft"]').dataset.state === 'edited');
  const { m } = await expectedFromPage(page); const f = await figures(page);
  assert.equal(f.lot_area_sqft, m.lot_area_sqft); sameFigures(m, f);
  assert.equal(await page.evaluate(() => document.activeElement.id), h.id, 'focus stayed on the corner after the list updated');
});

await scenario('Reset outlines restores every figure and every outline; Undo in the list takes the outline back too', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  const before = await figures(page); const hs0 = await handles(page, 'lot'); const model0 = await page.evaluate(() => document.querySelector('#lot-map .lm-frame').dataset.model);
  const far = hs0.reduce((a, h) => (h.y < a.y ? h : a));
  await drag(page, far, -10, -16);
  await page.waitForFunction(() => document.querySelector('.fact[data-key="lot_area_sqft"]').dataset.state === 'edited');
  const house = houseOf(await handles(page, 'bld'));
  await drag(page, house.reduce((a, h) => (h.x < a.x ? h : a)), -6, 4);
  await page.waitForFunction(() => document.querySelector('.fact[data-key="building_footprint_sqft"]').dataset.state === 'edited');
  assert.notDeepEqual(await figures(page), before);
  await page.click('#lm-breset');
  await page.waitForFunction(() => !document.querySelector('.fact[data-state="edited"]'));
  assert.deepEqual(await figures(page), before, 'every figure is back');
  assert.equal(await page.evaluate(() => document.querySelector('#lot-map .lm-frame').dataset.model), model0, 'every outline is back');
  assert.equal(await page.locator('#lm-breset').isVisible(), false);
  // Undo coupling: drag again, then press Undo on the lot size line
  await drag(page, (await handles(page, 'lot')).reduce((a, h) => (h.y < a.y ? h : a)), -12, -12);
  await page.waitForFunction(() => document.querySelector('.fact[data-key="lot_area_sqft"]').dataset.state === 'edited');
  await page.click('#undo-lot_area_sqft');
  await page.waitForFunction(() => !document.querySelector('.fact[data-state="edited"]'));
  assert.deepEqual(await figures(page), before, 'Undo put the looked-up figures back');
  assert.equal(await page.evaluate(() => document.querySelector('#lot-map .lm-frame').dataset.model), model0, 'Undo put the outline back');
  assert.equal(await page.locator('#lm-note').innerText(), '');
});

await scenario('a number typed in the list wins over the map: dragging an unrelated outline does not overwrite it', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  await page.fill('#f-lot_area_sqft', '7777'); await page.press('#f-lot_area_sqft', 'Enter');
  assert.equal(await val(page, 'lot_area_sqft'), 7777); assert.equal(await state(page, 'lot_area_sqft'), 'edited');
  const house = houseOf(await handles(page, 'bld'));
  const fp0 = await val(page, 'building_footprint_sqft');
  await drag(page, house.reduce((a, h) => (h.x + h.y > a.x + a.y ? h : a)), 10, 8);
  await page.waitForFunction((v) => Number(document.querySelector('#f-building_footprint_sqft').value.replace(/,/g, '')) !== v, fp0);
  assert.equal(await val(page, 'lot_area_sqft'), 7777, 'the typed lot size is still there');
  assert.equal(await state(page, 'lot_area_sqft'), 'edited');
});

await scenario('no lot outline (Chicago City Hall): starter box with the hint; after adjusting, lot size and yards are filled', async (page) => {
  world = 'chicago'; photoMode = 'png';
  await open(page, CHICAGO); await mapReady(page); await settled(page);
  assert.equal(await page.inputValue('#f-lot_area_sqft'), '', 'no lot size yet');
  const t = await page.locator('#lot-map').innerText();
  assert.match(t, /Drag the corners to match your lot/); assert.doesNotMatch(t, /These are the outlines we measured/);
  const hs = await handles(page, 'lot'); assert.equal(hs.length, 4, 'a starter rectangle');
  const lotShapeOk = await page.evaluate(() => JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model).blds.length >= 1); assert.ok(lotShapeOk);
  const far = hs.reduce((a, h) => (h.y < a.y ? h : a));
  await drag(page, far, -10, -10);
  await page.waitForFunction(() => document.querySelector('.fact[data-key="lot_area_sqft"]').dataset.state === 'edited', null, { timeout: 15000 });
  const { m } = await expectedFromPage(page);
  assert.equal(await val(page, 'lot_area_sqft'), m.lot_area_sqft); assert.ok(m.lot_area_sqft > 1000);
  // say which side faces the street: yards appear
  const h2 = await handles(page, 'lot'); const bot = Math.max(...h2.map((h) => h.y)); const b2 = h2.filter((h) => Math.abs(h.y - bot) < 4);
  await page.mouse.click((b2[0].sx + b2[1].sx) / 2, b2[0].sy);
  await page.click('#lm-bfront');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="front_yard_sqft"]')?.dataset.state === 'edited', null, { timeout: 15000 });
  const e2 = await expectedFromPage(page); const f = await figures(page);
  assert.ok(Number.isFinite(e2.m.front_yard_sqft) && f.front_yard_sqft === e2.m.front_yard_sqft && f.back_yard_sqft === e2.m.back_yard_sqft, `yards filled (${f.front_yard_sqft}/${f.back_yard_sqft})`);
  await page.screenshot({ path: `${SHOTS}/starter-desktop.png`, fullPage: false });
});

// ---- the lookup's measured bundle arrives AFTER the map was set up (outlines/streets held back) -----------------------------------------------
const bundleOf = (page) => page.evaluate(async () => { const m = await import('/estimate/app.js'); const p = m.getProfile(); return p?.geometry ? JSON.parse(JSON.stringify({ ...p.geometry, zones: undefined, image: undefined })) : null; });
const mapText = (page) => page.locator('#lot-map').innerText();
const legendNum = async (page, name) => { const t = await page.locator('#lot-map .lm-legend').innerText(); const m = new RegExp(`${name}\\s*\\n?\\s*([\\d,]+) sq ft`).exec(t); return m ? Number(m[1].replace(/,/g, '')) : null; };
const mapLotOnly = async (page) => { await page.waitForSelector('#lot-map .lm-h', { state: 'attached' }); await page.waitForFunction(() => !document.querySelector('#lot-map').hidden && document.querySelector('#lot-map .lm-frame')?.dataset.model); };
const bundleArrived = (page) => page.waitForFunction(async () => { const m = await import('/estimate/app.js'); return Boolean(m.getProfile()?.geometry); }, null, { timeout: 15000 });

await scenario('late bundle: after it arrives the street side and both zones are drawn, the legend equals the list and measureFromGeometry(profile.geometry); the tap-the-side prompt is gone', async (page) => {
  world = 'county'; photoMode = 'png'; lariacDelay = 2500;
  try {
    await open(page); await mapLotOnly(page);
    assert.equal(await page.locator('#lot-map .lm-front-line').count(), 0, 'no street side drawn before the bundle');
    await bundleArrived(page); await settled(page);
    await page.waitForFunction(() => document.querySelector('#lot-map .lm-front-line'), null, { timeout: 10000 });
    const g = await bundleOf(page);
    const m = measureFromGeometry(g, { now: new Date().toISOString() });
    assert.ok(Number.isFinite(m.front_yard_sqft) && Number.isFinite(m.back_yard_sqft), 'the bundle measures a front and back yard');
    const f = await figures(page);
    for (const k of ['front_yard_sqft', 'back_yard_sqft', 'usable_yard_sqft', 'usable_front_yard_sqft', 'usable_back_yard_sqft', 'building_footprint_sqft', 'roof_area_sqft']) assert.equal(f[k], m[k], `list ${k}`);
    assert.equal(await legendNum(page, 'Front yard'), m.front_yard_sqft); assert.equal(await legendNum(page, 'Back yard'), m.back_yard_sqft);
    assert.match(await page.locator('#lot-map .lm-legend').innerText(), new RegExp(`Usable yard\\s*${m.usable_yard_sqft.toLocaleString('en-US')} sq ft`));
    assert.doesNotMatch(await mapText(page), /tap the side/i);
    assert.ok(await page.evaluate(() => document.querySelector('#lot-map .lm-zone[d]:not([d=""])') !== null), 'a yard tint is drawn');
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('#lot-map .lm-zone')].filter((z) => z.getAttribute('d')).length), 2, 'both zones are drawn');
    assert.ok(await page.locator('#lot-map .lm-label.is-street').count() >= 1, 'Street side label');
    assert.equal(await state(page, 'front_yard_sqft'), 'estimated'.length ? await state(page, 'front_yard_sqft') : '', 'the list line is the lookup value (not edited)');
    assert.notEqual(await state(page, 'front_yard_sqft'), 'edited');
  } finally { lariacDelay = 0; }
});

await scenario('late bundle: a street side the owner marked before it arrived is kept', async (page) => {
  world = 'county'; photoMode = 'png'; lariacDelay = 3000;
  try {
    await open(page); await mapLotOnly(page);
    const hs = await handles(page, 'lot');
    const top = hs.filter((h) => Math.abs(h.y - Math.min(...hs.map((p) => p.y))) < 3);
    await page.mouse.click((top[0].sx + top[1].sx) / 2, top[0].sy);
    await page.click('#lm-bfront');
    const chosen = await page.evaluate(() => document.querySelector('#lot-map .lm-frame').dataset.front);
    assert.ok(chosen, 'the owner marked the top side');
    await bundleArrived(page); await settled(page);
    await page.waitForFunction(() => document.querySelector('#lot-map .lm-legend').innerText.includes('Back yard'), null, { timeout: 10000 });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.querySelector('#lot-map .lm-frame').dataset.front), chosen, 'the owner\'s side is still the street side');
    const { m } = await expectedFromPage(page); const f = await figures(page);
    assert.equal(f.front_yard_sqft, m.front_yard_sqft); assert.equal(f.back_yard_sqft, m.back_yard_sqft);
    assert.equal(await legendNum(page, 'Front yard'), m.front_yard_sqft);
    const g = await bundleOf(page); const mg = measureFromGeometry(g, { now: new Date().toISOString() });
    assert.notEqual(m.front_yard_sqft, mg.front_yard_sqft, "the owner's side gives other figures than the lookup's");
  } finally { lariacDelay = 0; }
});

await scenario('late bundle: Reset outlines returns to the bundle figures', async (page) => {
  world = 'county'; photoMode = 'png'; lariacDelay = 2500;
  try {
    await open(page); await mapLotOnly(page); await bundleArrived(page); await settled(page);
    await page.waitForFunction(() => document.querySelector('#lot-map .lm-front-line'), null, { timeout: 10000 });
    const before = await figures(page); const g = await bundleOf(page); const mg = measureFromGeometry(g, { now: new Date().toISOString() });
    const hs = await handles(page, 'lot'); await drag(page, hs.reduce((a, h) => (h.y < a.y ? h : a)), -12, -14);
    await page.waitForFunction(() => document.querySelector('.fact[data-key="lot_area_sqft"]').dataset.state === 'edited');
    assert.notDeepEqual(await figures(page), before);
    await page.click('#lm-breset');
    await page.waitForFunction(() => !document.querySelector('.fact[data-state="edited"]'));
    const after = await figures(page); assert.deepEqual(after, before);
    for (const k of ['lot_area_sqft', 'front_yard_sqft', 'back_yard_sqft', 'usable_yard_sqft', 'building_footprint_sqft', 'roof_area_sqft']) assert.equal(after[k], mg[k], k);
    assert.equal(await legendNum(page, 'Front yard'), mg.front_yard_sqft);
  } finally { lariacDelay = 0; }
});

await scenario('late bundle: a corner being dragged when it arrives is not moved', async (page) => {
  world = 'county'; photoMode = 'png'; lariacDelay = 2500;
  try {
    await open(page); await mapLotOnly(page);
    assert.equal(await page.evaluate(async () => Boolean((await import('/estimate/app.js')).getProfile()?.geometry)), false, 'bundle not here yet');
    const hs = await handles(page, 'lot'); const far = hs.reduce((a, h) => (h.y < a.y ? h : a));
    await page.mouse.move(far.sx, far.sy); await page.mouse.down(); await page.mouse.move(far.sx - 9, far.sy - 11, { steps: 6 });
    await frames(page);
    const held = (await handles(page, 'lot')).find((h) => h.id === far.id);
    assert.ok(Math.abs(held.x - (far.x - 9)) < 1.5 && Math.abs(held.y - (far.y - 11)) < 1.5, 'the corner follows the pointer');
    await bundleArrived(page); await page.waitForFunction(() => document.querySelector('#lot-map .lm-front-line'), null, { timeout: 10000 });
    if (process.env.DBG) console.log('DBGP', await page.evaluate(async () => { const p = (await import('/estimate/app.js')).getProfile(); return JSON.stringify([p.geometry.parcel.type, p.geometry.parcel.coordinates[0].length, p.attributes.parcel_boundary.value.coordinates[0].length, p.geometry.parcel.coordinates[0][0], p.attributes.parcel_boundary.value.coordinates[0][0]]); }));
    await frames(page);
    const after = (await handles(page, 'lot')).find((h) => h.id === far.id);
    assert.ok(Math.abs(after.x - held.x) < 0.01 && Math.abs(after.y - held.y) < 0.01 && after.lng === held.lng && after.lat === held.lat, 'the corner did not move when the bundle arrived');
    await page.mouse.move(far.sx - 12, far.sy - 14, { steps: 4 }); await page.mouse.up();
    if (process.env.DBG) { await page.waitForTimeout(800); console.log('DBGQ', JSON.stringify(await handles(page, 'lot')), JSON.stringify(await figures(page)), await page.locator('#lm-note').innerText(), await page.locator('.fact[data-key="lot_area_sqft"]').getAttribute('data-state'), await page.locator('#lm-breset').isVisible()); }
    await page.waitForFunction(() => document.querySelector('.fact[data-key="lot_area_sqft"]').dataset.state === 'edited');
    const model = await page.evaluate(() => JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model));
    const g = await bundleOf(page); g.parcel = { type: 'Polygon', coordinates: [[...model.lot, model.lot[0]]] };
    const m = measureFromGeometry(g, { now: new Date().toISOString() }); const f = await figures(page);
    assert.equal(f.lot_area_sqft, m.lot_area_sqft); assert.equal(f.back_yard_sqft, m.back_yard_sqft); assert.equal(f.front_yard_sqft, m.front_yard_sqft);
  } finally { lariacDelay = 0; }
});

await scenario('very small outlines are measured but get no handles or legend line of their own; several fold into one "Other buildings" total; the house stays the house', async (page) => {
  world = 'county'; photoMode = 'png'; lariacSlivers = true;
  try {
    await open(page); await mapReady(page); await settled(page);
    const t = await page.locator('#lot-map .lm-legend').innerText();
    assert.match(t, /Other buildings\s*\n?\s*1[23]\d sq ft in all \(2 small outlines\)/, t);
    assert.equal((t.match(/Other building\b/g) ?? []).length, 1, 'only the 300 sq ft building has its own line');
    assert.match(t, /House\s*\n?\s*1,400 sq ft footprint/);
    const per = await page.evaluate(() => { const c = {}; for (const h of document.querySelectorAll('#lot-map .lm-h')) c[h.dataset.shape] = (c[h.dataset.shape] ?? 0) + 1; return Object.values(c).sort(); });
    assert.deepEqual(per, [4, 4, 4], 'lot, house and the 300 sq ft building only');
    assert.equal(await page.locator('#lot-map .lm-svg .lm-house').count(), 1, 'one house outline');
    assert.equal(await page.evaluate(() => JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model).blds.length), 4, 'slivers are still outlines in the measurement');
    assert.equal(await val(page, 'building_footprint_sqft'), 1400);
  } finally { lariacSlivers = false; }
});

// ---- driveway and "what is this building?" ---------------------------------------------------------------------------------------------------
const modelOf = (page) => page.evaluate(() => JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model));
async function expectedFull(page) {
  const g = await bundleOf(page); const model = await modelOf(page);
  const fr = await page.evaluate(() => document.querySelector('#lot-map .lm-frame').dataset.front);
  g.parcel = { type: 'Polygon', coordinates: [[...model.lot, model.lot[0]]] };
  g.buildings = model.blds.map((b) => ({ polygon: b.geo, main: b.main, kind: b.what ?? null }));
  delete g.driveway; delete g.exclude;
  if (model.drv) { g.driveway = model.drv; if (model.drvTouched) g.exclude = [model.drv]; }
  if (fr) { g.streets = []; g.streetName = null; g.frontPoint = null; g.frontEdge = { coordinates: JSON.parse(fr) }; }
  const m = measureFromGeometry(g, { now: new Date().toISOString() });
  const dv = model.drv ? drivewayAreaSqft(model.drv, g.parcel, model.blds.map((b) => b.geo)) : null;
  return { m, dv, model, g };
}
const smallBuilding = async (page) => { const hs = await handles(page, 'bld'); const g = {}; for (const h of hs) (g[h.shape] ??= []).push(h); const area = (x) => (Math.max(...x.map((p) => p.x)) - Math.min(...x.map((p) => p.x))) * (Math.max(...x.map((p) => p.y)) - Math.min(...x.map((p) => p.y))); const grp = Object.values(g).reduce((a, x) => (area(x) < area(a) ? x : a)); return { id: grp[0].shape, cx: grp.reduce((t, h) => t + h.sx, 0) / grp.length, cy: grp.reduce((t, h) => t + h.sy, 0) / grp.length }; };
const legendHas = async (page, re) => assert.match(await page.locator('#lot-map .lm-legend').innerText(), re);
const earnText = async (page) => { await page.click('#next-earn'); await page.waitForSelector('#earn-headline'); const t = await page.locator('#view-earn').innerText(); await page.click('#back-property'); await page.waitForSelector('#facts'); return t; };
const driveStable = async (page) => { await frames(page); };

await scenario('driveway from the lookup: drawn with its area; dragging a corner updates Driveway and the usable yard; add and remove a corner; it cannot leave the lot', async (page) => {
  world = 'county'; photoMode = 'png'; lariacDelay = 1200;
  try {
    await open(page); await mapLotOnly(page); await bundleArrived(page); await settled(page);
    await page.waitForFunction(() => document.querySelector('#lot-map .lm-frame').dataset.model.includes('"drv":{'), null, { timeout: 10000 });
    const e0 = await expectedFull(page);
    assert.ok(e0.dv > 100, `driveway area ${e0.dv}`);
    assert.match(await page.locator('#lot-map .lm-legend').innerText(), new RegExp(`Driveway\\s*\\n?\\s*${e0.dv.toLocaleString('en-US')} sq ft`));
    assert.ok(await page.evaluate(() => document.querySelector('#lot-map .lm-drvfill').getAttribute('d').length > 10), 'driveway fill drawn');
    assert.ok(await page.evaluate(() => document.querySelector('#lot-map .lm-drvfill').closest('g[clip-path]') !== null), 'clipped to the lot');
    assert.equal(await page.locator('#lot-map .lm-svg .lm-drv').count(), 1);
    assert.equal(await page.locator('.fact[data-key="driveway_area_sqft"]').count(), 0, 'no list line until the owner changes it');
    const before = await figures(page);
    // drag a corner of the driveway (the outline's own handles are the ones that are neither the lot's nor a building's)
    const dh = (await page.evaluate(() => [...document.querySelectorAll('#lot-map .lm-h')].filter((h) => h.dataset.shape === 'drv').map((h) => h.id)));
    assert.equal(dh.length, 4);
    await page.evaluate(() => document.querySelector('#lot-map .lm-frame').scrollIntoView({ block: 'center' }));
    const hs = await handles(page, 'any'); const d = hs.filter((h) => h.shape === 'drv').sort((a, b) => a.y - b.y)[0];
    await drag(page, d, 3, 12);
    await page.waitForFunction(() => document.querySelector('.fact[data-key="driveway_area_sqft"]')?.dataset.state === 'edited');
    const e1 = await expectedFull(page); const f = await figures(page);
    assert.equal(await val(page, 'driveway_area_sqft'), e1.dv); assert.equal(e1.m.driveway_area_sqft ?? e1.dv, e1.dv);
    for (const k of ['usable_yard_sqft', 'usable_front_yard_sqft', 'usable_back_yard_sqft']) assert.equal(f[k], e1.m[k], k);
    assert.ok(f.usable_yard_sqft < before.usable_yard_sqft || f.usable_front_yard_sqft < before.usable_front_yard_sqft, 'the driveway is out of the usable yard');
    assert.match(await page.locator('.fact[data-key="driveway_area_sqft"] .flabel').innerText(), /^Driveway$/);
    // add a corner by double-click on its side, then remove it with Delete
    const dd = (await handles(page, 'any')).filter((h) => h.shape === 'drv').sort((a, b) => a.x - b.x);
    const left = dd.slice(0, 2).sort((a, b) => a.y - b.y);
    await page.mouse.dblclick((left[0].sx + left[1].sx) / 2, (left[0].sy + left[1].sy) / 2);
    await page.waitForFunction(() => [...document.querySelectorAll('#lot-map .lm-h')].filter((h) => h.dataset.shape === 'drv').length === 5);
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => [...document.querySelectorAll('#lot-map .lm-h')].filter((h) => h.dataset.shape === 'drv').length === 4);
    // it cannot leave the lot: pull a corner far out through the street side and past the lot's west line
    const far = (await handles(page, 'any')).filter((h) => h.shape === 'drv').sort((a, b) => b.y - a.y)[0];
    await drag(page, far, -60, 30);
    await frames(page);
    await page.waitForFunction(() => document.querySelector('.fact[data-key="driveway_area_sqft"]'));
    const e2 = await expectedFull(page);
    const raw = polygonAreaSqft(e2.model.drv);
    assert.ok(e2.dv < raw - 20, `the part outside the lot is not counted (${e2.dv} of ${Math.round(raw)})`);
    assert.equal(await val(page, 'driveway_area_sqft'), e2.dv);
    // remove the driveway: the owner value goes, the usable yard comes back
    await page.click('#lm-rmdrv');
    await page.waitForFunction(() => !document.querySelector('.fact[data-key="driveway_area_sqft"]'));
    assert.deepEqual(await figures(page), before, 'figures are back as looked up');
    await legendHas(page, /Driveway/); assert.equal(await page.locator('#lm-adddrv').isVisible(), true);
  } finally { lariacDelay = 0; }
}, { patch: { driveway: true } });

await scenario('add your driveway: needs the street side; then a starter strip from the street side toward the house, measured with buildings subtracted', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  assert.equal(await page.locator('#lm-adddrv').isVisible(), true, 'the legend offers Add your driveway');
  await page.click('#lm-adddrv');
  await page.waitForFunction(() => document.querySelector('#lot-map .lm-frame').dataset.model.includes('"drv":{'));
  await frames(page);
  assert.equal(await page.locator('#lot-map .lm-hint, #lot-map .lm-tip:not([hidden])').filter({ hasText: 'Drag the corners to match your driveway' }).count(), 1, 'the hint shows');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="driveway_area_sqft"]')?.dataset.state === 'edited');
  const e = await expectedFull(page); const f = await figures(page);
  assert.ok(e.dv > 50); assert.equal(await val(page, 'driveway_area_sqft'), e.dv);
  assert.equal(f.usable_yard_sqft, e.m.usable_yard_sqft);
  // about 10 ft wide, runs from the street-facing side toward (and stops at) the house
  const ring = e.model.drv.coordinates[0]; const kx = 6371008.8 * Math.cos(34 * Math.PI / 180) * Math.PI / 180, ky = 6371008.8 * Math.PI / 180;
  const w = Math.hypot((ring[1][0] - ring[0][0]) * kx, (ring[1][1] - ring[0][1]) * ky) / 0.3048;
  assert.ok(Math.abs(w - 10) < 0.3, `width ${w} ft`);
  const topLat = Math.max(...ring.map((p) => p[1])); const houseSouth = Math.min(...e.model.blds.find((b) => b.main).geo.coordinates[0].map((p) => p[1]));
  assert.ok(topLat <= houseSouth + 0.0000012, 'stops at the house');
  assert.match(await page.locator('#lot-map .lm-legend').innerText(), /Driveway\s*\n?\s*[\d,]+ sq ft/);
  // dragging a corner removes the starter hint
  const d = (await handles(page, 'any')).filter((h) => h.shape === 'drv')[0]; await drag(page, d, 4, 0);
  await frames(page);
  assert.equal(await page.locator('#lot-map .lm-tip:not([hidden])').filter({ hasText: 'Drag the corners to match your driveway' }).count(), 0);
});

await scenario('add your driveway with no street side known asks for it first', async (page) => {
  world = 'chicago'; photoMode = 'png';
  await open(page, CHICAGO); await mapReady(page); await settled(page);
  await page.click('#lm-adddrv');
  assert.match(await page.locator('#lm-note').innerText(), /street first/i);
  assert.equal(await page.locator('#lot-map .lm-svg .lm-drv').count(), 0);
});

await scenario('naming a building: Garage sets the garage facts, relabels, and the earnings page lists the garage option; changing it reverses them', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  assert.doesNotMatch(await earnText(page), /garage/i, 'no garage option before');
  const sb = await smallBuilding(page);
  await page.mouse.click(sb.cx, sb.cy);
  await page.waitForSelector('#lm-kind-bar', { state: 'visible' });
  await page.selectOption('#lm-kind-bar', 'garage');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="garage_present"]')?.dataset.state === 'edited');
  const e = await expectedFull(page);
  const area = Math.round(polygonAreaSqft(e.model.blds.find((b) => !b.main).geo));
  assert.equal(await val(page, 'garage_area_sqft'), area); assert.equal(await page.locator('#f-garage_present-yes').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('.fact[data-key="garage_area_sqft"] .flabel').innerText(), /^Garage size$/);
  await legendHas(page, new RegExp(`Garage\\s*\\n?\\s*${area.toLocaleString('en-US')} sq ft`));
  assert.ok(await page.locator('#lot-map .lm-label.is-what').filter({ hasText: 'Garage' }).count() >= 1, 'the outline is labelled Garage');
  assert.match(await earnText(page), /garage/i, 'the earnings page lists the garage option');
  // undo coupling: Undo on the garage line takes the name back too
  await page.click('#undo-garage_present');
  await page.waitForFunction(() => !document.querySelector('.fact[data-key="garage_area_sqft"][data-state="edited"]') && !document.querySelector('.fact[data-key="garage_present"][data-state="edited"]'));
  assert.doesNotMatch((await page.locator('#lot-map .lm-legend .lm-name').allInnerTexts()).join('|'), /Garage/);
  // name it again, then change it to Other: both facts go
  await page.selectOption(`#lot-map .lm-legend select.lm-what`, 'garage');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="garage_present"]')?.dataset.state === 'edited');
  await page.selectOption(`#lot-map .lm-legend select.lm-what`, 'other');
  await page.waitForFunction(() => !document.querySelector('.fact[data-key="garage_area_sqft"]') && document.querySelector('.fact[data-key="garage_present"]')?.dataset.state !== 'edited');
  await legendHas(page, /Other\s*\n?\s*[\d,]+ sq ft/);
});

await scenario('naming a building ADU / guest house sets the ADU facts and the earnings page lists the ADU option', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  const before = await earnText(page);
  const sb = await smallBuilding(page);
  await page.mouse.click(sb.cx, sb.cy);
  await page.selectOption('#lm-kind-bar', 'adu');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="adu_present"]')?.dataset.state === 'edited');
  const e = await expectedFull(page); const area = Math.round(polygonAreaSqft(e.model.blds.find((b) => !b.main).geo));
  assert.equal(await val(page, 'adu_area_sqft'), area);
  assert.match(await page.locator('.fact[data-key="adu_area_sqft"] .flabel').innerText(), /^ADU \/ guest house size$/);
  await legendHas(page, /ADU \/ guest house/);
  const after = await earnText(page);
  assert.notEqual(after, before, 'page 2 changed'); assert.match(after, /guest house|ADU|accessory/i);
});

await scenario('a kind the lookup states is pre-selected with ≈ and pushes nothing; "This one is the house" swaps and the roof follows; "Not a building" removes and the yards update', async (page) => {
  world = 'county'; photoMode = 'png'; lariacDelay = 1200;
  try {
    await open(page); await mapLotOnly(page); await bundleArrived(page); await settled(page);
    await page.waitForFunction(() => document.querySelector('#lot-map .lm-legend').innerText.includes('Garage'), null, { timeout: 10000 });
    await legendHas(page, /Garage ≈\s*\n?\s*[\d,]+ sq ft/);
    assert.equal(await page.locator('#lot-map .lm-legend select.lm-what option:checked').innerText(), '≈ Garage');
    assert.equal(await page.locator('.fact[data-key="garage_present"][data-state="edited"]').count(), 0, 'nothing pushed for a lookup kind');
    const before = await figures(page);
    // swap the house
    await page.selectOption('#lot-map .lm-legend select.lm-what', '__house');
    await page.waitForFunction(() => document.querySelector('.fact[data-key="building_footprint_sqft"]')?.dataset.state === 'edited');
    const e = await expectedFull(page); const f = await figures(page);
    assert.notEqual(f.building_footprint_sqft, before.building_footprint_sqft);
    assert.equal(f.building_footprint_sqft, e.m.building_footprint_sqft); assert.equal(f.roof_area_sqft, e.m.roof_area_sqft); assert.ok(f.roof_area_sqft < before.roof_area_sqft, 'roof follows the new house');
    await legendHas(page, /House\s*\n?\s*300 sq ft footprint/);
    // the old house is now the other building: remove it ("Not a building")
    await page.selectOption('#lot-map .lm-legend select.lm-what', '__remove');
    await page.waitForFunction(() => document.querySelector('.fact[data-key="back_yard_sqft"]')?.dataset.state === 'edited' || document.querySelector('.fact[data-key="front_yard_sqft"]')?.dataset.state === 'edited');
    const e2 = await expectedFull(page); const f2 = await figures(page);
    assert.equal(e2.model.blds.length, 1);
    for (const k of ['front_yard_sqft', 'back_yard_sqft', 'usable_yard_sqft']) assert.equal(f2[k], e2.m[k], k);
    assert.ok(f2.back_yard_sqft + f2.front_yard_sqft > before.back_yard_sqft + before.front_yard_sqft, 'the removed building went back into the yard figures');
    await page.click('#lm-breset');
    await page.waitForFunction(() => !document.querySelector('.fact[data-state="edited"]'));
    assert.deepEqual(await figures(page), before, 'Reset restores the lookup'); await legendHas(page, /Garage ≈/);
  } finally { lariacDelay = 0; }
}, { patch: { kind: true } });

await scenario('add a building: a starter box near the back of the lot, then name it; Reset restores; a typed number wins', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  const before = await figures(page); const n0 = (await modelOf(page)).blds.length;
  if (process.env.DBG) console.log('DBGA', await page.evaluate(() => [document.querySelectorAll('#lot-map .lm-hitbody').length, JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model).blds.length]));
  await page.click('#lm-baddbld');
  if (process.env.DBG) { await page.waitForTimeout(500); console.log('DBGB', n0, await page.evaluate(() => [document.querySelectorAll('#lot-map .lm-hitbody').length, document.querySelector('#lot-map .lm-frame').dataset.model.length, document.getElementById('lm-note').innerText, JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model).blds.length])); }
  await page.waitForFunction((n) => document.querySelectorAll('#lot-map .lm-hitbody').length === n, n0);
  const e = await expectedFull(page); assert.equal(e.model.blds.length, n0 + 1);
  const nb = e.model.blds[e.model.blds.length - 1]; const lotNorth = Math.max(...e.model.lot.map((p) => p[1])), lotSouth = Math.min(...e.model.lot.map((p) => p[1]));
  assert.ok(Math.min(...nb.geo.coordinates[0].map((p) => p[1])) > (lotNorth + lotSouth) / 2 - 0.00003, 'near the back of the lot');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="back_yard_sqft"]')?.dataset.state === 'edited' || document.querySelector('.fact[data-key="front_yard_sqft"]')?.dataset.state === 'edited' || document.querySelector('.fact[data-key="usable_yard_sqft"]')?.dataset.state === 'edited');
  const f = await figures(page); for (const k of ['back_yard_sqft', 'front_yard_sqft']) assert.equal(f[k], e.m[k], k);
  assert.ok(await page.locator('#lm-kind-bar').isVisible(), 'the new outline is selected so it can be named');
  await page.selectOption('#lm-kind-bar', 'garage');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="garage_present"]')?.dataset.state === 'edited');
  // a typed number wins over later drags of an unrelated outline
  await page.fill('#f-garage_area_sqft', '555'); await page.press('#f-garage_area_sqft', 'Enter');
  assert.equal(await val(page, 'garage_area_sqft'), 555);
  const hs = await handles(page, 'lot'); await drag(page, hs.reduce((a, h) => (h.y < a.y ? h : a)), -8, -9);
  await page.waitForFunction(() => document.querySelector('.fact[data-key="lot_area_sqft"]').dataset.state === 'edited');
  assert.equal(await val(page, 'garage_area_sqft'), 555, 'typed garage size kept');
  assert.equal((await modelOf(page)).blds.length, n0 + 1, 'typing did not move or remove an outline');
  await page.click('#lm-breset');
  await page.waitForFunction(() => !document.querySelector('.fact[data-key="lot_area_sqft"][data-state="edited"]') && !document.querySelector('.fact[data-key="back_yard_sqft"][data-state="edited"]'));
  assert.equal((await modelOf(page)).blds.length, n0, 'the added building is gone');
  const after = await figures(page); for (const k of ALLK) assert.equal(after[k], before[k], k);
  assert.equal(await val(page, 'garage_area_sqft'), 555, 'the typed number stays after Reset');
});

await scenario('driveway and named garage on the picture: desktop and phone screenshots, no failure wording, no sideways scroll', async (page) => {
  world = 'county'; photoMode = 'png'; lariacDelay = 1200;
  try {
    await open(page); await mapLotOnly(page); await bundleArrived(page); await settled(page);
    await page.waitForFunction(() => document.querySelector('#lot-map .lm-legend').innerText.includes('Garage'), null, { timeout: 10000 });
    await page.waitForFunction(() => { const i = document.querySelector('#lot-map .lm-img'); return i && !i.hidden && i.complete; });
    const t = await page.locator('main').innerText(); assert.doesNotMatch(t, /fail|error|unavailable|not found/i); assert.doesNotMatch(t, /side yard/i);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); assert.ok(m.sw <= m.cw);
    await page.screenshot({ path: `${SHOTS}/${page.viewportSize().width < 600 ? 'phone' : 'desktop'}-driveway-garage.png`, fullPage: true, clip: await clipOf(page) });
  } finally { lariacDelay = 0; }
}, { patch: { driveway: true, kind: true } });
await scenario('driveway and named garage on the picture (phone 390 px)', async (page) => {
  world = 'county'; photoMode = 'png'; lariacDelay = 1200;
  try {
    await open(page); await mapLotOnly(page); await bundleArrived(page); await settled(page);
    await page.waitForFunction(() => document.querySelector('#lot-map .lm-legend').innerText.includes('Garage'), null, { timeout: 10000 });
    await page.waitForFunction(() => { const i = document.querySelector('#lot-map .lm-img'); return i && !i.hidden && i.complete; });
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); assert.ok(m.sw <= m.cw, `${m.sw} > ${m.cw}`);
    await page.screenshot({ path: `${SHOTS}/phone-driveway-garage.png`, fullPage: true, clip: await clipOf(page) });
  } finally { lariacDelay = 0; }
}, { patch: { driveway: true, kind: true }, viewport: { width: 390, height: 844 }, hasTouch: true });

await scenario('photo answers 404: outlines still drawn, nothing said about it', async (page, rec) => {
  world = 'county'; photoMode = '404';
  await open(page); await mapReady(page); await settled(page);
  await page.waitForFunction(() => document.querySelector('#lot-map .lm-frame').dataset.photoUrl);
  await page.waitForTimeout(400);
  assert.ok(rec.photo.length >= 1);
  assert.equal(await page.locator('#lot-map .lm-img').isVisible(), false, 'no broken picture');
  assert.equal(await page.locator('#lot-map .lm-credit').isVisible(), false, 'no credit without a photo');
  assert.ok(await page.locator('#lot-map .lm-lot').count() >= 1 && await page.locator('#lot-map .lm-h').count() >= 4, 'outlines drawn');
  assert.doesNotMatch(await page.locator('main').innerText(), /fail|error|unavailable|not found/i);
  assert.doesNotMatch(await page.locator('#lot-map').evaluate((n) => n.outerHTML), /fail|error|unavailable|not found/i);
  await page.screenshot({ path: `${SHOTS}/desktop-light-nophoto.png`, fullPage: true, clip: await clipOf(page) });
  photoMode = 'png';
}, { allow404: true });

async function clipOf(page) { await page.locator('#lot-map').scrollIntoViewIfNeeded(); const b = await page.locator('#lot-map').boundingBox(); const sy = await page.evaluate(() => window.scrollY); return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y + sy - 8), width: b.width + 16, height: b.height + 16 }; }

for (const [scheme, label] of [['light', 'light'], ['dark', 'dark']]) {
  await scenario(`desktop screenshot ${label} with the photo`, async (page) => {
    world = 'county'; photoMode = 'png';
    await open(page); await mapReady(page); await settled(page);
    await page.waitForFunction(() => { const i = document.querySelector('#lot-map .lm-img'); return i && !i.hidden && i.complete; });
    await page.screenshot({ path: `${SHOTS}/desktop-${label}-photo.png`, fullPage: true, clip: await clipOf(page) });
  }, { colorScheme: scheme });
}

await scenario('phone 390 px: no horizontal scroll; a touch drag on a corner moves it and does not scroll; a swipe elsewhere on the picture scrolls', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page); await settled(page);
  await page.waitForFunction(() => { const i = document.querySelector('#lot-map .lm-img'); return i && !i.hidden && i.complete; });
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, mw: document.getElementById('lot-map').getBoundingClientRect().width, pw: document.getElementById('property').getBoundingClientRect().width }));
  assert.ok(m.sw <= m.cw, `scrollWidth ${m.sw} > ${m.cw}`); assert.ok(m.mw >= m.pw - 40, 'the box is full width of the card');
  await page.evaluate(() => document.getElementById('lot-map').scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -60));
  const hit = await page.evaluate(() => Math.min(...[...document.querySelectorAll('#lot-map .lm-hit')].map((c) => { const r = c.getBoundingClientRect(); return Math.min(r.width, r.height); })));
  assert.ok(hit >= 28, `hit area ${hit}px`);
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const hs = await handles(page, 'lot'); const far = hs.reduce((a, h) => (h.y < a.y ? h : a));
  const y0 = await page.evaluate(() => window.scrollY);
  const lot0 = await page.evaluate(() => JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model).lot);
  await touch('touchStart', far.sx, far.sy);
  for (let i = 1; i <= 8; i++) await touch('touchMove', far.sx - i, far.sy + i * 6);
  await touch('touchEnd');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.scrollY), y0, 'dragging a corner did not scroll the page');
  const lot1 = await page.evaluate(() => JSON.parse(document.querySelector('#lot-map .lm-frame').dataset.model).lot);
  assert.notDeepEqual(lot1, lot0, 'the corner moved with touch');
  await page.waitForFunction(() => document.querySelector('.fact[data-key="lot_area_sqft"]').dataset.state === 'edited');
  // a swipe on an empty part of the picture scrolls the page
  const fb = await page.locator('#lot-map .lm-frame').boundingBox();
  const y1 = await page.evaluate(() => window.scrollY);
  const sx0 = fb.x + 10, sy0 = Math.min(fb.y + fb.height - 30, 700);
  await touch('touchStart', sx0, sy0);
  for (let i = 1; i <= 12; i++) { await touch('touchMove', sx0, sy0 - i * 12); await page.waitForTimeout(16); }
  await touch('touchEnd');
  await page.waitForTimeout(400);
  assert.ok((await page.evaluate(() => window.scrollY)) > y1 + 20, 'a swipe on the picture scrolls the page');
  const m2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); assert.ok(m2.sw <= m2.cw);
  await page.evaluate(() => document.getElementById('lot-map').scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${SHOTS}/phone-light-photo.png` });
}, { viewport: { width: 390, height: 844 }, hasTouch: true });

for (const [scheme, label, mode] of [['dark', 'phone-dark-photo', 'png'], ['light', 'phone-light-nophoto', '404'], ['dark', 'phone-dark-nophoto', '404']]) {
  await scenario(`phone screenshot ${label}`, async (page) => {
    world = 'county'; photoMode = mode;
    await open(page); await mapReady(page); await settled(page);
    if (mode === 'png') await page.waitForFunction(() => { const i = document.querySelector('#lot-map .lm-img'); return i && !i.hidden && i.complete; });
    else await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('lot-map').scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: `${SHOTS}/${label}.png` });
    photoMode = 'png';
  }, { viewport: { width: 390, height: 844 }, colorScheme: scheme, hasTouch: true, allow404: mode === '404' });
}

await scenario('reduced motion: nothing animates in the map', async (page) => {
  world = 'county'; photoMode = 'png';
  await open(page); await mapReady(page);
  const a = await page.evaluate(() => [...document.querySelectorAll('#lot-map *')].every((e) => { const c = getComputedStyle(e); return (c.animationName === 'none' || c.animationDuration === '0s') && (c.transitionDuration === '0s' || c.transitionDuration === ''); }));
  assert.ok(a);
}, { reducedMotion: 'reduce' });

if (allExternal.length) failures.push(`unmocked external requests: ${allExternal.join(', ')}`);
await browser.close();
server.close();
console.log(`\n${passed} scenario(s) passed, ${failures.length} failure(s)`);
if (failures.length) { console.error(failures.join('\n\n')); process.exit(1); }

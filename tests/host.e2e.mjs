// Host Console e2e with a fully mocked backend. Never touches a real Supabase project.
// Run: node tests/host.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright'); }
const { chromium } = pw;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'SECRETTOKEN123';
const TZ = 'America/Los_Angeles';
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ---- helpers to build local-time instants in the property's zone
const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
const dayOf = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const localInstant = (offsetDays, hour) => { // epoch ms of `hour`:00 local, `offsetDays` after today (local)
  const target = dayOf(now + offsetDays * 86400000 + 3600000 * 6 * 0);
  for (let m = Math.floor(now / 900000) * 900000 + (offsetDays - 2) * 86400000; m < now + (offsetDays + 2) * 86400000; m += 900000) {
    const p = parts(m); if (`${p.year}-${p.month}-${p.day}` === target && +p.hour === hour && +p.minute === 0) return m;
  }
  throw new Error('no instant');
};

// ---- mock data
const U = 'u-1';
const data = {
  profiles: [{ id: U, full_name: 'Test Host' }],
  properties: [{ id: 'p1', title: 'Maple House', address: '1 Maple', city: 'LA', timezone: TZ, created_at: iso(now - 9e9) }],
  spaces: [
    { id: 's1', property_id: 'p1', parent_space_id: null, category: 'private_room', title: 'Guest room', quantity: 1, created_at: iso(now - 8e9) },
    { id: 's2', property_id: 'p1', parent_space_id: null, category: 'pool', title: 'Pool', quantity: 1, created_at: iso(now - 7e9) },
    { id: 's3', property_id: 'p1', parent_space_id: null, category: 'studio', title: 'Studio', quantity: 1, created_at: iso(now - 6e9) },
  ],
  channel_listings: [
    { id: 'l1', space_id: 's1', channel: 'airbnb', status: 'live', booking_mode: 'instant', url: null, created_at: iso(now - 5e9) },
    { id: 'l2', space_id: 's1', channel: 'vrbo', status: 'live', booking_mode: 'request', url: null, created_at: iso(now - 4e9) },
    { id: 'l3', space_id: 's3', channel: 'booking_com', status: 'live', booking_mode: 'request', url: null, created_at: iso(now - 3e9) },
  ],
  calendar_imports: [
    { id: 'i1', space_id: 's1', channel: 'airbnb', url: `https://www.airbnb.com/calendar/ical/1.ics?s=${TOKEN}`, last_synced_at: iso(now - 600000), last_status: 'error', last_error: `fetch failed: https://www.airbnb.com/calendar/ical/1.ics?s=${TOKEN} returned 403`, event_count: 0 },
    { id: 'i2', space_id: 's1', channel: 'vrbo', url: `https://vrbo.example/ical/${TOKEN}`, last_synced_at: iso(now - 5 * 3600000), last_status: 'ok', last_error: null, event_count: 2 },
    { id: 'i3', space_id: 's3', channel: 'booking_com', url: `https://booking.example/ical/${TOKEN}`, last_synced_at: iso(now - 600000), last_status: 'ok', last_error: null, event_count: 1 },
  ],
  calendar_feeds: [
    { id: 'f1', space_id: 's1', for_channel: 'airbnb', token: 'feedtok1', last_fetched_at: iso(now - 1e6) },
    { id: 'f2', space_id: 's1', for_channel: 'vrbo', token: 'feedtok2', last_fetched_at: iso(now - 1e6) },
    { id: 'f3', space_id: 's3', for_channel: 'booking_com', token: 'feedtok3', last_fetched_at: iso(now - 1e6) },
  ],
  reservations: [
    { id: 'r1', space_id: 's2', channel: 'swimply', kind: 'booking', status: 'confirmed', starts_at: iso(localInstant(1, 14)), ends_at: iso(localInstant(1, 17)), all_day: false, guest_name: 'Pat', summary: null, payout_cents: 9000 },
    { id: 'r2', space_id: 's1', channel: 'airbnb', kind: 'booking', status: 'confirmed', starts_at: iso(localInstant(3, 0)), ends_at: iso(localInstant(6, 0)), all_day: true, guest_name: 'Sam', summary: null, payout_cents: 30000 },
  ],
  booking_holds: [], booking_alerts: [], conflicts: [], earnings_ledger: [],
};

// ---- stub of supabase-js (served in place of the CDN bundle). Queries still go through fetch() so the page's real network paths are exercised.
const STUB = `
window.supabase = { createClient(url, key) {
  const user = { id: '${U}', email: 'host@example.test' };
  const session = { access_token: 'mock-token', user };
  const q = (table) => { const p = new URLSearchParams(); let single = false;
    const b = { select(c) { p.set('select', c); return b; }, eq(c, v) { p.set(c, 'eq.' + v); return b; }, gte(c, v) { p.set(c, 'gte.' + v); return b; }, is(c, v) { p.set(c, 'is.' + v); return b; },
      order(c) { return b; }, limit(n) { return b; }, maybeSingle() { single = true; return b; },
      then(res, rej) { return fetch(url + '/rest/v1/' + table + '?' + p, { headers: { apikey: key, Authorization: 'Bearer ' + session.access_token } })
        .then((r) => r.json()).then((rows) => ({ data: single ? (rows[0] ?? null) : rows, error: null })).then(res, rej); } };
    return b; };
  let cb;
  return { from: q, rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session } }), signOut: async () => {},
      onAuthStateChange(f) { cb = f; fetch(url + '/auth/v1/user', { headers: { apikey: key, Authorization: 'Bearer mock-token' } }).then((r) => r.json()).then((u) => cb('INITIAL_SESSION', { ...session, user: u })); return { data: { subscription: { unsubscribe() {} } } }; } } };
} };`;

// ---- static server
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/plain' }); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const failures = []; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };
const consoleErrors = []; const unmocked = []; const supabaseHits = [];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname.endsWith('.supabase.co')) {
      supabaseHits.push(`${route.request().method()} ${u.pathname}`);
      if (u.pathname === '/auth/v1/user') return route.fulfill({ json: { id: U, email: 'host@example.test' } });
      const m = u.pathname.match(/^\/rest\/v1\/(\w+)$/);
      if (m && m[1] in data) return route.fulfill({ json: data[m[1]], headers: { 'access-control-allow-origin': '*' } });
      unmocked.push(`${route.request().method()} ${u.pathname}`);
      return route.abort();
    }
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('@supabase/supabase-js')) return route.fulfill({ contentType: 'application/javascript', body: STUB });
    if (u.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    unmocked.push(`${route.request().method()} ${u.href}`);
    return route.abort();
  });

  await page.goto(`${base}/host/index.html`);
  await page.waitForSelector('.tabs');

  // (a) dashboard renders
  check(await page.locator('h1', { hasText: 'Hi Test' }).count() === 1, '(a) signed-in dashboard renders');

  // (b) banners
  const today = await page.locator('main').innerText();
  check(/Airbnb calendar for Guest room could not be read on the last try\./.test(today), '(b) error link shows "could not be read" banner');
  check(/Vrbo calendar for Guest room hasn't been read since .*\. Bookings made there since then are not shown here\./.test(today), '(b) stale link shows "hasn\'t been read since" banner');
  check(!/Booking\.com calendar for Studio (hasn't|could not)/.test(today), '(b) healthy link has no banner');
  check(await page.locator('[data-sync]').count() === 2, '(b) exactly two banners on Today');
  const todayHtml = await page.locator('#app').innerHTML();

  // calendar tab
  await page.click('button[data-tab="calendar"]');
  await page.waitForSelector('.cal');
  check(await page.locator('[data-sync]').count() === 2, '(b) two banners on Calendar');
  // (e) note
  check(await page.locator('[data-note="links"]').innerText() === 'Calendar links share availability only. Other sites re-read them every few hours, not instantly.', '(e) calendar-links note present');

  // (d) hourly vs nightly
  const cls = async (title) => (await page.locator(`.cal .d[title^="${title}"]`).first().getAttribute('class')).split(/\s+/);
  const hDay = dayOf(localInstant(1, 14));
  const hc = await cls(hDay + ': Swimply');
  const hTitle = await page.locator(`.cal .d[title^="${hDay}: Swimply"]`).first().getAttribute('title');
  check(/Swimply 2–5 PM/.test(hTitle) && /partly booked/.test(hTitle), `(d) hourly cell tooltip shows range ("${hTitle}")`);
  check(hc.includes('p') && !hc.includes('b'), '(d) hourly day is "partly booked", not fully booked');
  const upcoming = await page.locator('main').innerText();
  check(/2–5 PM/.test(upcoming), '(d) upcoming list shows the time range');
  for (let i = 3; i < 6; i++) { const c = await cls(dayOf(localInstant(i, 12)) + ': Airbnb'); check(c.includes('b') && !c.includes('p'), `(d) night ${i - 2} of 3-night stay still fully booked`); }
  check((await cls(dayOf(localInstant(6, 12)) + ': open')).every((c) => c !== 'b' && c !== 'p'), '(d) checkout day stays open');

  // (c) no token anywhere
  const calHtml = await page.locator('#app').innerHTML();
  await page.click('button[data-tab="places"]');
  await page.waitForSelector('.step');
  const placesText = await page.locator('main').innerText();
  check(![todayHtml, calHtml, placesText].some((t) => t.includes(TOKEN)), '(c) calendar token never appears in banners or page text');

  check(consoleErrors.length === 0, `(a) zero console errors${consoleErrors.length ? ': ' + consoleErrors.join(' | ') : ''}`);
  check(unmocked.length === 0, `(a) zero unmocked requests${unmocked.length ? ': ' + unmocked.join(' | ') : ''}`);
  check(supabaseHits.length > 0, `backend requests were intercepted (${supabaseHits.length})`);
} catch (e) { check(false, 'test crashed: ' + e.stack); }
finally { await browser.close(); server.close(); }
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nall host e2e checks passed');

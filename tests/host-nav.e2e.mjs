// Host Console navigation, states and robustness e2e with a fully mocked backend. Never touches a real Supabase project:
// every request to *.supabase.co is answered by the in-test Backend below, and anything unknown is aborted and fails the run.
// Run: node tests/host-nav.e2e.mjs
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

// ======================================================================= shared mock harness (copied into each test file)
// Nothing here may reach a real Supabase project: every request to *.supabase.co is answered by `Backend`, and anything it does not know is aborted and recorded.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const U = 'u-1'; const EMAIL = 'host@example.test'; const PASSWORD = 'correct-horse-9';
const CORS_H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

// Stand-in for the supabase-js CDN bundle. Queries and auth calls still travel through fetch(), so the page's real network paths are exercised.
const STUB = `
window.supabase = { createClient(url, key) {
  const KEY = 'mock-sb-session', listeners = [];
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const write = (s) => { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); };
  const emit = (ev, s) => listeners.forEach((f) => f(ev, s));
  const H = (extra = {}) => ({ apikey: key, 'content-type': 'application/json', ...extra });
  const authFail = (j, status) => ({ name: status === 0 ? 'AuthRetryableFetchError' : 'AuthApiError', message: j.msg || j.message || j.error_description || 'error', status, code: j.error_code });
  const post = async (p, body, method = 'POST') => { const tok = read()?.access_token;
    try { const r = await fetch(url + p, { method, headers: H(tok ? { authorization: 'Bearer ' + tok } : {}), body: JSON.stringify(body ?? {}) }); const j = await r.json().catch(() => ({})); return { ok: r.ok, j, status: r.status }; }
    catch { return { ok: false, j: { message: 'Failed to fetch' }, status: 0 }; } };
  const q = (table) => { const p = new URLSearchParams(); let method = 'GET', body, single = false, maybe = false, upsert = false, wantRows = false;
    const b = { select(c) { if (method === 'GET') p.set('select', c); else wantRows = true; return b; },
      insert(v) { method = 'POST'; body = v; return b; }, upsert(v, o) { method = 'POST'; body = v; upsert = true; p.set('on_conflict', o?.onConflict ?? ''); return b; },
      update(v) { method = 'PATCH'; body = v; return b; }, delete() { method = 'DELETE'; return b; },
      eq(c, v) { p.set(c, 'eq.' + v); return b; }, gte(c, v) { p.set(c, 'gte.' + v); return b; }, is(c, v) { p.set(c, 'is.' + v); return b; },
      order() { return b; }, limit(n) { p.set('limit', n); return b; }, single() { single = true; return b; }, maybeSingle() { maybe = true; return b; },
      then(res, rej) { return (async () => { const tok = read()?.access_token;
        let r; try { r = await fetch(url + '/rest/v1/' + table + '?' + p, { method, headers: H({ authorization: 'Bearer ' + (tok ?? key), ...(upsert ? { prefer: 'resolution=merge-duplicates' } : {}) }), body: body === undefined ? undefined : JSON.stringify(body) }); }
        catch { return { data: null, error: { message: 'Failed to fetch' } }; }
        const j = await r.json().catch(() => null);
        if (!r.ok) return { data: null, error: { message: j?.message ?? 'request failed', code: j?.code, status: r.status } };
        if (method !== 'GET' && !wantRows) return { data: null, error: null };
        const rows = Array.isArray(j) ? j : [j];
        return { data: single ? rows[0] : maybe ? (rows[0] ?? null) : j, error: null }; })().then(res, rej); } };
    return b; };
  window.__mockAuth = { emit, expire() { write(null); emit('SIGNED_OUT', null); } };
  return { from: q,
    rpc: async (name, args) => { const tok = read()?.access_token; try { const r = await fetch(url + '/rest/v1/rpc/' + name, { method: 'POST', headers: H({ authorization: 'Bearer ' + (tok ?? key) }), body: JSON.stringify(args) }); const j = await r.json().catch(() => null);
      return r.ok ? { data: j, error: null } : { data: null, error: { message: j?.message ?? 'request failed', code: j?.code, status: r.status } }; } catch { return { data: null, error: { message: 'Failed to fetch' } }; } },
    auth: {
      getSession: async () => ({ data: { session: read() } }),
      async signInWithPassword({ email, password }) { const { ok, j, status } = await post('/auth/v1/token?grant_type=password', { email, password }); if (!ok) return { data: { session: null, user: null }, error: authFail(j, status) };
        write(j); emit('SIGNED_IN', j); return { data: { session: j, user: j.user }, error: null }; },
      async signUp({ email, password, options }) { const { ok, j, status } = await post('/auth/v1/signup?redirect_to=' + encodeURIComponent(options?.emailRedirectTo ?? ''), { email, password, data: options?.data }); if (!ok) return { data: { session: null, user: null }, error: authFail(j, status) };
        if (j.access_token) { write(j); emit('SIGNED_IN', j); return { data: { session: j, user: j.user }, error: null }; } return { data: { session: null, user: j.user ?? j }, error: null }; },
      async resetPasswordForEmail(email, o) { const { ok, j, status } = await post('/auth/v1/recover?redirect_to=' + encodeURIComponent(o?.redirectTo ?? ''), { email }); return ok ? { data: {}, error: null } : { data: null, error: authFail(j, status) }; },
      async updateUser(attrs) { const { ok, j, status } = await post('/auth/v1/user', attrs, 'PUT'); if (!ok) return { data: { user: null }, error: authFail(j, status) }; emit('USER_UPDATED', read()); return { data: { user: j }, error: null }; },
      async signOut(o) { if (o?.scope !== 'local') { const r = await post('/auth/v1/logout', {}); if (r.status === 0) return { error: authFail(r.j, 0) }; } write(null); emit('SIGNED_OUT', null); return { error: null }; },
      onAuthStateChange(f) { listeners.push(f);
        const h = new URLSearchParams(location.hash.slice(1));
        if (h.get('access_token') && h.get('type') === 'recovery') { const s = { access_token: h.get('access_token'), refresh_token: 'r', user: { id: '${U}', email: '${EMAIL}' } }; write(s); history.replaceState(null, '', location.pathname + location.search);
          Promise.resolve().then(() => f('INITIAL_SESSION', s)); setTimeout(() => f('PASSWORD_RECOVERY', s), 0); }
        else Promise.resolve().then(() => f('INITIAL_SESSION', read()));
        return { data: { subscription: { unsubscribe() {} } } }; } } };
} };`;

class Backend {
  static all = [];
  constructor(data = {}) {
    Backend.all.push(this);
    this.db = structuredClone(data); this.log = []; this.unmocked = []; this.fail = {}; this.fn = {}; this.delay = 0; this.seq = 0;
    this.users = { [EMAIL]: PASSWORD }; this.unconfirmed = new Set(); this.restDown = null; this.jwtExpired = false;
  }
  session(email = EMAIL) { return { access_token: 'mock-token', refresh_token: 'r', expires_in: 3600, user: { id: U, email } }; }
  async handle(route) {
    const req = route.request(); const u = new URL(req.url()); const method = req.method(); const p = u.pathname;
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS_H });
    this.log.push({ method, path: p, query: u.search, body: req.postData() });
    const json = (status, body) => route.fulfill({ status, headers: { ...CORS_H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    // ---- auth
    if (p.startsWith('/auth/v1/')) {
      const body = req.postDataJSON?.() ?? {};
      if (p === '/auth/v1/token') {
        if (this.users[body.email] !== body.password) return json(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        if (this.unconfirmed.has(body.email)) return json(400, { error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
        return json(200, this.session(body.email));
      }
      if (p === '/auth/v1/signup') return json(200, { id: 'new-user', email: body.email }); // email confirmation is on: a user and no session; the same for an address that already exists
      if (p === '/auth/v1/recover') return json(200, {});
      if (p === '/auth/v1/user' && method === 'PUT') { this.users[EMAIL] = body.password; return json(200, { id: U, email: EMAIL }); }
      if (p === '/auth/v1/logout') return json(204, {});
    }
    // ---- edge functions
    const fm = p.match(/^\/functions\/v1\/([\w-]+)$/);
    if (fm && this.fn[fm[1]]) { const r = await this.fn[fm[1]](req.postDataJSON?.() ?? {}, this); return json(r.status ?? 200, r.body ?? {}); }
    // ---- tables
    const rm = p.match(/^\/rest\/v1\/(?:rpc\/)?(\w+)$/);
    if (rm) {
      if (this.jwtExpired) return json(401, { code: 'PGRST301', message: 'JWT expired' });
      if (this.restDown) return json(this.restDown, { message: 'upstream unavailable', code: 'XX000' });
      const t = rm[1]; const f = this.fail[`${method} ${t}`]; if (f) return json(f.status ?? 500, { message: f.message ?? 'boom', code: f.code });
      if (p.includes('/rpc/')) { if (t === 'dismiss_alert') { const id = req.postDataJSON().p_alert; this.db.booking_alerts = (this.db.booking_alerts ?? []).filter((a) => a.id !== id); return json(200, true); } return json(404, { message: 'function not found' }); }
      if (!(t in this.db)) return json(404, { message: `relation "${t}" does not exist`, code: '42P01' });
      const rows = this.db[t]; const match = (r) => [...u.searchParams].every(([k, v]) => {
        if (['select', 'order', 'limit', 'on_conflict'].includes(k)) return true;
        if (v.startsWith('eq.')) return String(r[k]) === v.slice(3); if (v.startsWith('gte.')) return String(r[k]) >= v.slice(4); if (v === 'is.null') return r[k] == null; return true; });
      if (method === 'GET') { const lim = +u.searchParams.get('limit') || Infinity; return json(200, rows.filter(match).slice(0, lim)); }
      if (method === 'POST') {
        const body = req.postDataJSON(); const out = [];
        for (const b of Array.isArray(body) ? body : [body]) {
          const keys = (u.searchParams.get('on_conflict') || '').split(',').filter(Boolean);
          const dup = rows.find((r) => keys.length ? keys.every((k) => r[k] === b[k]) : (t === 'channel_listings' || t === 'calendar_feeds') && r.space_id === b.space_id && (r.channel ?? r.for_channel) === (b.channel ?? b.for_channel));
          if (dup && keys.length) { Object.assign(dup, b); out.push(dup); continue; }
          if (dup) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
          if (t === 'channel_listings' && b.booking_mode === 'instant' && rows.some((r) => r.space_id === b.space_id && r.booking_mode === 'instant')) return json(400, { code: 'P0001', message: 'Only one site can take instant bookings for the same space. airbnb already does for "x".' });
          const row = { id: `${t}-${++this.seq}`, created_at: new Date().toISOString(), ...(t === 'properties' ? { timezone: 'America/Los_Angeles' } : {}), ...(t === 'calendar_feeds' ? { token: `tok${this.seq}`.padEnd(64, '0'), last_fetched_at: null } : {}), ...(t === 'channel_listings' ? { booking_mode: 'request', url: null } : {}), ...b };
          rows.push(row); out.push(row);
        }
        return json(201, out);
      }
      if (method === 'PATCH') { const hit = rows.filter(match); hit.forEach((r) => Object.assign(r, req.postDataJSON())); return json(200, hit); }
      if (method === 'DELETE') { const hit = rows.filter(match); this.db[t] = rows.filter((r) => !hit.includes(r)); return json(200, hit); }
    }
    this.unmocked.push(`${method} ${p}`); return route.abort();
  }
  count(method, p) { return this.log.filter((l) => l.method === method && l.path === p).length; }
}

// Serves the repo under /everyspace/ (like GitHub Pages) and also at /.
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/everyspace(?=\/|$)/, '');
      let f = path.join(ROOT, rel);
      if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/plain' }); res.end(fs.readFileSync(f));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// Every non-local request is answered here. Nothing can reach the internet.
async function wire(context, backend, seen) {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname.endsWith('.supabase.co')) { seen.supabase++; return backend.handle(route); }
    if (u.hostname === 'cdn.jsdelivr.net' && u.pathname.includes('@supabase/supabase-js')) { if (seen.blockCdn) return route.abort(); return route.fulfill({ contentType: 'application/javascript', body: STUB }); }
    if (u.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    seen.other.push(`${route.request().method()} ${u.href}`); return route.abort();
  });
}
function watch(page, errors) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e));
}
const hscroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const failures = []; const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures.push(msg); };
// ======================================================================= end shared harness

const SHOTS = process.env.HOST_SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const now = Date.now(); const iso = (ms) => new Date(ms).toISOString(); const DAY = 86400000;
const noon = (n) => { const d = new Date(now + n * DAY); d.setUTCHours(20, 0, 0, 0); return d.getTime(); }; // 1 pm in Los Angeles, close enough for these checks
const TABS = ['today', 'requests', 'calendar', 'places', 'earnings'];
const empty = () => ({ profiles: [{ id: U, full_name: 'Test Host' }], properties: [], spaces: [], channel_listings: [], calendar_imports: [], calendar_feeds: [], reservations: [], booking_holds: [], booking_alerts: [], conflicts: [], earnings_ledger: [] });
const populated = () => ({
  ...empty(),
  properties: [{ id: 'p1', title: 'Maple House', address: '1 Maple', city: 'LA', timezone: 'America/Los_Angeles', created_at: iso(now - 9e9) }],
  spaces: [
    { id: 's1', property_id: 'p1', parent_space_id: null, category: 'private_room', title: 'Guest room', quantity: 1, created_at: iso(now - 8e9) },
    { id: 's2', property_id: 'p1', parent_space_id: null, category: 'pool', title: 'Pool', quantity: 1, created_at: iso(now - 7e9) },
    { id: 's4', property_id: 'p1', parent_space_id: null, category: 'other', title: 'Kayaks', quantity: 3, created_at: iso(now - 6e9) },
  ],
  channel_listings: [
    { id: 'l1', space_id: 's1', channel: 'airbnb', status: 'live', booking_mode: 'instant', url: null, created_at: iso(now - 5e9) },
    { id: 'l2', space_id: 's1', channel: 'vrbo', status: 'live', booking_mode: 'request', url: null, created_at: iso(now - 4e9) },
    { id: 'l4', space_id: 's4', channel: 'swimply', status: 'live', booking_mode: 'request', url: null, created_at: iso(now - 4e9) },
  ],
  calendar_imports: [
    { id: 'i1', space_id: 's1', channel: 'airbnb', url: 'https://www.airbnb.com/calendar/ical/1.ics?s=SECRETTOKEN', last_synced_at: iso(now - 600000), last_status: 'ok', last_error: null, event_count: 2 },
    { id: 'i2', space_id: 's1', channel: 'vrbo', url: 'https://vrbo.example/ical/SECRETTOKEN', last_synced_at: iso(now - 600000), last_status: 'error', last_error: 'fetch_failed', event_count: 0 },
  ],
  calendar_feeds: [
    { id: 'f1', space_id: 's1', for_channel: 'airbnb', token: 'a'.repeat(64), last_fetched_at: iso(now - 1e6) },
    { id: 'f2', space_id: 's1', for_channel: 'vrbo', token: 'b'.repeat(64), last_fetched_at: null },
  ],
  reservations: [
    { id: 'r1', space_id: 's1', channel: 'airbnb', kind: 'booking', status: 'confirmed', starts_at: iso(noon(2)), ends_at: iso(noon(5)), all_day: true, guest_name: 'Sam', summary: null, payout_cents: null },
    ...[0, 1].map((i) => ({ id: `k${i}`, space_id: 's4', channel: 'swimply', kind: 'booking', status: 'confirmed', starts_at: iso(noon(3)), ends_at: iso(noon(4)), all_day: true, guest_name: `Kay ${i}`, summary: null, payout_cents: null })),
  ],
  booking_holds: [{ id: 'h1', space_id: 's1', channel: 'vrbo', guest_name: 'Lee', starts_at: iso(noon(9)), ends_at: iso(noon(11)), all_day: true, status: 'holding', released_reason: null, expires_at: iso(now + DAY), verified_at: null, created_at: iso(now - 1e5) }],
  booking_alerts: [
    { id: 'a1', space_id: 's1', kind: 'door_open', channel: 'airbnb', message: 'Close the nights of Dec 3 – Dec 4 on Airbnb now.', created_at: iso(now - 1e5), reservation: { channel: 'vrbo', starts_at: iso(noon(2)), ends_at: iso(noon(4)), all_day: true, guest_name: 'Sam' } },
    { id: 'a2', space_id: 's1', kind: 'unchecked_accept', channel: 'vrbo', message: 'x', created_at: iso(now - 1e5), reservation: null },
  ],
  conflicts: [{ id: 'c1', space_id: 's1', detected_at: iso(now), a: null, b: { channel: 'vrbo', starts_at: null, ends_at: null, all_day: true } }], // a cut-off row must not blank the page
  earnings_ledger: [{ id: 'e1', period: '2026-10-01', gross_cents: 50000, attributed: false, share_pct: 0, fee_cents: 0, reservation: null }],
});

const { server, base } = await startServer();
const PAGE = `${base}/everyspace/host/`;
const errors = []; const seen = { supabase: 0, other: [], blockCdn: false };
const browser = await chromium.launch();
const session = JSON.stringify({ access_token: 'mock-token', refresh_token: 'r', user: { id: U, email: EMAIL } });
async function open(backend, { viewport = { width: 1280, height: 900 }, scheme = 'light', signedIn = true, install } = {}) {
  const context = await browser.newContext({ viewport, colorScheme: scheme }); await wire(context, backend, seen);
  if (signedIn) await context.addInitScript((s) => { try { if (!localStorage.getItem('mock-sb-session')) localStorage.setItem('mock-sb-session', s); } catch {} }, session);
  const page = await context.newPage(); watch(page, errors); if (install) await install(page); return { context, page };
}
const expected = (re) => { for (let i = errors.length - 1; i >= 0; i--) if (re.test(errors[i])) errors.splice(i, 1); };
const view = (page) => page.locator('main').innerText();
const goTab = async (page, k) => { await page.click(`button[data-tab="${k}"]`); await page.waitForSelector(`button[data-tab="${k}"][aria-current="page"]`); };
const clipped = (page) => page.evaluate(() => { const w = innerWidth; return [...document.querySelectorAll('body *')].filter((e) => { if (e.closest('.tabs, dialog:not([open]), .toast')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > w + 1 || r.left < -1); }).map((e) => `${e.tagName.toLowerCase()}.${e.className}`).slice(0, 5); });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); };

try {
  // ---------------------------------------------------------------- 1. every tab, desktop and phone, light and dark
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) for (const scheme of ['light', 'dark']) {
    const b = new Backend(populated()); const { context, page } = await open(b, { viewport, scheme });
    await page.goto(PAGE); await page.waitForSelector('.tabs');
    const tag = `${label}/${scheme}`;
    check(await page.locator('h1', { hasText: 'Hi Test' }).count() === 1, `[${tag}] dashboard renders even though one conflict row has no dates`);
    if (scheme === 'dark') check(await page.evaluate(() => getComputedStyle(document.body).backgroundColor) === 'rgb(11, 16, 22)', `[${tag}] dark theme applies`);
    for (const k of TABS) {
      await goTab(page, k);
      check(await hscroll(page) <= 0, `[${tag}] ${k}: no horizontal scroll`);
      const off = await clipped(page); check(off.length === 0, `[${tag}] ${k}: nothing runs off the screen${off.length ? ' (' + off.join(', ') + ')' : ''}`);
      check((await view(page)).trim().length > 40, `[${tag}] ${k}: shows content`);
      if (label === 'phone') { // tap targets
        const small = await page.evaluate(() => [...document.querySelectorAll('main button, main a[data-tab], .tabs button, .who button')].filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return { t: (e.textContent || '').trim().slice(0, 20), h: Math.round(r.height), w: Math.round(r.width) }; }).filter((x) => x.h < 30 || x.w < 30));
        check(small.length === 0, `[${tag}] ${k}: buttons are at least 30px tall and wide${small.length ? ' ' + JSON.stringify(small) : ''}`);
      }
      await shot(page, `${label}-${scheme}-${k}`);
    }
    // the bookings view tolerates a booking with unreadable dates, and a space with several units is not "double booked" by two bookings
    await goTab(page, 'calendar');
    check(await page.locator('.cal .d.x').count() === 0, `[${tag}] 2 bookings of a 3-unit space are not shown as a double booking`);
    // dialogs fit the screen
    for (const [btn, name] of [['[data-act=newreq]', 'New request'], ['[data-act=addplace]', 'Add a place'], ['[data-act=addspace]', 'Add a space'], ['[data-act=addsite]', 'Add a site']]) {
      await goTab(page, btn.includes('newreq') ? 'requests' : 'places');
      await page.locator(btn).first().click(); await page.waitForSelector('dialog[open]');
      const r = await page.locator('dialog[open]').boundingBox();
      check(r.x >= 0 && r.x + r.width <= viewport.width + 1 && await hscroll(page) <= 0, `[${tag}] "${name}" dialog fits the screen`);
      if (label === 'phone' && scheme === 'light') await shot(page, `phone-dialog-${name.replace(/\W+/g, '-')}`);
      await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    }
    await context.close();
  }

  // ---------------------------------------------------------------- 2. empty account
  for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const b = new Backend(empty()); const { context, page } = await open(b, { viewport });
    await page.goto(PAGE); await page.waitForSelector('.tabs');
    check(/add your first place to get started/i.test(await view(page)) && await page.locator('[data-tab=places]', { hasText: 'Open' }).count() >= 1, `[${label}] empty account: Today says to add a first place and links to it`);
    await goTab(page, 'requests'); check(/No open requests/.test(await view(page)), `[${label}] empty account: Requests is empty but readable`);
    await goTab(page, 'calendar'); check(/Add a place and its spaces first/.test(await view(page)) && await page.locator('main [data-tab=places]').count() === 1, `[${label}] empty account: Calendar explains and links to Places`);
    await goTab(page, 'earnings'); check(/No finished stays/.test(await view(page)), `[${label}] empty account: Earnings is empty but readable`);
    await goTab(page, 'places'); check(await page.locator('form[data-form=place]').count() === 1 && /Add your first place/.test(await view(page)), `[${label}] empty account: Places offers the add-a-place form`);
    check(await hscroll(page) <= 0, `[${label}] empty account: no horizontal scroll`);
    await shot(page, `${label}-empty-places`);
    // first-run walkthrough: place -> space -> site
    await page.fill('form[data-form=place] input[name=title]', 'Elm Cottage'); await page.click('form[data-form=place] button[type=submit]');
    await page.waitForSelector('[data-act=addspace]'); check(/Elm Cottage/.test(await view(page)), `[${label}] adding a place shows it`);
    check(b.db.properties[0].host_id === U && b.db.properties[0].city === 'Los Angeles', `[${label}] the place is saved for this host`);
    await page.click('[data-act=addspace]'); await page.fill('dialog input[name=title]', 'Whole house'); await page.click('dialog button[type=submit]');
    await page.waitForSelector('[data-act=addsite]'); check(b.db.spaces.length === 1 && b.db.spaces[0].quantity === 1, `[${label}] adding a space saves it`);
    await page.click('[data-act=addsite]'); await page.selectOption('dialog select[name=channel]', 'airbnb'); await page.click('dialog button[type=submit]');
    await page.waitForSelector('form[data-form=import]');
    check(b.db.channel_listings.length === 1 && b.db.calendar_feeds.length === 1, `[${label}] adding a site saves the listing and its Everyspace link`);
    // calendar link validation and saving
    const imp = page.locator('form[data-form=import]');
    for (const bad of ['http://insecure.example/x.ics', 'https://localhost/x', 'notaurl']) {
      await imp.locator('input[name=url]').evaluate((el, v) => { el.removeAttribute('type'); el.value = v; }, bad); await imp.locator('button').click();
      await page.waitForSelector('.toast.bad'); check(/doesn.t look like a calendar link/i.test(await page.locator('.toast').innerText()), `[${label}] link "${bad}" is rejected with a clear message`);
      await page.evaluate(() => document.querySelector('.toast')?.remove());
    }
    check(b.db.calendar_imports.length === 0, `[${label}] invalid links were never saved`);
    b.fn['calendar-sync'] = async () => ({ body: { synced: 1, skipped: 0, results: [{ id: 'x', ok: false, error: 'fetch_failed' }] } });
    await imp.locator('input[name=url]').fill('webcal://www.airbnb.com/calendar/ical/9.ics?s=SECRETTOKEN'); await imp.locator('button').click();
    await page.waitForSelector('.toast.bad');
    const toast = await page.locator('.toast').innerText();
    check(b.db.calendar_imports[0]?.url.startsWith('https://www.airbnb.com/'), `[${label}] a webcal:// link is saved as https://`);
    check(/couldn.t read 1 calendar/i.test(toast) && !/https?:|SECRETTOKEN|fetch_failed/.test(toast), `[${label}] a failed sync says so in words, with no link or code ("${toast}")`);
    await context.close();
  }

  // ---------------------------------------------------------------- 3. backend problems on load
  {
    const b = new Backend(populated()); b.restDown = 500; const { context, page } = await open(b);
    await page.goto(PAGE); await page.waitForSelector('[data-load-error]');
    const msg = await page.locator('[data-load-error]').innerText();
    check(/couldn.t load your data/i.test(await view(page).catch(() => '') + await page.locator('h1').innerText()) && msg.length > 10, `backend error on load shows a readable message ("${msg}")`);
    check(await page.locator('.tabs').count() === 0 && (await page.locator('#app').innerText()).trim().length > 20, 'the error screen is not a blank page');
    expected(/500|Failed to load resource/);
    b.restDown = null; await page.click('[data-act=retry]'); await page.waitForSelector('.tabs');
    check(await page.locator('h1', { hasText: 'Hi Test' }).count() === 1, '"Try again" loads the dashboard once the backend recovers');
    await context.close();
    // network failure
    const b2 = new Backend(populated()); const c2 = await open(b2);
    await c2.page.route('**/rest/v1/**', (r) => r.abort());
    await c2.page.goto(PAGE); await c2.page.waitForSelector('[data-load-error]');
    check(/couldn.t reach everyspace/i.test(await c2.page.locator('[data-load-error]').innerText()), 'a network failure on load says it could not reach Everyspace');
    expected(/Failed to load resource|ERR_FAILED/);
    // sign out from the error screen
    await c2.page.click('[data-act=signout]'); await c2.page.waitForSelector('#authForm'); check(true, 'Sign out works from the error screen');
    await c2.context.close();
  }

  // ---------------------------------------------------------------- 4. history, reload, links
  {
    const b = new Backend(populated()); const { context, page } = await open(b);
    await page.goto(PAGE); await page.waitForSelector('.tabs');
    const h0 = await page.evaluate(() => history.length);
    await goTab(page, 'calendar'); await goTab(page, 'places');
    check(await page.evaluate(() => history.length) === h0, 'switching tabs adds no history entries (no routing)');
    await page.reload(); await page.waitForSelector('.tabs');
    const after = await page.locator('.tabs [aria-current=page]').innerText();
    console.log(`FINDING reload returns to "${after}" (the current tab is not kept in the address); Back leaves the console instead of the previous tab. Not changed: no routing was invented.`);
    check(after === 'Today' && await page.locator('h1', { hasText: 'Hi Test' }).count() === 1, 'reload keeps the session and opens Today');
    // links: every anchor is in-page, or opens safely
    const links = []; for (const k of TABS) { await goTab(page, k); links.push(...await page.evaluate(() => [...document.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent.trim() })))); }
    const external = links.filter((l) => /^(https?:)?\/\//i.test(l.href ?? ''));
    check(links.length > 0 && links.every((l) => l.href === '#' || external.includes(l)), `every link is in-page ("#") or external (${links.length} links, ${external.length} external)`);
    check(external.every((l) => /noopener/.test(l.rel) && l.target === '_blank'), 'external links open in a new tab with rel=noopener');
    check(await page.locator('[target=_blank]:not([rel~=noopener])').count() === 0, 'no target=_blank without noopener');
    // in-page links do not scroll away or change the address
    const url0 = page.url(); await goTab(page, 'today'); await page.click('main a[data-tab=requests]'); await page.waitForSelector('button[data-tab=requests][aria-current=page]');
    check(page.url() === url0, 'in-page links do not change the address');
    // copy button, and fallback when the clipboard is refused
    await goTab(page, 'places'); await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await page.locator('details.more > summary').first().click(); // the link sits in the collapsed "Calendar connection" section
    await page.locator('[data-act=copy]').first().click(); await page.waitForSelector('.toast');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check(/\/functions\/v1\/calendar-feed\/a{64}\.ics$/.test(copied) && /link copied/i.test(await page.locator('.toast').innerText()), 'Copy puts the Everyspace calendar link on the clipboard');
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }); });
    await page.locator('[data-act=copy]').first().click(); await page.waitForFunction(() => /select the link/i.test(document.querySelector('.toast')?.textContent ?? ''));
    check(true, 'when the clipboard is refused the page asks the host to select the link');
    await context.close();
  }

  // ---------------------------------------------------------------- 5. robustness and safety
  {
    const evil = '<img src=x onerror="window.__xss=1">';
    const d = populated();
    d.properties[0].title = evil; d.properties[0].address = '"><script>window.__xss=2</script>'; d.spaces[0].title = evil; d.spaces[1].title = '</div><svg onload="window.__xss=3">';
    d.reservations[0].guest_name = '<b onmouseover="window.__xss=4">Sam</b>'; d.booking_holds[0].guest_name = evil; d.calendar_imports[1].last_error = `<i>boom</i> https://vrbo.example/ical/SECRETTOKEN`;
    d.booking_alerts[0].message = evil;
    d.reservations.push(...Array.from({ length: 998 }, (_, i) => ({ id: `bulk${i}`, space_id: 's2', channel: 'swimply', kind: 'booking', status: 'confirmed', starts_at: iso(noon(20 + i)), ends_at: iso(noon(20 + i) + 3600000), all_day: false, guest_name: null, summary: null, payout_cents: null })));
    const b = new Backend(d); const { context, page } = await open(b);
    await page.goto(PAGE); await page.waitForSelector('.tabs');
    let html = ''; for (const k of TABS) { await goTab(page, k); html += await page.locator('main').innerHTML(); }
    check(await page.evaluate(() => window.__xss) === undefined, 'text from property, space, guest and calendar fields never runs as HTML');
    check(!/<img src=x|<script>window|<svg onload/.test(html) && /&lt;img src=x/.test(html), 'markup typed into names is shown as text');
    check(!html.includes('SECRETTOKEN'), 'the calendar link secret never appears in banners, gaps or errors');
    check(/Only the first 1,000 bookings are loaded/.test(await (async () => { await goTab(page, 'calendar'); return view(page); })()), 'a cut-off bookings list is announced instead of silently dropping dates');
    check(!/undefined|NaN|null/.test(await view(page)), 'no "undefined", "NaN" or "null" text on the calendar');
    await goTab(page, 'today'); const today = await view(page);
    check(/Double booking on/.test(today) && /dates not available/.test(today), 'a conflict whose booking has no dates still renders, in words');
    check(!/undefined|NaN|null/.test(today), 'no "undefined", "NaN" or "null" text on Today');
    await goTab(page, 'earnings'); check(!/undefined|NaN|null/.test(await view(page)) && /\$500/.test(await view(page)), 'Earnings renders a row whose booking is missing');
    // remove a site: errors from the link deletes are reported, and the site stays
    await goTab(page, 'places'); page.once('dialog', (x) => x.accept());
    b.fail['DELETE calendar_feeds'] = { status: 403, message: 'permission denied' };
    await page.locator('[data-act=delsite]').first().click(); await page.waitForSelector('.toast.bad');
    check(/permission denied/.test(await page.locator('.toast').innerText()) && b.db.channel_listings.some((l) => l.id === 'l1'), 'a failed delete of a site link is reported and the site is kept');
    delete b.fail['DELETE calendar_feeds']; page.once('dialog', (x) => x.accept());
    await page.locator('[data-act=delsite]').first().click(); await page.waitForFunction(() => /^Removed\./.test(document.querySelector('.toast')?.textContent ?? ''));
    check(!b.db.channel_listings.some((l) => l.id === 'l1') && !b.db.calendar_imports.some((i) => i.id === 'i1') && !b.db.calendar_feeds.some((f) => f.id === 'f1'), 'removing a site removes its listing, calendar link and Everyspace link');
    // one door: the database says no, the page says it plainly
    await page.locator('[data-act=mode][data-mode=instant]').last().click();
    await page.waitForSelector('.toast.bad'); check(/only one site can take instant bookings/i.test(await page.locator('.toast').innerText()), 'the one-instant-site rule is explained when the database refuses');
    // sync result mapping
    b.fn['calendar-sync'] = async () => ({ body: { synced: 2, skipped: 0, results: [{ ok: false, error: 'blocked_url' }, { ok: true }] } });
    await goTab(page, 'today'); await page.click('[data-act=syncall]'); await page.waitForFunction(() => /couldn.t read 1 calendar/i.test(document.querySelector('.toast')?.textContent ?? ''));
    check(!/https?:|blocked_url/.test(await page.locator('.toast').innerText()), 'a sync failure never shows a code or a link');
    // a function that is not deployed fails with a clear message
    b.fn['calendar-sync'] = async () => ({ status: 404, body: { code: 'NOT_FOUND', message: 'Requested function was not found' } });
    await page.click('[data-act=syncall]'); await page.waitForFunction(() => /isn.t switched on/i.test(document.querySelector('.toast')?.textContent ?? ''));
    check(true, 'a missing backend function is reported as not switched on, not as "no calendars"');
    delete b.fn['calendar-sync']; // unknown function -> aborted by the harness, i.e. a network failure
    await page.click('[data-act=syncall]'); await page.waitForFunction(() => /couldn.t reach everyspace/i.test(document.querySelector('.toast')?.textContent ?? '')); expected(/Failed to load resource|ERR_FAILED/);
    check(true, 'a network failure in a function call is reported plainly');
    // new request flow: hold + verdict, with an error answer
    b.fn['booking-guard'] = async (body) => body.action === 'hold' ? { body: { safe: true, step: 'accept', message: 'Dates locked.', hold_id: 'h9' } } : { status: 404, body: { error: 'Request not found' } };
    await goTab(page, 'requests'); await page.click('main [data-act=newreq]'); await page.waitForSelector('dialog[open]');
    await page.fill('dialog input[name=end]', await page.inputValue('dialog input[name=start]')); await page.click('dialog button[type=submit]');
    check(/Check-out has to be after check-in/.test(await page.locator('#holdMsg').innerText()), 'a request that ends before it starts is refused with a message');
    await page.fill('dialog input[name=end]', new Date(now + 5 * DAY).toISOString().slice(0, 10)); await page.click('dialog button[type=submit]');
    await page.waitForSelector('#verdict'); check(/Safe to accept/.test(await page.locator('#verdict').innerText()), 'a held request shows the verdict');
    page.once('dialog', (x) => x.accept()); await page.locator('[data-act=release]').first().click(); await page.waitForSelector('.toast.bad');
    check(/request not found/i.test(await page.locator('.toast').innerText()), 'a failed release shows the error from the service');
    // the minute refresh does not wipe a half-typed form
    await context.close();
  }
  {
    const b = new Backend(empty()); const { context, page } = await open(b, { install: (p) => p.clock.install() });
    await page.goto(PAGE); await page.waitForSelector('.tabs'); await goTab(page, 'places');
    await page.fill('form[data-form=place] input[name=title]', 'Half typed');
    const n = b.count('GET', '/rest/v1/properties'); await page.clock.fastForward(125000); await page.waitForTimeout(300);
    check(await page.inputValue('form[data-form=place] input[name=title]') === 'Half typed', 'the background refresh does not wipe a form the host is typing in');
    check(b.count('GET', '/rest/v1/properties') === n, 'the background refresh waits while a form has unsaved text');
    await page.fill('form[data-form=place] input[name=title]', ''); await page.evaluate(() => document.activeElement?.blur());
    await page.clock.fastForward(125000); await page.waitForTimeout(300);
    check(b.count('GET', '/rest/v1/properties') > n, 'the background refresh runs when nothing is being typed');
    await context.close();
  }

  check(errors.length === 0, `zero console errors and unhandled rejections${errors.length ? ': ' + errors.join(' | ') : ''}`);
  const unmocked = [...seen.other, ...Backend.all.flatMap((x) => x.unmocked)];
  check(unmocked.length === 0, `zero unmocked requests${unmocked.length ? ': ' + [...new Set(unmocked)].join(' | ') : ''}`);
  check(seen.supabase > 0, `backend requests were intercepted (${seen.supabase})`);
} catch (e) { check(false, 'test crashed: ' + e.stack); }
finally { await browser.close(); server.close(); }
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nall host navigation e2e checks passed');

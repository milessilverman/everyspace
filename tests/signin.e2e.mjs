// Host Console sign-in and session e2e with a fully mocked backend. Never touches a real Supabase project:
// every request to *.supabase.co is answered by the in-test Backend below, and anything unknown is aborted and fails the run.
// Run: node tests/signin.e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';

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

const iso = (ms) => new Date(ms).toISOString();
const baseData = () => ({
  profiles: [{ id: U, full_name: 'Test Host' }], properties: [], spaces: [], channel_listings: [], calendar_imports: [], calendar_feeds: [],
  reservations: [], booking_holds: [], booking_alerts: [], conflicts: [], earnings_ledger: [],
});

const { server, base } = await startServer();
const PAGE = `${base}/everyspace/host/`; // served under a sub-path like GitHub Pages
const errors = []; const seen = { supabase: 0, other: [], blockCdn: false };
const browser = await launchBrowser();
async function fresh(backend, { viewport = { width: 1280, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport }); await wire(context, backend, seen);
  const page = await context.newPage(); watch(page, errors); return { context, page };
}
const text = (page, sel) => page.locator(sel).innerText();
const signedOut = async (page) => (await page.locator('#authForm, #resetForm, #newPwForm').count()) === 1 && (await page.locator('.tabs').count()) === 0;
const dashboard = async (page) => { await page.waitForSelector('.tabs', { timeout: 5000 }); return page.locator('h1', { hasText: 'Hi Test' }).count(); };
// Console messages caused by a failure the test injects on purpose are removed here, so the final "zero errors" check stays strict.
const expected = (re) => { for (let i = errors.length - 1; i >= 0; i--) if (re.test(errors[i])) errors.splice(i, 1); };

try {
  // ---------------------------------------------------------------- 1. signed-out page
  {
    const b = new Backend(baseData()); const { context, page } = await fresh(b);
    await page.goto(PAGE); await page.waitForSelector('#authForm');
    check((await text(page, 'h1')) === 'Sign in', 'signed-out page shows the Sign in screen');
    check(await signedOut(page), 'no console tabs are shown while signed out');
    check(await page.locator('#authForm input[name=email]').count() === 1 && await page.locator('#authForm input[name=password]').count() === 1, 'email and password fields present');
    check(await page.locator('a[data-mode=reset]').count() === 1, '"Forgot your password?" link present');
    check(b.log.filter((l) => l.path.startsWith('/rest/')).length === 0, 'no data is requested while signed out');
    check(await hscroll(page) <= 0, 'signed-out page has no horizontal scroll');

    // ---------------------------------------------------------------- 2. wrong credentials
    await page.fill('#authForm input[name=email]', EMAIL); await page.fill('#authForm input[name=password]', 'nope-nope-nope');
    await page.click('#authForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#authMsg')?.textContent.trim());
    const msg = await text(page, '#authMsg');
    check(/email and password don.t match/i.test(msg), `wrong password shows a plain error ("${msg}")`);
    check(await signedOut(page), 'still signed out after wrong credentials');
    check(await page.locator('#authForm button[type=submit]').isEnabled(), 'submit button is usable again after an error');
    check(await page.evaluate(() => localStorage.getItem('mock-sb-session')) === null, 'no session stored after wrong credentials');

    // ---------------------------------------------------------------- 3. validation (nothing is sent)
    const before = b.count('POST', '/auth/v1/token');
    await page.fill('#authForm input[name=email]', ''); await page.fill('#authForm input[name=password]', '');
    await page.click('#authForm button[type=submit]');
    check(/enter your email/i.test(await text(page, '#authMsg')), 'empty email is rejected with a message');
    await page.fill('#authForm input[name=email]', 'not-an-email'); await page.click('#authForm button[type=submit]');
    check(/doesn.t look right/i.test(await text(page, '#authMsg')), 'malformed email is rejected');
    await page.fill('#authForm input[name=email]', EMAIL); await page.click('#authForm button[type=submit]');
    check(/enter your password/i.test(await text(page, '#authMsg')), 'empty password is rejected');
    check(b.count('POST', '/auth/v1/token') === before, 'validation failures send nothing to the backend');

    // ---------------------------------------------------------------- 4. unconfirmed email, network failure
    b.unconfirmed.add(EMAIL); await page.fill('#authForm input[name=password]', PASSWORD); await page.click('#authForm button[type=submit]');
    await page.waitForFunction(() => /confirm your email/i.test(document.querySelector('#authMsg')?.textContent ?? ''));
    check(true, 'unconfirmed email says to confirm the email first'); b.unconfirmed.clear();
    await page.route('**/auth/v1/token**', (r) => r.abort()); // browser-level network failure (takes precedence over the context route)
    await page.click('#authForm button[type=submit]');
    await page.waitForFunction(() => /couldn.t reach everyspace/i.test(document.querySelector('#authMsg')?.textContent ?? ''));
    check(true, 'network failure on sign-in shows "Couldn\'t reach Everyspace"'); expected(/Failed to load resource|ERR_FAILED|supabase\.co\/auth\/v1\/token[^\n]*CORS request did not succeed/);
    await page.unroute('**/auth/v1/token**');

    // ---------------------------------------------------------------- 5. create account
    await page.click('a[data-act=authmode]:not([data-mode])'); // "Create an account"
    check((await text(page, 'h1')) === 'Create your host account', 'Create an account switches to the sign-up form');
    check(await page.locator('#authForm input[name=name]').count() === 1, 'sign-up asks for a name');
    await page.fill('#authForm input[name=email]', 'new@example.test'); await page.fill('#authForm input[name=password]', 'longenough1');
    await page.click('#authForm button[type=submit]');
    check(/enter your name/i.test(await text(page, '#authMsg')), 'sign-up without a name is rejected');
    await page.fill('#authForm input[name=name]', 'New Host'); await page.fill('#authForm input[name=password]', 'short');
    await page.click('#authForm button[type=submit]');
    check(/at least 8 characters/i.test(await text(page, '#authMsg')), 'a short password is rejected before anything is sent');
    check(b.count('POST', '/auth/v1/signup') === 0, 'invalid sign-up sent nothing');
    await page.fill('#authForm input[name=password]', 'longenough1');
    b.delay = 250; await page.click('#authForm button[type=submit]'); await page.click('#authForm button[type=submit]', { force: true, timeout: 500 }).catch(() => {});
    await page.waitForFunction(() => /check your email/i.test(document.querySelector('#authMsg')?.textContent ?? ''));
    b.delay = 0;
    check(b.count('POST', '/auth/v1/signup') === 1, 'double-clicking Create account sends one request');
    const su = b.log.find((l) => l.path === '/auth/v1/signup'); const suBody = JSON.parse(su.body);
    check(suBody.data?.full_name === 'New Host' && suBody.email === 'new@example.test', 'sign-up sends the name and email');
    check(decodeURIComponent(su.query.split('redirect_to=')[1]) === PAGE, `confirmation link returns to this same page (${decodeURIComponent(su.query.split('redirect_to=')[1])})`);
    check((await text(page, 'h1')) === 'Sign in' && /check your email/i.test(await text(page, '#authMsg')), 'after sign-up the page says to check email and shows Sign in');
    await page.click('a[data-act=authmode]:not([data-mode])');
    check((await text(page, 'h1')) === 'Create your host account', 'the "Create an account" link still works after a sign-up message');
    await page.click('a[data-act=authmode]:not([data-mode])');
    check((await text(page, 'h1')) === 'Sign in', 'the "Sign in" link goes back to Sign in');

    // ---------------------------------------------------------------- 6. forgot password never reveals whether the email exists
    await page.click('a[data-mode=reset]');
    check((await text(page, 'h1')) === 'Reset your password', 'Forgot password opens the reset form');
    const reply = {};
    for (const [k, email] of [['known', EMAIL], ['unknown', 'nobody@example.test']]) {
      await page.fill('#resetForm input[name=email]', email); await page.click('#resetForm button[type=submit]');
      await page.waitForFunction(() => document.querySelector('#authMsg')?.textContent.trim());
      reply[k] = await text(page, '#authMsg');
      await page.reload(); await page.waitForSelector('#authForm'); await page.click('a[data-mode=reset]');
    }
    check(reply.known === reply.unknown && /if that email has an account/i.test(reply.known), `reset confirmation is identical for known and unknown emails ("${reply.known}")`);
    check(b.count('POST', '/auth/v1/recover') === 2, 'both reset requests were sent');
    const rc = b.log.find((l) => l.path === '/auth/v1/recover');
    check(decodeURIComponent(rc.query.split('redirect_to=')[1]) === PAGE, 'reset link returns to this same page');
    await page.fill('#resetForm input[name=email]', ''); await page.click('#resetForm button[type=submit]');
    check(/enter your email/i.test(await text(page, '#authMsg')) && b.count('POST', '/auth/v1/recover') === 2, 'reset with an empty email is rejected locally');
    await context.close();
  }

  // ---------------------------------------------------------------- 7. correct credentials, restore, sign out
  {
    const b = new Backend(baseData()); const { context, page } = await fresh(b);
    await page.goto(PAGE + '?utm=1'); await page.waitForSelector('#authForm');
    await page.fill('#authForm input[name=email]', EMAIL); await page.fill('#authForm input[name=password]', PASSWORD);
    b.delay = 200; await page.click('#authForm button[type=submit]'); await page.click('#authForm button[type=submit]', { force: true, timeout: 400 }).catch(() => {}); b.delay = 0;
    check(await dashboard(page) === 1, 'correct credentials reach the dashboard');
    check(b.count('POST', '/auth/v1/token') === 1, 'signing in sent one request even when clicked twice');
    check(!(await page.locator('#authForm').count()), 'the sign-in form is gone once signed in');
    check(await hscroll(page) <= 0, 'dashboard has no horizontal scroll');
    // session restore
    await page.reload(); await page.waitForSelector('.tabs');
    check(await page.locator('h1', { hasText: 'Hi Test' }).count() === 1 && !(await page.locator('#authForm').count()), 'reload restores the session and shows the dashboard');
    // sign out
    await page.click('[data-act=signout]'); await page.waitForSelector('#authForm');
    check(await signedOut(page) && (await text(page, 'h1')) === 'Sign in', 'sign-out returns to the sign-in screen');
    check((await text(page, '#authMsg')).trim() === '', 'a deliberate sign-out shows no "session ended" message');
    check(await page.evaluate(() => localStorage.getItem('mock-sb-session')) === null, 'sign-out clears the stored session');
    await page.reload(); await page.waitForSelector('#authForm');
    check(await signedOut(page), 'after sign-out a reload stays signed out');
    // data of the previous host is not left on the page
    check(!(await page.content()).includes('Test Host'), 'the signed-out page holds no data from the previous session');
    // sign-out while offline still signs out locally
    await page.fill('#authForm input[name=email]', EMAIL); await page.fill('#authForm input[name=password]', PASSWORD); await page.click('#authForm button[type=submit]'); await dashboard(page);
    await page.route('**/auth/v1/logout**', (r) => r.abort()); await page.click('[data-act=signout]'); await page.waitForSelector('#authForm');
    check(await signedOut(page), 'sign-out works even when the network call fails'); expected(/Failed to load resource|ERR_FAILED|supabase\.co\/auth\/v1\/logout[^\n]*CORS request did not succeed/); await page.unroute('**/auth/v1/logout**');
    await context.close();
  }

  // ---------------------------------------------------------------- 8. expired session
  {
    const b = new Backend(baseData()); const { context, page } = await fresh(b);
    await page.goto(PAGE); await page.waitForSelector('#authForm');
    await page.fill('#authForm input[name=email]', EMAIL); await page.fill('#authForm input[name=password]', PASSWORD); await page.click('#authForm button[type=submit]'); await dashboard(page);
    await page.evaluate(() => window.__mockAuth.expire()); // the login service ends the session (refresh token revoked or expired)
    await page.waitForSelector('#authForm');
    check(/session ended/i.test(await text(page, '#authMsg')), 'a session ended by the server returns to sign-in with a message');
    check(await signedOut(page), 'expired session shows no console');
    // back in, then the data service rejects the token mid-use
    await page.fill('#authForm input[name=email]', EMAIL); await page.fill('#authForm input[name=password]', PASSWORD); await page.click('#authForm button[type=submit]'); await dashboard(page);
    b.fn['calendar-sync'] = async () => ({ status: 401, body: { code: 401, message: 'Invalid JWT' } });
    await page.click('[data-act=syncall]'); await page.waitForSelector('#authForm');
    check(/session ended/i.test(await text(page, '#authMsg')), 'a 401 from an action returns to sign-in with a message');
    await page.fill('#authForm input[name=email]', EMAIL); await page.fill('#authForm input[name=password]', PASSWORD); await page.click('#authForm button[type=submit]'); await dashboard(page);
    await page.reload(); await page.waitForSelector('.tabs'); b.jwtExpired = true; // the token is rejected on the next load
    await page.reload(); await page.waitForSelector('#authForm');
    check(await signedOut(page) && /session ended/i.test(await text(page, '#authMsg')), 'an expired token on load explains why');
    expected(/401|Failed to load resource/);
    await context.close();
  }

  // ---------------------------------------------------------------- 9. recovery link
  {
    const b = new Backend(baseData()); const { context, page } = await fresh(b);
    await page.goto(PAGE + '#access_token=rec-token&refresh_token=r&type=recovery&expires_in=3600');
    await page.waitForSelector('#newPwForm');
    await page.waitForTimeout(600); // the dashboard load that races the recovery event must not replace this screen
    check((await text(page, 'h1')) === 'Set a new password' && await page.locator('#newPwForm').count() === 1, 'a recovery link opens the set-new-password screen');
    check(await page.locator('.tabs').count() === 0, 'the dashboard does not replace the recovery screen');
    check(!page.url().includes('access_token'), 'the recovery token is removed from the address bar');
    await page.fill('#newPwForm input[name=password]', 'brand-new-pass1'); await page.fill('#newPwForm input[name=password2]', 'different-pass1'); await page.click('#newPwForm button[type=submit]');
    check(/don.t match/i.test(await text(page, '#authMsg')), 'mismatched new passwords are rejected');
    await page.fill('#newPwForm input[name=password]', 'short'); await page.fill('#newPwForm input[name=password2]', 'short'); await page.click('#newPwForm button[type=submit]');
    check(/at least 8/i.test(await text(page, '#authMsg')), 'a too-short new password is rejected');
    check(b.count('PUT', '/auth/v1/user') === 0, 'rejected passwords are never sent');
    await page.fill('#newPwForm input[name=password]', 'brand-new-pass1'); await page.fill('#newPwForm input[name=password2]', 'brand-new-pass1');
    b.delay = 200; await page.click('#newPwForm button[type=submit]'); await page.click('#newPwForm button[type=submit]', { force: true, timeout: 400 }).catch(() => {}); b.delay = 0;
    check(await dashboard(page) === 1, 'saving a matching new password reaches the dashboard');
    check(b.count('PUT', '/auth/v1/user') === 1 && JSON.parse(b.log.find((l) => l.method === 'PUT').body).password === 'brand-new-pass1', 'the new password was sent once');
    await context.close();
    // cancel from the recovery screen
    const b2 = new Backend(baseData()); const c2 = await fresh(b2);
    await c2.page.goto(PAGE + '#access_token=rec-token&refresh_token=r&type=recovery'); await c2.page.waitForSelector('#newPwForm');
    await c2.page.click('a[data-act=signout]'); await c2.page.waitForSelector('#authForm');
    check(await signedOut(c2.page), 'Cancel on the recovery screen signs out');
    await c2.context.close();
    // an expired or already-used link
    const b3 = new Backend(baseData()); const c3 = await fresh(b3);
    await c3.page.goto(PAGE + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    await c3.page.waitForSelector('#resetForm');
    check(/expired or was already used/i.test(await text(c3.page, '#authMsg')), 'an expired email link explains itself and offers a new one');
    await c3.context.close();
  }

  // ---------------------------------------------------------------- 10. the sign-in library cannot load
  {
    const b = new Backend(baseData()); const s2 = { supabase: 0, other: [], blockCdn: true };
    const context = await browser.newContext(); await wire(context, b, s2); const page = await context.newPage(); const errs = []; watch(page, errs);
    await page.goto(PAGE); await page.waitForSelector('[role=alert]');
    check(/could not be downloaded/i.test(await text(page, '[role=alert]')), 'if the sign-in library is blocked the page says so instead of staying on "Loading…"');
    check(errs.every((e) => /Failed to load resource|ERR_FAILED/.test(e)), 'only the blocked download is logged as an error');
    await context.close();
  }

  check(errors.length === 0, `zero console errors and unhandled rejections${errors.length ? ': ' + errors.join(' | ') : ''}`);
  const unmocked = [...seen.other, ...Backend.all.flatMap((x) => x.unmocked)];
  check(unmocked.length === 0, `zero unmocked requests${unmocked.length ? ': ' + unmocked.join(' | ') : ''}`);
  check(seen.supabase > 0, `backend requests were intercepted (${seen.supabase})`);
} catch (e) { check(false, 'test crashed: ' + e.stack); }
finally { await browser.close(); server.close(); }
if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nall sign-in e2e checks passed');

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeCalendarUrl, fetchCalendar, isPrivateAddress, type FetchOptions } from '../supabase/functions/_shared/fetch.ts';
import { ProviderError } from '../supabase/functions/_shared/providers/adapter.ts';

const PUBLIC = '93.184.216.34';
const SECRET = 'SECRETTOKEN123';
const URL_ = `https://cal.example.com/ical/abc.ics?token=${SECRET}`;
const ICS = 'BEGIN:VCALENDAR\nEND:VCALENDAR';
const publicDns = async () => [PUBLIC];

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as unknown as typeof fetch;
  return { fn, calls };
}
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x) => x);
  assert.ok(e instanceof ProviderError, `expected ProviderError, got ${e}`);
  assert.equal(e.code, code, e.message);
  return e as ProviderError;
};
const opts = (f: ReturnType<typeof fakeFetch>, extra: FetchOptions = {}): FetchOptions => ({ fetch: f.fn, resolve: publicDns, ...extra });

test('reads a calendar over https and uses manual redirects', async () => {
  const f = fakeFetch(() => new Response(ICS));
  assert.equal(await fetchCalendar(URL_, opts(f)), ICS);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.redirect, 'manual');
});

test('only https links with no credentials and the default port', () => {
  for (const u of ['http://cal.example.com/a.ics', 'webcal://cal.example.com/a.ics', 'ftp://cal.example.com/a', 'cal.example.com/a.ics', '']) {
    assert.throws(() => assertSafeCalendarUrl(u), (e: ProviderError) => e.code === 'blocked_url', u);
  }
  assert.throws(() => assertSafeCalendarUrl('https://user:pw@cal.example.com/a.ics'), (e: ProviderError) => e.code === 'blocked_url');
  assert.throws(() => assertSafeCalendarUrl('https://user@cal.example.com/a.ics'), (e: ProviderError) => e.code === 'blocked_url');
  assert.throws(() => assertSafeCalendarUrl('https://cal.example.com:8443/a.ics'), (e: ProviderError) => e.code === 'blocked_url');
  assert.doesNotThrow(() => assertSafeCalendarUrl('https://cal.example.com:443/a.ics')); // 443 is the default
});

test('IP-literal hosts in private, loopback, link-local, CGNAT, multicast and unspecified ranges are rejected', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255',
    '224.0.0.1', '239.255.255.255', '0.0.0.0', '255.255.255.255', '240.0.0.1',
    '[::1]', '[::]', '[fe80::1]', '[fc00::1]', '[fd12:3456::1]', '[ff02::1]', '[2001:db8::1]',
    '2130706433', '0x7f.0.0.1', '017700000001', '127.1', // other spellings of 127.0.0.1
  ];
  for (const h of blocked) assert.throws(() => assertSafeCalendarUrl(`https://${h}/a.ics?token=${SECRET}`), (e: ProviderError) => e.code === 'blocked_url', h);
});

test('IPv4-mapped and embedded IPv6 forms are rejected', () => {
  for (const h of ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.1]', '[::ffff:a9fe:a9fe]', '[::ffff:8.8.8.8]', '[64:ff9b::7f00:1]', '[2002:7f00:1::]']) {
    assert.throws(() => assertSafeCalendarUrl(`https://${h}/a.ics`), (e: ProviderError) => e.code === 'blocked_url', h);
  }
});

test('public IP literals and the edges of private ranges are allowed', () => {
  for (const h of ['8.8.8.8', '172.32.0.1', '172.15.255.255', '100.63.255.255', '100.128.0.1', '169.253.0.1', '[2606:4700:4700::1111]', '[64:ff9b::808:808]']) {
    assert.doesNotThrow(() => assertSafeCalendarUrl(`https://${h}/a.ics`), h);
  }
  assert.equal(isPrivateAddress('not an address'), true); // unparseable fails closed
});

test('localhost and internal host names are rejected', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'api.localhost', 'printer.local', 'db.internal', 'metadata.google.internal', 'intranet', 'router.lan', 'nas.home.arpa']) {
    assert.throws(() => assertSafeCalendarUrl(`https://${h}/a.ics`), (e: ProviderError) => e.code === 'blocked_url', h);
  }
});

test('DNS: rejected when ANY resolved address is private', async () => {
  const f = fakeFetch(() => new Response(ICS));
  await rejects(fetchCalendar(URL_, { fetch: f.fn, resolve: async () => [PUBLIC, '10.0.0.5'] }), 'blocked_url');
  await rejects(fetchCalendar(URL_, { fetch: f.fn, resolve: async () => ['2606:4700::1', '::ffff:127.0.0.1'] }), 'blocked_url');
  await rejects(fetchCalendar(URL_, { fetch: f.fn, resolve: async () => ['169.254.169.254'] }), 'blocked_url');
  await rejects(fetchCalendar(URL_, { fetch: f.fn, resolve: async () => [] }), 'blocked_url');
  assert.equal(f.calls.length, 0, 'no request is made to a blocked host');
});

test('DNS: a failing lookup fails closed; a runtime with no resolver (null) relies on literal checks', async () => {
  const f = fakeFetch(() => new Response(ICS));
  await rejects(fetchCalendar(URL_, { fetch: f.fn, resolve: async () => { throw new Error('NXDOMAIN'); } }), 'fetch_failed');
  assert.equal(await fetchCalendar(URL_, { fetch: f.fn, resolve: async () => null }), ICS);
  assert.equal(await fetchCalendar(URL_, { fetch: f.fn, resolve: null }), ICS);
});

test('redirects are followed by hand, up to 3, and relative ones work', async () => {
  const f = fakeFetch((url) => {
    if (url.endsWith('/a')) return redirect('/b');
    if (url.endsWith('/b')) return redirect('https://cdn.example.net/c', 301);
    if (url.endsWith('/c')) return redirect('/d', 307);
    return new Response(ICS);
  });
  assert.equal(await fetchCalendar('https://cal.example.com/a', opts(f)), ICS);
  assert.deepEqual(f.calls.map((c) => c.url), ['https://cal.example.com/a', 'https://cal.example.com/b', 'https://cdn.example.net/c', 'https://cdn.example.net/d']);
});

test('a fourth redirect is refused', async () => {
  const f = fakeFetch((url) => redirect(`${url}x`));
  await rejects(fetchCalendar('https://cal.example.com/a', opts(f)), 'fetch_failed');
  assert.equal(f.calls.length, 4);
});

test('a redirect to a private IP is blocked before it is requested', async () => {
  for (const to of ['https://127.0.0.1/a', 'https://[::1]/a', 'https://169.254.169.254/latest/meta-data', 'http://cal.example.com/a', 'https://user:pw@cal.example.com/a', 'https://cal.example.com:8080/a', 'https://localhost/a']) {
    const f = fakeFetch(() => redirect(to));
    await rejects(fetchCalendar(URL_, opts(f)), 'blocked_url');
    assert.equal(f.calls.length, 1, to);
  }
});

test('a redirect to a name that resolves to a private address is blocked (every hop is re-resolved)', async () => {
  const f = fakeFetch(() => redirect('https://evil.example.org/x'));
  const resolve = async (h: string) => (h === 'evil.example.org' ? ['192.168.0.9'] : [PUBLIC]);
  await rejects(fetchCalendar(URL_, { fetch: f.fn, resolve }), 'blocked_url');
  assert.equal(f.calls.length, 1);
});

test('a redirect with no Location is an error', async () => {
  const f = fakeFetch(() => new Response(null, { status: 302 }));
  await rejects(fetchCalendar(URL_, opts(f)), 'fetch_failed');
});

test('times out when the site never answers', async () => {
  const f = fakeFetch((_u, init) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason))));
  await rejects(fetchCalendar(URL_, opts(f, { timeoutMs: 20 })), 'timeout');
});

test('times out when the body stalls', async () => {
  const f = fakeFetch(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('BEGIN:VCALENDAR')); } })));
  await rejects(fetchCalendar(URL_, opts(f, { timeoutMs: 30 })), 'timeout');
});

test('oversize bodies are refused while streaming, and by declared length', async () => {
  const big = fakeFetch(() => new Response('x'.repeat(5000)));
  await rejects(fetchCalendar(URL_, opts(big, { maxBytes: 1000 })), 'too_large');
  const declared = fakeFetch(() => new Response('small', { headers: { 'content-length': '999999999' } }));
  await rejects(fetchCalendar(URL_, opts(declared)), 'too_large');
  const exact = fakeFetch(() => new Response('x'.repeat(1000)));
  assert.equal((await fetchCalendar(URL_, opts(exact, { maxBytes: 1000 }))).length, 1000);
});

test('HTTP errors have clear messages; 404 says the link is gone', async () => {
  const gone = await rejects(fetchCalendar(URL_, opts(fakeFetch(() => new Response('no', { status: 404 })))), 'fetch_failed');
  assert.match(gone.message, /no longer exists/);
  const down = await rejects(fetchCalendar(URL_, opts(fakeFetch(() => new Response('no', { status: 503 })))), 'fetch_failed');
  assert.match(down.message, /503/);
});

test('no error ever contains the URL or its query string', async () => {
  const hostile = `https://cal.example.com/a.ics?token=${SECRET}`;
  const cases: [string, FetchOptions][] = [
    [`http://cal.example.com/a.ics?token=${SECRET}`, {}],
    [`https://user:${SECRET}@cal.example.com/a.ics?token=${SECRET}`, {}],
    [`https://127.0.0.1/a.ics?token=${SECRET}`, {}],
    [`https://localhost/a.ics?token=${SECRET}`, {}],
    [hostile, opts(fakeFetch(() => new Response('', { status: 500 })))],
    [hostile, opts(fakeFetch(() => new Response('', { status: 404 })))],
    [hostile, opts(fakeFetch(() => { throw new Error(`connect ECONNREFUSED ${hostile}`); }))],
    [hostile, opts(fakeFetch(() => redirect(`https://127.0.0.1/x?token=${SECRET}`)))],
    [hostile, opts(fakeFetch(() => new Response('x'.repeat(5000))), { maxBytes: 10 })],
    [hostile, { fetch: fakeFetch(() => new Response('')).fn, resolve: async () => ['10.0.0.1'] }],
    [hostile, { fetch: fakeFetch(() => new Response('')).fn, resolve: async () => { throw new Error(hostile); } }],
  ];
  for (const [url, o] of cases) {
    const e = await fetchCalendar(url, o).then(() => null, (x) => x as ProviderError);
    assert.ok(e instanceof ProviderError);
    assert.ok(!`${e.message} ${e.details.join(' ')} ${e.stack?.split('\n')[0]}`.includes(SECRET), `${e.code}: ${e.message}`);
    assert.ok(!e.message.includes('token='));
  }
  const slow = await fetchCalendar(hostile, opts(fakeFetch((_u, init) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(init.signal!.reason)))), { timeoutMs: 10 })).then(() => null, (x) => x as ProviderError);
  assert.ok(!slow!.message.includes(SECRET));
});

test('network failures become fetch_failed with a fixed message', async () => {
  const e = await rejects(fetchCalendar(URL_, opts(fakeFetch(() => { throw new TypeError('fetch failed'); }))), 'fetch_failed');
  assert.match(e.message, /Couldn't reach/);
});

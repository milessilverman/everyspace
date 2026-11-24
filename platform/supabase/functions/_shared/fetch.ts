// Reads a calendar link a host pasted, from another site, safely.
//
// The link is untrusted input, so before every request (and every redirect hop) we require:
//   https only, no user:password in the URL, default port only, a public host name, and, when a DNS resolver is
//   available, that EVERY address the name resolves to is a public one. Redirects are followed by hand (max 3) and
//   each hop is checked again. Time (15 s total) and size (3 MB, counted while streaming) are capped.
// The URL's query string carries the secret token of the calendar, so no error message, and nothing logged, ever
// contains the URL: messages are fixed text.
//
// Residual risk (cannot be closed in this layer): DNS rebinding. We resolve the name to check it, then fetch() resolves it
// again itself; a hostile DNS server could answer differently the second time. Deno's fetch does not let us pin the
// address. Also, when the runtime has no `Deno.resolveDns` (e.g. a platform that does not implement it) the default
// resolver returns null and only the host-name and IP-literal checks apply; failing closed there would reject every
// calendar. Egress filtering at the platform level is the real fix for both.
import { ProviderError } from './providers/adapter.ts';

/** Returns the addresses a host name resolves to, or null when this runtime cannot resolve (then only literal checks apply). */
export type Resolver = (host: string) => Promise<string[] | null>;
export type FetchOptions = {
  /** Replaces the global fetch (tests). */
  fetch?: typeof fetch;
  /** Replaces DNS resolution (tests). `null` skips the DNS check. */
  resolve?: Resolver | null;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

export const MAX_BYTES = 3_000_000;
export const TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2048;

// ---------------------------------------------------------------- address classification

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.includes('%')) return null;
  if (s.includes('.')) {
    const i = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(i + 1));
    if (!v4) return null;
    s = `${s.slice(0, i + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) { if (!/^[0-9a-f]{1,4}$/.test(g)) return null; out.push(parseInt(g, 16)); }
    return out;
  };
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill >= 1 ? [...head, ...Array(fill).fill(0), ...tail] : null;
}

function blockedIPv4(o: number[]): boolean {
  const [a, b, c] = o;
  return a === 0 // "this network", unspecified
    || a === 10 // private
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || a === 127 // loopback
    || (a === 169 && b === 254) // link-local (cloud metadata lives here)
    || (a === 172 && b >= 16 && b <= 31) // private
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF protocol / documentation
    || (a === 192 && b === 168) // private
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // documentation
    || a >= 224; // multicast, reserved, broadcast
}

function blockedIPv6(g: number[]): boolean {
  const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g[0] === 0x64 && g[1] === 0xff9b) { // NAT64: public only if the embedded IPv4 is public
    return g[2] !== 0 || g.slice(3, 6).some((x) => x !== 0) || blockedIPv4(v4(g[6], g[7]));
  }
  if ((g[0] & 0xff00) === 0) return true; // ::/8: unspecified, loopback, IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return true; // documentation, Teredo
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x0010) return true; // ORCHID (2001:10::/28), not routable
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only 100::/64
  if (g[0] === 0x2002) return blockedIPv4(v4(g[1], g[2])); // 6to4 embeds an IPv4 address
  return false;
}

/** True if the address is not a normal public one. Anything unparseable counts as blocked. */
export function isPrivateAddress(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(s);
  if (v4) return blockedIPv4(v4);
  const v6 = parseIPv6(s);
  return v6 ? blockedIPv6(v6) : true;
}

const isIpLiteral = (host: string) => parseIPv4(host) !== null || host.includes(':');
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

function blockedName(host: string): boolean {
  return host === 'localhost' || !host.includes('.') || host.split('.').some((l) => l === '') || BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
}

/** Checks everything about a URL that does not need the network. Returns the parsed URL or throws ProviderError('blocked_url'). */
export function assertSafeCalendarUrl(raw: string): URL {
  const bad = (message: string) => new ProviderError('blocked_url', message);
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) throw bad("That doesn't look like a calendar link.");
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw bad("That doesn't look like a calendar link."); }
  if (u.protocol !== 'https:') throw bad('Calendar links must start with https://');
  if (u.username || u.password) throw bad('Calendar links cannot contain a user name or password.');
  if (u.port !== '') throw bad('Calendar links must use the standard secure port.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIpLiteral(host) ? isPrivateAddress(host) : blockedName(host)) throw bad("Everyspace can't read calendars from that address.");
  return u;
}

// ---------------------------------------------------------------- DNS

/** Default resolver: Deno's, when it exists. Returns null where the runtime cannot resolve DNS. */
export const defaultResolver: Resolver = async (host) => {
  // deno-lint-ignore no-explicit-any
  const d = (globalThis as any).Deno;
  if (!d || typeof d.resolveDns !== 'function') return null;
  const out: string[] = [];
  let unsupported = 0; let answered = 0;
  for (const type of ['A', 'AAAA']) {
    try {
      out.push(...(await d.resolveDns(host, type)) as string[]);
      answered++;
    } catch (e) {
      const text = `${(e as Error)?.name ?? ''} ${(e as Error)?.message ?? ''}`;
      if (/NotSupported|not (yet )?(implemented|supported)|unsupported/i.test(text)) { unsupported++; continue; }
      // "No records of this type" is a valid answer; any other failure (timeout, SERVFAIL, ...) is not, and the
      // runtime's own lookup might still return a private address: fail closed.
      if (/NotFound|no (such )?(record|data|address)|NXDOMAIN|not found/i.test(text)) { answered++; continue; }
      throw new Error(`DNS lookup failed (${type})`);
    }
  }
  if (unsupported === 2) return null; // this runtime cannot resolve at all: documented fail-open
  if (unsupported > 0) throw new Error('DNS lookup incomplete'); // one type unsupported: partial answer, fail closed
  if (out.length && answered > 0) return out;
  throw new Error('no addresses');
};

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

async function assertPublicHost(u: URL, resolve: Resolver | null, signal: AbortSignal): Promise<void> {
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (isIpLiteral(host) || !resolve) return;
  let addrs: string[] | null;
  try { addrs = await raceAbort(resolve(host), signal); } catch (e) {
    if (signal.aborted) throw e;
    throw new ProviderError('fetch_failed', "Couldn't find that site. Check the calendar link.");
  }
  if (addrs === null) return;
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new ProviderError('blocked_url', "Everyspace can't read calendars from that address.");
}

// ---------------------------------------------------------------- reading

async function readLimited(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const tooBig = () => new ProviderError('too_large', `That calendar is too large to read (over ${Math.round(maxBytes / 1_000_000)} MB).`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) { res.body?.cancel().catch(() => {}); throw tooBig(); }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await raceAbort(reader.read(), signal).catch((e) => { reader.cancel().catch(() => {}); throw e; });
    if (done) break;
    size += value.length;
    if (size > maxBytes) { reader.cancel().catch(() => {}); throw tooBig(); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

const isRedirect = (s: number) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

export async function fetchCalendar(url: string, opts: FetchOptions = {}): Promise<string> {
  const doFetch = opts.fetch ?? fetch;
  const resolve = opts.resolve === undefined ? defaultResolver : opts.resolve;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  // Our own timer (not AbortSignal.timeout) so it is cleared when done and keeps the event loop honest in tests.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException('timed out', 'TimeoutError')), timeoutMs);
  const signal = ctl.signal;
  try {
    let current = assertSafeCalendarUrl(url);
    for (let followed = 0; ; followed++) {
      await assertPublicHost(current, resolve, signal);
      const res = await doFetch(current.href, {
        signal, redirect: 'manual', cache: 'no-store',
        headers: { 'user-agent': 'Everyspace-CalendarSync/1.0 (+https://everyspace.app)', accept: 'text/calendar, */*' },
      });
      if (isRedirect(res.status)) {
        res.body?.cancel().catch(() => {});
        if (followed >= maxRedirects) throw new ProviderError('fetch_failed', 'That calendar link redirects too many times.');
        const location = res.headers.get('location');
        if (!location) throw new ProviderError('fetch_failed', 'The site sent us somewhere without saying where.');
        let next: URL;
        try { next = new URL(location, current); } catch { throw new ProviderError('blocked_url', "Everyspace can't read calendars from that address."); }
        current = assertSafeCalendarUrl(next.href);
        continue;
      }
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw new ProviderError('fetch_failed', res.status === 404
          ? 'The site says this calendar link no longer exists. Copy a fresh link from the site.'
          : `The site answered with an error (${res.status}). We'll retry.`);
      }
      return await readLimited(res, maxBytes, signal);
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (signal.aborted) throw new ProviderError('timeout', `That site took too long to answer (over ${Math.round(timeoutMs / 1000)} seconds). We'll retry.`);
    // Never pass the underlying message on: network errors can embed the host name.
    throw new ProviderError('fetch_failed', "Couldn't reach that site. We'll retry.");
  } finally {
    clearTimeout(timer);
  }
}

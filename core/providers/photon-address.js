// @ts-check
// Photon (komoot) address suggestions: keyless, OpenStreetMap data, used for address autofill OUTSIDE Los Angeles County
// (the LA County locator stays first). Photon is a free best-effort service ("please be fair", no availability promise; docs/zillow.md),
// so this provider is deliberately polite and silent:
//   - no request for fewer than MIN_CHARS (4) characters;
//   - at most ONE request in flight (a newer question aborts the older one first) and at most one request START per MIN_INTERVAL_MS (250 ms);
//   - any failure (network, 4xx/5xx, bad JSON, abort) is returned as {ok:false}; nothing is thrown and the page shows nothing about it;
//   - only results in the United States that have a house number and a street are kept.
// Each suggestion carries its coordinates, so choosing it needs no second geocoding request. Photon's house-number results come from
// OpenStreetMap address nodes and building outlines, so the point is treated as rooftop-level (`precision: 'rooftop'`); the parcel lookup
// still retries from the building centroid if that point finds no parcel.
// Data: OpenStreetMap contributors, ODbL. Footer attribution: ATTRIBUTION_TEXT. Browser use: CORS answered `access-control-allow-origin: *`
// when last checked (2026-11-27, docs/zillow.md); if it ever stops, the source simply returns nothing.

import { qs, fail } from './util.js';

export const PHOTON_URL = 'https://photon.komoot.io/api/';
export const MIN_CHARS = 4;
export const MIN_INTERVAL_MS = 250;
export const REQUEST_LIMIT = 8;
export const MAX_SUGGESTIONS = 5;
export const ATTRIBUTION_TEXT = 'Address suggestions © OpenStreetMap contributors (via Photon)';

/** State name -> postal abbreviation (50 states and DC). */
export const STATE_ABBR = /** @type {Record<string,string>} */ ({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
});

const str = (/** @type {any} */ v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null);

/**
 * One Photon feature -> a suggestion, or null when it is not a US street address with a house number. Pure. Names are kept as plain text
 * (the page renders them with textContent; nothing here builds markup).
 * @param {any} f
 * @returns {{text:string, lat:number, lng:number, precision:'rooftop', source:'photon', osm?:string}|null}
 */
export function suggestionFromFeature(f) {
  const p = f?.properties;
  if (!p || p.countrycode !== 'US') return null;
  const house = str(p.housenumber), street = str(p.street);
  if (!house || !street) return null;
  const c = f?.geometry?.coordinates;
  const lng = Array.isArray(c) ? Number(c[0]) : NaN, lat = Array.isArray(c) ? Number(c[1]) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const state = str(p.state);
  const st = state ? (/^[A-Za-z]{2}$/.test(state) ? state.toUpperCase() : STATE_ABBR[state.toLowerCase()]) : undefined;
  if (!st) return null;
  const city = str(p.city) ?? str(p.town) ?? str(p.village) ?? str(p.municipality) ?? str(p.locality) ?? str(p.district) ?? str(p.county);
  const zip = str(p.postcode);
  const tail = `${st}${zip ? ` ${zip}` : ''}`;
  const text = [`${house} ${street}`, city, tail].filter(Boolean).join(', ');
  return { text, lat, lng, precision: 'rooftop', source: 'photon', ...(p.osm_type && p.osm_id ? { osm: `${p.osm_type}${p.osm_id}` } : {}) };
}

/**
 * A Photon address provider with its own rate limiter (one per instance; the page uses the shared `photonAddress`).
 * `deps` may carry `sleep(ms)` and `nowMs()` for tests.
 * @returns {import('./types.js').AddressProvider & {suggest:Function}}
 */
export function createPhotonAddress() {
  /** @type {AbortController|null} */ let current = null;
  /** @type {Promise<any>|null} */ let currentDone = null;
  let lastStart = -Infinity;
  /** Newest question wins: only the latest waiter may start a request after the gap. */
  let ticket = 0;
  const realSleep = (/** @type {number} */ ms, /** @type {AbortSignal|undefined} */ signal) => new Promise((resolve) => {
    if (signal?.aborted) { resolve(undefined); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(undefined); }, { once: true });
  });
  return {
    id: 'photon', label: 'Photon address search (OpenStreetMap)', kind: 'address', needsKey: false, role: 'fallback', priority: 90, verified: false,
    coverage: { national: true }, retentionDays: 0,
    licenseNote: 'Photon by komoot, public instance, fair use ("please be fair"), no availability guarantee. Data: OpenStreetMap contributors, ODbL; attribution required. Typed text is sent to photon.komoot.io.',
    /**
     * @param {string} text
     * @param {{fetch?:(url:string, init?:any)=>Promise<any>, signal?:AbortSignal, bias?:{lat:number,lng:number}|null, sleep?:(ms:number, signal?:AbortSignal)=>Promise<any>, nowMs?:()=>number}} [deps]
     */
    async suggest(text, deps = {}) {
      const t = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
      if (t.length < MIN_CHARS) return { ok: true, suggestions: [] };
      if (typeof deps.fetch !== 'function') return fail('no fetch provided', 'no_fetch');
      const sleep = deps.sleep ?? realSleep, nowMs = deps.nowMs ?? (() => Date.now());
      const mine = ++ticket;
      // one in flight: stop the older request, then wait for it to settle before starting
      if (current) { current.abort(); try { await currentDone; } catch { /* settled */ } }
      const wait = lastStart + MIN_INTERVAL_MS - nowMs();
      if (wait > 0) await sleep(wait, deps.signal);
      if (mine !== ticket) return fail('superseded by a newer question', 'aborted'); // a newer keystroke arrived while waiting
      if (deps.signal?.aborted) return fail('aborted', 'aborted');
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      deps.signal?.addEventListener('abort', onAbort, { once: true });
      current = ctl;
      lastStart = nowMs();
      const params = { q: t, limit: String(REQUEST_LIMIT), lang: 'en' };
      const b = deps.bias;
      if (b && Number.isFinite(b.lat) && Number.isFinite(b.lng)) Object.assign(params, { lat: b.lat.toFixed(4), lon: b.lng.toFixed(4) });
      const run = (async () => {
        try {
          const res = await deps.fetch?.(`${PHOTON_URL}?${qs(params)}`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
          if (!res?.ok) return fail(`Photon answered HTTP ${res?.status ?? '?'}`, 'http_error');
          const j = await res.json();
          if (!Array.isArray(j?.features)) return fail('malformed response', 'malformed_json');
          /** @type {Set<string>} */ const seen = new Set();
          const suggestions = [];
          for (const f of j.features) {
            const s = suggestionFromFeature(f);
            if (!s || seen.has(s.text)) continue;
            seen.add(s.text); suggestions.push(s);
            if (suggestions.length >= MAX_SUGGESTIONS) break;
          }
          return { ok: /** @type {const} */ (true), suggestions };
        } catch (e) { return fail(e instanceof Error ? e.message : 'network', ctl.signal.aborted ? 'aborted' : 'network'); }
        finally { deps.signal?.removeEventListener('abort', onAbort); if (current === ctl) current = null; }
      })();
      currentDone = run;
      return run;
    },
    /** A chosen suggestion already carries its point; a plain string is not geocoded here (no second request). */
    async resolve(input) {
      const s = /** @type {any} */ (input);
      if (s && typeof s === 'object' && Number.isFinite(s.lat) && Number.isFinite(s.lng) && typeof s.text === 'string') {
        return { ok: /** @type {const} */ (true), address: s.text, lat: s.lat, lng: s.lng, confidence: 0.7, note: 'Coordinates of the address suggestion you chose (OpenStreetMap).' };
      }
      return fail('Photon is used for suggestions only; a typed address is located by the geocoder', 'unsupported');
    },
  };
}

/** The page-wide instance (one limiter for every address field). */
export const photonAddress = createPhotonAddress();

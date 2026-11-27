// @ts-check
// Address -> parcel -> property profile. All HTTP goes through an injected `fetch`; no clock (times come from the
// injected `now`); nothing is guessed: a failed lookup returns {ok:false, reason} and the attribute is recorded as
// 'unavailable'. Pattern (county-first, then statewide registry; ok:false with a reason) vendored from City Pretty
// workers/parcels.ts at commit ac7faf3; geocoder fallback and addressMismatch from workers/sources.ts:105-160; the
// Overpass/ODbL handling from workers/sources.ts:1140-1230. Parcel classification is ported from everyspace-demo index.html:8836.

import { sourced, unavailable } from './provenance.js';
import { createProfile, setAttribute } from './profile.js';
import { polygonAreaSqft, pointInPolygon, distanceM, centroid, yardAreaSqft } from './geometry.js';
import { PARCEL_SERVICES } from './data/parcel-services.js';

/** @typedef {import('./types.js').PropertyProfile} PropertyProfile */
/** @typedef {import('./data/parcel-services.js').ParcelService} ParcelService */
/**
 * @typedef {Object} Deps
 * @property {(url:string, init?:any)=>Promise<any>} fetch  injected, fetch-compatible
 * @property {string} [now]            ISO time stamped on retrieved values
 * @property {number} [timeoutMs]      per-request timeout (default 12000)
 * @property {string} [userAgent]      server-side only: descriptive client id (no personal data). Omitted by default, because a custom header forces a CORS preflight in a browser
 * @property {ParcelService[]} [services]
 * @property {string[]} [overpassEndpoints]
 * @property {{state?:string, countyFips?:string, county?:string}} [jurisdiction]
 * @property {Array<'census'|'nominatim'>} [geocoders]   order to try (default GEOCODERS_SERVER); a browser must use BROWSER_GEOCODERS
 * @property {number} [nominatimMinIntervalMs]  minimum gap between Nominatim calls (default 1000, usage policy)
 * @property {(ms:number)=>Promise<void>} [sleep]  injected delay used by the Nominatim spacing (default: real timer)
 * @property {()=>number} [nowMs]  injected clock (ms) for the spacing; default: Date.parse(now)
 * @property {{lastAt:number|null}} [nominatimLimiter]  share one limiter between resolvers; default: one per `fetch`
 * @property {boolean} [confirmMatchedAddress]  resolveAddress: continue although the geocoder matched a different street address
 * @property {string} [parcelApn]  resolveAddress: the parcel number the owner picked from `candidates`
 */

const NOT_VERIFIED = 'not verified 2026-11-24';
const CENSUS = 'https://geocoding.geo.census.gov/geocoder';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OSM_LICENSE = 'ODbL 1.0';
const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
const TRANSIT_RADIUS_M = 1500;
const INTEL = 'Everyspace property intelligence';
const DEFAULT_SEARCH_RADIUS_M = 40;
const NOMINATIM_MIN_INTERVAL_MS = 1000; // Nominatim usage policy: at most 1 request per second for the whole application

/** Server-side geocoder order: Census first (it also returns the county FIPS), then Nominatim. */
export const GEOCODERS_SERVER = /** @type {Array<'census'|'nominatim'>} */ (['census', 'nominatim']);
// The US Census geocoder sends no Access-Control-Allow-Origin header, so a browser cannot read its response (live check
// 2026-11-24); Nominatim sends `access-control-allow-origin: *`. Pass this as `geocoders` from browser code.
export const BROWSER_GEOCODERS = /** @type {Array<'census'|'nominatim'>} */ (['nominatim']);

// Confidence assigned to each kind of value (documented here so tests and docs can cite them).
// parcelBySitus: parcel chosen by matching the geocoded street address (not containing the point): lower than parcelId.
export const CONFIDENCE = { census: 0.8, nominatim: 0.65, mismatch: 0.3, parcelId: 0.9, parcelBySitus: 0.7, polygonArea: 0.85, assessor: 0.8,
  classified: 0.6, osmBuildings: 0.5, osmPool: 0.6, yard: 0.4, transit: 0.5 };

// ---------------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------------

/**
 * GET/POST JSON through the injected fetch with a timeout. Never throws.
 * @param {string} url @param {Deps} deps @param {any} [init]
 * @returns {Promise<{ok:true, json:any}|{ok:false, reason:string, status?:number, code?:string}>}  failures carry `status` (HTTP) and `code` ('http'|'timeout'|'network'|'malformed_json')
 */
export async function fetchJson(url, deps, init = {}) {
  if (typeof deps?.fetch !== 'function') return { ok: false, reason: 'no fetch provided' };
  const timeoutMs = deps.timeoutMs ?? 12000;
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  try {
    const res = await deps.fetch(url, {
      ...init, signal: ctl.signal,
      headers: { Accept: 'application/json', ...(deps.userAgent ? { 'User-Agent': deps.userAgent } : {}), ...(init.headers ?? {}) },
    });
    if (!res || !res.ok) return { ok: false, reason: `HTTP ${res?.status ?? 'error'}`, status: res?.status, code: 'http' };
    try {
      return { ok: true, json: await res.json() };
    } catch {
      return timedOut ? { ok: false, reason: `timeout after ${timeoutMs} ms`, code: 'timeout' } : { ok: false, reason: 'malformed JSON', code: 'malformed_json' };
    }
  } catch (e) {
    return timedOut ? { ok: false, reason: `timeout after ${timeoutMs} ms`, code: 'timeout' }
      : { ok: false, reason: `network error: ${e instanceof Error ? e.message : String(e)}`, code: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string|Date|undefined} now */
export function isoNow(now) {
  const iso = now instanceof Date ? now.toISOString() : now;
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) throw new TypeError('`now` (ISO time) must be injected');
  return iso;
}

export const num = (/** @type {any} */ v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
export const pos = (/** @type {any} */ v) => { const n = num(v); return n !== null && n > 0 ? n : null; };
export const text = (/** @type {any} */ v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

// ---------------------------------------------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------------------------------------------

const DIRS = { N: 'N', NORTH: 'N', S: 'S', SOUTH: 'S', E: 'E', EAST: 'E', W: 'W', WEST: 'W' };
const SUFFIXES = /** @type {Record<string,string>} */ ({ ST: 'ST', STREET: 'ST', AVE: 'AVE', AVENUE: 'AVE', AV: 'AVE', BLVD: 'BLVD', BOULEVARD: 'BLVD',
  RD: 'RD', ROAD: 'RD', DR: 'DR', DRIVE: 'DR', LN: 'LN', LANE: 'LN', CT: 'CT', COURT: 'CT', PL: 'PL', PLACE: 'PL', WAY: 'WAY',
  TER: 'TER', TERRACE: 'TER', HWY: 'HWY', HIGHWAY: 'HWY', PKWY: 'PKWY', PARKWAY: 'PKWY', CIR: 'CIR', CIRCLE: 'CIR', SQ: 'SQ',
  SQUARE: 'SQ', ALY: 'ALY', ALLEY: 'ALY', TRL: 'TRL', TRAIL: 'TRL', PLZ: 'PLZ', PLAZA: 'PLZ' });

/**
 * Splits a street line ("200 S SPRING ST", or a situs "145 S SPRING ST LOS ANGELES CA 90012") into house number,
 * directional prefix, street-name words and normalised suffix. Null when it does not start with a house number.
 * @param {string|null|undefined} line
 * @returns {{num:string, dir:string|null, core:string[], suffix:string|null}|null}
 */
export function parseStreet(line) {
  const t = String(line ?? '').toUpperCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean);
  if (!t.length || !/^\d/.test(t[0])) return null;
  let i = 1, dir = null;
  const left = t.length - 2; // tokens after a possible directional
  if (DIRS[t[1] ?? ''] && (left >= 2 || (left === 1 && !SUFFIXES[t[2]]))) { dir = DIRS[t[1]]; i = 2; }
  const rest = t.slice(i);
  let k = -1;
  for (let j = 1; j < rest.length; j++) if (SUFFIXES[rest[j]]) { k = j; break; }
  return k < 0 ? { num: t[0], dir, core: rest, suffix: null } : { num: t[0], dir, core: rest.slice(0, k), suffix: SUFFIXES[rest[k]] };
}

/** Same street name: equal words and suffix when both have a suffix; otherwise one name is a prefix of the other. */
function sameStreetName(/** @type {NonNullable<ReturnType<typeof parseStreet>>} */ a, /** @type {NonNullable<ReturnType<typeof parseStreet>>} */ b) {
  const eq = a.core.length === b.core.length && a.core.every((x, i) => x === b.core[i]);
  if (a.suffix && b.suffix) return a.suffix === b.suffix && eq;
  const [s, l] = a.core.length <= b.core.length ? [a.core, b.core] : [b.core, a.core];
  return s.length > 0 && s.every((x, i) => x === l[i]);
}

const firstSegment = (/** @type {string} */ a) => String(a ?? '').split(',')[0];
const streetLabel = (/** @type {NonNullable<ReturnType<typeof parseStreet>>} */ p) => [...p.core, p.suffix].filter(Boolean).join(' ');

/**
 * Does a parcel's situs address ("145 S SPRING ST LOS ANGELES CA 90012") denote the geocoded street address? Same house
 * number AND same normalised street name; the directional prefix is compared when both sides have one. An empty or
 * number-less situs never matches.
 * @param {string} geocodedAddress @param {string|null|undefined} situs
 */
export function situsMatchesAddress(geocodedAddress, situs) {
  const g = parseStreet(firstSegment(geocodedAddress)), s = parseStreet(situs);
  if (!g || !s || g.num !== s.num) return false;
  if (g.dir && s.dir && g.dir !== s.dir) return false;
  return sameStreetName(g, s);
}

/**
 * House number / street direction / street name comparison (from City Pretty addressMismatch), plus a missing-number check.
 * City, state and ZIP are not compared here.
 * @param {string} requested @param {string} matched @returns {string|null}
 */
export function addressMismatch(requested, matched) {
  const tok = (/** @type {string} */ a) => a.toUpperCase().replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean);
  const r = tok(requested), m = tok(matched);
  if (/^\d/.test(r[0] || "") && !/^\d/.test(m[0] || "")) return `house number ${r[0]} missing in match`;
  if (/^\d/.test(r[0] || "") && r[0] !== m[0]) return `house number ${r[0]} vs ${m[0]}`;
  const rd = /** @type {Record<string,string>} */ (DIRS)[r[1] || ''], md = /** @type {Record<string,string>} */ (DIRS)[m[1] || ''];
  if (rd && md && rd !== md) return `street direction ${rd} vs ${md}`;
  if (rd && !md) return `direction ${rd} missing in match`;
  const rs = parseStreet(firstSegment(requested)), ms = parseStreet(firstSegment(matched));
  if (rs && ms && !sameStreetName(rs, ms)) return `street ${streetLabel(rs)} vs ${streetLabel(ms)}`;
  return null;
}

/** Pulls ", Los Angeles, CA 90001" style city/state out of what the owner typed (only when comma-separated). */
function typedPlace(/** @type {string} */ address) {
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  const m = parts.length >= 2 ? /^([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(parts[parts.length - 1]) : null;
  const state = m ? m[1].toUpperCase() : null;
  const city = state && parts.length >= 3 ? parts[parts.length - 2] : null;
  return { state, city };
}

/** Compare typed vs matched; `street` is the house-number/direction/street-name problem (needs confirmation), `list` has all problems. */
function geocodeProblems(/** @type {string} */ typed, /** @type {string} */ matchedAddress, /** @type {{city?:string,state?:string}} */ got) {
  const list = [];
  const street = addressMismatch(typed, matchedAddress);
  if (street) list.push(street);
  const t = typedPlace(typed);
  if (t.state && got.state && t.state !== got.state.toUpperCase()) list.push(`state ${t.state} vs ${got.state}`);
  if (t.city && got.city && t.city.toLowerCase() !== got.city.toLowerCase()) list.push(`city ${t.city} vs ${got.city}`);
  return { list, street };
}

/**
 * Waits (via the injected sleep) so that two Nominatim calls through the same resolver are at least the minimum interval
 * apart. Uses virtual time (last call + interval), so a fixed injected `now` stays deterministic.
 * @param {Deps} deps
 */
async function nominatimGate(deps) {
  const min = deps.nominatimMinIntervalMs ?? NOMINATIM_MIN_INTERVAL_MS;
  if (!(min > 0)) return;
  let st = deps.nominatimLimiter;
  if (!st) {
    const key = /** @type {object} */ (deps.fetch);
    st = limiters.get(key);
    if (!st) { st = { lastAt: null }; limiters.set(key, st); }
  }
  const t = deps.nowMs ? deps.nowMs() : Date.parse(isoNow(deps.now));
  const start = st.lastAt === null ? t : Math.max(t, st.lastAt + min);
  st.lastAt = start;
  if (start > t) await (deps.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))))(start - t);
}
/** @type {WeakMap<object,{lastAt:number|null}>} */
const limiters = new WeakMap();

/**
 * Census geocoder, then Nominatim (order: `deps.geocoders`). Never guesses: returns {ok:false, reason} when all fail.
 * The result carries `matchedAddress` (what the geocoder actually found), `mismatch` and `streetMismatch` (house number,
 * directional or street name differs from what was typed).
 * @param {string} address @param {Deps} deps
 */
export async function geocode(address, deps) {
  const typed = typeof address === 'string' ? address.trim().slice(0, 200) : '';
  if (!typed) return { ok: false, reason: 'empty address' };
  const at = isoNow(deps?.now);
  const order = (deps.geocoders ?? GEOCODERS_SERVER).filter((x, i, a) => (x === 'census' || x === 'nominatim') && a.indexOf(x) === i);
  if (!order.length) return { ok: false, reason: 'no geocoder configured' };
  /** @type {string[]} */
  const attempts = [];

  for (const which of order) {
    if (which === 'census') {
      // US Census geocoder (also returns county FIPS).
      const cUrl = `${CENSUS}/geographies/onelineaddress?` + new URLSearchParams({ address: typed, benchmark: 'Public_AR_Current', vintage: 'Current_Current', format: 'json' });
      const c = await fetchJson(cUrl, deps);
      if (!c.ok) { attempts.push(`Census: ${c.reason}`); continue; }
      const matches = c.json?.result?.addressMatches;
      const m = Array.isArray(matches) ? matches[0] : null;
      const lat = num(m?.coordinates?.y), lng = num(m?.coordinates?.x);
      if (!m || lat === null || lng === null || !text(m.matchedAddress)) { attempts.push('Census: no address match'); continue; }
      const comp = m.addressComponents ?? {};
      const county = m.geographies?.Counties?.[0];
      const problems = geocodeProblems(typed, m.matchedAddress, { city: comp.city, state: comp.state });
      const notes = [];
      if (matches.length > 1) notes.push(`${matches.length} candidate matches; first used`);
      if (problems.list.length) notes.push(`WARNING: the geocoder matched a different place (${problems.list.join('; ')}). Facts are for "${m.matchedAddress}", not necessarily the address typed.`);
      return {
        ok: true, provider: 'census', lat, lng, matchedAddress: m.matchedAddress,
        jurisdiction: /** @type {any} */ ({ country: 'US', state: text(comp.state) ?? text(m.geographies?.States?.[0]?.STUSAB) ?? undefined,
          ...(county?.GEOID ? { countyFips: String(county.GEOID), county: county.NAME } : {}), ...(text(comp.city) ? { city: comp.city } : {}) }),
        confidence: problems.list.length ? CONFIDENCE.mismatch : CONFIDENCE.census,
        mismatch: problems.list.length > 0, streetMismatch: problems.street, ...(notes.length ? { note: notes.join(' ') } : {}),
        source: { name: 'US Census Geocoder', url: `${CENSUS}/geographies/onelineaddress`, license: NOT_VERIFIED }, retrievedAt: at,
      };
    }

    // Nominatim (OpenStreetMap), US only, one result; at most one request per second (usage policy).
    await nominatimGate(deps);
    const nUrl = `${NOMINATIM}?` + new URLSearchParams({ format: 'jsonv2', limit: '1', addressdetails: '1', countrycodes: 'us', q: typed });
    const n = await fetchJson(nUrl, deps);
    if (!n.ok) { attempts.push(`Nominatim: ${n.reason}`); continue; }
    const r = Array.isArray(n.json) ? n.json[0] : null;
    const lat = num(r?.lat), lng = num(r?.lon);
    if (!r || lat === null || lng === null) { attempts.push('Nominatim: no address match'); continue; }
    const a = r.address ?? {};
    const iso = typeof a['ISO3166-2-lvl4'] === 'string' && /^US-[A-Z]{2}$/.test(a['ISO3166-2-lvl4']) ? a['ISO3166-2-lvl4'].slice(3) : undefined;
    const city = text(a.city) ?? text(a.town) ?? text(a.village) ?? text(a.municipality) ?? undefined;
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const matchedAddress = street ? `${street}${city ? ', ' + city : ''}${iso ? ', ' + iso : ''}${a.postcode ? ' ' + a.postcode : ''}` : String(r.display_name ?? '');
    if (!matchedAddress) { attempts.push('Nominatim: no address match'); continue; }
    const problems = geocodeProblems(typed, matchedAddress, { city, state: iso });
    const notes = problems.list.length ? [`WARNING: the geocoder matched a different place (${problems.list.join('; ')}). Facts are for "${matchedAddress}", not necessarily the address typed.`] : [];
    /** @type {any} */
    const jurisdiction = { country: 'US', state: iso, ...(city ? { city } : {}) };
    // Nominatim has no county FIPS: ask the Census geography service for the county at this point (only where Census is
    // reachable: it is not from a browser). Without it the county is the name Nominatim gave, which servicesFor can match.
    if (order.includes('census')) {
      const g = await fetchJson(`${CENSUS}/geographies/coordinates?` + new URLSearchParams({ x: String(lng), y: String(lat), benchmark: 'Public_AR_Current', vintage: 'Current_Current', format: 'json' }), deps);
      const cty = g.ok ? g.json?.result?.geographies?.Counties?.[0] : null;
      if (cty?.GEOID) { jurisdiction.countyFips = String(cty.GEOID); jurisdiction.county = cty.NAME; }
      else { if (text(a.county)) jurisdiction.county = a.county; notes.push(`County FIPS not available (${g.ok ? 'Census returned no county' : 'Census: ' + g.reason}).`); }
    } else {
      if (text(a.county)) jurisdiction.county = a.county;
      notes.push('County FIPS not available (Census is not used from a browser); the county name from Nominatim is used.');
    }
    return {
      ok: true, provider: 'nominatim', lat, lng, matchedAddress, jurisdiction,
      confidence: problems.list.length ? CONFIDENCE.mismatch : CONFIDENCE.nominatim,
      mismatch: problems.list.length > 0, streetMismatch: problems.street, ...(notes.length ? { note: notes.join(' ') } : {}),
      source: { name: 'OpenStreetMap Nominatim', url: NOMINATIM, license: OSM_LICENSE }, retrievedAt: at,
    };
  }
  return { ok: false, reason: `could not geocode: ${attempts.join('; ')}`, attempts };
}

// ---------------------------------------------------------------------------------------------------------------
// Parcel registry lookup
// ---------------------------------------------------------------------------------------------------------------

const countyKey = (/** @type {any} */ n) => String(n ?? '').toLowerCase().replace(/\s+county$/, '').trim();

/**
 * County match first, then statewide. A county matches by FIPS, or (only when the jurisdiction has no FIPS, as with a
 * browser-side Nominatim geocode) by the registry's `coverage.county` name within the same state.
 * @param {ParcelService[]} services @param {{state?:string,countyFips?:string,county?:string}} j
 */
export function servicesFor(services, j) {
  const state = j?.state?.toUpperCase();
  const byName = !j?.countyFips && state && j?.county ? countyKey(j.county) : null;
  const county = services.filter((s) => s.coverage.countyFips && (s.coverage.countyFips === j?.countyFips
    || (byName && s.coverage.county && s.coverage.state.toUpperCase() === state && countyKey(s.coverage.county) === byName)));
  const statewide = services.filter((s) => !s.coverage.countyFips && state && s.coverage.state.toUpperCase() === state);
  return [...county, ...statewide];
}

/** Esri rings (outer = clockwise, holes = counter-clockwise) -> GeoJSON Polygon/MultiPolygon, or null. */
export function ringsToGeoJSON(/** @type {number[][][]} */ rings) {
  const signed = (/** @type {number[][]} */ r) => r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
  const closed = (/** @type {number[][]} */ r) => (r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r : [...r, r[0]]);
  const valid = rings.filter((r) => Array.isArray(r) && r.length >= 3 && r.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])));
  /** @type {{outer:number[][], holes:number[][][]}[]} */
  const polys = [];
  for (const r of valid) if (signed(r) < 0) polys.push({ outer: closed([...r].reverse()), holes: [] }); // GeoJSON outer = CCW
  if (!polys.length) return null;
  for (const r of valid) {
    if (signed(r) >= 0) {
      const host = polys.find((p) => pointInPolygon({ lng: r[0][0], lat: r[0][1] }, { type: 'Polygon', coordinates: [p.outer] })) ?? polys[0];
      host.holes.push(closed([...r].reverse())); // GeoJSON hole = CW
    }
  }
  return polys.length === 1 ? { type: 'Polygon', coordinates: [polys[0].outer, ...polys[0].holes] }
    : { type: 'MultiPolygon', coordinates: polys.map((p) => [p.outer, ...p.holes]) };
}

/**
 * Assessor fields -> numbers. '0000', 0, '' and null all become null ("not recorded by the assessor"); the LA service
 * returns YearBuilt1 as a string.
 * @param {any} a @param {ParcelService['fields']} f
 */
function assessorOf(a, f) {
  const year = (/** @type {any} */ v) => { const n = pos(v); return n !== null && Number.isInteger(n) && n >= 1000 && n <= 9999 ? n : null; };
  return {
    useCode: f.useCode ? text(a[f.useCode]) : null, useType: f.useType ? text(a[f.useType]) : null,
    useDescription: f.useDescription ? text(a[f.useDescription]) : null,
    livingAreaSqft: f.livingAreaSqft ? pos(a[f.livingAreaSqft]) : null, units: f.units ? pos(a[f.units]) : null,
    yearBuilt: f.yearBuilt ? year(a[f.yearBuilt]) : null, bedrooms: f.bedrooms ? pos(a[f.bedrooms]) : null,
    lotAreaSqft: f.lotAreaSqft ? pos(a[f.lotAreaSqft]) : null,
  };
}

const apnOf = (/** @type {any} */ a, /** @type {ParcelService['fields']} */ f) => text(a[f.apn]) ?? (num(a[f.apn]) !== null ? String(a[f.apn]) : null);

/**
 * Parcel at a point via the registry: the county's service first, then a statewide one. Pass the jurisdiction on the
 * point (`{lat,lng,jurisdiction}`) or in deps.
 *
 * 1. Exact intersect at the point. 2. If that finds nothing and `opts.matchedAddress` is given (geocoders return a point
 * on the street, not in the parcel): query again with a buffer (`service.searchRadiusM`, default 40 m) and take ONLY a
 * parcel whose situs address matches the geocoded address (house number + street name; directional when both have one).
 * Exactly one -> used, with `matchedBy:'situs'` and `method`. Zero or several -> ok:false with `candidates`
 * ([{apn, address}], max 10) so an owner can pick; the nearest parcel is never chosen. `opts.parcelApn` resolves that one
 * parcel from the buffered candidates (`matchedBy:'owner'`).
 * @param {{lat:number,lng:number,jurisdiction?:{state?:string,countyFips?:string,county?:string}}} point
 * @param {Deps} deps
 * @param {{matchedAddress?:string, parcelApn?:string}} [opts]
 */
export async function parcelAt(point, deps, opts = {}) {
  const j = point.jurisdiction ?? deps.jurisdiction ?? {};
  const at = isoNow(deps?.now);
  const candidates = servicesFor(deps.services ?? PARCEL_SERVICES, j);
  if (!candidates.length) return { ok: false, reason: `no parcel service for ${j.county ?? j.countyFips ?? 'unknown county'}, ${j.state ?? 'unknown state'}` };
  /** @type {string[]} */
  const reasons = [];
  /** @type {Array<{apn:string|null,address:string|null}>|undefined} */
  let pickList;
  for (const svc of candidates) {
    const f = svc.fields;
    const outFields = [f.apn, f.address, f.useCode, f.useType, f.useDescription, f.livingAreaSqft, f.units, f.yearBuilt, f.bedrooms, f.lotAreaSqft]
      .filter((x, i, a) => x && a.indexOf(x) === i);
    const base = `${svc.url}?` + `geometry=${point.lng.toFixed(6)},${point.lat.toFixed(6)}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${outFields.join(',')}&returnGeometry=true&outSR=4326&f=json`;
    const result = (/** @type {any} */ feature, /** @type {any} */ extra) => {
      const a = feature.attributes ?? {};
      return {
        ok: true, service: svc, boundary: ringsToGeoJSON(feature.geometry?.rings ?? []), apn: apnOf(a, f),
        address: f.address ? text(a[f.address]) : null, assessor: assessorOf(a, f),
        multipleCandidates: false, source: { name: svc.publisher, url: svc.url, license: svc.license }, retrievedAt: at, ...extra,
      };
    };

    // 1. Exact intersect (skipped when the owner already picked a parcel from the candidates).
    if (!opts.parcelApn) {
      const r = await fetchJson(base, deps);
      if (!r.ok) { reasons.push(`${svc.id}: ${r.reason}`); continue; }
      if (r.json?.error) { reasons.push(`${svc.id}: service error: ${r.json.error.message ?? r.json.error.code ?? 'unknown'}`); continue; }
      const features = r.json?.features;
      if (!Array.isArray(features)) { reasons.push(`${svc.id}: malformed response`); continue; }
      if (features.length) {
        let feature = features[0];
        if (features.length > 1) {
          feature = features.find((ft) => { const g = ringsToGeoJSON(ft?.geometry?.rings ?? []); return g && pointInPolygon(point, g); });
          if (!feature) { reasons.push(`${svc.id}: ${features.length} parcels returned but none contains the point`); continue; }
        }
        return result(feature, { multipleCandidates: features.length > 1, matchedBy: 'containing-point', method: 'parcel containing the geocoded point' });
      }
      if (!opts.matchedAddress || !f.address) { reasons.push(`${svc.id}: no parcel at this point`); continue; }
    }

    // 2. Buffered query: a geocoded point usually lies in the street, not in the parcel.
    const radius = svc.searchRadiusM ?? DEFAULT_SEARCH_RADIUS_M;
    const b = await fetchJson(`${base}&distance=${radius}&units=esriSRUnit_Meter`, deps);
    const pre = opts.parcelApn ? `${svc.id}: ` : `${svc.id}: no parcel at this point; `;
    if (!b.ok) { reasons.push(`${pre}search within ${radius} m failed: ${b.reason}`); continue; }
    if (b.json?.error) { reasons.push(`${pre}search within ${radius} m: service error: ${b.json.error.message ?? b.json.error.code ?? 'unknown'}`); continue; }
    const near = b.json?.features;
    if (!Array.isArray(near)) { reasons.push(`${pre}search within ${radius} m: malformed response`); continue; }
    const rows = near.map((ft) => { const a = ft?.attributes ?? {}; return { ft, apn: apnOf(a, f), address: f.address ? text(a[f.address]) : null }; });
    // addressed parcels first: a blank situs cannot be recognised by an owner; capped at 10, addresses only
    const list = [...rows.filter((x) => x.address), ...rows.filter((x) => !x.address)].slice(0, 10).map((x) => ({ apn: x.apn, address: x.address }));

    if (opts.parcelApn) {
      const hit = rows.filter((x) => x.apn !== null && x.apn === String(opts.parcelApn));
      if (hit.length !== 1) { reasons.push(`${pre}parcel ${opts.parcelApn} is not among the ${near.length} parcels within ${radius} m of the geocoded point`); pickList ??= list; continue; }
      return result(hit[0].ft, { matchedBy: 'owner', searchRadiusM: radius, method: `parcel ${opts.parcelApn} chosen by the owner from the ${near.length} parcels within ${radius} m of the geocoded point` });
    }
    const hits = rows.filter((x) => x.address && situsMatchesAddress(opts.matchedAddress ?? '', x.address));
    if (hits.length === 1) {
      return result(hits[0].ft, { matchedBy: 'situs', searchRadiusM: radius, method: `matched by situs address within ${radius} m of the geocoded point`,
        nearbyParcels: near.length });
    }
    pickList ??= hits.length > 1 ? hits.slice(0, 10).map((x) => ({ apn: x.apn, address: x.address })) : list;
    reasons.push(!near.length ? `${pre}no parcel within ${radius} m either`
      : hits.length ? `${pre}${hits.length} of ${near.length} parcels within ${radius} m match the address "${opts.matchedAddress}"; more than one, so none was chosen`
        : `${pre}${near.length} parcels within ${radius} m of the geocoded point, but none matches the address "${opts.matchedAddress}"`);
  }
  return { ok: false, reason: `parcel lookup failed: ${reasons.join('; ')}`, ...(pickList?.length ? { candidates: pickList } : {}) };
}

/**
 * Port of classifyParcel (everyspace-demo index.html:8836) mapped to the PropertyProfile property types. LA use-code rules apply only
 * to services with useCodeScheme 'la-assessor'; other services are classified from the use-type text alone.
 * @param {{useCode?:string|null,useType?:string|null,useDescription?:string|null,livingAreaSqft?:number|null,units?:number|null}} a
 * @param {{codeScheme?:string, hasSqftField?:boolean}} [opts]
 * @returns {'single_family'|'condo'|'multi_family'|'land'|'commercial'|'unknown'}
 */
export function classifyPropertyType(a, opts = {}) {
  const code = String(a.useCode ?? '').toUpperCase();
  const type = `${a.useType ?? ''} ${a.useDescription ?? ''}`;
  const sqft = a.livingAreaSqft ?? 0, units = a.units ?? 0;
  /** @type {ReturnType<typeof classifyPropertyType>} */
  let kind = 'unknown';
  if (opts.codeScheme === 'la-assessor') {
    if (/V$/.test(code) || /vacant/i.test(type)) kind = 'land';
    else if (/^0[0-9]/.test(code) || /resid/i.test(type)) kind = units > 4 || /^05|apartment/i.test(code + type) ? 'multi_family' : /condo/i.test(type) || /^010[0-9]C/i.test(code) ? 'condo' : 'single_family';
    else if (/^[12]/.test(code) || /commerc|industr|office|store|retail/i.test(type)) kind = 'commercial';
    else if (/^4/.test(code) || /agric|farm|ranch|pasture/i.test(type)) kind = 'land';
    if (kind === 'single_family' && sqft === 0 && opts.hasSqftField) kind = 'land'; // original rule: no building area = land
  } else {
    if (/vacant|\bland\b/i.test(type)) kind = 'land';
    else if (/condo/i.test(type)) kind = 'condo';
    else if (/apartment|multi|duplex|triplex|fourplex/i.test(type) || units > 4) kind = 'multi_family';
    else if (/single|sfr|resid/i.test(type)) kind = 'single_family';
    else if (/commerc|industr|office|store|retail/i.test(type)) kind = 'commercial';
    else if (/agric|farm|ranch|pasture/i.test(type)) kind = 'land';
  }
  return kind;
}

// ---------------------------------------------------------------------------------------------------------------
// OpenStreetMap (one Overpass query for buildings, pools and transit)
// ---------------------------------------------------------------------------------------------------------------

const osmSource = (/** @type {string} */ url) => ({ name: 'OpenStreetMap via Overpass API', publisher: 'OpenStreetMap contributors', url, license: OSM_LICENSE, attribution: OSM_ATTRIBUTION });

/**
 * One Overpass query covering buildings + swimming pools within buildingRadiusM and transit within transitRadiusM.
 * Tries each endpoint in turn.
 * @param {{lat:number,lng:number}} point
 * @param {{buildingRadiusM?:number, transitRadiusM?:number}} opts @param {Deps} deps
 */
export async function overpassNear(point, opts, deps) {
  const at = isoNow(deps?.now);
  const rb = Math.round(opts.buildingRadiusM ?? 60), rt = Math.round(opts.transitRadiusM ?? TRANSIT_RADIUS_M);
  const b = `(around:${rb},${point.lat},${point.lng})`, t = `(around:${rt},${point.lat},${point.lng})`;
  const query = `[out:json][timeout:25];(way["building"]${b};node["leisure"="swimming_pool"]${b};way["leisure"="swimming_pool"]${b};` +
    `node["railway"="station"]${t};node["public_transport"="platform"]${t};node["highway"="bus_stop"]${t};);out geom tags;`;
  /** @type {string[]} */
  const reasons = [];
  for (const ep of deps.overpassEndpoints ?? OVERPASS) {
    const r = await fetchJson(`${ep}?data=${encodeURIComponent(query)}`, deps);
    if (!r.ok) { reasons.push(`${new URL(ep).host}: ${r.reason}`); continue; }
    if (!Array.isArray(r.json?.elements) || /runtime error/i.test(String(r.json?.remark ?? ''))) { reasons.push(`${new URL(ep).host}: ${r.json?.remark ? 'Overpass: ' + r.json.remark : 'malformed response'}`); continue; }
    return { ok: true, elements: /** @type {any[]} */ (r.json.elements), source: osmSource(ep), retrievedAt: at };
  }
  return { ok: false, reason: `Overpass query failed: ${reasons.join('; ')}` };
}

async function osmOf(/** @type {any} */ point, /** @type {any} */ o, /** @type {Deps} */ deps) {
  return o.osm ?? overpassNear(point, { buildingRadiusM: o.radiusM, transitRadiusM: o.transitRadiusM }, deps);
}

/** OSM way geometry [{lat,lon}] -> closed GeoJSON Polygon, or null. */
function wayPolygon(/** @type {any} */ el) {
  const g = Array.isArray(el.geometry) ? el.geometry.filter((p) => num(p?.lat) !== null && num(p?.lon) !== null) : [];
  if (g.length < 3) return null;
  const ring = g.map((p) => [p.lon, p.lat]);
  const [f, l] = [ring[0], ring[ring.length - 1]];
  if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
  return ring.length >= 4 ? { type: 'Polygon', coordinates: [ring] } : null;
}

/** Building footprints from OSM. @param {{lat:number,lng:number}} point @param {Deps} deps @param {{radiusM?:number, osm?:any}} [opts] */
export async function buildingsNear(point, deps, opts = {}) {
  const o = await osmOf(point, opts, deps);
  if (!o.ok) return o;
  const buildings = [];
  for (const el of o.elements) {
    if (el?.type !== 'way' || !el.tags?.building) continue;
    const polygon = wayPolygon(el);
    if (polygon) buildings.push({ id: `way/${el.id}`, footprintSqft: polygonAreaSqft(polygon), polygon, centroid: centroid(polygon) });
  }
  return { ok: true, buildings, source: o.source, retrievedAt: o.retrievedAt };
}

/** Swimming pools mapped in OSM. With opts.parcel, `pools` holds only those on the parcel. */
export async function poolNear(point, deps, opts = {}) {
  const o = await osmOf(point, opts, deps);
  if (!o.ok) return o;
  const all = [];
  for (const el of o.elements) {
    if (el?.tags?.leisure !== 'swimming_pool') continue;
    if (el.type === 'node' && num(el.lat) !== null && num(el.lon) !== null) all.push({ id: `node/${el.id}`, lat: el.lat, lng: el.lon });
    else if (el.type === 'way') { const p = wayPolygon(el); if (p) all.push({ id: `way/${el.id}`, ...centroid(p) }); }
  }
  const pools = opts.parcel ? all.filter((p) => pointInPolygon(p, opts.parcel)) : all;
  return { ok: true, pools, mappedNearby: all.length, source: o.source, retrievedAt: o.retrievedAt };
}

/** Transit stops/stations mapped in OSM, nearest first, straight-line distance from the point. */
export async function transitNear(point, deps, opts = {}) {
  const o = await osmOf(point, opts, deps);
  if (!o.ok) return o;
  const radius = opts.transitRadiusM ?? TRANSIT_RADIUS_M;
  const stops = [];
  for (const el of o.elements) {
    if (el?.type !== 'node' || num(el.lat) === null || num(el.lon) === null) continue;
    const tg = el.tags ?? {};
    const kind = tg.railway === 'station' ? 'rail_station' : tg.highway === 'bus_stop' ? 'bus_stop' : tg.public_transport === 'platform' ? 'platform' : null;
    if (!kind) continue;
    const distM = distanceM(point, { lat: el.lat, lng: el.lon });
    if (distM <= radius) stops.push({ id: `node/${el.id}`, name: tg.name ?? null, kind, lat: el.lat, lng: el.lon, distanceM: distM });
  }
  stops.sort((a, b) => a.distanceM - b.distanceM);
  return { ok: true, stops, nearest: stops[0] ?? null, radiusM: radius, source: o.source, retrievedAt: o.retrievedAt };
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------------------------

const UNAVAILABLE_ALWAYS = /** @type {Array<[string,string]>} */ ([
  ['driveway_area_sqft', 'No data source found for driveway area; the owner can enter it.'],
  ['parking_spaces', 'No sourced parking count (assessor garage fields are not mapped); the owner can enter it.'],
  ['garage_present', 'No sourced garage data; the owner can enter it.'],
  ['adu_present', 'No sourced ADU data; the owner can enter it.'],
  ['zoning', 'No zoning layer is integrated; the parcel use type is not zoning.'],
  ['roof_area_sqft', 'No sourced roof pitch; building footprint is available separately.'],
  ['demand_generators', 'No sourced event or venue dataset is integrated.'],
]);

const ALL_KEYS = ['address', 'location', 'jurisdiction', 'parcel_id', 'parcel_boundary', 'lot_area_sqft', 'property_type', 'use_type',
  'year_built', 'bedrooms', 'living_area_sqft', 'units', 'buildings', 'building_footprint_sqft', 'roof_area_sqft', 'yard_area_sqft',
  'driveway_area_sqft', 'parking_spaces', 'garage_present', 'pool_present', 'adu_present', 'zoning', 'transit_distance_m', 'demand_generators'];

/**
 * Address -> geocode -> parcel -> OSM -> profile. Partial failure is normal; each step is reported.
 * `steps[0].matchedAddress` is what the geocoder actually found. If it differs from the typed house number, directional
 * or street, the result is `{ok:false, reason:'address matched a different location', matchedAddress, needsConfirmation:true,
 * profile}` (profile holds only the geocode attributes) unless `deps.confirmMatchedAddress` is true. If no parcel could be
 * chosen by address, the result carries `candidates` ([{apn,address}]); call again with `deps.parcelApn` to use the one
 * the owner picks (recorded as owner-confirmed).
 * @param {string} address
 * @param {Deps & {now:string}} deps
 * @returns {Promise<{ok:boolean, profile:PropertyProfile, steps:Array<{step:string, ok:boolean, reason?:string, source:string, matchedAddress?:string, provider?:string, candidates?:Array<{apn:string|null,address:string|null}>}>,
 *   reason?:string, matchedAddress?:string, needsConfirmation?:boolean, candidates?:Array<{apn:string|null,address:string|null}>}>}
 */
export async function resolveAddress(address, deps) {
  const at = isoNow(deps?.now);
  let profile = createProfile();
  /** @type {Array<{step:string, ok:boolean, reason?:string, source:string, matchedAddress?:string, provider?:string, candidates?:any[]}>} */
  const steps = [];
  const put = (/** @type {string} */ k, /** @type {any} */ v) => { profile = setAttribute(profile, k, v); };
  const none = (/** @type {string} */ k, /** @type {string} */ reason, /** @type {string} */ source = INTEL) => put(k, unavailable(reason, source));
  const step = (/** @type {string} */ name, /** @type {{ok:boolean, reason?:string}} */ r, /** @type {string} */ source, /** @type {any} */ extra = {}) =>
    steps.push({ step: name, ok: r.ok, ...(r.ok ? {} : { reason: r.reason }), source, ...extra });

  // 1. Geocode
  const g = await geocode(address, deps);
  step('geocode', g, g.ok ? g.source.name : (deps.geocoders ?? GEOCODERS_SERVER).map((x) => (x === 'census' ? 'US Census Geocoder' : 'OpenStreetMap Nominatim')).join(', then '),
    g.ok ? { matchedAddress: g.matchedAddress, provider: g.provider } : {});
  /** @type {{lat:number,lng:number}|null} */
  let point = null;
  if (g.ok) {
    point = { lat: g.lat, lng: g.lng };
    const m = { tag: /** @type {const} */ ('measured'), source: g.source.name, sourceUrl: g.source.url, license: g.source.license, retrievedAt: g.retrievedAt, ...(g.note ? { note: g.note } : {}) };
    put('address', sourced(g.matchedAddress, { ...m, confidence: g.confidence, method: 'geocoded from the typed address' }));
    put('location', sourced(point, { ...m, confidence: g.confidence, unit: 'degrees (WGS84)', method: 'geocoded from the typed address' }));
    if (g.jurisdiction.state) put('jurisdiction', sourced(g.jurisdiction, { ...m, confidence: Math.min(g.confidence, g.jurisdiction.countyFips ? CONFIDENCE.census : CONFIDENCE.nominatim) }));
    else none('jurisdiction', 'the geocoder returned no state', g.source.name);
    if (g.streetMismatch && !deps.confirmMatchedAddress) {
      // The geocoder found a different house number / directional / street: do not continue to a parcel for it.
      return { ok: false, reason: 'address matched a different location', matchedAddress: g.matchedAddress, needsConfirmation: true, profile, steps };
    }
  } else {
    for (const k of ['address', 'location', 'jurisdiction']) none(k, g.reason, 'geocoding');
  }

  // 2. Parcel
  /** @type {any} */
  let parcel = null;
  if (point && g.ok && g.jurisdiction.state) {
    const p = await parcelAt({ ...point, jurisdiction: g.jurisdiction }, deps, { matchedAddress: g.matchedAddress, ...(deps.parcelApn ? { parcelApn: String(deps.parcelApn) } : {}) });
    step('parcel', p, p.ok ? p.service.publisher : 'parcel service registry', !p.ok && p.candidates ? { candidates: p.candidates } : {});
    if (p.ok) parcel = p;
    else for (const k of ['parcel_id', 'parcel_boundary', 'lot_area_sqft', 'property_type', 'use_type', 'year_built', 'bedrooms', 'living_area_sqft', 'units']) none(k, p.reason, 'parcel service registry');
  } else {
    const reason = point ? 'no jurisdiction to choose a parcel service' : 'location unavailable (geocode failed)';
    step('parcel', { ok: false, reason }, 'parcel service registry');
    for (const k of ['parcel_id', 'parcel_boundary', 'lot_area_sqft', 'property_type', 'use_type', 'year_built', 'bedrooms', 'living_area_sqft', 'units']) none(k, reason, 'parcel service registry');
  }

  if (parcel) {
    const svc = /** @type {ParcelService} */ (parcel.service), a = parcel.assessor;
    const base = { source: svc.publisher, sourceUrl: svc.url, license: svc.license, retrievedAt: parcel.retrievedAt };
    const meas = (/** @type {number} */ confidence, /** @type {any} */ extra = {}) => ({ tag: /** @type {const} */ ('measured'), ...base, confidence, ...extra });
    const multi = parcel.multipleCandidates ? 'The service returned several parcels; the one containing the point was used.' : undefined;
    const bySitus = parcel.matchedBy === 'situs', byOwner = parcel.matchedBy === 'owner';
    // a parcel chosen by situs address (the geocoded point was in the street) is less certain than one containing the point
    const idConf = bySitus ? CONFIDENCE.parcelBySitus : CONFIDENCE.parcelId;
    const idExtra = bySitus ? { method: parcel.method, note: `The geocoded point is not inside any parcel; this parcel's situs address (${parcel.address}) matches the geocoded address.` } : { note: multi };
    if (parcel.apn && byOwner) put('parcel_id', sourced(parcel.apn, { tag: 'owner-confirmed', source: 'Owner', confidence: 1, retrievedAt: at, method: parcel.method }));
    else if (parcel.apn) put('parcel_id', sourced(parcel.apn, meas(idConf, idExtra))); else none('parcel_id', 'the service returned no parcel number', svc.publisher);
    if (parcel.boundary) put('parcel_boundary', sourced(parcel.boundary, meas(byOwner ? CONFIDENCE.parcelId : idConf, { unit: 'GeoJSON (WGS84)', ...(bySitus ? { method: parcel.method } : {}) })));
    else none('parcel_boundary', 'the service returned no parcel geometry', svc.publisher);
    let lotPoly = null;
    if (parcel.boundary) {
      lotPoly = Math.round(polygonAreaSqft(parcel.boundary));
      put('lot_area_sqft', sourced(lotPoly, meas(bySitus ? Math.min(CONFIDENCE.polygonArea, idConf) : CONFIDENCE.polygonArea, { unit: 'sqft', method: 'WGS84 parcel polygon area, holes subtracted (core/geometry.js)', note: 'Measured from the published outline; can differ from the recorded lot size.' })));
    }
    if (a.lotAreaSqft) put('lot_area_sqft', sourced(a.lotAreaSqft, meas(CONFIDENCE.assessor, { unit: 'sqft', method: 'lot size reported by the service' })));
    if (lotPoly === null && !a.lotAreaSqft) none('lot_area_sqft', 'no parcel polygon and the service reports no lot size', svc.publisher);

    const useVal = a.useType ?? a.useDescription ?? a.useCode;
    const useNote = [a.useCode && `use code ${a.useCode}`, a.useDescription].filter(Boolean).join('; ') || undefined;
    if (useVal) {
      put('use_type', sourced(useVal, meas(CONFIDENCE.assessor, { note: useNote })));
      const type = classifyPropertyType(a, { codeScheme: svc.useCodeScheme, hasSqftField: Boolean(svc.fields.livingAreaSqft) });
      put('property_type', type === 'unknown' ? sourced('unknown', { tag: 'estimated', source: INTEL, retrievedAt: at, confidence: 0.1, note: 'The use type did not match a known class.' })
        : sourced(type, { tag: 'estimated', source: svc.publisher, sourceUrl: svc.url, license: svc.license, retrievedAt: at, confidence: CONFIDENCE.classified,
          method: 'classified from the assessor use type (ported from the Everyspace parcel classifier)' }));
    } else {
      none('use_type', 'the service reports no use type', svc.publisher);
      none('property_type', 'no use type to classify', svc.publisher);
    }
    const field = (/** @type {string} */ key, /** @type {string|undefined} */ f, /** @type {number|null} */ v, /** @type {string|undefined} */ unit) => {
      if (!f) none(key, 'this parcel service does not publish the field', svc.publisher);
      else if (v === null) none(key, 'not recorded by the assessor', svc.publisher);
      else put(key, sourced(v, meas(CONFIDENCE.assessor, unit ? { unit } : {})));
    };
    field('year_built', svc.fields.yearBuilt, a.yearBuilt, undefined);
    field('bedrooms', svc.fields.bedrooms, a.bedrooms, undefined);
    field('living_area_sqft', svc.fields.livingAreaSqft, a.livingAreaSqft, 'sqft');
    field('units', svc.fields.units, a.units, undefined);
  }

  // 3. OpenStreetMap: one query for buildings, pool, transit.
  /** @type {any} */
  let osm = null;
  if (point) {
    let radius = 60;
    if (parcel?.boundary) {
      const far = Math.max(...parcel.boundary.coordinates.flatMap((/** @type {any} */ poly) => poly[0]).map((/** @type {number[]} */ c) => distanceM(point, { lat: c[1], lng: c[0] })));
      radius = Math.min(400, Math.max(40, Math.ceil(far) + 15));
    }
    osm = await overpassNear(point, { buildingRadiusM: radius }, deps);
  }
  const osmFail = !point ? 'location unavailable (geocode failed)' : osm && !osm.ok ? osm.reason : null;
  const osmName = 'OpenStreetMap via Overpass API';
  const osmMeta = (/** @type {number} */ confidence, /** @type {any} */ extra = {}) => ({ tag: /** @type {const} */ ('estimated'),
    source: 'OpenStreetMap contributors via Overpass API', sourceUrl: osm?.source?.url, license: OSM_LICENSE, retrievedAt: osm?.retrievedAt, confidence, ...extra,
    note: `${OSM_ATTRIBUTION} (${OSM_LICENSE}). ${extra.note ?? ''}`.trim() });

  const b = osmFail ? null : await buildingsNear(/** @type {any} */ (point), deps, { osm });
  const onParcel = b?.ok && parcel?.boundary ? b.buildings.filter((x) => pointInPolygon(x.centroid, parcel.boundary)) : [];
  if (osmFail) { step('buildings', { ok: false, reason: osmFail }, osmName); }
  else if (!parcel?.boundary) step('buildings', { ok: false, reason: 'no parcel boundary to attribute buildings to' }, osmName);
  else step('buildings', { ok: true }, osmName);
  if (osmFail || !parcel?.boundary || !b?.ok) {
    const why = osmFail ?? 'no parcel boundary to attribute buildings to';
    for (const k of ['buildings', 'building_footprint_sqft', 'yard_area_sqft']) none(k, why, osmName);
  } else if (!onParcel.length) {
    const why = 'no OSM building is mapped on this parcel (not mapped is not proof of absence)';
    for (const k of ['buildings', 'building_footprint_sqft', 'yard_area_sqft']) none(k, why, osmName);
  } else {
    const rows = onParcel.map((x) => ({ footprintSqft: Math.round(x.footprintSqft), polygon: x.polygon }));
    put('buildings', sourced(rows, osmMeta(CONFIDENCE.osmBuildings, { method: 'OSM building outlines whose centroid lies on the parcel', note: 'OSM may be incomplete.' })));
    put('building_footprint_sqft', sourced(rows.reduce((s, r) => s + r.footprintSqft, 0), osmMeta(CONFIDENCE.osmBuildings, { unit: 'sqft', method: 'sum of OSM building polygon areas on the parcel', note: 'OSM may be incomplete.' })));
    const lot = profile.attributes.lot_area_sqft;
    if (lot && lot.value !== null) {
      const y = yardAreaSqft(parcel.boundary, onParcel, lot.value);
      put('yard_area_sqft', sourced(Math.round(y.yardSqft), osmMeta(CONFIDENCE.yard, { unit: 'sqft', method: 'lot area minus OSM building footprints on the parcel, floored at 0', note: 'Includes driveways, pools and any structure OSM lacks.' })));
    } else none('yard_area_sqft', 'no lot area to subtract buildings from', osmName);
  }

  const pl = osmFail ? null : await poolNear(/** @type {any} */ (point), deps, { osm, parcel: parcel?.boundary });
  if (osmFail) step('pool', { ok: false, reason: osmFail }, osmName);
  else if (!parcel?.boundary) step('pool', { ok: false, reason: 'no parcel boundary to test pools against' }, osmName);
  else step('pool', { ok: true }, osmName);
  if (pl?.ok && parcel?.boundary && pl.pools.length) put('pool_present', sourced(true, osmMeta(CONFIDENCE.osmPool, { method: 'OSM swimming_pool feature on the parcel', note: 'A mapped pool; the owner should confirm.' })));
  else none('pool_present', osmFail ?? (!parcel?.boundary ? 'no parcel boundary to test pools against' : 'not mapped is not proof of absence'), osmName);

  const tr = osmFail ? null : await transitNear(/** @type {any} */ (point), deps, { osm });
  step('transit', osmFail ? { ok: false, reason: osmFail } : { ok: true }, osmName);
  if (tr?.ok && tr.nearest) put('transit_distance_m', sourced(Math.round(tr.nearest.distanceM), osmMeta(CONFIDENCE.transit, { unit: 'm', method: `straight-line distance to the nearest mapped ${tr.nearest.kind.replace('_', ' ')}${tr.nearest.name ? ' (' + tr.nearest.name + ')' : ''}`, note: 'Not walking distance; OSM may be incomplete.' })));
  else none('transit_distance_m', osmFail ?? `no transit stop mapped within ${TRANSIT_RADIUS_M} m`, osmName);

  for (const [k, why] of UNAVAILABLE_ALWAYS) none(k, why);
  for (const k of ALL_KEYS) if (!profile.attributes[k]) none(k, 'not looked up');

  const pStep = steps.find((x) => x.step === 'parcel');
  return { ok: Boolean(g.ok && parcel), profile, steps, ...(pStep && !pStep.ok && pStep.candidates ? { candidates: pStep.candidates } : {}) };
}

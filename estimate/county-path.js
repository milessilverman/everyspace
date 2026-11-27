// Property lookups for the estimator, built for speed: requests that do not depend on each other run together, the
// property screen can be shown as soon as the address and the parcel records are in, and the slower parts (building
// outlines, then the optional map extras) arrive later as `pending` promises the page fills in when they land.
//
// First choice: Los Angeles County's public services, called straight from the browser (county locator, assessor parcel
// layer, LARIAC building outlines), assembled by core/property-profile.js. Only when that path cannot answer does the
// older path in core/parcel.js run (OpenStreetMap Nominatim, then the county parcel service).
// The optional map extras (pool, transit stop; on the older path also building outlines) come from OpenStreetMap's
// Overpass service, which is often slow: one attempt per mirror, a hard cap of EXTRAS_CAP_MS, and nothing is shown when
// they do not arrive. Nothing here stores anything outside memory.
//
// runCountyPath -> {kind:'fallback', why} | {kind:'confirm', matchedAddress, reason}
//                | {kind:'ok', profile, pending:[{keys, promise}], summary}
// runOlderPath  -> {kind:'ok'|'none', profile, pending} | {kind:'confirm', matchedAddress, profile} | {kind:'candidates', candidates, profile}
// Each pending promise resolves to {profile} (a fuller looked-up profile) or {attrs} (extra attributes) or null; it never rejects.
import { buildPropertyProfile, toSourcedProfile } from '../core/property-profile.js';
import { createBrowserRegistry, browserSplitYard } from '../core/providers/browser.js';
import { splitYard } from '../core/yard.js';
import { addressMismatch, overpassNear, poolNear, transitNear, buildingsNear, resolveAddress, BROWSER_GEOCODERS, CONFIDENCE } from '../core/parcel.js';
import { setAttribute, applyOwnerCorrection, createProfile } from '../core/profile.js';
import { sourced } from '../core/provenance.js';
import { yardAreaSqft, distanceM, pointInPolygon } from '../core/geometry.js';

/** Per-request timeout for the county services and the older path. */
export const REQUEST_TIMEOUT_MS = 5000;
/** The county path gives up on the main screen after this long and lets the older path try. */
export const COUNTY_MAIN_MS = 7000;
/** Building outlines that have not arrived this long after the records are dropped silently. */
export const BUILDINGS_MAX_MS = 6000;
/** Overpass: hard cap for the optional extras, and the delay before the second mirror is also asked. */
export const EXTRAS_CAP_MS = 6000;
export const MIRROR_STAGGER_MS = 1500;
export const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
/** Attributes that come from building outlines (filled in after the first screen). */
export const BUILDING_KEYS = ['floors', 'roof_area_sqft', 'building_footprint_sqft', 'front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft', 'yard_area_sqft'];
/** Attributes that come from the optional map extras. */
export const EXTRA_KEYS = ['pool_present', 'transit_distance_m'];

const COUNTY_SOURCE = "Los Angeles County's public services";
const OSM_NAME = 'OpenStreetMap contributors via Overpass API';
const title = (s) => String(s ?? '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const cityOf = (addr) => { const p = String(addr ?? '').split(',').map((x) => x.trim()); return p.length >= 3 ? p[1] : null; };
const abortError = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };

/** Resolve with the promise's value, or with `fallback` after `ms`. Never rejects. */
export function within(promise, ms, fallback = null) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), Math.max(0, ms));
    Promise.resolve(promise).then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

/**
 * A fetch that shares one network request between every caller asking for the same thing (same method, URL and body)
 * for the rest of the page session, in memory only. A failed or non-OK answer is forgotten so a later try asks again.
 * Each caller keeps its own abort signal (its own timeout); the shared request itself stops after `hardMs`.
 * @param {(url:string, init?:any)=>Promise<any>} base
 */
export function sessionFetch(base, { hardMs = 15000 } = {}) {
  if (base && base.shared) return base;
  const cache = new Map();
  const NO_BODY = new Set([101, 204, 205, 304]);
  const shared = (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const hdrs = init.headers ? Object.entries(init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers).map(([k, v]) => `${k.toLowerCase()}:${v}`).sort().join('|') : '';
    const key = `${method} ${url} ${hdrs} ${typeof init.body === 'string' ? init.body : ''}`;
    let p = cache.get(key);
    if (!p) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), hardMs);
      const { signal: _ignored, ...rest } = init;
      p = Promise.resolve().then(() => base(url, { ...rest, signal: ctl.signal }))
        .then(async (res) => ({ ok: Boolean(res?.ok), status: res?.status ?? 0, body: await res.arrayBuffer(), headers: res.headers ? [...res.headers] : [] }))
        .finally(() => clearTimeout(t));
      cache.set(key, p);
      p.then((r) => { if (!r.ok) cache.delete(key); }, () => cache.delete(key));
    }
    const sig = init.signal;
    return new Promise((resolve, reject) => {
      if (sig?.aborted) { reject(abortError()); return; }
      const onAbort = () => reject(abortError());
      sig?.addEventListener('abort', onAbort, { once: true });
      p.then((r) => {
        sig?.removeEventListener('abort', onAbort);
        const status = r.status >= 200 && r.status <= 599 ? r.status : 502;
        resolve(new Response(NO_BODY.has(status) ? null : r.body.slice(0), { status, headers: r.headers }));
      }, (e) => { sig?.removeEventListener('abort', onAbort); reject(e); });
    });
  };
  shared.shared = true;
  return shared;
}

/** A fetch whose requests all stop when `stop` is aborted (used to drop a branch nobody waits for any more). */
function stoppable(fetchFn, stop) {
  return (url, init = {}) => {
    if (stop.aborted) return Promise.reject(abortError());
    const ctl = new AbortController();
    const kill = () => ctl.abort();
    stop.addEventListener('abort', kill, { once: true });
    init.signal?.addEventListener('abort', kill, { once: true });
    if (init.signal?.aborted) ctl.abort();
    return fetchFn(url, { ...init, signal: ctl.signal }).finally(() => stop.removeEventListener('abort', kill));
  };
}

/** The looked-up profile, the late extras, then the owner's own values on top (owner values always win). */
export function mergeProfile(base, extra = {}, owner = {}, now = new Date().toISOString()) {
  let p = base ?? createProfile();
  for (const [k, v] of Object.entries(extra)) if (v) p = setAttribute(p, k, v);
  for (const [k, o] of Object.entries(owner)) p = applyOwnerCorrection(p, k, o.value, o.at ?? now, o.unit);
  return p;
}

/** Wait for every pending part of a lookup and return the merged profile (what the page shows once settled). */
export async function settleProfile(result) {
  let base = result.profile;
  const extra = {};
  for (const r of await Promise.all((result.pending ?? []).map((x) => x.promise))) {
    if (r?.profile) base = r.profile;
    if (r?.attrs) Object.assign(extra, r.attrs);
  }
  return mergeProfile(base, extra);
}

/** State and ZIP the owner typed, if any. */
function typedPlace(typed) {
  const m = /(?:^|[\s,])([A-Za-z]{2}|California)[\s,]*(\d{5})(?:-\d{4})?\s*$/.exec(typed);
  const s = m ?? /,\s*([A-Za-z]{2}|California)\s*$/.exec(typed);
  const st = s ? (/^california$/i.test(s[1]) ? 'CA' : s[1].toUpperCase()) : null;
  return { state: st, zip: m ? m[2] : (/\b(\d{5})(?:-\d{4})?\s*$/.exec(typed) ?? [])[1] ?? null };
}
/** Why the typed address is plainly not in the county locator's area, or null. */
function outsideCounty(typed, r) {
  const t = typedPlace(typed);
  if (t.state && t.state !== 'CA') return `the address says ${t.state}, outside Los Angeles County`;
  const mz = r.components?.zip;
  if (t.zip && mz && String(mz).slice(0, 5) !== t.zip) return `the typed ZIP ${t.zip} does not match the county's ${String(mz).slice(0, 5)}`;
  return null;
}

/** Outer-ring vertices of a Polygon or MultiPolygon. */
const outerRing = (b) => (b?.type === 'MultiPolygon' ? b.coordinates.flatMap((poly) => poly[0] ?? []) : (b?.coordinates?.[0] ?? []));
/** Overpass search radius that covers the whole lot. */
function lotRadius(point, boundary) {
  const far = Math.max(0, ...outerRing(boundary).map((c) => distanceM(point, { lat: c[1], lng: c[0] })).filter(Number.isFinite));
  return Math.min(400, Math.max(40, Math.ceil(far) + 15));
}

/**
 * Overpass with one attempt per mirror: the first mirror at once, the next after MIRROR_STAGGER_MS or as soon as the
 * previous one fails; the first good answer wins and the rest are cancelled. Gives up after `capMs` in total. Never rejects.
 */
export function overpassCapped(point, opts, deps, { capMs = EXTRAS_CAP_MS, staggerMs = MIRROR_STAGGER_MS, endpoints = OVERPASS_ENDPOINTS } = {}) {
  const stop = new AbortController();
  const f = stoppable(deps.fetch, stop.signal);
  return new Promise((resolve) => {
    let settled = false, failed = 0, next = 0, timer = null;
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cap); stop.abort(); resolve(v); };
    const cap = setTimeout(() => finish({ ok: false, reason: 'cap' }), capMs);
    const launch = () => {
      if (settled || next >= endpoints.length) return;
      const ep = endpoints[next++];
      clearTimeout(timer);
      if (next < endpoints.length) timer = setTimeout(launch, staggerMs);
      overpassNear(point, opts, { ...deps, fetch: f, overpassEndpoints: [ep], timeoutMs: capMs }).then((r) => {
        if (r.ok) finish(r);
        else if (++failed >= endpoints.length) finish(r);
        else launch();
      }, () => { if (++failed >= endpoints.length) finish({ ok: false, reason: 'error' }); else launch(); });
    };
    launch();
  });
}

const osmMeta = (osm, confidence, extra = {}) => ({ tag: 'estimated', source: OSM_NAME, sourceUrl: osm?.source?.url, license: 'ODbL 1.0', retrievedAt: osm?.retrievedAt, confidence, ...extra,
  note: `© OpenStreetMap contributors (ODbL 1.0). ${extra.note ?? ''}`.trim() });

/** Pool and transit stop from one Overpass answer, as the older path records them. Only values that were found. */
async function poolAndTransit(osm, point, boundary, deps) {
  const attrs = {};
  const pl = await poolNear(point, deps, { osm, parcel: boundary });
  if (pl?.ok && boundary && pl.pools.length) attrs.pool_present = sourced(true, osmMeta(osm, CONFIDENCE.osmPool, { method: 'OSM swimming_pool feature on the parcel', note: 'A mapped pool; the owner should confirm.' }));
  const tr = await transitNear(point, deps, { osm });
  if (tr?.ok && tr.nearest) attrs.transit_distance_m = sourced(Math.round(tr.nearest.distanceM), osmMeta(osm, CONFIDENCE.transit, { unit: 'm', method: `straight-line distance to the nearest mapped ${tr.nearest.kind.replace('_', ' ')}${tr.nearest.name ? ' (' + tr.nearest.name + ')' : ''}`, note: 'Not walking distance; OSM may be incomplete.' }));
  return attrs;
}

/** The county assembler's output -> the estimator's profile (same additions as before: city, total open ground). */
function countyProfile(pj, now) {
  let profile = toSourcedProfile(pj);
  const strip = (k) => { const { [k]: _a, ...attributes } = profile.attributes; const { [k]: _h, ...history } = profile.history; profile = { attributes, history }; };
  strip('place_id'); // only a Google Places key could fill it; it is not shown
  const city = cityOf(pj.address);
  const jur = profile.attributes.jurisdiction;
  if (city && jur?.value) profile = setAttribute(profile, 'jurisdiction', sourced({ ...jur.value, country: 'US', city: title(city) }, { tag: 'measured', source: jur.source, confidence: jur.confidence, retrievedAt: jur.retrievedAt, method: 'parcel in the LA County assessor layer; city from the county locator' }));
  const boundary = pj.details?.parcel_boundary;
  const buildings = pj.details?.buildings ?? [];
  const lot = profile.attributes.lot_area_sqft;
  const yardTotal = profile.attributes.yard_area_sqft;
  if (boundary && (!yardTotal || yardTotal.value === null) && buildings.length && lot && lot.value !== null) {
    const y = yardAreaSqft(boundary, buildings, lot.value);
    profile = setAttribute(profile, 'yard_area_sqft', sourced(Math.round(y.yardSqft), { tag: 'estimated', source: 'Everyspace: lot area minus building outlines', confidence: CONFIDENCE.yard, retrievedAt: now, unit: 'sqft',
      method: 'lot area minus the LARIAC building outlines on the parcel, floored at 0', note: 'Includes driveways, pools and any structure the outlines lack.' }));
  }
  return profile;
}

/** A registry view without building-outline and street providers: the records-only first pass. */
function recordsOnly(registry) {
  return { ...registry, providersFor: (kind, opts) => (kind === 'footprint' || kind === 'street' ? { providers: [], skipped: [] } : registry.providersFor(kind, opts)) };
}

/**
 * @param {string} typed what the owner typed
 * @param {{fetch:(u:string,i?:any)=>Promise<any>, now:string, confirmedAddress?:string, onStage?:(s:string)=>void,
 *   mainMs?:number, buildingsMs?:number, extrasCapMs?:number, timeoutMs?:number}} ctx
 */
export async function runCountyPath(typed, ctx) {
  const fetchShared = sessionFetch(ctx.fetch);
  const stage = (s) => { try { ctx.onStage?.(s); } catch { /* display only */ } };
  const timeoutMs = ctx.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const started = Date.now();
  const mainLeft = () => (ctx.mainMs ?? COUNTY_MAIN_MS) - (Date.now() - started);
  const stopAll = new AbortController();
  const f = stoppable(fetchShared, stopAll.signal);
  const deps = { fetch: f, now: ctx.now, timeoutMs };
  const registry = createBrowserRegistry();
  const giveUp = (why) => { stopAll.abort(); return { kind: 'fallback', why }; };

  stage('address');
  let query = typed;
  if (ctx.confirmedAddress) query = ctx.confirmedAddress;
  else {
    const loc = registry.get('la-cams-address');
    if (!loc) return giveUp('no county locator');
    const r = await within(loc.resolve(typed, deps), mainLeft(), { ok: false, code: 'timeout', reason: 'timeout' });
    if (!r.ok) return giveUp(`the county address locator ${r.code === 'no_match' ? 'found no match' : 'could not answer'} (${r.reason})`);
    const out = outsideCounty(typed, r);
    if (out) return giveUp(out);
    const mm = addressMismatch(typed, r.address);
    if (mm || r.note) { stopAll.abort(); return { kind: 'confirm', matchedAddress: r.address, reason: mm ?? r.note }; }
  }

  // Records and building outlines start together; both share the same requests (the locator answer is reused, the parcel
  // request is made once), so the records-only pass returns as soon as the parcel is in and the full pass continues to
  // the building outlines.
  stage('records');
  const pctx = (reg) => ({ registry: reg, fetch: f, now: ctx.now, keys: {}, splitYard: browserSplitYard(splitYard), timeoutMs });
  const pRecords = buildPropertyProfile(query, pctx(recordsOnly(registry)));
  const pFull = buildPropertyProfile(query, pctx(registry));
  pFull.catch(() => {});
  const pj = await within(pRecords, mainLeft(), null);
  if (!pj) return giveUp('the county lookup took too long');
  const fl = pj.fields ?? {};
  if (!fl.address || fl.address.value === null) return giveUp('the county address locator gave no result');
  if (!pj.details?.parcel_boundary || !fl.apn || fl.apn.value === null) return giveUp('the county assessor has no matching parcel');

  const profile = countyProfile(pj, ctx.now);
  const boundary = pj.details.parcel_boundary;
  const point = profile.attributes.location?.value ?? null;

  stage('buildings');
  const buildingKeys = BUILDING_KEYS.filter((k) => !(profile.attributes[k] && profile.attributes[k].value !== null));
  const buildingsDone = within(pFull.then((full) => ({ profile: countyProfile(full, ctx.now) })), ctx.buildingsMs ?? BUILDINGS_MAX_MS, null)
    .then((v) => { if (!v) stopAll.abort(); return v; });
  const extrasDone = point
    ? overpassCapped(point, { buildingRadiusM: lotRadius(point, boundary) }, { fetch: ctx.fetch, now: ctx.now }, { capMs: ctx.extrasCapMs ?? EXTRAS_CAP_MS })
      .then((osm) => (osm.ok ? poolAndTransit(osm, point, boundary, { fetch: ctx.fetch, now: ctx.now }).then((attrs) => ({ attrs })) : null)).catch(() => null)
    : Promise.resolve(null);
  return {
    kind: 'ok', profile, summary: `used ${COUNTY_SOURCE}`,
    pending: [{ keys: buildingKeys, part: 'buildings', promise: buildingsDone }, { keys: EXTRA_KEYS, part: 'extras', promise: extrasDone }],
  };
}

/**
 * The older path: OpenStreetMap Nominatim, then the county's parcel service (core/parcel.js resolveAddress), without its
 * built-in Overpass step; building outlines, pool and transit then come from one capped Overpass request as `pending`.
 * @param {string} address
 * @param {{fetch:Function, now:string, nominatimLimiter?:any, confirmMatchedAddress?:boolean, parcelApn?:string, timeoutMs?:number, extrasCapMs?:number, onStage?:(s:string)=>void}} ctx
 */
export async function runOlderPath(address, ctx) {
  const f = sessionFetch(ctx.fetch);
  const stage = (s) => { try { ctx.onStage?.(s); } catch { /* display only */ } };
  const res = await resolveAddress(address, {
    fetch: f, now: ctx.now, geocoders: BROWSER_GEOCODERS, nowMs: () => Date.now(), nominatimLimiter: ctx.nominatimLimiter, overpassEndpoints: [],
    timeoutMs: ctx.timeoutMs ?? REQUEST_TIMEOUT_MS, ...(ctx.confirmMatchedAddress ? { confirmMatchedAddress: true } : {}), ...(ctx.parcelApn ? { parcelApn: ctx.parcelApn } : {}),
  });
  if (res.needsConfirmation) return { kind: 'confirm', matchedAddress: res.matchedAddress, profile: res.profile };
  if (!res.ok && res.candidates?.length) return { kind: 'candidates', candidates: res.candidates, profile: res.profile };
  if (!res.ok) return { kind: 'none', profile: res.profile ?? createProfile(), pending: [] };
  stage('buildings');
  const profile = res.profile;
  const point = profile.attributes.location?.value ?? null;
  const boundary = profile.attributes.parcel_boundary?.value ?? null;
  const deps = { fetch: ctx.fetch, now: ctx.now };
  const keys = ['building_footprint_sqft', 'yard_area_sqft', ...EXTRA_KEYS];
  const later = point ? overpassCapped(point, { buildingRadiusM: boundary ? lotRadius(point, boundary) : 60 }, deps, { capMs: ctx.extrasCapMs ?? EXTRAS_CAP_MS }).then(async (osm) => {
    if (!osm.ok) return null;
    const attrs = await poolAndTransit(osm, point, boundary, deps);
    const b = await buildingsNear(point, deps, { osm });
    const onParcel = b?.ok && boundary ? b.buildings.filter((x) => pointInPolygon(x.centroid, boundary)) : [];
    if (onParcel.length) {
      const rows = onParcel.map((x) => ({ footprintSqft: Math.round(x.footprintSqft), polygon: x.polygon }));
      attrs.buildings = sourced(rows, osmMeta(osm, CONFIDENCE.osmBuildings, { method: 'OSM building outlines whose centroid lies on the parcel', note: 'OSM may be incomplete.' }));
      attrs.building_footprint_sqft = sourced(rows.reduce((s, r) => s + r.footprintSqft, 0), osmMeta(osm, CONFIDENCE.osmBuildings, { unit: 'sqft', method: 'sum of OSM building polygon areas on the parcel', note: 'OSM may be incomplete.' }));
      const lot = profile.attributes.lot_area_sqft;
      if (lot && lot.value !== null) {
        const y = yardAreaSqft(boundary, onParcel, lot.value);
        attrs.yard_area_sqft = sourced(Math.round(y.yardSqft), osmMeta(osm, CONFIDENCE.yard, { unit: 'sqft', method: 'lot area minus OSM building footprints on the parcel, floored at 0', note: 'Includes driveways, pools and any structure OSM lacks.' }));
      }
    }
    return { attrs };
  }).catch(() => null) : Promise.resolve(null);
  return { kind: 'ok', profile, pending: [{ keys, part: 'extras', promise: later }] };
}

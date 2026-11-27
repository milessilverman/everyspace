// @ts-check
// "Address in -> property profile out" for any US address. Pure orchestration over the provider registry: every HTTP
// call goes through the injected `fetch`, time comes from `now`, nothing is guessed (an unobtainable field is
// 'unavailable' with a reason), and a source that disagrees with the primary is reported, never averaged.
// The assembler does not import the yard splitter; pass `splitYard` (core/yard.js) in. See docs/property-data.md.
//
// How a run goes (wall time is close to the slowest single call, not the sum of all calls):
//   1. address (providers in order; skipped when the caller supplies lat/lng)
//   2. jurisdiction: `ctx.jurisdiction` / `query.jurisdiction` if given; else the coverage of the county-level address provider that
//      located the point (no request); else `countyAt` (FCC, TIGERweb fallback) from the point.
//   3. everything that can start now starts together: records providers (in parallel with each other), footprint providers, street
//      providers and the optional transit call. Dependencies, and nothing more:
//        - a footprint provider flagged `needsParcel` (LARIAC) waits for the parcel polygon (it searches the parcel, as before);
//          every other footprint provider (Overture) starts at once from the point;
//        - a records provider flagged `needsPointInParcel` (the nationwide parcel registry; it finds nothing unless the point lies INSIDE
//          the parcel) starts at once when the point is rooftop-level (`query.pointPrecision === 'rooftop'`), otherwise it waits for the
//          early footprints and uses the centroid of the building nearest the geocoded point (the building the address is on).
//          If a rooftop point finds no parcel and a building centroid is known, it is tried once more from that centroid.
//   4. the result is assembled from whatever has arrived. The assembly is one pure function of the collected state, so a partial result
//      and the final result are made by the same code.
//
// PROGRESSIVE USE (chosen: a callback, not an async iterator): `ctx.onPartial(profileSoFar, {stage})` is called after the address and
// jurisdiction are known ('address'), after the records group ('records') and after the footprint group ('footprints'), and a last time
// with the final result ('final', deeply equal to the returned value). Calls are in order, never overlap and never throw into the
// builder. A partial has the same shape as the final profile; fields that have not arrived yet are 'unavailable' ("still loading").
// Running with or without onPartial gives an identical result.

import { confidenceLabel, sourced, unavailable } from './provenance.js';
import { createProfile, setAttribute } from './profile.js';
import { addressMismatch, CONFIDENCE, isoNow, parseStreet } from './parcel.js';
import { polygonAreaSqft, pointInPolygon, centroid, localProjection, distanceM } from './geometry.js';
import { compareValues, COMPARE_KIND } from './providers/util.js';
import { countyAt } from './providers/county-lookup.js';
import { estimateRoof } from './roof.js';
import { estimateFloors } from './building-size.js';
import { overpassNear } from './parcel.js';
import { summarizeTransit, transitAttributes } from './transit.js';
import { streetReference } from './street-ref.js';

/** Los Angeles County (the first jurisdiction with richer providers). Kept as an export; the assembler no longer assumes it. */
export const LA_COUNTY = { state: 'CA', countyFips: '06037', county: 'Los Angeles County' };
const ASSEMBLER = 'Everyspace property-profile assembler';
const RECORD_KEYS = ['apn', 'lot_sqft', 'house_sqft', 'floors', 'beds', 'baths', 'year_built', 'remodeled_year', 'property_type', 'use_code', 'units'];
/** Top-level flat fields of the profile, in output order. */
export const PROFILE_FIELDS = ['address', 'lat', 'lng', 'place_id', 'apn', 'lot_sqft', 'house_sqft', 'floors', 'beds', 'baths', 'roof_sqft',
  'front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft', 'year_built', 'property_type'];
const MAX_STREET_SIDE_DISTANCE_M = 150;
const MAX_GEOCODE_TO_PARCEL_M = 150;
/** A rooftop point that found no parcel is retried from a building centroid only when the centroid is at least this far away. */
const RETRY_MIN_M = 2;
/** Search radius of a footprint lookup made from a point alone (no parcel polygon yet). */
export const POINT_SEARCH_RADIUS_M = 60;
/** Stand-in jurisdiction when neither the county nor a typed state is known: only providers with national coverage are asked. (With a typed state, providers of that state are asked too.) */
const UNKNOWN_JURISDICTION = { state: '??' };

const isNum = (/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v);
const conf = (/** @type {number} */ n) => Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;

/** One profile.fields entry from a Sourced value (+ optional cross_check). @param {any} s @param {any} [crossCheck] */
function entry(s, crossCheck) {
  const out = /** @type {any} */ ({ value: s.value, unit: s.unit ?? null, tag: s.tag, source: s.source, confidence: s.confidence, confidence_label: confidenceLabel(s.confidence), retrieved_at: s.retrievedAt ?? null });
  if (s.method !== undefined) out.method = s.method;
  if (s.note !== undefined) out.note = s.note;
  if (crossCheck) out.cross_check = crossCheck;
  return out;
}
const gone = (/** @type {string} */ reason, /** @type {string} */ source = ASSEMBLER) => entry(unavailable(reason, source));
const joinNotes = (/** @type {Array<string|undefined|null|false>} */ ...n) => n.filter(Boolean).join(' ') || undefined;
/** Run an async step; a throw becomes a provider-style failure. @param {()=>Promise<any>} fn */
const safe = async (fn) => { try { return await fn(); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e), code: 'exception' }; } };

/** Smallest distance in metres from a point to a polygon outline (0 inside). @param {{lat:number,lng:number}} pt @param {any} poly */
export function distanceToPolygonM(pt, poly) {
  if (pointInPolygon(pt, poly)) return 0;
  const proj = localProjection(pt);
  const polys = poly.type === 'Polygon' ? [poly.coordinates] : poly.coordinates;
  let best = Infinity;
  for (const rings of polys) {
    const ring = rings[0].map((/** @type {number[]} */ p) => proj.toXY(p));
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx - ay * dy) / l2));
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

/** Centroid of a building polygon (the largest part of a MultiPolygon). @param {any} g @returns {{lat:number,lng:number}|null} */
function buildingCentroid(g) {
  try {
    if (g?.type === 'MultiPolygon') {
      let best = g.coordinates[0], bestA = -1;
      for (const rings of g.coordinates) { const a = polygonAreaSqft({ type: 'Polygon', coordinates: rings }); if (a > bestA) { bestA = a; best = rings; } }
      return centroid({ type: 'Polygon', coordinates: best });
    }
    return centroid(g);
  } catch { return null; }
}

/**
 * Index of the building the address is on: the one that contains the point, else the one whose centroid is nearest. -1 when there is none.
 * @param {any[]} buildings @param {{lat:number,lng:number}} pt
 */
export function nearestBuildingIndex(buildings, pt) {
  let best = -1, bestD = Infinity;
  buildings.forEach((b, i) => {
    let d;
    try { d = pointInPolygon(pt, b.polygon) ? -1 : (() => { const c = buildingCentroid(b.polygon); return c ? distanceM(pt, c) : Infinity; })(); } catch { d = Infinity; }
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/** State code from the end of a typed address ("..., Chicago, IL 60602"). @param {string} t */
const stateFromText = (t) => (/,\s*([A-Za-z]{2})\b[\s,]*(?:\d{5}(?:-\d{4})?)?\s*$/.exec(t) ?? [])[1]?.toUpperCase();

const needsPointInParcel = (/** @type {any} */ p) => p.needsPointInParcel === true || p.id === 'parcel-registry';
const needsParcel = (/** @type {any} */ p) => p.needsParcel === true || p.id === 'lariac-buildings';

/**
 * @param {{address:string, lat?:number, lng?:number, placeId?:string, apn?:string, jurisdiction?:{state?:string,countyFips?:string,county?:string}, pointPrecision?:'rooftop'|'street'|string, pointSource?:string, pointMethod?:string, roofPitchRise?:number, roofType?:string}|string} query
 * @param {{registry:any, fetch:(url:string, init?:any)=>Promise<any>, now:string, keys?:Record<string,string|undefined>, osm?:any, transit?:boolean, splitYard?:(a:any)=>any, timeoutMs?:number,
 *   jurisdiction?:{state?:string,countyFips?:string,county?:string}, countyCache?:Map<string,any>, onPartial?:(profileSoFar:any, info:{stage:string})=>void}} ctx
 */
export async function buildPropertyProfile(query, ctx) {
  const at = isoNow(ctx?.now);
  const q = typeof query === 'string' ? { address: query } : { ...query };
  const typed = typeof q.address === 'string' ? q.address.trim() : '';
  const { registry, keys = {} } = ctx;
  const deps = (/** @type {string} */ id) => ({ fetch: ctx.fetch, now: at, ...(keys[id] ? { apiKey: keys[id] } : {}), ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}) });
  /** @type {Map<string, {id:string, status:string, reason?:string}>} rows in launch order; 'pending' rows are not reported */
  const rows = new Map();
  const mark = (/** @type {string} */ id, /** @type {'used'|'skipped'|'failed'|'pending'} */ status, /** @type {string} [reason] */ reason) => { rows.set(id, { id, status, ...(reason ? { reason } : {}) }); };
  /** @type {any} */ let jur = ctx.jurisdiction ?? q.jurisdiction ?? null;
  const forKind = (/** @type {string} */ kind) => {
    const r = registry.providersFor(kind, { jurisdiction: jur ?? (stateFromText(typed) ? { state: stateFromText(typed) } : UNKNOWN_JURISDICTION), keys });
    for (const s of r.skipped) mark(s.id, 'skipped', s.skipped);
    return r.providers;
  };
  // ---- collected state (everything assemble() reads) ----------------------------------------------------------------------
  const S = /** @type {any} */ ({
    addr: null, streetSide: null, addrDetails: [], jurisdiction: jur, jurisdictionHow: jur ? 'supplied by the caller' : null, jurisdictionWhy: null,
    recs: /** @type {Array<{p:any,r:any}>|null} */ (null), fps: /** @type {Array<{p:any,r:any}>|null} */ (null), streets: /** @type {any[]|null} */ (null), streetSource: null, streetDone: false, osm: undefined, transitDone: false,
  });
  if (isNum(q.lat) && isNum(q.lng)) S.addr = { address: typed, lat: q.lat, lng: q.lng, placeId: q.placeId, source: q.pointSource ?? 'caller-supplied coordinates', confidence: 0.7, provider: 'caller', precision: q.pointPrecision ?? null, ...(q.pointMethod ? { methodNote: q.pointMethod } : {}) };
  const wantStreetSide = typeof ctx.splitYard === 'function';

  // ---- 1. jurisdiction (when the caller gave coordinates) and address ----------------------------------------------------------
  let jurTried = false;
  const resolveJurisdiction = async () => {
    if (jur || jurTried || !S.addr) return;
    jurTried = true;
    const cov = S.addr.providerCoverage;
    if (cov && !cov.national && cov.countyFips) { jur = { state: cov.state, countyFips: cov.countyFips, county: cov.county }; S.jurisdictionHow = `county of the ${S.addr.provider} address provider`; }
    else if (isNum(S.addr.lat) && isNum(S.addr.lng)) {
      mark('county-lookup', 'pending');
      const c = /** @type {any} */ (await safe(() => countyAt({ lat: S.addr.lat, lng: S.addr.lng }, { ...deps('county-lookup'), ...(ctx.countyCache ? { countyCache: ctx.countyCache } : {}) })));
      if (c.ok) { jur = { state: c.state, countyFips: c.countyFips, county: c.county }; S.jurisdictionHow = c.source; mark('county-lookup', 'used'); }
      else { S.jurisdictionWhy = c.reason; mark('county-lookup', 'failed', c.reason); }
    }
    S.jurisdiction = jur;
  };
  await resolveJurisdiction(); // caller-supplied lat/lng: the county first, so address providers of other counties are not asked
  const addrProviders = typed ? (jur ? forKind('address') : (() => { const r = registry.providersFor('address', { keys }); for (const s of r.skipped) mark(s.id, 'skipped', s.skipped); return r.providers; })()) : [];
  for (const p of addrProviders) {
    if (S.addr && (S.streetSide || !wantStreetSide)) { mark(p.id, 'skipped', 'not needed: address already resolved'); continue; }
    const r = await safe(() => p.resolve(typed, deps(p.id)));
    if (!r.ok) { mark(p.id, 'failed', r.reason); S.addrDetails.push({ id: p.id, ok: false, reason: r.reason }); continue; }
    S.addrDetails.push({ id: p.id, ok: true, address: r.address, mismatch: addressMismatch(typed, r.address) ?? null, hasStreetSidePoint: Boolean(r.streetSidePoint) });
    if (!S.addr) { S.addr = { ...r, source: p.label, provider: p.id, providerCoverage: p.coverage }; }
    if (!S.streetSide && r.streetSidePoint) S.streetSide = { ...r.streetSidePoint, from: p.id };
    mark(p.id, 'used', S.addr.provider === p.id ? undefined : 'street-side point only');
  }
  // ---- 2. jurisdiction from the located address (no request when a county-level provider located it) ---------------------------------
  await resolveJurisdiction();
  const stateCode = jur?.state ?? stateFromText(typed);

  // ---- 3. everything that can start now ------------------------------------------------------------------------------------
  const fpProviders = forKind('footprint');
  const recProviders = typed ? forKind('records') : (forKind('records'), []);
  const streetProviders = S.addr ? forKind('street') : (forKind('street'), []);
  for (const p of [...recProviders, ...fpProviders, ...streetProviders]) mark(p.id, 'pending');
  const point = S.addr ? { lat: S.addr.lat, lng: S.addr.lng } : null;
  const rooftop = S.addr?.precision === 'rooftop';
  const recAddress = S.addr && !addressMismatch(typed, S.addr.address) && !S.addr.mismatch && typed.split(',').length < 2 ? S.addr.address : typed;

  // ---- the assembly: one pure function of S (partial and final results come from here) -----------------------------------------
  /** @param {string} stage */
  async function assemble(stage) {
    const a = S.addr;
    const recsLoaded = S.recs !== null, fpsLoaded = S.fps !== null;
    /** @type {string[]} */ const warnings = [];
    /** @type {Record<string, any>} */ const fields = {};
    /** @type {any} */ const details = {};
    /** @type {string[]} */ const attributions = [];
    const attribute = (/** @type {any} */ s) => { if (typeof s === 'string' && s && !attributions.includes(s)) attributions.push(s); };
    const J = S.jurisdiction;
    if (!typed) warnings.push('empty address');
    if (S.addrDetails.length) details.address_providers = S.addrDetails;
    if (!a) warnings.push('address could not be geocoded by any provider');
    let addr = a;
    if (addr && addr.provider !== 'caller') {
      const mm = addressMismatch(typed, addr.address);
      if (mm || addr.mismatch) { addr = { ...addr, mismatchReason: mm ?? 'geocoder flagged a different place' }; warnings.push(`geocoder matched a different address (${addr.mismatchReason}): "${addr.address}"`); }
    }
    let streetSide = S.streetSide;

    // ---- records (primary first; every available provider is fetched so the assessor can cross-check) ----
    const recs = (S.recs ?? []).filter((x) => x.r.ok);
    /** @type {string[]} */ const recFailures = [];
    for (const x of S.recs ?? []) if (!x.r.ok) { warnings.push(`${x.p.id}: ${x.r.reason}`); recFailures.push(`${x.p.id}: ${x.r.reason}`); }
    const parcelSrc = recs.find((x) => x.r.parcel?.boundary);
    /** @type {any} */ const boundary = parcelSrc?.r.parcel.boundary ?? null;
    if (boundary) details.parcel_boundary = boundary;
    if (parcelSrc) details.parcel = { provider: parcelSrc.p.id, apn: parcelSrc.r.parcel.apn, situs: parcelSrc.r.parcel.address, matchedBy: parcelSrc.r.parcel.matchedBy, assessorAreaSqft: parcelSrc.r.parcel.assessorAreaSqft, raw: parcelSrc.r.raw ?? null };
    for (const x of recs) attribute(x.r.attribution);

    // ---- footprints / roof ----
    /** @type {any} */ let fp = null, fpP = null, roof = null, roofP = null;
    for (const x of S.fps ?? []) {
      if (!x.r.ok) { warnings.push(`${x.p.id}: ${x.r.reason}`); continue; }
      if (!fp && x.r.buildings.length) { fp = x.r; fpP = x.p; }
      if (!roof && x.r.roof) { roof = x.r.roof; roofP = x.p; }
    }
    if (fp) attribute(fp.attribution);
    if (roof && roofP && roofP !== fpP) attribute(S.fps?.find((x) => x.p === roofP)?.r.attribution);
    // A point-only search (no parcel was available when the footprint provider ran) returns every building near the point. Keep the one the
    // address is on; once a parcel polygon is known keep the buildings whose centroid lies on it (as the parcel-based search does).
    /** @type {any[]} */ let buildings = fp ? fp.buildings : [];
    let pointScoped = false;
    if (fp && !fp.parcelScoped) {
      pointScoped = true;
      const pt = point ?? (parcelSrc && boundary ? centroid(boundary) : null);
      if (boundary) buildings = buildings.filter((b) => { const c = buildingCentroid(b.polygon); return c ? pointInPolygon(c, boundary) : false; });
      else if (pt) { const i = nearestBuildingIndex(buildings, pt); buildings = i >= 0 ? [buildings[i]] : []; }
    }
    let mainIdx = -1;
    buildings.forEach((b, i) => { if (mainIdx < 0 || b.areaSqft > buildings[mainIdx].areaSqft) mainIdx = i; });
    const main = mainIdx >= 0 ? buildings[mainIdx] : null;
    if (buildings.length) details.buildings = buildings.map((b) => ({ polygon: b.polygon, areaSqft: b.areaSqft, ...(b.heightFt !== undefined ? { heightFt: b.heightFt } : {}), ...(b.kind ? { kind: b.kind } : {}) }));
    if (main) details.main_building_index = mainIdx;
    const pcen = boundary ? centroid(boundary) : null;
    const fpPoint = pcen ?? point;

    // ---- street reference ----
    const sp = parseStreet(typed.split(',')[0]);
    const streetName = sp ? [...sp.core, sp.suffix].filter(Boolean).join(' ') : undefined;
    // centrelines first (the address's street when a line of that name is near, else the nearest street); the geocoder street-side point
    // is the fallback (docs/yard-accuracy.md, Stage 1: on ten LA lots the centreline split was produced for 10, the point split for 8)
    const sref = S.streets ? streetReference({ streets: S.streets, address: typed }) : null;
    if (sref && S.streetSource?.attribution) attribute(S.streetSource.attribution);
    if (streetSide && boundary) {
      const d = distanceToPolygonM(streetSide, boundary);
      if (d > MAX_STREET_SIDE_DISTANCE_M) { warnings.push(`street-side point from ${/** @type {any} */ (streetSide).from} is ${Math.round(d)} m from the parcel (wrong block or side?); not used as the front reference`); streetSide = null; }
    }

    // ---- record fields with cross-checks ----
    const recField = (/** @type {string} */ k) => recs.map((x) => ({ p: x.p, s: x.r.fields?.[k] })).filter((x) => x.s);
    for (const k of RECORD_KEYS) {
      const all = recField(k);
      const have = all.filter((x) => x.s.tag !== 'unavailable' && x.s.value !== null);
      if (!have.length) {
        const why = [...all.map((x) => `${x.p.id}: ${x.s.note ?? 'unavailable'}`), ...recFailures].join('; ') || (recsLoaded ? 'no records provider answered' : 'records still loading');
        fields[k] = entry(unavailable(why, all[0]?.s.source ?? ASSEMBLER));
        continue;
      }
      const [chosen, ...others] = have;
      let s = chosen.s;
      const kind = COMPARE_KIND[k];
      const other = others.find((o) => typeof o.s.value === typeof s.value);
      /** @type {any} */ let cross = null;
      let note = s.note;
      if (other) {
        const o = other.s;
        if (kind && isNum(s.value) && isNum(o.value)) {
          const c = compareValues(s.value, o.value, kind);
          cross = { source: o.source, value: c.other, difference: c.difference, differencePct: c.differencePct, agreement: c.agreement };
        } else if (!kind) {
          const norm = (/** @type {any} */ v) => String(v).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
          cross = { source: o.source, value: o.value, difference: null, differencePct: null, agreement: norm(s.value) === norm(o.value) ? 'match' : 'conflict' };
        }
        if (cross?.agreement === 'conflict') {
          s = { ...s, confidence: conf(s.confidence * 0.5) };
          warnings.push(`${k}: ${s.source} says ${JSON.stringify(s.value)} but ${o.source} says ${JSON.stringify(o.value)}${cross.differencePct !== null ? ` (${cross.differencePct}% apart)` : ''}; kept ${s.source}, confidence lowered`);
        }
      } else if (s.crossCheck) {
        cross = s.crossCheck; // the provider's own second figure (assessor polygon area vs stored area); not an independent source
        note = joinNotes(note, `No independent second source; cross-check is the same provider's stored figure (${cross.source}).`);
        if (cross.agreement === 'conflict') warnings.push(`${k}: polygon area ${cross.value === undefined ? '' : `differs from ${cross.source} by ${cross.differencePct}%`}`);
      } else {
        note = joinNotes(note, 'Single source: no independent cross-check.');
      }
      fields[k] = entry({ ...s, ...(note !== undefined ? { note } : {}) }, cross);
    }

    // ---- address / location / place id ----
    const geoConf = addr ? (addr.mismatchReason ? CONFIDENCE.mismatch : addr.confidence ?? CONFIDENCE.census) : 0;
    const geoSrc = addr ? addr.source ?? addr.provider : ASSEMBLER;
    const geoNote = addr?.mismatchReason ? `Geocoder matched a different address (${addr.mismatchReason}).` : addr?.note;
    const geoMethod = addr?.provider === 'caller' && addr?.methodNote ? addr.methodNote : 'geocoded from the typed address';
    fields.address = addr ? entry(sourced(addr.address, { tag: 'measured', source: geoSrc, confidence: conf(geoConf), retrievedAt: at, method: geoMethod, ...(geoNote ? { note: geoNote } : {}) }))
      : gone('address could not be geocoded');
    let latLng = addr ? { lat: addr.lat, lng: addr.lng, src: geoSrc, c: geoConf, note: geoNote, method: geoMethod } : null;
    if (!latLng && pcen) latLng = { lat: pcen.lat, lng: pcen.lng, src: parcelSrc?.r.fields.lot_sqft?.source ?? ASSEMBLER, c: 0.6, note: 'No geocoder answered; location is the centroid of the matched parcel.', method: 'centroid of the assessor parcel polygon' };
    if (latLng && pcen && boundary) {
      const d = distanceToPolygonM({ lat: latLng.lat, lng: latLng.lng }, boundary);
      if (d > MAX_GEOCODE_TO_PARCEL_M) {
        warnings.push(`geocoded point is ${Math.round(d)} m from the matched parcel; the parcel centroid is used for lat/lng`);
        latLng = { lat: pcen.lat, lng: pcen.lng, src: parcelSrc?.r.fields.lot_sqft?.source ?? ASSEMBLER, c: 0.7, note: `The geocoded point was ${Math.round(d)} m from the matched parcel.`, method: 'centroid of the assessor parcel polygon' };
      }
    }
    for (const [key, v] of /** @type {const} */ ([['lat', latLng?.lat], ['lng', latLng?.lng]])) {
      fields[key] = latLng ? entry(sourced(/** @type {number} */ (v), { tag: 'measured', source: latLng.src, confidence: conf(latLng.c), retrievedAt: at, unit: 'degrees (WGS84)', method: latLng.method, ...(latLng.note ? { note: latLng.note } : {}) }))
        : gone('address could not be geocoded');
    }
    fields.place_id = addr?.placeId ? entry(sourced(addr.placeId, { tag: 'measured', source: geoSrc, confidence: conf(geoConf), retrievedAt: at }))
      : gone(addr ? 'no registered address provider issues a place id (Google Places key needed)' : 'address could not be geocoded');

    // ---- footprint, roof, floors ----
    const lariacOutline = Boolean(fpP && fpP.id === 'lariac-buildings' && !fp?.fallbackFrom);
    const fpSrc = fpP ? fpP.label : 'building footprint provider';
    const fpMeta = { tag: /** @type {const} */ ('measured'), source: fp?.source ?? fpSrc, retrievedAt: at, confidence: 0.6 };
    if (main) {
      fields.building_footprint_sqft = entry(sourced(Math.round(main.areaSqft), { ...fpMeta, unit: 'sqft',
        method: pointScoped && !boundary ? 'area computed from the building outline the address point is on (or nearest to)' : 'area computed from the main (largest) building outline on the parcel',
        note: joinNotes(buildings.length > 1 ? `${buildings.length} buildings on the parcel; this is the largest.` : undefined, main.layerAreaSqft ? `Layer's own AREA ${Math.round(main.layerAreaSqft)} sq ft.` : undefined,
          lariacOutline ? 'Outlines date from the 2008-2020 imagery.' : undefined, pointScoped && !boundary ? 'No parcel polygon: the building at the address point, not confirmed to be on this lot.' : undefined) }));
    } else fields.building_footprint_sqft = gone(!fpsLoaded ? 'building outlines still loading' : fpP || fpProviders.length ? 'no building outline found on the parcel' : 'no footprint provider available');

    // floors: records provider first (above), then the footprint provider's floor count (OSM levels / Overture num_floors), then its height
    // (not LARIAC's: its unit and accuracy are unverified, so that one stays a note), then living area / footprint (core/building-size.js).
    if (fields.floors.value === null) {
      const levels = main?.levels ?? main?.floors ?? null;
      const est = estimateFloors({ levelsTag: levels, heightFt: !lariacOutline && isNum(main?.heightFt) ? main.heightFt : null, livingAreaSqft: isNum(fields.house_sqft.value) ? fields.house_sqft.value : null, footprintSqft: main && main.areaSqft > 0 ? main.areaSqft : null }, { now: at });
      const s = est.floors;
      if (est.ok) {
        const fromFpLevels = main?.levels == null && main?.floors != null;
        const fromFpHeight = levels == null && !lariacOutline && isNum(main?.heightFt) && /height/.test(s.method ?? '');
        fields.floors = entry({ ...s,
          ...(fromFpLevels ? { source: `${fp?.source ?? fpSrc} floor count`, method: 'floor count (num_floors) of the building outline on the parcel', note: 'Mapped by volunteers or detected; the owner should confirm.' } : {}),
          ...(fromFpHeight ? { note: joinNotes(s.note, `Height from ${fp?.source ?? fpSrc}.`) } : {}),
          ...(levels == null && lariacOutline && main?.heightFt !== undefined ? { note: joinNotes(s.note, `Building outline height ${main.heightFt} ft (LARIAC; unit and accuracy unverified).`) } : {}) });
      } else fields.floors = gone(!fpsLoaded && !recsLoaded ? 'still loading' : s.note ?? 'floors cannot be estimated');
    }

    if (roof) {
      fields.roof_sqft = entry(sourced(Math.round(roof.areaSqft), { tag: 'measured', source: roofP.label, confidence: 0.8, retrievedAt: at, unit: 'sqft', method: 'solarPotential.wholeRoofStats.areaMeters2 converted to sq ft', note: `${roof.segments?.length ?? 0} roof segments returned.` }));
    } else if (main) {
      // City Pretty's roof-area method (core/roof.js): footprint x pitch. The pitch is a typical value unless an owner supplies one.
      const yb = fields.year_built.value, pt = fields.property_type.value;
      const rr = estimateRoof({ footprintSqft: main.areaSqft, yearBuilt: isNum(yb) ? yb : null, propertyType: typeof pt === 'string' ? pt : null, stories: isNum(fields.floors.value) ? fields.floors.value : null,
        ...(stateCode && stateCode !== '??' ? { stateCode } : {}), ...(q.roofPitchRise !== undefined ? { pitchRise: q.roofPitchRise } : {}), ...(q.roofType ? { roofType: q.roofType } : {}) }, { now: at });
      fields.roof_sqft = rr.ok ? entry({ ...rr.roof, source: `${rr.roof.source} on ${fp?.source ?? fpSrc} footprint` }) : gone(rr.roof.note ?? 'roof not estimated');
      if (rr.ok) details.roof = { planAreaSqft: rr.planAreaSqft, footprintSqft: rr.footprintSqft, pitchRise: rr.pitchRise, pitchDegrees: rr.pitchDegrees, pitchSource: rr.pitchSource, slopeFactor: rr.slopeFactor, roofShape: rr.roofShape, shapeMultiplier: rr.shapeMultiplier, overhangInches: rr.overhangInches };
    } else fields.roof_sqft = gone(fpsLoaded ? 'no roof area provider answered and no building footprint is available' : 'roof still loading');

    if (isNum(fields.house_sqft.value) && main && fields.house_sqft.value > main.areaSqft * 4.5) warnings.push('living area is more than 4.5x the main footprint; the footprint may be incomplete');

    // ---- yard (best street reference: the locator's street-side point, else a street centreline, else none) ----
    /** @type {string|null} */ let yardWhy = null;
    if (typeof ctx.splitYard !== 'function') yardWhy = 'yard splitter not provided';
    else if (!boundary) yardWhy = recsLoaded ? 'no parcel polygon' : 'parcel still loading';
    else if (!main) yardWhy = fpsLoaded ? 'no building footprint on the parcel' : 'building outlines still loading';
    /** @type {any} */ let yard = null;
    /** @type {'centreline'|'point'|null} */ let yardRef = null;
    if (!yardWhy) {
      const memo = S.yardMemo;
      if (memo && memo.boundary === boundary && memo.fp === fp && memo.streetSide === streetSide && memo.streets === S.streets && memo.buildings.length === buildings.length) { yard = memo.yard; yardWhy = memo.yardWhy; yardRef = memo.yardRef; }
      else {
        const onParcel = buildings.map((b) => b.polygon);
        const base = { parcel: boundary, buildings: onParcel, mainBuildingIndex: mainIdx };
        /** @type {string[]} */ const tried = [];
        const attempt = async (/** @type {any} */ args, /** @type {'centreline'|'point'|null} */ how) => {
          try {
            const y = await /** @type {Function} */ (ctx.splitYard)({ ...base, ...args });
            if (y && y.ok) { yard = y; yardRef = how; return true; }
            tried.push(`${how ?? 'no street reference'}: ${y?.reason ?? 'no result'}`);
          } catch (e) { tried.push(`${how ?? 'no street reference'}: yard splitter threw: ${e instanceof Error ? e.message : String(e)}`); }
          return false;
        };
        let done = false;
        if (sref) done = await attempt({ streets: sref.streets, ...(sref.streetName ? { streetName: sref.streetName } : {}) }, 'centreline');
        if (!done && streetSide) done = await attempt({ frontPoint: { lat: streetSide.lat, lng: streetSide.lng }, ...(streetName ? { streetName } : {}) }, 'point');
        if (!done && !sref && !streetSide) done = await attempt({ ...(streetName ? { streetName } : {}) }, null);
        if (!done) yardWhy = `yard split failed: ${tried.join('; ') || 'no street reference'}`;
        if (!done && tried.length === 1) yardWhy = `yard split failed: ${tried[0].replace(/^[a-z ]+: /, '')}`;
        S.yardMemo = { boundary, fp, streetSide, streets: S.streets, buildings, yard, yardWhy, yardRef };
      }
    }
    const yardKeys = /** @type {const} */ ([['front_yard_sqft', 'frontYardSqft'], ['back_yard_sqft', 'backYardSqft'], ['side_yard_sqft', 'sideYardSqft']]);
    if (yard) {
      const rc = typeof yard.confidence === 'number' ? yard.confidence : ({ low: 0.2, medium: 0.35, high: 0.4 }[/** @type {string} */ (yard.confidence)] ?? 0.2);
      const yw = Array.isArray(yard.warnings) ? yard.warnings.map(String) : [];
      for (const w of yw) warnings.push(`yard: ${w}`);
      if (!yardRef) warnings.push('yard: no street reference was available; the front/back split is less certain');
      for (const [k, rk] of yardKeys) {
        const v = yard[rk];
        fields[k] = isNum(v) ? entry(sourced(Math.round(v), { tag: 'estimated', source: 'Everyspace yard split (parcel minus building footprints)', confidence: conf(Math.min(CONFIDENCE.yard, rc)), retrievedAt: at, unit: 'sqft',
          method: yard.method ?? 'yard split', note: joinNotes(yw.length ? `Warnings: ${yw.join('; ')}.` : undefined, yardRef === 'centreline' ? `Front edge from the street centreline (${sref?.how ?? 'street line'}; ${S.streetSource?.label ?? 'street lines'}).` : yardRef === 'point' ? 'Front edge from the geocoder street-side point.' : 'No street reference.') })) : gone(yard.yardReason ? `yard not split: ${yard.yardReason}` : `splitYard returned no ${rk}`);
      }
      details.yard = { lotSqft: yard.lotSqft, buildingSqft: yard.buildingSqft, openSqft: yard.openSqft, method: yard.method, confidence: yard.confidence, frontEdge: yard.frontEdge ?? null, warnings: yw, reference: yardRef, ...(yardRef === 'centreline' && sref ? { street: sref.how } : {}) };
    } else for (const [k] of yardKeys) fields[k] = gone(yardWhy ?? 'yard not computed');

    // ---- transit (core/transit.js, City Pretty's walk-radius logic over OSM stops) ----
    // Opt-in so a profile never makes an unannounced network call: pass `ctx.osm` (an overpassNear answer) or `ctx.transit: true` (one call).
    {
      const tp = fpPoint ?? (isNum(fields.lat.value) ? { lat: fields.lat.value, lng: fields.lng.value } : null);
      /** @type {any} */ let osm = ctx.osm ?? S.osm ?? null;
      let why = 'transit stops not looked up (pass ctx.osm or ctx.transit to enable)';
      if (!ctx.osm && ctx.transit === true && !S.transitDone) why = 'transit stops still loading';
      else if (ctx.transit === true && !tp) why = 'no location to look up transit stops from';
      if (osm && !osm.ok) { why = `OpenStreetMap transit lookup failed: ${osm.reason}`; osm = null; }
      const attrs = transitAttributes(osm && tp ? summarizeTransit(osm.elements, tp) : null, { now: at, unavailableReason: why,
        ...(osm?.source ? { source: osm.source.publisher ? `${osm.source.publisher} via Overpass API` : osm.source.name, sourceUrl: osm.source.url, license: osm.source.license } : {}) });
      for (const [k, v] of Object.entries(attrs)) fields[k] = entry(v);
    }

    // ---- consistency checks against geometry ----
    if (boundary && isNum(fields.lot_sqft.value)) {
      const poly = polygonAreaSqft(boundary);
      if (fields.lot_sqft.source.indexOf('Assessor') < 0 && poly > 0) {
        const c = compareValues(fields.lot_sqft.value, Math.round(poly), 'area');
        if (c.agreement === 'conflict') warnings.push(`lot_sqft differs ${c.differencePct}% from the parcel polygon area`);
      }
    }
    if (!J && S.jurisdictionWhy && stage === 'final') warnings.push(`county could not be determined: ${S.jurisdictionWhy}`);

    // ---- output ----
    /** @type {Record<string, any>} */ const out = { address: fields.address.value, lat: fields.lat.value, lng: fields.lng.value, place_id: fields.place_id.value };
    const ordered = /** @type {Record<string, any>} */ ({});
    for (const k of PROFILE_FIELDS) ordered[k] = fields[k];
    for (const k of ['building_footprint_sqft', 'use_code', 'units', 'transit_distance_m', 'transit_stops_nearby', 'rail_station_nearby']) ordered[k] = fields[k];
    for (const k of PROFILE_FIELDS.slice(4)) out[k] = fields[k].value;
    out.building_footprint_sqft = fields.building_footprint_sqft.value;
    out.transit_distance_m = fields.transit_distance_m.value;
    if (typeof ctx.splitYard === 'function' || yard) details.yard_used = Boolean(yard);
    if (J && J.state !== '??') details.county = { state: J.state, ...(J.countyFips ? { countyFips: J.countyFips } : {}), ...(J.county ? { county: J.county } : {}) };
    if (parcelSrc) {
      details.jurisdiction = { country: 'US', ...(J && J.state !== '??' ? J : {}) };
      details.jurisdiction_method = J?.countyFips === LA_COUNTY.countyFips ? 'parcel found in the LA County assessor layer' : `parcel found in the county's own parcel layer (${parcelSrc.p.id}); county from ${S.jurisdictionHow ?? 'the map location'}`;
    }
    const providers = [...rows.values()].filter((r) => r.status !== 'pending');
    return { ...out, fields: ordered, providers, warnings, details, attributions, retrieved_at: at };
  }

  // ---- progressive output -------------------------------------------------------------------------------------------------------
  const onPartial = typeof ctx.onPartial === 'function' ? ctx.onPartial : null;
  let chain = Promise.resolve();
  const emit = (/** @type {string} */ stage) => {
    if (!onPartial) return;
    chain = chain.then(async () => { try { const r = await assemble(stage); try { onPartial(r, { stage }); } catch { /* a page callback must not break the builder */ } } catch { /* a partial is optional */ } });
  };
  if (S.addr || typed) emit('address');

  // ---- records, footprints, street, transit: started together -------------------------------------------------------------------
  /** @type {any} */ let resolveEarly;
  const earlyDone = new Promise((r) => { resolveEarly = r; });
  /** @type {any} */ let resolveRecs;
  const recsDone = new Promise((r) => { resolveRecs = r; });
  const earlyFp = fpProviders.filter((p) => !needsParcel(p));
  const lateFp = fpProviders.filter((p) => needsParcel(p));
  /** @type {Map<any, any>} */ const fpResult = new Map();

  const runFootprint = async (/** @type {any} */ p, /** @type {boolean} */ withParcel) => {
    const pcen0 = withParcel ? (() => { const b = S.recs?.find((x) => x.r.ok && x.r.parcel?.boundary)?.r.parcel.boundary; return b ? { b, c: centroid(b) } : null; })() : null;
    const pt = pcen0?.c ?? point;
    if (!pt) { fpResult.set(p, { ok: false, reason: 'no location', code: 'bad_query' }); return; }
    // Without a parcel the search is by point: 60 m around it, so the building the address is on is found even from a street-side point.
    const r = await safe(() => p.lookup({ lat: pt.lat, lng: pt.lng, ...(pcen0 ? { parcel: pcen0.b } : { radiusM: POINT_SEARCH_RADIUS_M }) }, deps(p.id)));
    fpResult.set(p, r.ok ? { ...r, parcelScoped: Boolean(pcen0) } : r);
  };
  const fpEarlyTask = Promise.all(earlyFp.map((p) => runFootprint(p, false))).then(() => resolveEarly());
  if (!earlyFp.length) resolveEarly();

  const nearestCentroid = () => {
    if (!point) return null;
    const list = earlyFp.map((p) => fpResult.get(p)).find((r) => r?.ok && r.buildings.length)?.buildings ?? [];
    const i = nearestBuildingIndex(list, point);
    return i >= 0 ? buildingCentroid(list[i].polygon) : null;
  };
  const recTask = (async () => {
    const results = await Promise.all(recProviders.map(async (p) => {
      /** @type {{lat?:number,lng?:number}} */ let at0 = point ?? {};
      const needsPoint = needsPointInParcel(p);
      // The parcel registry needs a point INSIDE the parcel. RULE: a rooftop-level geocode is used as it is; otherwise the point is the centroid of
      // the building footprint nearest the geocoded point (the building containing it, else the closest), once footprints have arrived.
      if (needsPoint && !rooftop) { await earlyDone; at0 = nearestCentroid() ?? at0; }
      const ask = (/** @type {any} */ pt) => safe(() => p.lookup({ address: recAddress, ...(isNum(pt?.lat) ? { lat: pt.lat, lng: pt.lng } : {}), ...(S.addr?.placeId ? { placeId: S.addr.placeId } : {}), ...(q.apn ? { apn: q.apn } : {}), ...(jur ? { jurisdiction: jur } : {}) }, deps(p.id)));
      let r = await ask(at0);
      if (!r.ok && needsPoint && rooftop && r.code === 'no_match') {
        await earlyDone;
        const c = nearestCentroid();
        if (c && point && distanceM(point, c) >= RETRY_MIN_M) r = await ask(c);
      }
      return { p, r };
    }));
    S.recs = results;
    for (const x of results) { if (x.r.ok) mark(x.p.id, 'used'); else mark(x.p.id, 'failed', x.r.reason); }
    resolveRecs();
    emit('records');
  })();

  const lateTask = (async () => {
    if (!lateFp.length) return; // nothing depends on the parcel: the footprint group is done when the early providers are
    await recsDone;
    await Promise.all(lateFp.map((p) => runFootprint(p, true)));
  })();
  const fpTask = Promise.all([fpEarlyTask, lateTask]).then(() => {
    S.fps = fpProviders.map((p) => ({ p, r: fpResult.get(p) })).filter((x) => x.r);
    let fpFound = false, roofFound = false;
    for (const x of S.fps) {
      if (!x.r.ok) { mark(x.p.id, 'failed', x.r.reason); continue; }
      let used = false;
      if (!fpFound && x.r.buildings.length) { fpFound = true; used = true; }
      if (!roofFound && x.r.roof) { roofFound = true; used = true; }
      mark(x.p.id, 'used', used ? undefined : 'answered, nothing new');
    }
    emit('footprints');
  });

  const streetTask = (async () => {
    if (!point) { S.streetDone = true; return; }
    for (const p of streetProviders) {
      const r = await safe(() => p.lookup({ lat: point.lat, lng: point.lng, address: typed }, deps(p.id)));
      if (!r.ok) { mark(p.id, 'failed', r.reason); continue; }
      const list = Array.isArray(r.streets) ? r.streets.filter((/** @type {any} */ s) => s && s.geometry) : [];
      if (!list.length) { mark(p.id, 'used', 'no street line near the address'); continue; }
      // every street near the address is kept: the address's own street is the front, the others tell a corner or a through lot (core/street-ref.js)
      S.streets = list; S.streetSource = { id: p.id, label: p.label ?? p.id, attribution: r.attribution ?? null };
      mark(p.id, 'used', streetReference({ streets: list, address: typed })?.matched ? undefined : 'no street with a matching name; the nearest street is used');
      break;
    }
    S.streetDone = true;
  })();

  const transitTask = (async () => {
    if (ctx.osm || ctx.transit !== true || !point) { S.transitDone = true; return; }
    const osm = await safe(() => overpassNear(point, { buildingRadiusM: 1 }, { fetch: ctx.fetch, now: at, ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}) }));
    S.osm = osm; S.transitDone = true;
    mark('overpass-transit', osm.ok ? 'used' : 'failed', osm.ok ? undefined : osm.reason);
  })();

  await Promise.all([recTask, fpTask, streetTask, transitTask].map((t) => t.catch(() => {})));
  await chain;
  const result = await assemble('final');
  if (onPartial) { try { onPartial(result, { stage: 'final' }); } catch { /* ignore */ } }
  return result;
}

/**
 * The attribute-map shape of core/profile.js (so core/opportunities, revenue etc. can consume it).
 * @param {any} pj output of buildPropertyProfile
 */
export function toSourcedProfile(pj) {
  let profile = createProfile();
  const f = pj?.fields ?? {};
  const toSourced = (/** @type {any} */ e) => (!e || e.tag === 'unavailable' || e.value === null || e.value === undefined
    ? unavailable(e?.note ?? 'not available', e?.source ?? ASSEMBLER)
    : sourced(e.value, { tag: e.tag, source: e.source, confidence: e.confidence, retrievedAt: e.retrieved_at ?? null, ...(e.unit ? { unit: e.unit } : {}), ...(e.method ? { method: e.method } : {}), ...(e.note ? { note: e.note } : {}) }));
  const put = (/** @type {string} */ key, /** @type {any} */ s) => { profile = setAttribute(profile, key, s); };
  const map = /** @type {Array<[string,string]>} */ ([['address', 'address'], ['apn', 'parcel_id'], ['lot_sqft', 'lot_area_sqft'], ['house_sqft', 'living_area_sqft'], ['floors', 'floors'],
    ['beds', 'bedrooms'], ['baths', 'bathrooms'], ['roof_sqft', 'roof_area_sqft'], ['front_yard_sqft', 'front_yard_sqft'], ['back_yard_sqft', 'back_yard_sqft'],
    ['side_yard_sqft', 'side_yard_sqft'], ['year_built', 'year_built'], ['property_type', 'property_type'], ['place_id', 'place_id'], ['use_code', 'use_code'], ['units', 'units'],
    ['building_footprint_sqft', 'building_footprint_sqft'], ['transit_distance_m', 'transit_distance_m'], ['transit_stops_nearby', 'transit_stops_nearby'], ['rail_station_nearby', 'rail_station_nearby']]);
  for (const [from, to] of map) if (f[from]) put(to, toSourced(f[from]));
  if (f.lat && f.lng) {
    const ok = f.lat.value !== null && f.lng.value !== null;
    put('location', ok ? sourced({ lat: f.lat.value, lng: f.lng.value }, { tag: f.lat.tag, source: f.lat.source, confidence: Math.min(f.lat.confidence, f.lng.confidence), retrievedAt: f.lat.retrieved_at ?? null, unit: 'degrees (WGS84)', ...(f.lat.method ? { method: f.lat.method } : {}) })
      : unavailable(f.lat.note ?? 'no location', f.lat.source));
  }
  const ys = ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft'].map((k) => f[k]);
  if (ys.every((y) => y && isNum(y.value))) {
    put('yard_area_sqft', sourced(ys.reduce((s, y) => s + y.value, 0), { tag: 'estimated', source: ys[0].source, confidence: Math.min(...ys.map((y) => y.confidence)), retrievedAt: ys[0].retrieved_at ?? null, unit: 'sqft', method: 'front + back + side yard' }));
  } else put('yard_area_sqft', unavailable('no yard split', ASSEMBLER));
  const d = pj?.details ?? {};
  if (d.parcel_boundary) put('parcel_boundary', sourced(d.parcel_boundary, { tag: 'measured', source: f.apn?.source ?? ASSEMBLER, confidence: f.lot_sqft?.confidence ?? 0.7, retrievedAt: f.apn?.retrieved_at ?? null, unit: 'GeoJSON (WGS84)' }));
  else put('parcel_boundary', unavailable('no parcel polygon', ASSEMBLER));
  if (d.jurisdiction) put('jurisdiction', sourced(d.jurisdiction, { tag: 'measured', source: f.apn?.source ?? ASSEMBLER, confidence: 0.8, retrievedAt: f.apn?.retrieved_at ?? null, method: 'parcel found in the LA County assessor layer' }));
  if (Array.isArray(d.buildings) && d.buildings.length) {
    put('buildings', sourced(d.buildings.map((/** @type {any} */ b) => ({ footprintSqft: Math.round(b.areaSqft), polygon: b.polygon })), { tag: f.building_footprint_sqft?.tag ?? 'measured', source: f.building_footprint_sqft?.source ?? ASSEMBLER, confidence: f.building_footprint_sqft?.confidence ?? 0.6, retrievedAt: f.building_footprint_sqft?.retrieved_at ?? null }));
  }
  return profile;
}

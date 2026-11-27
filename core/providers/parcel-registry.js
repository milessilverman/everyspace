// @ts-check
// Nationwide parcel records provider (kind 'records', id 'parcel-registry'): the parcel polygon at a point from the county's own open
// ArcGIS REST parcel service, else a truly statewide one, from the registry in core/data/parcel-services.js (131 services).
//
// PORTED FROM StreetForge streetforge2d.html:
//   13668-13670  `parcelService`, service choice: a county's own service first (service.counties contains the FIPS); a state service only when it lists no
//                counties, because "one county's service listed under its state was answering for the whole state"
//                -> core/parcel.js `servicesFor` (already in Everyspace: county match first, then entries with no countyFips) + this file
//   13671        `esriPolygons` (ArcGIS rings -> polygons)                           -> core/parcel.js `ringsToGeoJSON` (already in Everyspace)
//   13672-13683  `parcelsIn`: `j.geometryType !== 'esriGeometryPolygon'` -> a layer of POINTS (one per property) has no lot lines: skipped;
//                condo units stack identical parcels: one is enough                    -> queryService
//   13664-13667  county lookup                                                       -> ./county-lookup.js
// Differences, on purpose: StreetForge asks for every parcel inside a drawn area (envelope query, paged, up to 3000) to draw lot lines;
// Everyspace needs ONE parcel at a point, so this asks a point-intersect query (like core/parcel.js `parcelAt`, whose situs-matched
// buffer step is also repeated here, but only for services that map an address field). Everyspace's records contract (fields with
// provenance, `parcel` object, never a guess) replaces StreetForge's `{apn, polys}`.
//
// LIMITS (read before use):
//  - The point must lie INSIDE the parcel. A street-side geocode point finds nothing unless the service maps a situs address field
//    (then one parcel within 40 m whose address matches is taken; zero or several is a failure with candidates). Of the generated
//    services only the apn field is mapped, so pass a building centroid or a point from another provider.
//  - Only the fields the service's field map names are read; for the generated services that is the APN. Everything else is `unavailable`.
//  - LA County is served by the richer `la-assessor` provider; this provider refuses it unless `query.allowLosAngeles` is true.
//  - Licences of the individual services are NOT verified (see each entry's termsUrl). `corsStatus` says what was tested for browsers.

import { servicesFor, ringsToGeoJSON, classifyPropertyType, situsMatchesAddress, CONFIDENCE, isoNow, pos, text, num } from '../parcel.js';
import { polygonAreaSqft, pointInPolygon } from '../geometry.js';
import { PARCEL_SERVICES } from '../data/parcel-services.js';
import { countyAt } from './county-lookup.js';
import { callJson, qs, fail, sourced, unavailable, withCrossCheck, compareValues, round } from './util.js';

const LA_FIPS = '06037';
const DEFAULT_RADIUS_M = 40;
const MAX_CANDIDATES = 10;
/** Timeout for a browser-side try of a service whose CORS support was never tested. */
export const UNVERIFIED_TIMEOUT_MS = 4000;

/** @typedef {import('../data/parcel-services.js').ParcelService} ParcelService */

/**
 * The services to try for a jurisdiction, in order: the county's own first, then statewide ones. Pure.
 * @param {ParcelService[]} services @param {{state?:string, countyFips?:string, county?:string}} j
 * @param {{corsMode?:'any'|'verified-only'|'try-unverified', includeCaveated?:boolean}} [opts]
 * @returns {{try:ParcelService[], skippedCors:ParcelService[], skippedCaveat:ParcelService[]}}
 */
export function selectServices(services, j, opts = {}) {
  const ordered = servicesFor(services, j);
  const all = opts.includeCaveated ? ordered : ordered.filter((s) => !s.caveat);
  const skippedCaveat = opts.includeCaveated ? [] : ordered.filter((s) => s.caveat);
  if (opts.corsMode !== 'verified-only') return { try: all, skippedCors: [], skippedCaveat };
  return { try: all.filter((s) => s.corsStatus === 'verified'), skippedCors: all.filter((s) => s.corsStatus !== 'verified'), skippedCaveat };
}

/** Stable key of a parcel geometry, to spot the identical parcels that stacked condo units produce. @param {number[][][]} rings */
const ringKey = (rings) => rings.map((R) => `${R.length}:${R.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';')}`).join('|');

/**
 * Ask one service for the parcel at a point. Never throws.
 * @param {ParcelService} svc @param {{lat:number,lng:number,address?:string}} pt @param {any} deps
 * @returns {Promise<{ok:true, feature:any, boundary:any, matchedBy:string, method:string, stackedUnits:number, nearby?:number}|{ok:false, reason:string, code:string, candidates?:any[]}>}
 */
export async function queryService(svc, pt, deps) {
  const f = svc.fields;
  const outFields = [f.apn, f.address, f.useCode, f.useType, f.useDescription, f.livingAreaSqft, f.units, f.yearBuilt, f.bedrooms, f.lotAreaSqft].filter((x, i, a) => x && a.indexOf(x) === i);
  const base = { geometry: `${pt.lng.toFixed(6)},${pt.lat.toFixed(6)}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: outFields.length ? outFields.join(',') : '*', returnGeometry: 'true', outSR: '4326', f: 'json' };
  /** @param {Record<string,string>} extra */
  const call = (extra) => callJson(`${svc.url}?${qs({ ...base, ...extra })}`, deps);
  /** @param {any} r @returns {{ok:false, reason:string, code:string}|{ok:true, features:any[]}} */
  const check = (r) => {
    if (!r.ok) return { ok: false, reason: r.reason, code: r.code };
    if (r.json?.error) return { ok: false, reason: `service error: ${r.json.error.message ?? r.json.error.code ?? 'unknown'}`, code: 'http_error' };
    if (r.json?.geometryType && r.json.geometryType !== 'esriGeometryPolygon') return { ok: false, reason: `layer holds ${String(r.json.geometryType).replace('esriGeometry', '').toLowerCase()}s, not parcel polygons (skipped)`, code: 'point_layer' };
    if (!Array.isArray(r.json?.features)) return { ok: false, reason: 'malformed response', code: 'malformed_json' };
    return { ok: true, features: r.json.features };
  };
  const polyOf = (/** @type {any} */ ft) => ringsToGeoJSON(ft?.geometry?.rings ?? []);

  // 1. the parcel containing the point
  const a = check(await call({}));
  if (!a.ok) return a;
  const withGeom = a.features.map((ft) => ({ ft, g: polyOf(ft) })).filter((x) => x.g);
  if (a.features.length && !withGeom.length) return { ok: false, reason: 'the service returned features without polygon geometry (a layer of points?)', code: 'point_layer' };
  const containing = withGeom.filter((x) => pointInPolygon(pt, x.g));
  if (containing.length) {
    const distinct = new Map(containing.map((x) => [ringKey(x.ft.geometry.rings), x]));
    if (distinct.size > 1) return { ok: false, reason: `${distinct.size} different parcels contain the point; none was chosen`, code: 'multiple_matches',
      candidates: [...distinct.values()].slice(0, MAX_CANDIDATES).map((x) => ({ apn: f.apn ? text(x.ft.attributes?.[f.apn]) ?? null : null, address: f.address ? text(x.ft.attributes?.[f.address]) ?? null : null })) };
    const x = containing[0];
    return { ok: true, feature: x.ft, boundary: x.g, matchedBy: 'containing-point', method: 'parcel containing the point', stackedUnits: containing.length };
  }
  if (withGeom.length) return { ok: false, reason: `${withGeom.length} parcels returned but none contains the point`, code: 'no_match' };

  // 2. nothing at the point: a geocoded address point is usually in the street. Only with an address field can a parcel be chosen safely.
  if (!pt.address || !f.address) return { ok: false, reason: `no parcel at this point${f.address ? '' : ' (this service maps no address field, so a street-side point cannot be matched)'}`, code: 'no_match' };
  const radius = svc.searchRadiusM ?? DEFAULT_RADIUS_M;
  const b = check(await call({ distance: String(radius), units: 'esriSRUnit_Meter' }));
  if (!b.ok) return { ok: false, reason: `no parcel at this point; search within ${radius} m failed: ${b.reason}`, code: b.code };
  const rows = b.features.map((ft) => ({ ft, g: polyOf(ft), address: text(ft?.attributes?.[f.address ?? '']) ?? null })).filter((x) => x.g);
  const hits = rows.filter((x) => x.address && situsMatchesAddress(pt.address ?? '', x.address));
  if (hits.length === 1) return { ok: true, feature: hits[0].ft, boundary: hits[0].g, matchedBy: 'situs', method: `matched by situs address within ${radius} m of the point`, stackedUnits: 1, nearby: rows.length };
  const candidates = (hits.length ? hits : rows).slice(0, MAX_CANDIDATES).map((x) => ({ apn: f.apn ? text(x.ft.attributes?.[f.apn]) ?? null : null, address: x.address }));
  return { ok: false, code: hits.length ? 'multiple_matches' : 'no_match', candidates,
    reason: !rows.length ? `no parcel within ${radius} m either` : hits.length ? `${hits.length} of ${rows.length} parcels within ${radius} m match the address; none chosen` : `${rows.length} parcels within ${radius} m, none matches the address` };
}

/** @param {any} v */
const year = (v) => { const n = pos(v); return n !== null && Number.isInteger(n) && n >= 1000 && n <= 9999 ? n : null; };

/**
 * Parcel + service attributes -> records-provider fields (every field Sourced; a field the service does not map is unavailable with the reason).
 * @param {ParcelService} svc @param {any} attrs @param {any} boundary @param {{at:string, idConf:number, method:string}} ctx
 */
export function fieldsFromService(svc, attrs, boundary, ctx) {
  const { at, idConf, method } = ctx;
  const f = svc.fields, source = svc.publisher;
  const meta = (/** @type {number} */ confidence, /** @type {any} */ extra = {}) => ({ tag: /** @type {const} */ ('measured'), source, sourceUrl: svc.url, license: svc.license, retrievedAt: at, confidence: Math.min(confidence, idConf), ...extra });
  const none = (/** @type {string} */ r) => unavailable(r, source);
  const unmapped = (/** @type {string} */ what) => none(`this service's field map has no ${what} field`);
  /** @type {Record<string, any>} */ const out = {};
  const apn = f.apn ? (text(attrs[f.apn]) ?? (num(attrs[f.apn]) !== null ? String(attrs[f.apn]) : null)) : null;
  out.apn = apn ? sourced(apn, meta(CONFIDENCE.parcelId, { method })) : none(f.apn ? 'the parcel has no number in the service' : "this service's field map has no parcel-number field");
  const area = Math.round(polygonAreaSqft(boundary));
  const stored = f.lotAreaSqft ? pos(attrs[f.lotAreaSqft]) : null;
  const lot = sourced(area, meta(CONFIDENCE.polygonArea, { unit: 'sqft', method: 'WGS84 parcel polygon area (core/geometry.js), holes subtracted', note: `Measured from the published outline; can differ from the recorded lot size.${svc.termsNote ? ` Terms note from the source list: ${svc.termsNote}` : ''}` }));
  out.lot_sqft = stored !== null ? withCrossCheck(lot, { source: `${source} stored lot area`, ...compareValues(area, Math.round(stored), 'area') }) : lot;
  const living = f.livingAreaSqft ? pos(attrs[f.livingAreaSqft]) : null;
  out.house_sqft = !f.livingAreaSqft ? unmapped('living area') : living !== null ? sourced(living, meta(CONFIDENCE.assessor, { unit: 'sqft', method: `field ${f.livingAreaSqft}` })) : none('the service records no living area for this parcel');
  out.floors = none('parcel services do not publish a floor count');
  const beds = f.bedrooms ? pos(attrs[f.bedrooms]) : null;
  out.beds = !f.bedrooms ? unmapped('bedrooms') : beds !== null ? sourced(beds, meta(CONFIDENCE.assessor, { method: `field ${f.bedrooms}` })) : none('the service records no bedroom count for this parcel');
  out.baths = none('parcel services do not publish a bathroom count in a known field');
  const yb = f.yearBuilt ? year(attrs[f.yearBuilt]) : null;
  out.year_built = !f.yearBuilt ? unmapped('year built') : yb !== null ? sourced(yb, meta(CONFIDENCE.assessor, { method: `field ${f.yearBuilt}` })) : none('the service records no valid year built for this parcel');
  const units = f.units ? pos(attrs[f.units]) : null;
  out.units = !f.units ? unmapped('units') : units !== null ? sourced(units, meta(CONFIDENCE.assessor, { method: `field ${f.units}` })) : none('the service records no unit count for this parcel');
  const useCode = f.useCode ? text(attrs[f.useCode]) : null, useType = f.useType ? text(attrs[f.useType]) : null, useDesc = f.useDescription ? text(attrs[f.useDescription]) : null;
  out.use_code = useCode ? sourced(useCode, meta(CONFIDENCE.assessor, { method: `field ${f.useCode}`, note: [useType, useDesc].filter(Boolean).join(' / ') || undefined })) : (f.useCode ? none('the service records no use code for this parcel') : unmapped('use code'));
  const kind = useCode || useType || useDesc
    ? classifyPropertyType({ useCode, useType, useDescription: useDesc, livingAreaSqft: living, units }, { ...(svc.useCodeScheme ? { codeScheme: svc.useCodeScheme } : {}), hasSqftField: Boolean(f.livingAreaSqft) }) : 'unknown';
  out.property_type = kind === 'unknown'
    ? none(useCode || useType || useDesc ? 'the use text did not match a known class' : "this service's field map has no use-type field")
    : sourced(kind, { tag: 'estimated', source, sourceUrl: svc.url, retrievedAt: at, confidence: Math.min(CONFIDENCE.classified, idConf), method: 'classified from the service use text (core/parcel.js classifyPropertyType)' });
  return out;
}

/**
 * Build the provider. Options: `services` (default the whole registry); `corsMode` 'any' (server: try every service) | 'verified-only'
 * (browser default: services never tested for CORS are skipped) | 'try-unverified' (browser opt-in: they are tried with a short timeout).
 * @param {{services?:ParcelService[], corsMode?:'any'|'verified-only'|'try-unverified', unverifiedTimeoutMs?:number, includeCaveated?:boolean}} [opts]
 * @returns {import('./types.js').PropertyRecordsProvider}
 */
export function createParcelRegistryProvider(opts = {}) {
  const services = opts.services ?? PARCEL_SERVICES;
  const corsMode = opts.corsMode ?? 'any';
  return {
    id: 'parcel-registry', label: 'County and state parcel services (registry)', kind: 'records', needsKey: false, role: 'fallback', priority: 50, verified: true,
    coverage: /** @type {any} */ ({ national: true, exceptCountyFips: [LA_FIPS] }), retentionDays: null,
    licenseNote: 'Each county or state sets its own terms; the registry keeps each service\'s terms link (termsUrl) and every licence is "not verified". Confirm the terms of the counties that matter before storing at scale.',
    async lookup(query, deps) {
      let at;
      try { at = isoNow(deps?.now); } catch (e) { return fail(e instanceof Error ? e.message : '`now` must be injected', 'bad_query'); }
      const q = /** @type {any} */ (query);
      if (!q || !Number.isFinite(q.lat) || !Number.isFinite(q.lng)) return fail('lat/lng required (a point inside the parcel)', 'bad_query');
      /** @type {{state?:string, countyFips?:string, county?:string|null}} */
      let j = q.jurisdiction ?? /** @type {any} */ (deps).jurisdiction ?? null;
      if (!j?.state) {
        const c = await countyAt({ lat: q.lat, lng: q.lng }, deps);
        if (!c.ok) return fail(`county not found: ${c.reason}`, c.code);
        j = { state: c.state, countyFips: c.countyFips, county: c.county };
      }
      if (j.countyFips === LA_FIPS && !q.allowLosAngeles) return fail('Los Angeles County is read by the la-assessor provider (richer fields)', 'unsupported');
      const sel = selectServices(services, /** @type {any} */ (j), { corsMode, includeCaveated: opts.includeCaveated === true });
      const where = `${j.county ?? j.countyFips ?? 'unknown county'}, ${j.state ?? 'unknown state'}`;
      if (!sel.try.length) {
        if (sel.skippedCaveat.length && !sel.skippedCors.length) return fail(`the only parcel service listed for ${where} is not a verified parcel layer (${sel.skippedCaveat.map((s) => `${s.id}: ${s.caveat}`).join('; ')})`, 'no_service', { jurisdiction: j, skippedCaveat: sel.skippedCaveat.map((s) => s.id) });
        return fail(sel.skippedCors.length ? `${sel.skippedCors.length} parcel service(s) cover ${where} but none is verified to answer browser requests (CORS not verified): ${sel.skippedCors.map((s) => s.id).join(', ')}` : `no parcel service for ${where}`,
          sel.skippedCors.length ? 'cors_unverified' : 'no_service', { jurisdiction: j, skippedCors: sel.skippedCors.map((s) => s.id), skippedCaveat: sel.skippedCaveat.map((s) => s.id) });
      }
      /** @type {string[]} */ const reasons = [], codes = [];
      /** @type {any[]|undefined} */ let candidates;
      for (const svc of sel.try) {
        const d = corsMode === 'try-unverified' && svc.corsStatus !== 'verified' ? { ...deps, timeoutMs: Math.min(deps.timeoutMs ?? UNVERIFIED_TIMEOUT_MS, opts.unverifiedTimeoutMs ?? UNVERIFIED_TIMEOUT_MS) } : deps;
        const r = await queryService(svc, { lat: q.lat, lng: q.lng, ...(typeof q.address === 'string' ? { address: q.address } : {}) }, d);
        if (!r.ok) { reasons.push(`${svc.id}: ${r.reason}`); codes.push(r.code); if (r.candidates?.length) candidates ??= r.candidates; continue; }
        const attrs = r.feature.attributes ?? {};
        const idConf = r.matchedBy === 'situs' ? CONFIDENCE.parcelBySitus : CONFIDENCE.parcelId;
        const fields = fieldsFromService(svc, attrs, r.boundary, { at, idConf, method: r.method });
        return {
          ok: /** @type {const} */ (true), fields,
          parcel: { boundary: r.boundary, apn: fields.apn.value, address: svc.fields.address ? text(attrs[svc.fields.address]) ?? null : null, assessorAreaSqft: svc.fields.lotAreaSqft ? pos(attrs[svc.fields.lotAreaSqft]) : null,
            matchedBy: r.matchedBy, method: r.method, confidence: idConf },
          raw: { service: svc.id, serviceUrl: svc.url, termsUrl: svc.termsUrl, ...(svc.termsNote ? { termsNote: svc.termsNote } : {}), county: j.county ?? null, countyFips: j.countyFips ?? null, state: j.state ?? null, corsStatus: svc.corsStatus ?? 'not verified', scope: svc.coverage.countyFips ? 'county' : 'statewide',
            ...(r.stackedUnits > 1 ? { stackedUnits: r.stackedUnits } : {}), attributes: attrs, lotSqftRounded: round(fields.lot_sqft.value, 0) },
        };
      }
      const TRANSPORT = ['http_error', 'network', 'timeout', 'malformed_json', 'server_error', 'rate_limited', 'auth', 'not_found'];
      const code = codes.includes('multiple_matches') ? 'multiple_matches' : codes.length && codes.every((c) => TRANSPORT.includes(c)) ? 'http_error' : 'no_match';
      return fail(`no parcel found for ${where}: ${reasons.join('; ')}`, code, { jurisdiction: j, ...(candidates ? { candidates } : {}) });
    },
  };
}

export const parcelRegistry = createParcelRegistryProvider();

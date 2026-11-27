// @ts-check
// LA County Assessor parcel layer as a keyless records provider (records + parcel polygon). Verified live 2026-11-27:
// LACounty_Cache/LACounty_Parcel/MapServer/0. `Shape.STArea()` is square feet (255,338 against 255,412 measured from the
// polygon for 200 N Spring St). Lookup order: (1) direct situs attribute query from the parsed address; (2) the existing
// point/buffer + situs match in core/parcel.js (parcelAt), then a by-AIN query for the full record.
//
// SQL SAFETY: every value placed in a `where` clause is validated, never escaped: house number digits only, street/city
// letters+digits+spaces only, ZIP digits only, AIN digits only. Anything else returns {ok:false, code:'bad_query'} and no
// request is made. (Consequence: street names with an apostrophe or hyphen are refused rather than risk a malformed query.)

import { parseStreet, situsMatchesAddress, ringsToGeoJSON, classifyPropertyType, parcelAt, CONFIDENCE } from '../parcel.js';
import { polygonAreaSqft, pointInPolygon } from '../geometry.js';
import { PARCEL_SERVICES } from '../data/parcel-services.js';
import { callJson, qs, fail, isoNow, pos, text, sourced, unavailable, withCrossCheck, compareValues, round } from './util.js';

const SERVICE = PARCEL_SERVICES.find((s) => s.id === 'la-county-assessor');
if (!SERVICE) throw new Error('la-county-assessor missing from core/data/parcel-services.js');
const QUERY_URL = SERVICE.url;
const SOURCE = SERVICE.publisher;
const LA_JURISDICTION = { state: 'CA', countyFips: '06037', county: 'Los Angeles County' };
const STATE_ZIP = /^[A-Za-z]{2}(\s+\d{5}(-\d{4})?)?$/;

/**
 * Parse a US address into validated situs parts. Never builds SQL.
 * @param {string} address
 * @returns {{ok:true, line1:string, houseNo:string, dir:string|null, street:string, suffix:string|null, city:string|null, zip:string|null}|{ok:false, reason:string, code:'bad_query'}}
 */
export function parseSitus(address) {
  const bad = (/** @type {string} */ reason) => /** @type {{ok:false, reason:string, code:'bad_query'}} */ ({ ok: false, reason, code: 'bad_query' });
  if (typeof address !== 'string' || !address.trim()) return bad('empty address');
  if (address.length > 200) return bad('address too long');
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  const p = parseStreet(parts[0]);
  if (!p) return bad('address has no house number');
  if (!/^\d{1,6}$/.test(p.num)) return bad('house number must be digits only (fractions and letters are not supported)');
  if (!p.core.length) return bad('address has no street name');
  if (!p.core.every((w) => /^[A-Z0-9]+$/.test(w))) return bad('street name may contain only letters, digits and spaces');
  let city = null;
  const second = parts[1];
  if (parts.length >= 2 && second && !STATE_ZIP.test(second) && !/^\d/.test(second)) {
    const c = second.toUpperCase().replace(/\./g, '');
    if (!/^[A-Z0-9 ]+$/.test(c)) return bad('city may contain only letters, digits and spaces');
    city = c.replace(/\s+/g, ' ').trim();
  }
  const rest = parts.slice(1).join(' ');
  const zipM = /\b(\d{5})(?:-\d{4})?\b/.exec(rest) ?? (parts.length === 1 ? /\b(\d{5})(?:-\d{4})?\s*$/.exec(parts[0].slice(p.num.length)) : null);
  const zip = zipM ? zipM[1] : null;
  return { ok: true, line1: parts[0], houseNo: p.num, dir: p.dir, street: p.core.join(' '), suffix: p.suffix, city, zip };
}

/**
 * Build the `where` clause from parsed parts. Pure; throws if given an unvalidated part (defence in depth).
 * @param {{houseNo:string, dir:string|null, street:string, city:string|null, zip:string|null}} s
 */
export function buildSitusWhere(s) {
  if (!/^\d{1,6}$/.test(s.houseNo)) throw new RangeError('unsafe house number');
  if (!/^[A-Z0-9 ]+$/.test(s.street)) throw new RangeError('unsafe street');
  if (s.city !== null && !/^[A-Z0-9 ]+$/.test(s.city)) throw new RangeError('unsafe city');
  if (s.zip !== null && !/^\d{5}$/.test(s.zip)) throw new RangeError('unsafe zip');
  if (s.dir !== null && !/^[NSEW]$/.test(s.dir)) throw new RangeError('unsafe direction');
  const w = [`SitusHouseNo='${s.houseNo}'`];
  if (s.dir) w.push(`SitusDirection='${s.dir}'`);
  w.push(`SitusStreet LIKE '${s.street}%'`);
  if (s.zip) w.push(`SitusZIP LIKE '${s.zip}%'`);
  else if (s.city) w.push(`SitusCity LIKE '${s.city}%'`);
  return w.join(' AND ');
}

const yearOf = (/** @type {any} */ v) => { const n = pos(v); return n !== null && Number.isInteger(n) && n >= 1000 && n <= 9999 ? n : null; };

/**
 * Collapse the assessor's five improvement slots into facts. '0000', 0, '' and null are "not recorded".
 * @param {any} a layer attributes
 */
export function summarizeImprovements(a) {
  const recs = [];
  for (let i = 1; i <= 5; i++) {
    recs.push({ i, sqft: pos(a[`SQFTmain${i}`]), beds: pos(a[`Bedrooms${i}`]), baths: pos(a[`Bathrooms${i}`]), year: yearOf(a[`YearBuilt${i}`]), units: pos(a[`Units${i}`]) });
  }
  const sum = (/** @type {'sqft'|'beds'|'baths'|'units'} */ k) => {
    const have = recs.filter((r) => r[k] !== null);
    return { value: have.length ? round(have.reduce((s, r) => s + /** @type {number} */ (r[k]), 0), 2) : null, records: have.length };
  };
  const withYear = recs.filter((r) => r.year !== null);
  // the year of the largest recorded improvement; the earliest year breaks ties
  const main = [...withYear].sort((x, y) => (y.sqft ?? 0) - (x.sqft ?? 0) || /** @type {number} */ (x.year) - /** @type {number} */ (y.year))[0];
  return { sqft: sum('sqft'), beds: sum('beds'), baths: sum('baths'), units: sum('units'), year: main ? { value: main.year, slot: main.i, of: withYear.length } : { value: null, slot: 0, of: 0 },
    improvements: recs.filter((r) => r.sqft !== null || r.beds !== null || r.baths !== null || r.year !== null || r.units !== null).length };
}

/** Whitelisted attributes kept as `raw` (no roll values, no names). */
const RAW_KEYS = ['AIN', 'APN', 'SitusFullAddress', 'SitusHouseNo', 'SitusDirection', 'SitusStreet', 'SitusCity', 'SitusZIP', 'UseCode', 'UseType', 'UseDescription',
  'DesignType1', 'YearBuilt1', 'SQFTmain1', 'Units1', 'Bedrooms1', 'Bathrooms1', 'Shape.STArea()', 'CENTER_LAT', 'CENTER_LON'];
const pick = (/** @type {any} */ a) => Object.fromEntries(RAW_KEYS.filter((k) => k in a).map((k) => [k, a[k]]));

/** @param {any} features */
const rowsOf = (features) => (Array.isArray(features) ? features : []).filter((f) => f && f.attributes).map((f) => {
  const a = f.attributes;
  const situs = [text(a.SitusHouseNo), text(a.SitusDirection), text(a.SitusStreet)].filter(Boolean).join(' ');
  return { f, a, ain: text(a.AIN) ?? (typeof a.AIN === 'number' ? String(a.AIN) : null), situs };
});

/**
 * Turn one parcel record into the records-provider fields.
 * @param {any} a attributes @param {any} boundary GeoJSON|null @param {{at:string, idConf:number, method:string}} ctx
 */
export function fieldsFromParcel(a, boundary, ctx) {
  const { at, idConf, method } = ctx;
  const meta = (/** @type {number} */ confidence, /** @type {any} */ extra = {}) => ({ tag: /** @type {const} */ ('measured'), source: SOURCE, sourceUrl: SERVICE?.url, retrievedAt: at, confidence: Math.min(confidence, idConf), ...extra });
  const none = (/** @type {string} */ r) => unavailable(r, SOURCE);
  const imp = summarizeImprovements(a);
  const many = (/** @type {{records:number}} */ s, /** @type {string} */ what) => (s.records > 1 ? { note: `Sum of ${s.records} improvement records (${what}).` } : {});
  /** @type {Record<string, any>} */
  const f = {};
  const ain = text(a.AIN);
  f.apn = ain ? sourced(ain, meta(CONFIDENCE.parcelId, { method, note: text(a.APN) ? `Formatted APN ${a.APN}` : undefined })) : none('the layer returned no parcel number');

  const stored = pos(a['Shape.STArea()']);
  if (boundary) {
    const area = Math.round(polygonAreaSqft(boundary));
    const lot = sourced(area, meta(CONFIDENCE.polygonArea, { unit: 'sqft', method: 'WGS84 parcel polygon area (core/geometry.js), holes subtracted', note: 'Measured from the published outline; can differ from the recorded lot size.' }));
    f.lot_sqft = stored !== null
      ? withCrossCheck(lot, { source: "LA County Assessor stored parcel area (Shape.STArea(), sq ft)", ...compareValues(area, Math.round(stored), 'area') })
      : lot;
  } else f.lot_sqft = none('the layer returned no parcel polygon');

  f.house_sqft = imp.sqft.value !== null ? sourced(imp.sqft.value, meta(CONFIDENCE.assessor, { unit: 'sqft', method: 'SQFTmain1..5 summed', ...many(imp.sqft, 'SQFTmain1..5') })) : none('assessor records no building area (SQFTmain1..5 empty or 0)');
  f.floors = none('the assessor parcel layer does not publish a floor count');
  f.beds = imp.beds.value !== null ? sourced(imp.beds.value, meta(CONFIDENCE.assessor, { method: 'Bedrooms1..5 summed', ...many(imp.beds, 'Bedrooms1..5') })) : none('assessor records no bedroom count (Bedrooms1..5 empty or 0)');
  f.baths = imp.baths.value !== null ? sourced(imp.baths.value, meta(CONFIDENCE.assessor, { method: 'Bathrooms1..5 summed', ...many(imp.baths, 'Bathrooms1..5') })) : none('assessor records no bathroom count (Bathrooms1..5 empty or 0)');
  f.year_built = imp.year.value !== null
    ? sourced(imp.year.value, meta(CONFIDENCE.assessor, { method: imp.year.of > 1 ? `YearBuilt${imp.year.slot} (largest improvement of ${imp.year.of} with a year)` : `YearBuilt${imp.year.slot}`, note: 'Assessor year of construction (not effective year).' }))
    : none("assessor records no year built (YearBuilt1..5 empty or '0000')");
  f.units = imp.units.value !== null ? sourced(imp.units.value, meta(CONFIDENCE.assessor, { method: 'Units1..5 summed', ...many(imp.units, 'Units1..5') })) : none('assessor records no unit count (Units1..5 empty or 0)');
  const useCode = text(a.UseCode);
  f.use_code = useCode ? sourced(useCode, meta(CONFIDENCE.assessor, { note: [text(a.UseType), text(a.UseDescription)].filter(Boolean).join(' / ') || undefined })) : none('the layer returned no use code');
  const kind = useCode || text(a.UseType) ? classifyPropertyType({ useCode, useType: text(a.UseType), useDescription: text(a.UseDescription), livingAreaSqft: imp.sqft.value, units: imp.units.value }, { codeScheme: 'la-assessor', hasSqftField: true }) : 'unknown';
  f.property_type = kind === 'unknown'
    ? none(useCode || text(a.UseType) ? 'the use type did not match a known class' : 'the layer returned no use type')
    : sourced(kind, { tag: 'estimated', source: SOURCE, sourceUrl: SERVICE?.url, retrievedAt: at, confidence: Math.min(CONFIDENCE.classified, idConf), method: 'classified from the assessor use code/type (core/parcel.js classifyPropertyType)' });
  return f;
}

/** @param {any} deps */
async function lookup(/** @type {{address:string, lat?:number, lng?:number, apn?:string}} */ query, deps) {
  const at = isoNow(deps?.now);
  /** @param {any} a @param {any} boundary @param {number} idConf @param {string} method @param {string} matchedBy */
  const done = (a, boundary, idConf, method, matchedBy) => ({
    ok: /** @type {const} */ (true), fields: fieldsFromParcel(a, boundary, { at, idConf, method }),
    parcel: { boundary, apn: text(a.AIN), address: text(a.SitusFullAddress), assessorAreaSqft: pos(a['Shape.STArea()']), matchedBy, method, confidence: idConf },
    raw: pick(a),
  });

  const s = parseSitus(query?.address);
  if (!s.ok) return fail(s.reason, s.code);
  const typed = `${s.houseNo} ${s.dir ?? ''} ${s.street} ${s.suffix ?? ''}`.replace(/\s+/g, ' ').trim();
  const reasons = [];

  // 1. direct situs query
  const url = `${QUERY_URL}?` + qs({ where: buildSitusWhere(s), outFields: '*', returnGeometry: 'true', outSR: '4326', f: 'json' });
  const r = await callJson(url, deps);
  if (r.ok) {
    if (r.json?.error) reasons.push(`situs query: service error: ${r.json.error.message ?? r.json.error.code ?? 'unknown'}`);
    else if (!Array.isArray(r.json?.features)) reasons.push('situs query: malformed response');
    else {
      const rows = rowsOf(r.json.features).filter((x) => situsMatchesAddress(typed, x.situs));
      const byAin = new Map(rows.map((x) => [x.ain, x]));
      const uniq = [...byAin.values()];
      if (uniq.length === 1) {
        const x = uniq[0];
        return done(x.a, ringsToGeoJSON(x.f.geometry?.rings ?? []), CONFIDENCE.parcelId, 'parcel whose situs address equals the address (house number, street, direction)', 'situs-query');
      }
      if (uniq.length > 1) {
        const pt = Number.isFinite(query.lat) && Number.isFinite(query.lng) ? { lat: /** @type {number} */ (query.lat), lng: /** @type {number} */ (query.lng) } : null;
        const inside = pt ? uniq.filter((x) => { const g = ringsToGeoJSON(x.f.geometry?.rings ?? []); return g && pointInPolygon(pt, g); }) : [];
        if (inside.length === 1) return done(inside[0].a, ringsToGeoJSON(inside[0].f.geometry?.rings ?? []), CONFIDENCE.parcelBySitus, `${uniq.length} parcels share this situs address; the one containing the geocoded point was chosen`, 'situs-query+point');
        return fail(`${uniq.length} parcels share this situs address; none was chosen`, 'multiple_matches', { candidates: uniq.slice(0, 10).map((x) => ({ apn: x.ain, address: text(x.a.SitusFullAddress) })) });
      }
      reasons.push(`situs query: no parcel with situs ${typed}`);
    }
  } else reasons.push(`situs query: ${r.reason}`);

  // 2. fallback: parcel at the point / within the buffer with a situs match (core/parcel.js), then the full record by AIN
  if (Number.isFinite(query.lat) && Number.isFinite(query.lng)) {
    const p = await parcelAt({ lat: /** @type {number} */ (query.lat), lng: /** @type {number} */ (query.lng), jurisdiction: LA_JURISDICTION }, { ...deps, services: [SERVICE] }, { matchedAddress: typed });
    if (p.ok && p.apn && /^\d{6,12}$/.test(p.apn)) {
      const full = await callJson(`${QUERY_URL}?` + qs({ where: `AIN='${p.apn}'`, outFields: '*', returnGeometry: 'false', f: 'json' }), deps);
      const a = full.ok ? full.json?.features?.[0]?.attributes : null;
      if (a) return done(a, p.boundary, CONFIDENCE.parcelBySitus, `${p.method} (fallback after the direct situs query failed)`, p.matchedBy ?? 'point');
      reasons.push(`full record for AIN ${p.apn}: ${full.ok ? 'not returned' : full.reason}`);
    } else reasons.push(p.ok ? 'point lookup returned no usable parcel number' : p.reason);
  } else reasons.push('no coordinates for the point fallback');
  const first = reasons[0] ?? '';
  const code = /HTTP|timeout|network|malformed/.test(first) ? 'http_error' : 'no_match';
  return fail(`no parcel found: ${reasons.join('; ')}`, code);
}

/** @type {import('./types.js').PropertyRecordsProvider} */
export const laAssessor = {
  id: 'la-assessor', label: 'LA County Assessor parcel layer', kind: 'records', needsKey: false, role: 'fallback', priority: 10, verified: true,
  coverage: { state: 'CA', countyFips: '06037', county: 'Los Angeles County' }, retentionDays: null,
  licenseNote: 'Public LA County GIS service; no copyright or licence text is published on the service. Confirm terms before storing at scale.',
  lookup,
};

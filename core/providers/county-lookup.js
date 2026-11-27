// @ts-check
// County (and state) of a point, keyless, browser-safe: the FCC census-area API first, the Census TIGERweb State_County layer as the fallback.
//
// PORTED FROM StreetForge streetforge2d.html:13664-13667 (`countyAt`) and 13662 (`FIPS_ST`, state FIPS -> abbreviation).
// Differences: `fetch`/`now` are injected; failures carry a code and reason instead of `null`; the StreetForge memo (lat/lng rounded to
// 0.01 degrees, about 1 km, which can straddle a county line) is replaced by an optional `deps.countyCache` keyed to 5 decimals;
// when the FCC answer lists blocks of DIFFERENT counties (a point in a street on a county line) the FCC answer is not trusted and
// TIGERweb (one county per point) decides. CORS (checked live 2026-11-27 with Origin https://milessilverman.github.io): the FCC API answers
// `access-control-allow-origin: *`; TIGERweb answers `access-control-allow-origin: https://milessilverman.github.io`. Both are readable in a browser.

import { callJson, fail } from './util.js';

export const FCC_AREA_URL = 'https://geo.fcc.gov/api/census/area';
export const TIGERWEB_COUNTY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query';

/** State FIPS -> postal abbreviation (50 states and DC; StreetForge streetforge2d.html:13662). */
export const FIPS_ST = /** @type {Record<string,string>} */ ({ '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY' });

/** @typedef {{ok:true, state:string, stateFips:string, countyFips:string, county:string|null, source:string}} CountyResult */

/** @param {any} json @returns {{ok:true, hit:CountyResult}|{ok:false, reason:string, code:string}} */
function fromFcc(json) {
  const rows = json?.results;
  if (!Array.isArray(rows)) return { ok: false, reason: 'FCC answer has no results list', code: 'malformed_json' };
  const hits = rows.filter((x) => x && /^\d{5}$/.test(String(x.county_fips ?? '')));
  if (!hits.length) return { ok: false, reason: 'FCC census-area API found no county at this point (outside the US?)', code: 'no_match' };
  const counties = new Set(hits.map((x) => String(x.county_fips)));
  if (counties.size > 1) return { ok: false, reason: `FCC census-area API lists blocks of ${counties.size} counties at this point (county line)`, code: 'ambiguous' };
  const x = hits[0];
  const fips = String(x.county_fips), st = fips.slice(0, 2);
  const state = typeof x.state_code === 'string' && x.state_code ? x.state_code.toUpperCase() : FIPS_ST[st];
  if (!state) return { ok: false, reason: `FCC answered state FIPS ${st}, which Everyspace has no state code for`, code: 'unsupported' };
  return { ok: true, hit: { ok: true, state, stateFips: st, countyFips: fips, county: typeof x.county_name === 'string' && x.county_name ? x.county_name : null, source: 'FCC census-area API' } };
}

/** @param {any} json @returns {{ok:true, hit:CountyResult}|{ok:false, reason:string, code:string}} */
function fromTiger(json) {
  if (json?.error) return { ok: false, reason: `TIGERweb error: ${json.error.message ?? json.error.code ?? 'unknown'}`, code: 'http_error' };
  const feats = json?.features;
  if (!Array.isArray(feats)) return { ok: false, reason: 'TIGERweb answer has no features list', code: 'malformed_json' };
  const a = feats[0]?.attributes;
  if (!a || !/^\d{2}$/.test(String(a.STATE ?? '')) || !/^\d{3}$/.test(String(a.COUNTY ?? ''))) return { ok: false, reason: 'TIGERweb found no county at this point (outside the US?)', code: 'no_match' };
  const state = FIPS_ST[a.STATE];
  if (!state) return { ok: false, reason: `TIGERweb answered state FIPS ${a.STATE}, which Everyspace has no state code for`, code: 'unsupported' };
  return { ok: true, hit: { ok: true, state, stateFips: a.STATE, countyFips: a.STATE + a.COUNTY, county: typeof a.NAME === 'string' && a.NAME ? a.NAME : null, source: 'Census TIGERweb State_County' } };
}

/**
 * County of a point. Never throws.
 * @param {{lat:number, lng:number}} point
 * @param {{fetch:Function, now?:string, timeoutMs?:number, countyCache?:Map<string, any>}} deps
 * @returns {Promise<CountyResult|{ok:false, reason:string, code:string}>}
 */
export async function countyAt(point, deps) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return fail('lat/lng required', 'bad_query');
  const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
  const hit = deps?.countyCache?.get(key);
  if (hit) return hit;
  /** @type {string[]} */ const reasons = [];
  let lastCode = 'no_match';
  const f = await callJson(`${FCC_AREA_URL}?lat=${point.lat.toFixed(5)}&lon=${point.lng.toFixed(5)}&censusYear=2020&format=json`, deps);
  if (f.ok) {
    const r = fromFcc(f.json);
    if (r.ok) { deps?.countyCache?.set(key, r.hit); return r.hit; }
    reasons.push(r.reason); lastCode = r.code;
  } else { reasons.push(`FCC: ${f.reason}`); lastCode = f.code; }
  const params = new URLSearchParams({ geometry: `${point.lng},${point.lat}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'STATE,COUNTY,NAME', returnGeometry: 'false', f: 'json' });
  const t = await callJson(`${TIGERWEB_COUNTY_URL}?${params}`, deps);
  if (t.ok) {
    const r = fromTiger(t.json);
    if (r.ok) { deps?.countyCache?.set(key, r.hit); return r.hit; }
    reasons.push(r.reason); lastCode = r.code === 'no_match' && lastCode !== 'no_match' ? lastCode : r.code;
  } else { reasons.push(`TIGERweb: ${t.reason}`); lastCode = lastCode === 'ambiguous' ? lastCode : t.code; }
  return fail(`county lookup failed: ${reasons.join('; ')}`, lastCode);
}

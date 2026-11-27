// @ts-check
// RentCast property records (primary records provider, needs a key). !!! UNVERIFIED !!!
// The endpoint, header and field names below are written from MEMORY of RentCast's public documentation. They have NOT been
// checked against a live response (no key exists yet), so the adapter is defensive: a missing or renamed field becomes
// `unavailable` with reason 'field not present in response', and the confidence of every value is capped at 0.65 with a note.
// Request: GET https://api.rentcast.io/v1/properties?address=<full address>, header X-Api-Key. Expected response: an array of
// property objects with squareFootage, bedrooms, bathrooms, lotSize, yearBuilt, propertyType, features.floorCount, assessorID.
// The key is supplied by the caller (deps.apiKey), is only ever sent in the header, and is removed from every error message.
// The first live call should be followed by checking the mapping (and the unit of lotSize) before relying on it.

import { callJson, qs, fail, isoNow, num, pos, text, sourced, unavailable } from './util.js';

const URL_ = 'https://api.rentcast.io/v1/properties';
const SOURCE = 'RentCast property records';
const CONF = 0.65;
const MISSING = 'field not present in response';

/** @param {any} s */
function typeOf(s) {
  const t = String(s ?? '').toLowerCase();
  if (!t) return null;
  if (/single/.test(t)) return 'single_family';
  if (/condo/.test(t)) return 'condo';
  if (/multi|apartment|duplex|triplex|fourplex/.test(t)) return 'multi_family';
  if (/land|lot/.test(t)) return 'land';
  if (/commerc|industr|office|retail/.test(t)) return 'commercial';
  return null;
}

/** Map one RentCast property object to records fields. Pure. @param {any} p @param {string} at */
export function mapRentcastProperty(p, at) {
  const meta = (/** @type {any} */ extra = {}) => ({ tag: /** @type {const} */ ('measured'), source: SOURCE, sourceUrl: URL_, retrievedAt: at, confidence: CONF,
    note: 'RentCast field mapping is unverified against a live response.', ...extra });
  const gone = (/** @type {string} */ r = MISSING) => unavailable(r, SOURCE);
  const posField = (/** @type {any} */ v, /** @type {any} */ extra) => (v === undefined || v === null ? gone() : pos(v) !== null ? sourced(pos(v), meta(extra)) : gone('zero or non-numeric value reported; treated as not recorded'));
  const f = /** @type {Record<string, any>} */ ({});
  const apn = text(p?.assessorID) ?? (num(p?.assessorID) !== null ? String(p.assessorID) : null);
  f.apn = apn ? sourced(apn, meta()) : gone();
  f.lot_sqft = posField(p?.lotSize, { unit: 'sqft', note: 'RentCast field mapping is unverified; lotSize is assumed to be square feet.' });
  f.house_sqft = posField(p?.squareFootage, { unit: 'sqft' });
  f.floors = posField(p?.features?.floorCount);
  f.beds = posField(p?.bedrooms);
  f.baths = posField(p?.bathrooms);
  const yr = pos(p?.yearBuilt);
  f.year_built = p?.yearBuilt === undefined || p?.yearBuilt === null ? gone() : yr !== null && Number.isInteger(yr) && yr >= 1000 && yr <= 9999 ? sourced(yr, meta()) : gone('year not a valid 4-digit year');
  const pt = p?.propertyType;
  const mapped = typeOf(pt);
  f.property_type = pt === undefined || pt === null ? gone() : mapped ? sourced(mapped, meta({ tag: 'estimated', method: `mapped from RentCast propertyType '${String(pt)}'` })) : gone(`propertyType '${String(pt)}' has no Everyspace equivalent`);
  f.use_code = gone('RentCast does not provide an assessor use code');
  f.units = gone('not mapped for this provider');
  return f;
}

/** @type {import('./types.js').PropertyRecordsProvider} */
export const rentcast = {
  id: 'rentcast', label: 'RentCast property records', kind: 'records', needsKey: true, role: 'primary', priority: 10, verified: false,
  coverage: { national: true }, retentionDays: null,
  licenseNote: 'Commercial API: caching, storage and display terms must be confirmed in the RentCast agreement before production use.',
  async lookup(query, deps) {
    const at = isoNow(deps?.now);
    const key = deps?.apiKey;
    if (typeof key !== 'string' || !key) return fail('RentCast API key required', 'no_key');
    const addr = typeof query?.address === 'string' ? query.address.trim().slice(0, 200) : '';
    if (!addr) return fail('empty address', 'bad_query');
    const r = await callJson(`${URL_}?` + qs({ address: addr }), deps, { headers: { 'X-Api-Key': key } }, [key]);
    if (!r.ok) return fail(`RentCast: ${r.reason}`, r.code);
    const body = r.json;
    const list = Array.isArray(body) ? body : body && typeof body === 'object' && !body.error ? [body] : null;
    if (!list) return fail('RentCast: malformed response', 'malformed_json');
    if (!list.length) return fail('RentCast has no record for this address', 'no_match');
    if (list.length > 1) return fail(`RentCast returned ${list.length} records for this address; none was chosen`, 'multiple_matches');
    return { ok: true, fields: /** @type {any} */ (mapRentcastProperty(list[0], at)), raw: { keys: Object.keys(list[0] ?? {}).sort() } };
  },
};

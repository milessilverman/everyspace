// @ts-check
// LA County Assessor parcel layer as a keyless records provider (records + parcel polygon). Verified live 2026-11-27:
// LACounty_Cache/LACounty_Parcel/MapServer/0. `Shape.STArea()` is square feet (255,338 against 255,412 measured from the
// polygon for 200 N Spring St). Lookup order: (1) direct situs attribute query from the parsed address; (2) the existing
// point/buffer + situs match in core/parcel.js (parcelAt), then a by-AIN query for the full record.
//
// SQL SAFETY: every value placed in a `where` clause is validated, never escaped: house number digits only, street/city
// letters+digits+spaces only, ZIP digits only, AIN digits only. Anything else returns {ok:false, code:'bad_query'} and no
// request is made. (Consequence: street names with an apostrophe or hyphen are refused rather than risk a malformed query.)

import { parseStreet, situsMatchesAddress, ringsToGeoJSON, classifyPropertyType, condoBasis, parcelAt, CONFIDENCE, stripUnit, cleanUnit, unitsMatch, normalizeUnit, compareUnits } from '../parcel.js';
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
  // a unit ("Apt 4", "#4") never reaches the query or the street match: it is taken out first (core/parcel.js stripUnit)
  const parts = stripUnit(address).address.split(',').map((s) => s.trim()).filter(Boolean);
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

/**
 * The assessor's effective year of the main improvement (the slot whose YearBuilt gave year_built), when it is a valid year later than the
 * year built and not in the future: the assessor moves it forward after a major remodel or addition. Otherwise unavailable with the reason.
 * @param {any} a attributes @param {{value:number|null, slot:number}} year @param {{at:string, idConf:number}} ctx
 */
export function remodeledYear(a, year, ctx) {
  const why = (/** @type {string} */ r) => unavailable(r, SOURCE);
  if (year.value === null || !year.slot) return why('no year built recorded, so a later remodel cannot be told apart');
  const eff = yearOf(a[`EffectiveYear${year.slot}`]);
  if (eff === null) return why(`assessor records no effective year (EffectiveYear${year.slot} empty)`);
  const nowYear = Number(String(ctx.at).slice(0, 4));
  if (Number.isFinite(nowYear) && eff > nowYear) return why(`assessor effective year ${eff} is in the future`);
  if (eff <= year.value) return why(`assessor effective year equals the year built (${eff}): no major remodel recorded`);
  return sourced(eff, { tag: 'estimated', source: SOURCE, sourceUrl: SERVICE?.url, retrievedAt: ctx.at, confidence: Math.min(0.5, ctx.idConf),
    method: "assessor's effective year (updated after major remodels)", note: `EffectiveYear${year.slot} ${eff} vs YearBuilt${year.slot} ${year.value}. The effective year can also move for additions or a reassessment of condition; the owner should confirm.` });
}

/** Whitelisted attributes kept as `raw` (no roll values, no names). */
const RAW_KEYS = ['AIN', 'APN', 'SitusFullAddress', 'SitusUnit', 'SitusHouseNo', 'SitusDirection', 'SitusStreet', 'SitusCity', 'SitusZIP', 'UseCode', 'UseType', 'UseDescription',
  'DesignType1', 'YearBuilt1', 'EffectiveYear1', 'EffectiveYear2', 'EffectiveYear3', 'EffectiveYear4', 'EffectiveYear5', 'SQFTmain1', 'SQFTmain2', 'SQFTmain3', 'SQFTmain4', 'SQFTmain5', 'Units1', 'Bedrooms1', 'Bathrooms1', 'Shape.STArea()', 'CENTER_LAT', 'CENTER_LON'];
const pick = (/** @type {any} */ a) => Object.fromEntries(RAW_KEYS.filter((k) => k in a).map((k) => [k, a[k]]));

/** @param {any} features */
const rowsOf = (features) => (Array.isArray(features) ? features : []).filter((f) => f && f.attributes).map((f) => {
  const a = f.attributes;
  const situs = [text(a.SitusHouseNo), text(a.SitusDirection), text(a.SitusStreet)].filter(Boolean).join(' ');
  return { f, a, ain: text(a.AIN) ?? (typeof a.AIN === 'number' ? String(a.AIN) : null), situs };
});

/** The use count the description names ("Two Units" -> 2, "Three Units (Any Combination)" -> 3, "Four Units ..." -> 4), else null. @param {any} a */
const describedUnits = (a) => ({ two: 2, three: 3, four: 4 })[/** @type {'two'|'three'|'four'} */ ((/\b(two|three|four) units\b/i.exec(String(a?.UseDescription ?? '')) ?? [])[1]?.toLowerCase())] ?? null;

/**
 * What kind of property one assessor record is, and why. `basis` is set for a condominium ('use code' or 'legal description').
 * @param {any} a layer attributes
 * @returns {{kind:'single_family'|'condo'|'multi_family'|'land'|'commercial'|'unknown', basis:string|null, input:any}}
 */
export function classifyRecord(a) {
  const imp = summarizeImprovements(a);
  const useCode = text(a.UseCode);
  const input = { useCode, useType: text(a.UseType), useDescription: text(a.UseDescription), livingAreaSqft: imp.sqft.value, units: imp.units.value, legalDescription: text(a.LegalDescription), unit: text(a.SitusUnit) };
  const kind = useCode || input.useType ? classifyPropertyType(input, { codeScheme: 'la-assessor', hasSqftField: true }) : 'unknown';
  return { kind, basis: kind === 'condo' ? condoBasis(input) : null, input };
}

/**
 * Turn one parcel record into the records-provider fields.
 * @param {any} a attributes @param {any} boundary GeoJSON|null @param {{at:string, idConf:number, method:string, complex?:{unitCount:number, note?:string}|null}} ctx
 */
export function fieldsFromParcel(a, boundary, ctx) {
  const { at, idConf, method } = ctx;
  const meta = (/** @type {number} */ confidence, /** @type {any} */ extra = {}) => ({ tag: /** @type {const} */ ('measured'), source: SOURCE, sourceUrl: SERVICE?.url, retrievedAt: at, confidence: Math.min(confidence, idConf), ...extra });
  const none = (/** @type {string} */ r) => unavailable(r, SOURCE);
  const imp = summarizeImprovements(a);
  const cls = classifyRecord(a);
  const isBuilding = cls.kind === 'multi_family';
  const many = (/** @type {{records:number}} */ s, /** @type {string} */ what) => (s.records > 1 || isBuilding ? { note: [s.records > 1 ? `Sum of ${s.records} improvement records (${what}).` : null, isBuilding ? 'Building total (all units together), not one unit.' : null].filter(Boolean).join(' ') } : {});
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
  f.remodeled_year = remodeledYear(a, imp.year, { at, idConf });
  if (cls.kind === 'condo') f.units = none('this record is one condominium unit (see complex_unit_count for the building)');
  else if (imp.units.value !== null) {
    const said = isBuilding ? describedUnits(a) : null;
    f.units = sourced(imp.units.value, meta(CONFIDENCE.assessor, { method: 'Units1..5 summed', ...many(imp.units, 'Units1..5'),
      ...(said !== null && said !== imp.units.value ? { note: `${imp.units.records > 1 ? `Sum of ${imp.units.records} improvement records (Units1..5). ` : ''}The use description says ${said} units but the unit counts add up to ${imp.units.value}; the recorded counts are used.` } : {}) }));
  } else f.units = none('assessor records no unit count (Units1..5 empty or 0)');
  const useCode = text(a.UseCode);
  f.use_code = useCode ? sourced(useCode, meta(CONFIDENCE.assessor, { note: [text(a.UseType), text(a.UseDescription)].filter(Boolean).join(' / ') || undefined })) : none('the layer returned no use code');
  const kind = cls.kind;
  f.property_type = kind === 'unknown'
    ? none(useCode || text(a.UseType) ? 'the use type did not match a known class' : 'the layer returned no use type')
    : sourced(kind, { tag: 'estimated', source: SOURCE, sourceUrl: SERVICE?.url, retrievedAt: at, confidence: Math.min(CONFIDENCE.classified, idConf),
      method: kind === 'condo' ? (cls.basis === 'legal description' ? "classified as a condominium unit from the assessor's legal description (names a condominium) and a unit number on the record; the use code's fourth character is not read as condo (core/parcel.js condoBasis)"
        : 'classified as a condominium unit from the assessor use code (the use code ends in C: a unit-numbered record on a lot shared by the whole complex)')
        : kind === 'multi_family' ? `classified from the assessor use (${text(a.UseDescription) ?? useCode}): more than one dwelling unit on the lot (core/parcel.js classifyPropertyType)`
          : 'classified from the assessor use code/type (core/parcel.js classifyPropertyType)' });
  const unit = cleanUnit(a.SitusUnit);
  f.unit_label = unit ? sourced(unit, meta(CONFIDENCE.assessor, { method: 'SitusUnit (the unit part of the situs address), designator word removed' })) : none('the record has no unit number');
  f.complex_unit_count = ctx.complex ? sourced(ctx.complex.unitCount, meta(CONFIDENCE.assessor, { method: 'count of condominium-unit records with this street number and street', note: ctx.complex.note ?? 'Counted from the records at this street address; the complex may also have other street numbers.' }))
    : none(kind === 'condo' ? 'only one record was found at this address, so the size of the complex is not known' : 'not a condominium complex');
  return f;
}

/** The same address line without the unit, as the assessor prints it ("22040 STRATHERN ST"). @param {any} a */
const situsLine = (a) => [text(a.SitusHouseNo), text(a.SitusDirection), text(a.SitusStreet)].filter(Boolean).join(' ');

/**
 * Several condominium-unit records at one address. Typed unit that matches exactly one -> that unit; `ownsWholeBuilding` -> the building as a
 * whole; otherwise the caller must say which (needs_unit). Returns null when the records are not a condominium complex (the caller then lists
 * candidates as before). A complex is two or more records that read as condominium units (see classifyRecord).
 * @param {Array<{f:any, a:any, ain:string|null}>} rows @param {{unit?:string, ownsWholeBuilding?:boolean}} query
 * @param {{at:string, done:(a:any, boundary:any, idConf:number, method:string, matchedBy:string, complex?:any)=>any, boundaryOf:(r:any)=>any}} h
 */
function complexResult(rows, query, h) {
  const recs = rows.map((x) => ({ ...x, cls: classifyRecord(x.a) }));
  const units = recs.filter((r) => r.cls.kind === 'condo');
  if (units.length < 2) return null;
  const complex = { address: situsLine(units[0].a), unitCount: units.length };
  const tellMe = () => {
    const seen = new Set();
    const list = units.filter((r) => cleanUnit(r.a.SitusUnit)).sort((x, y) => compareUnits(x.a.SitusUnit, y.a.SitusUnit))
      .map((r) => ({ unit: /** @type {string} */ (cleanUnit(r.a.SitusUnit)), label: `Unit ${cleanUnit(r.a.SitusUnit)}` }))
      .filter((u) => { const k = normalizeUnit(u.unit); if (seen.has(k)) return false; seen.add(k); return true; });
    return list;
  };
  if (query.ownsWholeBuilding === true) {
    return { whole: true, complex, units, boundary: h.boundaryOf(units[0]) };
  }
  if (typeof query.unit === 'string' && normalizeUnit(query.unit)) {
    const hit = units.filter((r) => unitsMatch(r.a.SitusUnit, query.unit));
    if (hit.length === 1) return { one: hit[0], complex, boundary: h.boundaryOf(hit[0]) };
    const list = tellMe();
    return { needs: true, complex, list: list.slice(0, 400), truncated: list.length > 400,
      reason: hit.length ? `${hit.length} records have unit ${query.unit}; say which unit you own` : `no unit ${query.unit} at this address among ${units.length} condominium units; pick one` };
  }
  const list = tellMe();
  return { needs: true, complex, list: list.slice(0, 400), truncated: list.length > 400, reason: `${units.length} condominium units share this address; say which unit you own, or that you own the whole building` };
}

/**
 * The fields of a whole condominium building, from the unit records that make it up (the owner says they own all of it). Living area, bedrooms and
 * bathrooms are SUMS of the unit records (each unit's own size; the building's shared spaces are not in them); units is the number of unit records.
 * @param {Array<{a:any, cls:any}>} units @param {any} boundary @param {{at:string, idConf:number, method:string}} ctx
 */
export function wholeBuildingFields(units, boundary, ctx) {
  const { at, idConf, method } = ctx;
  const meta = (/** @type {number} */ confidence, /** @type {any} */ extra = {}) => ({ tag: /** @type {const} */ ('measured'), source: SOURCE, sourceUrl: SERVICE?.url, retrievedAt: at, confidence: Math.min(confidence, idConf), ...extra });
  const none = (/** @type {string} */ r) => unavailable(r, SOURCE);
  const n = units.length;
  const imps = units.map((u) => summarizeImprovements(u.a));
  const total = (/** @type {'sqft'|'beds'|'baths'} */ k) => { const have = imps.filter((i) => i[k].value !== null); return have.length ? { v: round(have.reduce((t, i) => t + /** @type {number} */ (i[k].value), 0), 2), n: have.length } : null; };
  const note = (/** @type {{n:number}} */ t, /** @type {string} */ what) => `Building total: the sum of ${t.n} of the ${n} unit records (${what}); a unit record holds that unit's own size, so shared spaces are not included.`;
  const first = units[0].a;
  const base = fieldsFromParcel(first, boundary, { at, idConf, method, complex: { unitCount: n } });
  /** @type {Record<string, any>} */
  const f = { ...base };
  f.apn = none(`${n} unit parcels share this lot; there is no single parcel number for the building`);
  const sq = total('sqft'), bd = total('beds'), ba = total('baths');
  f.house_sqft = sq ? sourced(sq.v, meta(CONFIDENCE.assessor, { unit: 'sqft', method: 'SQFTmain1..5 summed over the unit records', note: note(sq, 'living area') })) : none('no unit record states a living area');
  f.beds = bd ? sourced(bd.v, meta(CONFIDENCE.assessor, { method: 'Bedrooms1..5 summed over the unit records', note: note(bd, 'bedrooms') })) : none('no unit record states bedrooms');
  f.baths = ba ? sourced(ba.v, meta(CONFIDENCE.assessor, { method: 'Bathrooms1..5 summed over the unit records', note: note(ba, 'bathrooms') })) : none('no unit record states bathrooms');
  const years = imps.map((i) => i.year.value).filter((y) => y !== null);
  if (years.length) {
    const count = new Map(); for (const y of years) count.set(y, (count.get(y) ?? 0) + 1);
    const [yr, c] = [...count.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0];
    f.year_built = sourced(yr, meta(CONFIDENCE.assessor, { method: `YearBuilt1..5, the most common year among the unit records (${c} of ${years.length})`, note: count.size > 1 ? `The unit records give ${count.size} different years.` : undefined }));
  } else f.year_built = none("no unit record states a year built");
  f.remodeled_year = none('not combined across the unit records');
  f.units = sourced(n, meta(CONFIDENCE.assessor, { method: 'number of condominium-unit records with this street number and street', note: 'One record per unit; a unit the assessor does not list separately is not counted.' }));
  f.property_type = sourced('multi_family', { tag: 'estimated', source: SOURCE, sourceUrl: SERVICE?.url, retrievedAt: at, confidence: Math.min(CONFIDENCE.classified, idConf),
    method: `you own the whole building: the ${n} condominium-unit records at this address are treated as one multi-unit building`, note: 'Owner said they own the whole building.' });
  f.use_code = sourced(text(first.UseCode) ?? 'see unit records', meta(CONFIDENCE.assessor, { note: `The unit records' use code (the first of ${n}); each unit record is a condominium unit.` }));
  f.unit_label = none('the owner owns the whole building');
  const areas = new Set(units.map((u) => Math.round(pos(u.a['Shape.STArea()']) ?? 0)));
  if (areas.size > 1 && f.lot_sqft.tag !== 'unavailable') f.lot_sqft = { ...f.lot_sqft, note: `${f.lot_sqft.note ?? ''} The unit records carry ${areas.size} different lot sizes; the first record's outline is used.`.trim() };
  return f;
}

/** @param {any} deps */
async function lookup(/** @type {{address:string, lat?:number, lng?:number, apn?:string, unit?:string, ownsWholeBuilding?:boolean}} */ query, deps) {
  const at = isoNow(deps?.now);
  /** @param {any} a @param {any} boundary @param {number} idConf @param {string} method @param {string} matchedBy */
  const done = (a, boundary, idConf, method, matchedBy, complex = null) => ({
    ok: /** @type {const} */ (true), fields: fieldsFromParcel(a, boundary, { at, idConf, method, complex }),
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
        // a condominium complex: one record per unit, all on the same lot (checked live 2026-11-27)
        const cx = complexResult(uniq, query, { at, done, boundaryOf: (/** @type {any} */ r) => ringsToGeoJSON(r.f.geometry?.rings ?? []) });
        if (cx?.needs) return fail(cx.reason, 'needs_unit', { needsUnit: true, units: cx.list, complex: cx.complex, ...(cx.truncated || r.json.exceededTransferLimit ? { unitsTruncated: true } : {}) });
        if (cx?.one) return done(cx.one.a, cx.boundary, CONFIDENCE.parcelBySitus, `the condominium unit record whose unit number equals the unit you gave (${cx.complex.unitCount} units at this address)`, 'situs-query+unit', { unitCount: cx.complex.unitCount });
        if (cx?.whole) {
          return { ok: /** @type {const} */ (true), fields: wholeBuildingFields(cx.units, cx.boundary, { at, idConf: CONFIDENCE.parcelBySitus, method: `all ${cx.units.length} condominium-unit records at this address (you own the whole building)` }),
            parcel: { boundary: cx.boundary, apn: null, address: situsLine(cx.units[0].a), assessorAreaSqft: pos(cx.units[0].a['Shape.STArea()']), matchedBy: 'situs-query+whole-building', method: `all ${cx.units.length} unit records share this lot`, confidence: CONFIDENCE.parcelBySitus },
            raw: pick(cx.units[0].a), complex: cx.complex, wholeBuilding: true };
        }
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
  // the property builder waits for this provider before it asks for photos, street lines and outlines: its answer says whether the address is
  // a house, a condominium unit (several records: the caller must say which unit) or a multi-unit building (core/property-profile.js)
  gatesLookup: true,
  lookup,
};

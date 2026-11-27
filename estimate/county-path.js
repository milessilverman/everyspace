// The first-choice property lookup for the estimator: Los Angeles County's public services, called straight from the
// browser (county locator, assessor parcel layer, LARIAC building outlines), assembled by core/property-profile.js.
// Returns one of: {kind:'fallback', why}  -> the caller runs the older OpenStreetMap Nominatim path unchanged
//                 {kind:'confirm', matchedAddress, reason} -> ask the owner "Is this your property?" before any parcel lookup
//                 {kind:'ok', profile, steps, notes, summary}
// Nothing here stores anything. Pool and transit stops are read from OpenStreetMap Overpass exactly as the older path does,
// so the earnings sections see the same kinds of facts whichever path ran.
import { buildPropertyProfile, toSourcedProfile } from '../core/property-profile.js';
import { createBrowserRegistry, browserSplitYard, YARD_NEEDS_STREET } from '../core/providers/browser.js';
import { splitYard } from '../core/yard.js';
import { addressMismatch, overpassNear, poolNear, transitNear, CONFIDENCE } from '../core/parcel.js';
import { setAttribute } from '../core/profile.js';
import { sourced, unavailable } from '../core/provenance.js';
import { yardAreaSqft, distanceM } from '../core/geometry.js';

const COUNTY_SOURCE = "Los Angeles County's public services";
/** Profile field -> estimator attribute, for notes. */
const ATTR_OF = { apn: 'parcel_id', lot_sqft: 'lot_area_sqft', house_sqft: 'living_area_sqft', floors: 'floors', beds: 'bedrooms', baths: 'bathrooms',
  roof_sqft: 'roof_area_sqft', year_built: 'year_built', units: 'units', property_type: 'property_type', use_code: 'use_code', building_footprint_sqft: 'building_footprint_sqft' };
const YARD_ATTRS = ['front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft'];
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const title = (s) => String(s ?? '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

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

const cityOf = (addr) => { const p = String(addr ?? '').split(',').map((x) => x.trim()); return p.length >= 3 ? p[1] : null; };

/** Short notes for the rows they affect: second-source disagreement and field-specific warnings. */
function buildNotes(pj) {
  const notes = {};
  const add = (k, t) => { if (k && t) (notes[k] ??= []).push(t); };
  const covered = new Set();
  for (const [f, e] of Object.entries(pj.fields ?? {})) {
    const cc = e?.cross_check;
    if (!cc || !cc.agreement || cc.agreement === 'match') continue;
    const pctText = typeof cc.differencePct === 'number' ? ` (${cc.differencePct}% apart)` : '';
    const other = cc.other !== undefined ? cc.other : cc.value; // the provider's own second figure carries both: `value` is ours, `other` is theirs
    add(ATTR_OF[f], `${cc.agreement === 'conflict' ? 'Check this: ' : ''}${cc.source} says ${typeof other === 'number' ? nf.format(other) : other}${pctText}.`);
    covered.add(f);
  }
  for (const w of pj.warnings ?? []) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(w);
    if (!m) continue;
    if (m[1] === 'yard') continue; // the yard rows already carry their own warnings in their note
    if (ATTR_OF[m[1]] && !covered.has(m[1]) && !/says .* but .* says/.test(m[2])) add(ATTR_OF[m[1]], m[2]);
  }
  return Object.fromEntries(Object.entries(notes).map(([k, v]) => [k, [...new Set(v)].slice(0, 2).join(' ')]));
}

/**
 * @param {string} typed what the owner typed
 * @param {{fetch:(u:string,i?:any)=>Promise<any>, now:string, confirmedAddress?:string}} ctx
 */
export async function runCountyPath(typed, ctx) {
  const registry = createBrowserRegistry();
  const deps = { fetch: ctx.fetch, now: ctx.now };
  let query = typed;
  if (ctx.confirmedAddress) query = ctx.confirmedAddress;
  else {
    const r = await registry.get('la-cams-address').resolve(typed, deps);
    if (!r.ok) return { kind: 'fallback', why: `the county address locator ${r.code === 'no_match' ? 'found no match' : 'could not answer'} (${r.reason}); the address may be outside Los Angeles County` };
    const out = outsideCounty(typed, r);
    if (out) return { kind: 'fallback', why: out };
    const mm = addressMismatch(typed, r.address);
    if (mm || r.note) return { kind: 'confirm', matchedAddress: r.address, reason: mm ?? r.note };
  }

  let pj;
  try {
    pj = await buildPropertyProfile(query, { registry, fetch: ctx.fetch, now: ctx.now, keys: {}, splitYard: browserSplitYard(splitYard) });
  } catch (e) { return { kind: 'fallback', why: `the county lookup failed (${e instanceof Error ? e.message : String(e)})` }; }
  const f = pj.fields;
  if (f.address.value === null) return { kind: 'fallback', why: `the county address locator gave no result (${f.address.note ?? 'unavailable'})` };
  if (!pj.details?.parcel_boundary || f.apn.value === null) {
    const why = (pj.warnings ?? []).find((w) => w.startsWith('la-assessor:')) ?? f.apn.note ?? 'no parcel found';
    return { kind: 'fallback', why: `the county assessor has no matching parcel (${why.replace(/^la-assessor:\s*/, '')})` };
  }

  // ---- profile ---------------------------------------------------------------------------------------------------
  let profile = toSourcedProfile(pj);
  const strip = (k) => { const { [k]: _a, ...attributes } = profile.attributes; const { [k]: _h, ...history } = profile.history; profile = { attributes, history }; };
  strip('place_id'); // only a Google Places key could fill it; it is not shown
  const city = cityOf(pj.address);
  const jur = profile.attributes.jurisdiction;
  if (city && jur?.value) profile = setAttribute(profile, 'jurisdiction', sourced({ ...jur.value, country: 'US', city: title(city) }, { tag: 'measured', source: jur.source, confidence: jur.confidence, retrievedAt: jur.retrievedAt, method: 'parcel in the LA County assessor layer; city from the county locator' }));

  const boundary = pj.details.parcel_boundary;
  const buildings = pj.details.buildings ?? [];
  const lot = profile.attributes.lot_area_sqft;
  const yardTotal = profile.attributes.yard_area_sqft;
  if ((!yardTotal || yardTotal.value === null) && buildings.length && lot && lot.value !== null) {
    const y = yardAreaSqft(boundary, buildings, lot.value);
    profile = setAttribute(profile, 'yard_area_sqft', sourced(Math.round(y.yardSqft), { tag: 'estimated', source: 'Everyspace: lot area minus building outlines', confidence: CONFIDENCE.yard, retrievedAt: ctx.now, unit: 'sqft',
      method: 'lot area minus the LARIAC building outlines on the parcel, floored at 0', note: 'Includes driveways, pools and any structure the outlines lack.' }));
  }

  // ---- pool and transit from OpenStreetMap, as the older path does -------------------------------------------------------------
  const point = profile.attributes.location?.value ?? null;
  let osmReason = point ? null : 'no map location';
  let osm = null;
  if (point) {
    // The outline may be a Polygon (rings) or a MultiPolygon (polygons of rings): take every outer ring's vertices.
    const outer = boundary?.type === 'MultiPolygon' ? boundary.coordinates.flatMap((poly) => poly[0] ?? []) : (boundary?.coordinates?.[0] ?? []);
    const far = Math.max(0, ...outer.map((c) => distanceM(point, { lat: c[1], lng: c[0] })).filter(Number.isFinite));
    osm = await overpassNear(point, { buildingRadiusM: Math.min(400, Math.max(40, Math.ceil(far) + 15)) }, deps);
    if (!osm.ok) osmReason = osm.reason;
  }
  const osmName = 'OpenStreetMap via Overpass API';
  const osmMeta = (confidence, extra = {}) => ({ tag: 'estimated', source: 'OpenStreetMap contributors via Overpass API', sourceUrl: osm?.source?.url, license: 'ODbL 1.0', retrievedAt: osm?.retrievedAt, confidence, ...extra, note: `© OpenStreetMap contributors (ODbL 1.0). ${extra.note ?? ''}`.trim() });
  const pl = osmReason ? null : await poolNear(point, deps, { osm, parcel: boundary });
  if (pl?.ok && pl.pools.length) profile = setAttribute(profile, 'pool_present', sourced(true, osmMeta(CONFIDENCE.osmPool, { method: 'OSM swimming_pool feature on the parcel', note: 'A mapped pool; the owner should confirm.' })));
  else profile = setAttribute(profile, 'pool_present', unavailable(osmReason ?? 'not mapped is not proof of absence', osmName));
  const tr = osmReason ? null : await transitNear(point, deps, { osm });
  if (tr?.ok && tr.nearest) profile = setAttribute(profile, 'transit_distance_m', sourced(Math.round(tr.nearest.distanceM), osmMeta(CONFIDENCE.transit, { unit: 'm', method: `straight-line distance to the nearest mapped ${tr.nearest.kind.replace('_', ' ')}${tr.nearest.name ? ' (' + tr.nearest.name + ')' : ''}`, note: 'Not walking distance; OSM may be incomplete.' })));
  else profile = setAttribute(profile, 'transit_distance_m', unavailable(osmReason ?? 'no transit stop mapped within 1500 m', osmName));

  // yard rows: the reason shown to the owner is the plain one
  for (const k of YARD_ATTRS) {
    const a = profile.attributes[k];
    if (a && a.tag === 'unavailable') {
      const why = String(a.note ?? '').replace(/^yard not split: /, '').replace(/^yard split failed: /, '');
      profile = { ...profile, attributes: { ...profile.attributes, [k]: { ...a, note: why.startsWith(YARD_NEEDS_STREET) ? `Needs a street reference; available once the server-side lookup is switched on.${why.slice(YARD_NEEDS_STREET.length)}` : why } } };
    }
  }

  const prov = (id) => pj.providers.find((p) => p.id === id);
  const steps = [
    { step: 'geocode', ok: true, source: 'LA County address locator', matchedAddress: pj.address, provider: 'la-cams-address' },
    { step: 'parcel', ok: true, source: 'LA County Assessor parcel layer' },
    { step: 'buildings', ok: buildings.length > 0, source: 'LARIAC building outlines 2020 (LA County)', ...(buildings.length ? {} : { reason: prov('lariac-buildings')?.reason ?? f.building_footprint_sqft?.note ?? 'no building outline on the parcel' }) },
    { step: 'pool', ok: !osmReason, source: osmName, ...(osmReason ? { reason: osmReason } : {}) },
    { step: 'transit', ok: !osmReason, source: osmName, ...(osmReason ? { reason: osmReason } : {}) },
  ];
  return { kind: 'ok', profile, steps, notes: buildNotes(pj), summary: `used ${COUNTY_SOURCE} (address locator, assessor parcel layer, LARIAC building outlines)`, warnings: pj.warnings ?? [] };
}

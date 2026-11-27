// @ts-check
// "Address in -> property profile out" for Los Angeles County. Pure orchestration over the provider registry: every HTTP
// call goes through the injected `fetch`, time comes from `now`, nothing is guessed (an unobtainable field is
// 'unavailable' with a reason), and a source that disagrees with the primary is reported, never averaged.
// The assembler does not import the yard splitter; pass `splitYard` (core/yard.js) in. See docs/property-data.md.

import { confidenceLabel, sourced, unavailable } from './provenance.js';
import { createProfile, setAttribute } from './profile.js';
import { addressMismatch, CONFIDENCE, isoNow, parseStreet } from './parcel.js';
import { polygonAreaSqft, pointInPolygon, centroid, distanceM, localProjection } from './geometry.js';
import { compareValues, COMPARE_KIND, round } from './providers/util.js';

/** Scope of this assembler. */
export const LA_COUNTY = { state: 'CA', countyFips: '06037', county: 'Los Angeles County' };
const ASSEMBLER = 'Everyspace property-profile assembler';
const RECORD_KEYS = ['apn', 'lot_sqft', 'house_sqft', 'floors', 'beds', 'baths', 'year_built', 'property_type', 'use_code', 'units'];
/** Top-level flat fields of the profile, in output order. */
export const PROFILE_FIELDS = ['address', 'lat', 'lng', 'place_id', 'apn', 'lot_sqft', 'house_sqft', 'floors', 'beds', 'baths', 'roof_sqft',
  'front_yard_sqft', 'back_yard_sqft', 'side_yard_sqft', 'year_built', 'property_type'];
const MAX_STREET_SIDE_DISTANCE_M = 150;
const MAX_GEOCODE_TO_PARCEL_M = 150;

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

/**
 * @param {{address:string, lat?:number, lng?:number, placeId?:string, apn?:string}|string} query
 * @param {{registry:any, fetch:(url:string, init?:any)=>Promise<any>, now:string, keys?:Record<string,string|undefined>, splitYard?:(a:any)=>any, timeoutMs?:number}} ctx
 */
export async function buildPropertyProfile(query, ctx) {
  const at = isoNow(ctx?.now);
  const q = typeof query === 'string' ? { address: query } : { ...query };
  const typed = typeof q.address === 'string' ? q.address.trim() : '';
  const { registry, keys = {} } = ctx;
  const deps = (/** @type {string} */ id) => ({ fetch: ctx.fetch, now: at, ...(keys[id] ? { apiKey: keys[id] } : {}), ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}) });
  /** @type {string[]} */ const warnings = [];
  /** @type {Array<{id:string, status:'used'|'skipped'|'failed', reason?:string}>} */ const providers = [];
  const mark = (/** @type {string} */ id, /** @type {'used'|'skipped'|'failed'} */ status, /** @type {string} [reason] */ reason) => {
    const i = providers.findIndex((p) => p.id === id);
    const row = { id, status, ...(reason ? { reason } : {}) };
    if (i >= 0) providers[i] = row; else providers.push(row);
  };
  const forKind = (/** @type {string} */ kind) => {
    const r = registry.providersFor(kind, { jurisdiction: LA_COUNTY, keys });
    for (const s of r.skipped) mark(s.id, 'skipped', s.skipped);
    return r.providers;
  };
  /** @type {Record<string, any>} */ const fields = {};
  /** @type {any} */ const details = {};

  if (!typed) warnings.push('empty address');

  // ---- 1. address ------------------------------------------------------------------------------------------------------
  /** @type {any} */ let addr = null;
  /** @type {{lat:number,lng:number}|null} */ let streetSide = null;
  const wantStreetSide = typeof ctx.splitYard === 'function';
  if (isNum(q.lat) && isNum(q.lng)) addr = { address: typed, lat: q.lat, lng: q.lng, placeId: q.placeId, source: 'caller-supplied coordinates', confidence: 0.7, provider: 'caller' };
  for (const p of typed ? forKind('address') : []) {
    if (addr && (streetSide || !wantStreetSide)) { mark(p.id, 'skipped', 'not needed: address already resolved'); continue; }
    const r = await p.resolve(typed, deps(p.id));
    if (!r.ok) { mark(p.id, 'failed', r.reason); continue; }
    if (!addr) addr = { ...r, source: p.label, provider: p.id };
    if (!streetSide && r.streetSidePoint) streetSide = { ...r.streetSidePoint, from: p.id };
    mark(p.id, 'used', addr.provider === p.id ? undefined : 'street-side point only');
  }
  if (!addr) warnings.push('address could not be geocoded by any provider');
  else if (addr.provider !== 'caller') {
    const mm = addressMismatch(typed, addr.address);
    if (mm || addr.mismatch) { addr.mismatchReason = mm ?? 'geocoder flagged a different place'; warnings.push(`geocoder matched a different address (${addr.mismatchReason}): "${addr.address}"`); }
  }

  // ---- 2. records (primary first; every available provider is fetched so the assessor can cross-check) ---------------------
  const recAddress = addr && !addr.mismatchReason && typed.split(',').length < 2 ? addr.address : typed;
  /** @type {Array<{p:any, r:any}>} */ const recs = [];
  for (const p of typed ? forKind('records') : []) {
    const r = await p.lookup({ address: recAddress, ...(isNum(addr?.lat) ? { lat: addr.lat, lng: addr.lng } : {}), ...(addr?.placeId ? { placeId: addr.placeId } : {}), ...(q.apn ? { apn: q.apn } : {}) }, deps(p.id));
    if (r.ok) { recs.push({ p, r }); mark(p.id, 'used'); } else { mark(p.id, 'failed', r.reason); warnings.push(`${p.id}: ${r.reason}`); }
  }
  const parcelSrc = recs.find((x) => x.r.parcel?.boundary);
  /** @type {any} */ const boundary = parcelSrc?.r.parcel.boundary ?? null;
  if (boundary) details.parcel_boundary = boundary;

  // ---- 3. footprints / roof ---------------------------------------------------------------------------------------------
  const pcen = boundary ? centroid(boundary) : null;
  const fpPoint = pcen ?? (addr ? { lat: addr.lat, lng: addr.lng } : null);
  /** @type {any} */ let fp = null, fpP = null, roof = null, roofP = null;
  if (fpPoint) {
    for (const p of forKind('footprint')) {
      const r = await p.lookup({ lat: fpPoint.lat, lng: fpPoint.lng, ...(boundary ? { parcel: boundary } : {}) }, deps(p.id));
      if (!r.ok) { mark(p.id, 'failed', r.reason); warnings.push(`${p.id}: ${r.reason}`); continue; }
      let used = false;
      if (!fp && r.buildings.length) { fp = r; fpP = p; used = true; }
      if (!roof && r.roof) { roof = r.roof; roofP = p; used = true; }
      mark(p.id, used ? 'used' : 'used', used ? undefined : 'answered, nothing new');
    }
  } else forKind('footprint');
  /** @type {any[]} */ const buildings = fp ? fp.buildings : [];
  let mainIdx = -1;
  buildings.forEach((b, i) => { if (mainIdx < 0 || b.areaSqft > buildings[mainIdx].areaSqft) mainIdx = i; });
  const main = mainIdx >= 0 ? buildings[mainIdx] : null;
  if (buildings.length) details.buildings = buildings.map((b) => ({ polygon: b.polygon, areaSqft: b.areaSqft, ...(b.heightFt !== undefined ? { heightFt: b.heightFt } : {}), ...(b.kind ? { kind: b.kind } : {}) }));
  if (main) details.main_building_index = mainIdx;

  // ---- 4. street reference ------------------------------------------------------------------------------------------------
  const sp = parseStreet(typed.split(',')[0]);
  const streetName = sp ? [...sp.core, sp.suffix].filter(Boolean).join(' ') : undefined;
  /** @type {any} */ let streetGeom;
  if (fpPoint) {
    for (const p of forKind('street')) {
      const r = await p.lookup({ lat: fpPoint.lat, lng: fpPoint.lng, address: typed }, deps(p.id));
      if (!r.ok) { mark(p.id, 'failed', r.reason); continue; }
      const hit = r.streets.find((s) => streetName && String(s.name ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').includes(sp?.core.join(' ') ?? '\u0000'));
      if (hit) { streetGeom = hit.geometry; mark(p.id, 'used'); break; }
      mark(p.id, 'used', 'no street with a matching name');
    }
  }
  if (streetSide && boundary) {
    const d = distanceToPolygonM(streetSide, boundary);
    if (d > MAX_STREET_SIDE_DISTANCE_M) { warnings.push(`street-side point from ${/** @type {any} */ (streetSide).from} is ${Math.round(d)} m from the parcel (wrong block or side?); not used as the front reference`); streetSide = null; }
  }

  // ---- 5. assemble record fields with cross-checks -------------------------------------------------------------------------
  const okRecs = recs;
  const recField = (/** @type {string} */ k) => okRecs.map((x) => ({ p: x.p, s: x.r.fields?.[k] })).filter((x) => x.s);
  for (const k of RECORD_KEYS) {
    const all = recField(k);
    const have = all.filter((x) => x.s.tag !== 'unavailable' && x.s.value !== null);
    if (!have.length) {
      const why = all.map((x) => `${x.p.id}: ${x.s.note ?? 'unavailable'}`).join('; ') || 'no records provider answered';
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

  // ---- 6. address / location / place id ------------------------------------------------------------------------------------
  const geoConf = addr ? (addr.mismatchReason ? CONFIDENCE.mismatch : addr.confidence ?? CONFIDENCE.census) : 0;
  const geoSrc = addr ? addr.source ?? addr.provider : ASSEMBLER;
  const geoNote = addr?.mismatchReason ? `Geocoder matched a different address (${addr.mismatchReason}).` : addr?.note;
  fields.address = addr ? entry(sourced(addr.address, { tag: 'measured', source: geoSrc, confidence: conf(geoConf), retrievedAt: at, method: 'geocoded from the typed address', ...(geoNote ? { note: geoNote } : {}) }))
    : gone('address could not be geocoded');
  let latLng = addr ? { lat: addr.lat, lng: addr.lng, src: geoSrc, c: geoConf, note: geoNote, method: 'geocoded from the typed address' } : null;
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

  // ---- 7. footprint, roof, floors ------------------------------------------------------------------------------------------
  const fpSrc = fpP ? fpP.label : 'building footprint provider';
  const fpMeta = { tag: /** @type {const} */ ('measured'), source: fp?.source ?? fpSrc, retrievedAt: at, confidence: 0.6 };
  if (main) {
    fields.building_footprint_sqft = entry(sourced(Math.round(main.areaSqft), { ...fpMeta, unit: 'sqft', method: 'area computed from the main (largest) building outline on the parcel',
      note: joinNotes(buildings.length > 1 ? `${buildings.length} buildings on the parcel; this is the largest.` : undefined, main.layerAreaSqft ? `Layer's own AREA ${Math.round(main.layerAreaSqft)} sq ft.` : undefined, 'Outlines date from the 2008-2020 imagery.') }));
  } else fields.building_footprint_sqft = gone(fpP || forKind('footprint').length ? 'no building outline found on the parcel' : 'no footprint provider available');

  if (roof) {
    fields.roof_sqft = entry(sourced(Math.round(roof.areaSqft), { tag: 'measured', source: roofP.label, confidence: 0.8, retrievedAt: at, unit: 'sqft', method: 'solarPotential.wholeRoofStats.areaMeters2 converted to sq ft', note: `${roof.segments?.length ?? 0} roof segments returned.` }));
  } else if (main) {
    fields.roof_sqft = entry(sourced(Math.round(main.areaSqft), { tag: 'estimated', source: fp?.source ?? fpSrc, confidence: 0.3, retrievedAt: at, unit: 'sqft', method: 'building footprint plan area; roof pitch not applied', note: 'A sloped roof is larger than its plan area; no roof provider answered (Google Solar needs a key).' }));
  } else fields.roof_sqft = gone('no roof area provider answered and no building footprint is available');

  if (fields.floors.value === null) {
    const living = fields.house_sqft.value;
    if (isNum(living) && main && main.areaSqft > 0) {
      const ratio = living / main.areaSqft;
      if (ratio > 4.5) fields.floors = gone(`living area / footprint = ${round(ratio, 1)}, too high to estimate floors (footprint may be incomplete)`);
      else {
        const n = Math.min(4, Math.max(1, Math.round(ratio)));
        const ambiguous = Math.abs(ratio - Math.round(ratio)) > 0.35 || ratio < 0.7;
        fields.floors = entry(sourced(n, { tag: 'estimated', source: ASSEMBLER, confidence: ambiguous ? 0.15 : 0.25, retrievedAt: at, method: 'living area / main building footprint, rounded to a whole number in 1..4',
          note: joinNotes(`Ratio ${round(ratio, 2)}.`, main.heightFt !== undefined ? `Building outline height ${main.heightFt} ft (LARIAC; unit and accuracy unverified).` : undefined, ambiguous ? 'Ratio is far from a whole number; low confidence.' : undefined) }));
      }
    } else fields.floors = gone(`floors cannot be estimated: ${!isNum(living) ? 'no living area' : 'no main building footprint'}`);
  }
  if (isNum(fields.house_sqft.value) && main && fields.house_sqft.value > main.areaSqft * 4.5) warnings.push('living area is more than 4.5x the main footprint; the footprint may be incomplete');

  // ---- 8. yard ----------------------------------------------------------------------------------------------------------
  /** @type {string|null} */ let yardWhy = null;
  if (typeof ctx.splitYard !== 'function') yardWhy = 'yard splitter not provided';
  else if (!boundary) yardWhy = 'no parcel polygon';
  else if (!main) yardWhy = 'no building footprint on the parcel';
  /** @type {any} */ let yard = null;
  if (!yardWhy) {
    const onParcel = buildings.map((b) => b.polygon);
    try {
      yard = await /** @type {Function} */ (ctx.splitYard)({ parcel: boundary, buildings: onParcel, ...(streetGeom ? { street: streetGeom } : {}), ...(streetName ? { streetName } : {}),
        ...(streetSide ? { frontPoint: { lat: streetSide.lat, lng: streetSide.lng } } : {}), mainBuildingIndex: mainIdx });
    } catch (e) { yardWhy = `yard splitter threw: ${e instanceof Error ? e.message : String(e)}`; }
    if (yard && !yard.ok) { yardWhy = `yard split failed: ${yard.reason}`; yard = null; }
  }
  const yardKeys = /** @type {const} */ ([['front_yard_sqft', 'frontYardSqft'], ['back_yard_sqft', 'backYardSqft'], ['side_yard_sqft', 'sideYardSqft']]);
  if (yard) {
    const rc = typeof yard.confidence === 'number' ? yard.confidence : ({ low: 0.2, medium: 0.35, high: 0.4 }[/** @type {string} */ (yard.confidence)] ?? 0.2);
    const yw = Array.isArray(yard.warnings) ? yard.warnings.map(String) : [];
    for (const w of yw) warnings.push(`yard: ${w}`);
    if (!streetSide && !streetGeom) warnings.push('yard: no street reference was available; the front/back split is less certain');
    for (const [k, rk] of yardKeys) {
      const v = yard[rk];
      fields[k] = isNum(v) ? entry(sourced(Math.round(v), { tag: 'estimated', source: 'Everyspace yard split (parcel minus building footprints)', confidence: conf(Math.min(CONFIDENCE.yard, rc)), retrievedAt: at, unit: 'sqft',
        method: yard.method ?? 'yard split', note: joinNotes(yw.length ? `Warnings: ${yw.join('; ')}.` : undefined, streetSide ? 'Front edge from the geocoder street-side point.' : streetGeom ? 'Front edge from the street centreline.' : 'No street reference.') })) : gone(`splitYard returned no ${rk}`);
    }
    details.yard = { lotSqft: yard.lotSqft, buildingSqft: yard.buildingSqft, openSqft: yard.openSqft, method: yard.method, confidence: yard.confidence, frontEdge: yard.frontEdge ?? null, warnings: yw };
  } else for (const [k] of yardKeys) fields[k] = gone(yardWhy ?? 'yard not computed');

  // ---- 9. consistency checks against geometry ----------------------------------------------------------------------------------
  if (boundary && isNum(fields.lot_sqft.value)) {
    const poly = polygonAreaSqft(boundary);
    if (fields.lot_sqft.source.indexOf('Assessor') < 0 && poly > 0) {
      const c = compareValues(fields.lot_sqft.value, Math.round(poly), 'area');
      if (c.agreement === 'conflict') warnings.push(`lot_sqft differs ${c.differencePct}% from the parcel polygon area`);
    }
  }

  // ---- output ---------------------------------------------------------------------------------------------------------------
  /** @type {Record<string, any>} */ const out = { address: fields.address.value, lat: fields.lat.value, lng: fields.lng.value, place_id: fields.place_id.value };
  const ordered = /** @type {Record<string, any>} */ ({});
  for (const k of PROFILE_FIELDS) ordered[k] = fields[k];
  for (const k of ['building_footprint_sqft', 'use_code', 'units']) ordered[k] = fields[k];
  for (const k of PROFILE_FIELDS.slice(4)) out[k] = fields[k].value;
  out.building_footprint_sqft = fields.building_footprint_sqft.value;
  if (typeof ctx.splitYard === 'function' || yard) details.yard_used = Boolean(yard);
  if (parcelSrc) details.jurisdiction = { country: 'US', ...LA_COUNTY };
  return { ...out, fields: ordered, providers, warnings, details, retrieved_at: at };
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
    ['building_footprint_sqft', 'building_footprint_sqft']]);
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

// Test doubles that follow the condo / apartment-building contract the property lookup and the earnings core are being given
// (needsUnit answers, ownerPropertyType, unit, ownsWholeBuilding, roofType; opportunities with quantity and per-unit figures).
// Used in two places: served to the browser in place of core/property-profile.js, core/opportunities.js and core/revenue.js
// (the real modules are still loaded, under "?real", and used for everything else), and imported by Node tests that recompute
// the expected figures. Pure: no network, no clock.

const src = (note) => ({ source: 'Test records', confidence: 0.8, retrieved_at: '2026-11-27T00:00:00.000Z', ...(note ? { note } : {}) });
const meas = (value, extra = {}) => ({ value, tag: 'measured', ...src(), ...extra });
const est = (value, extra = {}) => ({ value, tag: 'estimated', ...src(), confidence: 0.3, ...extra });
const none = () => ({ value: null, tag: 'unavailable', ...src() });

const rect = (lng, lat, w, h) => ({ type: 'Polygon', coordinates: [[[lng, lat], [lng + w, lat], [lng + w, lat + h], [lng, lat + h], [lng, lat]]] });

/** The places the tests ask about. `match` is the start of the typed address (lower case). */
export const PLACES = {
  complex: { match: '1200 test ave', address: '1200 Test Ave, Los Angeles, CA 90001', lat: 34.0522, lng: -118.2437, unitCount: 124, apn: '5149-001-001', lotSqft: 41000, buildingYear: 1987, ptype: 'condo', ptypeTag: 'estimated', la: true },
  smallComplex: { match: '77 small ct', address: '77 Small Ct, Los Angeles, CA 90001', lat: 34.0622, lng: -118.2537, unitCount: 6, apn: '5149-002-001', lotSqft: 9000, buildingYear: 1975, ptype: 'condo', ptypeTag: 'measured', la: true },
  house: { match: '500 house st', address: '500 House St, Los Angeles, CA 90001', lat: 34.0422, lng: -118.2337, apn: '5149-003-001', lotSqft: 6500, house: 1800, beds: 3, baths: 2, buildingYear: 1950, ptype: 'single_family', ptypeTag: 'measured', la: true },
  unknownType: { match: '9 plain rd', address: '9 Plain Rd, Phoenix, AZ 85001', lat: 33.4484, lng: -112.074, apn: '123-45-678', lotSqft: 7200, house: 1500, beds: 3, baths: 2, buildingYear: 1990, ptype: null, la: false },
};
export const unitList = (n) => Array.from({ length: n }, (_, i) => ({ unit: String(i + 1), label: `Unit ${i + 1}` }));

const geom = (p, shared) => {
  const parcel = rect(p.lng - 0.0006, p.lat - 0.0004, 0.0012, 0.0008);
  const b1 = rect(p.lng - 0.0004, p.lat - 0.00025, 0.0005, 0.0004), b2 = rect(p.lng + 0.0002, p.lat - 0.00025, 0.0003, 0.0004);
  return { shared, parcel, parcelSource: 'record', buildings: [{ polygon: b1, main: true }, { polygon: b2, main: false }] };
};

/**
 * What the lookup answers for this query (the shape core/property-profile.js's buildPropertyProfile returns).
 * @param {any} query @param {Record<string, any>} [places]
 */
export function fakeLookup(query, places = PLACES) {
  const q = typeof query === 'string' ? { address: query } : query;
  const typed = String(q.address ?? '').toLowerCase();
  const p = Object.values(places).find((x) => typed.startsWith(x.match));
  if (!p) return { fields: { address: none() }, details: {} };
  const base = { address: meas(p.address), lat: meas(p.lat), lng: meas(p.lng), apn: meas(p.apn) };
  const isComplex = p.unitCount > 0;
  const ownerType = q.ownerPropertyType ?? null;
  const out = { fields: base, details: { parcel_boundary: geom(p).parcel, buildings: [], county: { countyFips: p.la ? '06037' : '04013' } }, extraAttrs: {} };
  if (isComplex) {
    const wantsBuilding = q.ownsWholeBuilding === true || ownerType === 'multi_family';
    const wantsOther = ownerType === 'single_family' || ownerType === 'land';
    const units = unitList(p.unitCount);
    if (!wantsBuilding && !wantsOther) {
      if (!q.unit || !units.some((u) => u.unit === String(q.unit))) return { ok: false, needsUnit: true, units, complex: { address: p.address, unitCount: p.unitCount } };
      const n = Number(q.unit) || 1;
      out.fields = { ...base, house_sqft: meas(700 + n * 5), beds: meas(1 + (n % 3)), baths: meas(1 + (n % 2)), year_built: meas(p.buildingYear), property_type: ptype('condo', p) };
      out.extraAttrs = { unit_label: meas(`Unit ${q.unit}`), complex_unit_count: meas(p.unitCount), complex_lot_area_sqft: meas(p.lotSqft) };
      out.geometry = geom(p, true);
      out.details.buildings = [];
      return out;
    }
    if (wantsBuilding) {
      out.fields = { ...base, lot_sqft: meas(p.lotSqft), house_sqft: meas(p.unitCount * 760), beds: meas(p.unitCount * 2), baths: meas(p.unitCount), year_built: meas(p.buildingYear), floors: meas(4),
        building_footprint_sqft: meas(9200), units: meas(p.unitCount), property_type: ptype('multi_family', p), front_yard_sqft: est(1200), back_yard_sqft: est(2600), yard_area_sqft: est(5200) };
      if (q.roofType) out.fields.roof_sqft = est(Math.round(9200 * ({ flat: 1.01, gable: 1.2, hip: 1.25 }[q.roofType] ?? 1.1)), { note: `roof type: ${q.roofType}` });
      out.geometry = geom(p, false);
      return out;
    }
  }
  // a house, or a place the owner says is land
  const land = ownerType === 'land';
  out.fields = { ...base, lot_sqft: meas(p.lotSqft), ...(land ? {} : { house_sqft: meas(p.house ?? 1800), beds: meas(p.beds ?? 3), baths: meas(p.baths ?? 2), year_built: meas(p.buildingYear ?? 1950) }) };
  const pt = ownerType ?? p.ptype;
  if (pt) out.fields.property_type = ptype(pt, p);
  out.geometry = geom(p, false);
  return out;
}
const ptype = (v, p) => ({ value: v, tag: (p.ptypeTag ?? 'measured'), ...src() });

// ---- earnings: quantity and per-unit figures, as the core is to deliver them ----------------------------------------------
const num = (profile, k) => { const a = profile?.attributes?.[k]; return a && a.tag !== 'unavailable' && typeof a.value === 'number' ? a.value : null; };
/** Adds `quantity` (>= 1) to the options that count units or spaces. */
export function withQuantity(identify) {
  return (profile, opts) => identify(profile, opts).map((o) => {
    if (o.id === 'apartment_unit') { const n = num(profile, 'units_available_to_rent'); return n ? { ...o, quantity: n, quantityLabel: 'unit', quantityKind: 'units' } : { ...o, quantityKind: 'units' }; }
    if (o.id === 'parking_spot') { const n = num(profile, 'assigned_parking_spaces') ?? num(profile, 'parking_spaces'); return n >= 1 ? { ...o, quantity: n, quantityLabel: 'parking space' } : o; }
    return o;
  });
}
/** Scales an estimate's scenario figures by the option's quantity and keeps the per-unit figures next to them. */
export function withPerUnit(estimate) {
  return (o, inputs) => {
    const e = estimate(o, inputs);
    const q = Number.isFinite(o?.quantity) && o.quantity >= 1 ? Math.floor(o.quantity) : 1;
    if (q === 1 || !e?.available) return e;
    const scenarios = {}, perUnit = {};
    for (const [s, v] of Object.entries(e.scenarios)) {
      perUnit[s] = { noiCentsPerYear: v.noiCentsPerYear, noiCentsPerMonth: v.noiCentsPerMonth };
      scenarios[s] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'number' ? x * q : x]));
    }
    return { ...e, scenarios, perUnit };
  };
}

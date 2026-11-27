// @ts-check
// Google Solar API buildingInsights as a roof-area provider (needs a server-side key). !!! UNVERIFIED !!!
// Written from MEMORY of Google's public documentation, never run against the live service (no key exists yet):
//   GET https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=..&location.longitude=..&requiredQuality=LOW&key=..
//   roof area: solarPotential.wholeRoofStats.areaMeters2 ; segments: solarPotential.roofSegmentStats[] {pitchDegrees,
//   azimuthDegrees, stats.areaMeters2}. Missing/renamed fields are treated as absent, never defaulted.
// The key travels in the query string (Google's API design) and is removed from every error message and never logged.
// Returns buildings: [] on purpose: Solar gives a bounding box, not a footprint polygon, and we do not present one as such.

import { SQFT_PER_M2 } from '../geometry.js';
import { callJson, qs, fail, isoNow, num, round } from './util.js';

const BASE = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';

/** @param {any} body @param {string} at */
export function parseBuildingInsights(body, at) {
  const whole = num(body?.solarPotential?.wholeRoofStats?.areaMeters2);
  if (whole === null || whole <= 0) return null;
  const segs = Array.isArray(body?.solarPotential?.roofSegmentStats) ? body.solarPotential.roofSegmentStats : [];
  const segments = segs.map((s) => ({ areaSqft: num(s?.stats?.areaMeters2), pitchDegrees: num(s?.pitchDegrees), azimuthDegrees: num(s?.azimuthDegrees) }))
    .filter((s) => s.areaSqft !== null && s.pitchDegrees !== null && s.azimuthDegrees !== null)
    .map((s) => ({ areaSqft: round(/** @type {number} */ (s.areaSqft) * SQFT_PER_M2, 1), pitchDegrees: /** @type {number} */ (s.pitchDegrees), azimuthDegrees: /** @type {number} */ (s.azimuthDegrees) }));
  return { areaSqft: round(whole * SQFT_PER_M2, 1), segments, imageryDate: body?.imageryDate ?? null, imageryQuality: typeof body?.imageryQuality === 'string' ? body.imageryQuality : null, retrievedAt: at };
}

/** @type {import('./types.js').FootprintProvider} */
export const googleSolar = {
  id: 'google-solar', label: 'Google Solar API (roof area)', kind: 'footprint', needsKey: true, role: 'primary', priority: 10, verified: false,
  coverage: { national: true }, retentionDays: 30,
  licenseNote: "Google Maps Platform terms restrict caching and storing Solar API content (about 30 days); Google's terms on permitted use and caching must be confirmed before production use.",
  async lookup(q, deps) {
    const at = isoNow(deps?.now);
    const key = deps?.apiKey;
    if (typeof key !== 'string' || !key) return fail('Google Solar API key required', 'no_key');
    if (!q || !Number.isFinite(q.lat) || !Number.isFinite(q.lng)) return fail('lat/lng required', 'bad_query');
    const url = `${BASE}?` + qs({ 'location.latitude': String(q.lat), 'location.longitude': String(q.lng), requiredQuality: 'LOW', key });
    const r = await callJson(url, deps, {}, [key]);
    if (!r.ok) return fail(`Google Solar: ${r.reason}`, r.code);
    if (r.json?.error) return fail(`Google Solar: service error ${r.json.error.status ?? r.json.error.code ?? ''}`.trim(), r.json.error.code === 404 ? 'not_found' : 'http_error');
    const roof = parseBuildingInsights(r.json, at);
    if (!roof) return fail('Google Solar: field not present in response (solarPotential.wholeRoofStats.areaMeters2)', 'no_match');
    return { ok: true, buildings: [], roof, source: 'Google Solar API' };
  },
};

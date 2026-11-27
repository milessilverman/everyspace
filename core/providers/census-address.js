// @ts-check
// US Census geocoder as an address provider (wraps core/parcel.js geocode with geocoders ['census']). Server-side only: the
// service sends no CORS header. The point is interpolated along the street side, not inside the parcel, so it is returned
// as `streetSidePoint` (the front-lot-line reference for the yard splitter) as well as lat/lng.
// KNOWN: the Census match can change the street direction (200 N Spring St -> '200 S SPRING ST'); `mismatch` is set then.

import { geocode } from '../parcel.js';
import { fail } from './util.js';

/** @type {import('./types.js').AddressProvider} */
export const censusAddress = {
  id: 'census-address', label: 'US Census geocoder', kind: 'address', needsKey: false, role: 'fallback', priority: 20, verified: true,
  coverage: { national: true }, retentionDays: null,
  licenseNote: 'US Government public service; no licence text read for this build.',
  async resolve(input, deps) {
    const t = typeof input === 'string' ? input : input?.text;
    const g = await geocode(String(t ?? ''), { ...deps, geocoders: ['census'] });
    if (!g.ok) return fail(g.reason, /HTTP|timeout|network/.test(g.reason) ? 'http_error' : 'no_match');
    return {
      ok: true, address: g.matchedAddress, lat: g.lat, lng: g.lng, streetSidePoint: { lat: g.lat, lng: g.lng }, retrievedAt: g.retrievedAt,
      confidence: g.confidence, mismatch: g.mismatch, streetMismatch: g.streetMismatch, jurisdiction: g.jurisdiction, ...(g.note ? { note: g.note } : {}),
    };
  },
};

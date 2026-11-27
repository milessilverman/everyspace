// @ts-check
// The keyless providers that can run INSIDE A BROWSER, in the order buildPropertyProfile should use them. Rule for
// membership: no API key, and the service answers cross-origin requests from the site (CORS verified live, see
// docs/property-data.md "Browser wiring"). So: the LA County locator, the LA County assessor parcel layer and the LARIAC
// building outlines. NOT included: the Census geocoder (no CORS header), RentCast / Google Solar / Google Places (need keys).
// No Google code is loaded from here.

import { createRegistry } from './registry.js';
import { laCamsAddress } from './la-cams-address.js';
import { laAssessor } from './la-assessor.js';
import { lariacBuildings } from './lariac-buildings.js';
import { pointInPolygon } from '../geometry.js';
import { distanceToPolygonM } from '../property-profile.js';

/** Shown on the yard rows when there is no usable street-side reference. */
export const YARD_NEEDS_STREET = 'needs a street reference; available once the server-side lookup is switched on';
/** A locator point farther than this from the parcel is not trusted as "the street in front of the lot". */
export const STREET_POINT_MAX_M = 40;

/**
 * The county locator as a browser address provider. It additionally offers its point as `streetSidePoint`: the locator
 * interpolates along the street centreline, so for a parcel the point lies in the street (verified once: 9.1 m outside the
 * parcel of 200 N Spring St). The yard splitter given by `browserSplitYard` refuses it unless it lies OUTSIDE the parcel and
 * within STREET_POINT_MAX_M, so a point that falls inside a lot is never used to guess a front.
 * @type {import('./types.js').AddressProvider}
 */
export const countyLocator = {
  ...laCamsAddress,
  async resolve(input, deps) {
    const r = await laCamsAddress.resolve(input, deps);
    return r.ok ? { ...r, streetSidePoint: { lat: r.lat, lng: r.lng } } : r;
  },
};

/** Fresh registry: county locator, then assessor records + parcel polygon, then LARIAC footprints. Nothing else. */
export function createBrowserRegistry() {
  return createRegistry().register(countyLocator).register(laAssessor).register(lariacBuildings);
}

/**
 * Wrap core/yard.js splitYard for the browser. Without a front point that is outside the parcel and close to it, no front
 * is ever guessed: the result is a failure whose reason is YARD_NEEDS_STREET.
 * @param {(a:any)=>any} splitYard
 */
export function browserSplitYard(splitYard) {
  return (/** @type {any} */ args) => {
    const fp = args?.frontPoint;
    if (!fp || !args?.parcel) return { ok: false, reason: YARD_NEEDS_STREET };
    if (pointInPolygon(fp, args.parcel)) return { ok: false, reason: `${YARD_NEEDS_STREET} (the locator's point falls inside the lot, so it cannot show which side is the street)` };
    const d = distanceToPolygonM(fp, args.parcel);
    if (d > STREET_POINT_MAX_M) return { ok: false, reason: `${YARD_NEEDS_STREET} (the locator's point is ${Math.round(d)} m from the lot)` };
    return splitYard(args);
  };
}

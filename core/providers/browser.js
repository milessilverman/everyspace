// @ts-check
// The keyless providers that can run INSIDE A BROWSER, in the order buildPropertyProfile should use them. Rule for
// membership: no API key, and the service answers cross-origin requests from the site (CORS verified live, see
// docs/property-data.md "Browser wiring"). So: the LA County locator, the LA County assessor parcel layer and the LARIAC
// building outlines. NOT included: the Census geocoder (no CORS header), RentCast / Google Solar / Google Places (need keys).
// No Google code is loaded from here.
// Added 2026-11-27 (REUSE-B): Overture buildings (the catalog host stac.overturemaps.org answers `access-control-allow-origin: *` and the
// tile host overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com answers a ranged GET with `access-control-allow-origin: *` and exposes
// Content-Range, both checked live 2026-11-27) and the nationwide parcel registry restricted to services whose CORS support was verified
// (`corsStatus: 'verified'`; today only LA County, which the assessor provider serves, so outside LA the registry answers with the reason
// "CORS not verified" instead of firing requests at 130 servers nobody tested). `createBrowserRegistry({tryUnverifiedParcelServices:true})`
// tries a county's untested service anyway, with a 4 s timeout: a CORS block looks like a network error and costs one failed request.

import { createRegistry } from './registry.js';
import { laCamsAddress } from './la-cams-address.js';
import { laAssessor } from './la-assessor.js';
import { lariacBuildings } from './lariac-buildings.js';
import { overtureBuildings, withOvertureFallback } from './overture-buildings.js';
import { createParcelRegistryProvider } from './parcel-registry.js';
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

/**
 * Fresh registry: county locator; assessor records + parcel polygon (LA County) and the nationwide parcel registry (CORS-verified services
 * only unless `tryUnverifiedParcelServices`); footprints: LARIAC with an Overture fallback in LA County, Overture elsewhere.
 * @param {{tryUnverifiedParcelServices?:boolean}} [opts]
 */
export function createBrowserRegistry(opts = {}) {
  const parcels = createParcelRegistryProvider({ corsMode: opts.tryUnverifiedParcelServices ? 'try-unverified' : 'verified-only' });
  return createRegistry().register(countyLocator).register(laAssessor).register(parcels).register(withOvertureFallback(lariacBuildings)).register(overtureBuildings);
}

/**
 * Extra address-suggestion sources for the address field (estimate/address-suggest.js reads this if present). None yet: the county
 * locator is the only source. Each future entry would be `{id, label, suggest(text, deps)}`.
 * @returns {Array<{id:string, label:string, suggest:Function}>}
 */
export function suggestionSources() { return []; }

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

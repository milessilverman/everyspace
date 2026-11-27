// @ts-check
// Provider contracts for Everyspace property data. Plain JSDoc: a provider is a plain object, so adding ATTOM, Regrid or
// a county service later means ONE new file that implements the contract below plus ONE `registry.register(...)` call.
// Nothing here does I/O. Every value a provider returns is a `Sourced` value (core/types.js) so its source, tag and
// confidence travel with it; a value that could not be obtained is `unavailable(reason)` (value null, confidence 0).

/** @typedef {import('../types.js').Sourced<any>} Sourced */

/**
 * Injected dependencies for every provider call.
 * @typedef {Object} ProviderDeps
 * @property {(url:string, init?:any)=>Promise<any>} fetch  fetch-compatible
 * @property {string} now                                   ISO time stamped on retrieved values (no clock inside providers)
 * @property {string} [apiKey]                              caller-supplied key for providers with needsKey; never logged, never in errors
 * @property {number} [timeoutMs]                           per-request timeout (default 12000)
 */

/**
 * Where a provider has data. `national` covers everything; otherwise a state and optionally a county FIPS.
 * @typedef {{national:true}|{state:string, countyFips?:string, county?:string}} Coverage
 */

/**
 * Failure shape shared by every provider. `code` is one of: bad_query, no_key, no_match, multiple_matches, auth,
 * not_found, rate_limited, server_error, http_error, timeout, network, malformed_json, no_fetch, unsupported.
 * @typedef {{ok:false, reason:string, code:string, candidates?:any[]}} ProviderFailure
 */

/**
 * Fields of a records provider (every entry is a Sourced value; a field the provider cannot supply is `unavailable`):
 * apn, lot_sqft, house_sqft, floors, beds, baths, year_built, property_type, use_code, units (and, where the record has them: unit_label, complex_unit_count).
 * A records provider may also take `query.unit` and `query.ownsWholeBuilding` (condominium units, docs/condos-and-buildings.md) and may answer
 * `{ok:false, code:'needs_unit', needsUnit:true, units:[{unit,label}], complex:{address, unitCount}}` when several unit records share the address.
 * A provider with `gatesLookup:true` is awaited before the photo, street-line and outline lookups start (its answer decides whether they are needed).
 * A field may carry `crossCheck` ({source, value, difference, differencePct, agreement}) when the provider itself holds a
 * second figure for it (e.g. the assessor's stored lot area next to the polygon-measured lot area).
 * @typedef {'apn'|'lot_sqft'|'house_sqft'|'floors'|'beds'|'baths'|'year_built'|'property_type'|'use_code'|'units'} RecordField
 */

/**
 * @typedef {Object} CommonProvider
 * @property {string} id                 unique, stable (also the key in `keys` passed to providersFor)
 * @property {string} label
 * @property {boolean} needsKey          true: the caller must pass `deps.apiKey` (registry skips it when no key is available)
 * @property {Coverage} coverage
 * @property {'primary'|'fallback'} [role]   default 'fallback'; primaries are asked first
 * @property {number} [priority]         lower first within a role (default 100)
 * @property {boolean} [verified]        false when the adapter was written from documentation and never run against the live service
 * @property {number|null} retentionDays how long results may be cached/stored (null = no stated limit; see licenseNote)
 * @property {string} licenseNote
 */

/**
 * @typedef {CommonProvider & {kind:'records',
 *   lookup:(query:{address:string, lat?:number, lng?:number, placeId?:string, apn?:string}, deps:ProviderDeps)
 *     =>Promise<{ok:true, fields:Record<RecordField, Sourced>, parcel?:{boundary:any, apn:string|null, address:string|null,
 *       assessorAreaSqft:number|null, matchedBy:string, method:string, confidence:number}, raw?:any}|ProviderFailure>}} PropertyRecordsProvider
 */

/**
 * `buildings[].polygon` is a WGS84 GeoJSON Polygon/MultiPolygon. `roof` comes from providers that measure roofs.
 * @typedef {CommonProvider & {kind:'footprint',
 *   lookup:(q:{lat:number, lng:number, parcel?:any}, deps:ProviderDeps)
 *     =>Promise<{ok:true, buildings:Array<{polygon:any, areaSqft:number, heightFt?:number, kind?:string}>,
 *       roof?:{areaSqft:number, segments:Array<{areaSqft:number, pitchDegrees:number, azimuthDegrees:number}>}, source?:string,
 *       counts?:any}|ProviderFailure>}} FootprintProvider
 */

/**
 * `streetSidePoint` is a point on the street side of the address (not inside the parcel); used to find the front lot line.
 * @typedef {CommonProvider & {kind:'address',
 *   suggest?:(text:string, deps:ProviderDeps)=>Promise<{ok:true, suggestions:Array<{text:string, magicKey?:string}>}|ProviderFailure>,
 *   resolve:(textOrSuggestion:string|{text:string, magicKey?:string}, deps:ProviderDeps)
 *     =>Promise<{ok:true, address:string, lat:number, lng:number, placeId?:string, streetSidePoint?:{lat:number,lng:number},
 *       confidence?:number, note?:string, mismatch?:boolean}|ProviderFailure>}} AddressProvider
 */

/**
 * @typedef {CommonProvider & {kind:'street',
 *   lookup:(q:{lat:number, lng:number, address?:string}, deps:ProviderDeps)
 *     =>Promise<{ok:true, streets:Array<{name:string, geometry:any}>}|ProviderFailure>}} StreetProvider
 */

/** @typedef {PropertyRecordsProvider|FootprintProvider|AddressProvider|StreetProvider} Provider */

export {};

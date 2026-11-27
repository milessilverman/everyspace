# Property data: providers and the profile assembler

`buildPropertyProfile(query, {registry, fetch, now, keys, splitYard})` (core/property-profile.js) turns an address into a
PropertyProfile for any US address (richest in Los Angeles County): flat values plus per-field source, tag, confidence and cross-check. Providers live in
`core/providers/` and are plain objects (contract: `core/providers/types.js`). Nothing is guessed: an unobtainable field is
`unavailable` with a reason. Measured accuracy of the keyless path: `docs/phase1-accuracy.md`.

## Providers
| id | kind | key needed | coverage | status | retention / licence note |
|---|---|---|---|---|---|
| la-cams-address | address | no | LA County | verified live 2026-11-27 | no licence text published; not stored |
| census-address | address | no | US (server side only, no CORS) | verified live | US Government service; gives the street-side point |
| la-assessor | records + parcel polygon | no | LA County | verified live | no licence text on the service; confirm before storing at scale |
| lariac-buildings | footprint | no | LA County | verified live (2008-2020 imagery) | no licence text on the service |
| overture-buildings | footprint (+ height, floors) | no | US except LA County (LARIAC wrapper falls back to it inside LA) | verified live; CORS ok | ODbL; footer credit "Drafted buildings: Overture Maps Foundation (ODbL)" |
| parcel-registry | records + parcel polygon | no | US except LA County, 131 county/state ArcGIS services | one service CORS-verified (LA); the browser tries the rest with a 4 s timeout | each county sets its own terms; none verified |
| photon (suggestions only) | address | no | US | fair-use public instance, best effort | OpenStreetMap, ODbL; footer credit "Address suggestions © OpenStreetMap contributors (via Photon)" |
| rentcast | records | yes | US | UNVERIFIED (field names from memory) | commercial terms: confirm caching/storage |
| google-solar | footprint (roof area) | yes | US | UNVERIFIED (from memory) | 30 days; confirm Google's terms on use and caching |
| google-places | address (pure normaliser only) | yes (browser) | US | normaliser tested; no network code | Places terms apply |
| overture-roads | street (centrelines, names, alleys flagged) | no | US | verified live 2026-11-27; CORS `*` | ODbL; "Street lines: Overture Maps Foundation (ODbL), © OpenStreetMap contributors" |
| naip-aerial | aerial (USDA NAIP photo, RGB + near-infrared, 60 cm) | no | US | verified live 2026-11-27; CORS `*` (STAC, data API, USGS) | US Government imagery, public domain; credit "Aerial photo: USDA NAIP" |
| ATTOM, Regrid | - | - | - | not built | - |

Microsoft Global Building Footprints is a bulk dataset with no per-address query API. Using it needs hosted tiles or a database
import, which is a cost and hosting decision. LARIAC is the Los Angeles fallback in its place.

## How a run goes (any US address)
County first: the caller's `jurisdiction`, else the county of the county-level address provider, else `countyAt` (FCC, TIGERweb fallback). Then
records (all providers together), footprints, street and transit start together; a footprint provider flagged `needsParcel` (LARIAC) waits for
the parcel, a records provider flagged `needsPointInParcel` (parcel registry) uses a rooftop point at once, otherwise the centroid of the
building nearest the geocoded point. `onPartial(profileSoFar, {stage})` (stages address, records, footprints, final) lets a page render by group;
the last call equals the returned value. Results carry `attributions`; the 2008-2020 outline note only appears when LARIAC supplied the outline.

## Fallback order
Address: county locator, then Census (Census is also asked for the street-side point when a yard split is wanted). Records:
primary (RentCast, if keyed) first, then the assessor, which is always fetched as the cross-check. Footprint: Google Solar (roof)
if keyed, LARIAC (outlines). A primary value is kept when a source disagrees (lowered confidence plus a warning); values are
never averaged. If the primary lacks a field, the assessor value is used and noted as "no independent cross-check". Without a
Solar key, `roof_sqft` is the main footprint's plan area, tagged `estimated`.

## Adding a provider (for example ATTOM or Regrid)
1. Create `core/providers/<id>.js` exporting an object with `id, label, kind, needsKey, coverage, role, retentionDays,
   licenseNote` and `lookup` (or `resolve` for addresses) returning Sourced fields (see types.js; use `callJson` from util.js so
   failures carry a code and secrets are redacted).
2. Register it: `registry.register(provider)` (or add it to `createDefaultRegistry` in registry.js). `role: 'primary'` puts it
   first; a keyed provider without a key is reported as `skipped: 'no API key'`, never an error.
3. Add tests with a fixture of a real response. Mark `verified: false` until it has run against the live service.

## Keys needed
- **RentCast API key**: primary property records (living area, beds, baths, lot, year, floors). Unblocks an independent
  cross-check of the assessor. Verify the field mapping on the first live call.
- **Google Maps Platform key with Places API (New)**: browser address autocomplete. A browser key, restricted by HTTP referrer and
  by API. Unblocks place ids and typo-tolerant address entry.
- **Google Solar API key**: server-side roof area and segments. Unblocks measured `roof_sqft` (pitch included).

Known limits: street names with an apostrophe or hyphen are refused by the assessor query (safety over coverage); LARIAC
outlines date from 2008-2020.

## Yards, usable yard, photo reading, geometry (2026-11-27, AERIAL; measurements in `docs/yard-accuracy.md`)
- Front/back yard: Overture road centrelines first (the address's street by name, else the nearest street; alleys never the front), the
  geocoder street-side point as fallback. So yards now work wherever a parcel outline exists, not only in LA County.
- `side_yard_sqft` is computed but `hidden: true` and not in `toSourcedProfile` (owner request).
- `usable_yard_sqft`, `usable_front_yard_sqft`, `usable_back_yard_sqft`: open ground at least `ctx.minWidthFt` (default 10 ft, an Everyspace
  assumption) wide (`core/usable-yard.js`).
- `green_area_sqft`, `paved_area_sqft` from one NAIP photo (`core/aerial.js`); `tree_cover_sqft` and `pool_area_sqft` stay unavailable
  (not reliable at 60 cm; pools: `ctx.aerialPools: true`). The photo is asked only when building outlines are; `ctx.aerial: false` skips it.
- `remodeled_year` from the LA assessor's effective year.
- Estimated lot without a parcel record: `ctx.estimateLotWithoutParcel: true` only (failed its accuracy rule; off by default).
- `result.geometry` (WGS84): `{parcel, parcelSource, buildings:[{polygon, main}], frontEdge:{coordinates}, reference, streets, streetName, frontPoint,
  zones:{bands, usable:{mask, width, height, bbox, cellM, rowOrder}}, roof, minWidthFt, image:{url, bbox, crs, width, height, date, credit, corsForImg}}`.
  After an owner moves a corner, `core/measure.js` `measureFromGeometry(geometry, {now})` recomputes every number with the same functions.

## Browser wiring (2026-11-27)
Live checks, 5 requests to `public.gis.lacounty.gov` with `Origin: https://milessilverman.github.io`, public building 200 N Spring St only:
- CORS (answer: yes for all): CAMS `suggest` and `findAddressCandidates` (GET), LARIAC query (GET, and form-encoded POST, a simple request with no preflight) and the parcel layer (form POST) all returned `Access-Control-Allow-Origin: https://milessilverman.github.io` (`Vary: Origin`). Census still has no CORS header and is not in the browser registry.
- Locator point vs parcel: the candidate point (-118.243493, 34.053898) is OUTSIDE the matched parcel polygon, 9.1 m from its nearest edge, on the street side of the frontage. That is ONE sample; it is not proof for every lot.
- So `core/providers/browser.js` offers the point as `streetSidePoint`, but `browserSplitYard` uses it only when it lies outside the parcel and within 40 m; otherwise front/back/side stay unavailable ("needs a street reference; available once the server-side lookup is switched on"). A front is never guessed.
- `createBrowserRegistry()`: county locator, assessor, LARIAC. `estimate/county-path.js` runs it first (plus OSM Overpass for pool and transit as before). It falls back to the old Nominatim path when the locator has no match or fails, the typed state is not CA or the typed ZIP differs from the county's, or the assessor finds no parcel. A different house number or direction, or two near-equal candidates, asks "Is this your property?" first.
- `estimate/address-suggest.js`: combobox on the homepage and estimator; the county `suggest` is asked first (skipped when the text ends in another state), Photon (`suggestionSources()` in browser.js) only when the county has nothing; Photon: 4+ characters, one request in flight, one start per 250 ms, silent on failure, US addresses with a house number only, coordinates returned. A chosen Photon suggestion's point goes to `runCountyPath` (`picked`), so no geocoder is asked.
- Known limit: the locator's city can be a community name (e.g. Van Nuys), which would skip the City of Los Angeles rules in `core/regulatory.js`.
- Outside LA County (2026-11-27, INTEGRATE): `runCountyPath` takes the nationwide route for a chosen Photon suggestion, a typed state other than CA, or a county-locator miss that Nominatim places outside LA County. Same assembler: county (FCC), Overture outline, roof/floors derived, lot from the county parcel service (`createBrowserRegistry({tryUnverifiedParcelServices:true})`, 4 s timeout, started in parallel; silent when it does not answer, the lot-size line stays an empty input). Yards stay empty (no street reference). Earnings ideas wait for the owner to choose a property type (parcel services map no use code).
- Live check, public buildings only (real fetch, mocked nothing): LA City Hall typed: records 1.2 s, outline 4.1 s, 3 requests, 24 KB. Chicago City Hall from a Photon point: county 0.09 s, outline + roof + floors 1.5 s, 5 requests, 189 KB; Cook County's parcel host is outside the allowed hosts, so not contacted.

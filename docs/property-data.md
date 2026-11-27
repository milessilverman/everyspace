# Property data: providers and the profile assembler

`buildPropertyProfile(query, {registry, fetch, now, keys, splitYard})` (core/property-profile.js) turns an address into a
PropertyProfile for Los Angeles County: flat values plus per-field source, tag, confidence and cross-check. Providers live in
`core/providers/` and are plain objects (contract: `core/providers/types.js`). Nothing is guessed: an unobtainable field is
`unavailable` with a reason. Measured accuracy of the keyless path: `docs/phase1-accuracy.md`.

## Providers
| id | kind | key needed | coverage | status | retention / licence note |
|---|---|---|---|---|---|
| la-cams-address | address | no | LA County | verified live 2026-11-27 | no licence text published; not stored |
| census-address | address | no | US (server side only, no CORS) | verified live | US Government service; gives the street-side point |
| la-assessor | records + parcel polygon | no | LA County | verified live | no licence text on the service; confirm before storing at scale |
| lariac-buildings | footprint | no | LA County | verified live (2008-2020 imagery) | no licence text on the service |
| rentcast | records | yes | US | UNVERIFIED (field names from memory) | commercial terms: confirm caching/storage |
| google-solar | footprint (roof area) | yes | US | UNVERIFIED (from memory) | 30 days; confirm Google's terms on use and caching |
| google-places | address (pure normaliser only) | yes (browser) | US | normaliser tested; no network code | Places terms apply |
| ATTOM, Regrid, street centreline | - | - | - | not built | - |

Microsoft Global Building Footprints is a bulk dataset with no per-address query API. Using it needs hosted tiles or a database
import, which is a cost and hosting decision. LARIAC is the Los Angeles fallback in its place.

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
outlines date from 2008-2020; there is no street centreline source, so the yard split uses the Census street-side point.

## Browser wiring (2026-11-27)
Live checks, 5 requests to `public.gis.lacounty.gov` with `Origin: https://milessilverman.github.io`, public building 200 N Spring St only:
- CORS (answer: yes for all): CAMS `suggest` and `findAddressCandidates` (GET), LARIAC query (GET, and form-encoded POST, a simple request with no preflight) and the parcel layer (form POST) all returned `Access-Control-Allow-Origin: https://milessilverman.github.io` (`Vary: Origin`). Census still has no CORS header and is not in the browser registry.
- Locator point vs parcel: the candidate point (-118.243493, 34.053898) is OUTSIDE the matched parcel polygon, 9.1 m from its nearest edge, on the street side of the frontage. That is ONE sample; it is not proof for every lot.
- So `core/providers/browser.js` offers the point as `streetSidePoint`, but `browserSplitYard` uses it only when it lies outside the parcel and within 40 m; otherwise front/back/side stay unavailable ("needs a street reference; available once the server-side lookup is switched on"). A front is never guessed.
- `createBrowserRegistry()`: county locator, assessor, LARIAC. `estimate/county-path.js` runs it first (plus OSM Overpass for pool and transit as before). It falls back to the old Nominatim path when the locator has no match or fails, the typed state is not CA or the typed ZIP differs from the county's, or the assessor finds no parcel. A different house number or direction, or two near-equal candidates, asks "Is this your property?" first.
- `estimate/address-suggest.js`: combobox on the homepage and estimator, county `suggest` only, 5+ characters, 300 ms debounce, one request in flight, max 5, silent on failure. `EXTRA_SOURCES` is where a Google Places source can be added later (none now).
- Known limit: the locator's city can be a community name (e.g. Van Nuys), which would skip the City of Los Angeles rules in `core/regulatory.js`.

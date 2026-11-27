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

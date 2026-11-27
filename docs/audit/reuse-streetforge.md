# Reuse of StreetForge in the provider layer (REUSE-B, 2026-11-27)

Read-only reference: `/home/user/streetforge/streetforge2d.html` (line numbers below). Nothing was committed. All code is dependency-free ES modules; `fetch` and `now` are injected.

## What was ported
| StreetForge | Everyspace file | Note |
|---|---|---|
| 13596-13597, 13631-13638, 13639-13662, 13689 (8 m2 speck rule) | `core/providers/overture-buildings.js` | provider `overture-buildings` (footprint, no key, national except LA County); `withOvertureFallback` wraps LARIAC |
| 13598-13630 (PMTiles v3 reader, Hilbert id, directories, vector-tile decoder) | `core/providers/pmtiles.js` | decoder is plain JS embedded in StreetForge, ported as is; `fetch`, gunzip and directory cache injected |
| 13664-13667 `countyAt`, 13662 `FIPS_ST` | `core/providers/county-lookup.js` | FCC census-area, TIGERweb fallback |
| 13668-13683 service choice, point-layer skip, stacked units; `assets/parcel-services.json` | `core/providers/parcel-registry.js`, `core/data/parcel-services.js` | provider `parcel-registry` (records); 131 services |
Changes on purpose: a 200 answer to a Range request is refused (StreetForge would read a 181 GB file); gzip/compression errors are coded `decode`; header and directories are cached (second lookup: tiles only); FCC answers listing two counties go to TIGERweb; the 0.01-degree county memo (can straddle a county line) is a 5-decimal optional cache.

## Not ported, and why
- Cross-tile fragment merge (`mergeBuildingFragments`, 13431) and overlap test against a base map (`addMissingBuildings`): both use the `polygon-clipping` library. A building cut by a tile edge is returned as its largest piece with `partial:true` and a warning.
- Envelope/paged parcel queries (`parcelsIn`), prefetch caches, 5-minute outage memo, 60-acre limit, localStorage release memo: they serve StreetForge's draw-an-area flow; Everyspace asks for one parcel at a point.
- Voronoi lot split, tree/road/photo logic: not property data.

## Coverage
- Parcel registry: 131 services = 104 county entries (LA assessor among them, kept with its richer field map) + 27 statewide; all 50 states and DC have at least one entry (27 have a statewide layer; 24 states are county-only). Only the APN field name is known for the 125 StreetForge entries (address/use/year/beds/living area come back `unavailable` with the reason). Licence: "not verified" everywhere.
- CORS: verified for browser origin `https://milessilverman.github.io`: FCC (`*`), TIGERweb (that origin), `stac.overturemaps.org` (`*`), the Overture tile bucket (ranged GET, `*`, exposes Content-Range), LA County. NOT tested: the other 130 parcel services (their hosts are outside the five hosts this task could reach), so 1 of 131 is `corsStatus:'verified'`. Choice: the browser registry SKIPS unverified services and answers `cors_unverified` ("CORS not verified"), with no request to 130 untested servers; `createBrowserRegistry({tryUnverifiedParcelServices:true})` tries a county's service with a 4 s timeout.
- Skipped by default (`caveat`): 2 layers named "zoning layer" (King WA, Miami-Dade: polygons may not be parcels) and 3 whose source note forbids reuse (Linn IA, Douglas KS, Elko NV). 14 entries carry StreetForge's restriction text as `termsNote`.

## Live verification (public buildings only; 31 requests to the 5 allowed hosts)
| check | result |
|---|---|
| LA City Hall, parcel 200 N Spring St (255,412 sq ft) | LARIAC main outline 94,412.4 sq ft; Overture 94,594.0 sq ft: +0.19%. Overture also gives class civic, height 65.6 ft (20 m: the building, not the tower; LARIAC says 454.8 ft), source dataset OpenStreetMap, no floor count |
| Chicago City Hall (121 N LaSalle), outside California | FCC: Cook County, IL (17031). Overture 45,834 sq ft, 75.5 ft; neighbours with floors (120 N LaSalle: 39 floors, 502 ft). Parcel registry step NOT run: the Cook County service host is not an allowed host, so lot size from a parcel polygon is unavailable here. Tested instead with mocks (county first, statewide second, point layers skipped) |
- Cost of one Overture lookup: 5 requests / 424,005 bytes in LA (catalog 11 KB, header+root 16 KB, leaf 11 KB, two 180-205 KB tiles); 4 requests / 188,483 bytes in Chicago. Warm cache: 1 request per tile (~180-205 KB). County lookup: 1 request (~1.5 KB).
- Licence/attribution: Overture buildings are ODbL 1.0 (includes OSM-derived footprints). Show `Drafted buildings: Overture Maps Foundation (ODbL)` (`ATTRIBUTION_TEXT`; HTML form `ATTRIBUTION_HTML`, as StreetForge credits it). Share-alike for stored derived data is unconfirmed (owner). Parcel services: each county's own terms.

## Calls for the assembler (`core/property-profile.js`, not touched)
1. `import { countyAt } from './providers/county-lookup.js'`; `const j = await countyAt({lat,lng},{fetch,now})` gives `{ok,state,countyFips,county}`. The assembler still hard-codes `LA_COUNTY` in `forKind`; pass `j` instead.
2. `registry.providersFor('records',{jurisdiction:j})`: LA -> `la-assessor`; elsewhere -> `parcel-registry` (`lookup({address,lat,lng,jurisdiction:j},{fetch,now})`; same result shape as la-assessor: `fields`, `parcel.boundary`, `raw`). The point must lie INSIDE the parcel (a building centroid); a street-side point only works for services with an address field.
3. `registry.providersFor('footprint',{jurisdiction:j})`: LA -> one provider `lariac-buildings` that falls back to Overture inside itself (result then has `fallbackFrom`, `source`, `warnings`); elsewhere -> `overture-buildings` (`lookup({lat,lng,parcel},{fetch,now})`, buildings carry `areaSqft, kind, heightFt?, floors?, dataset, onParcel`, plus `attribution`, `counts.requests/bytes`). The note "Outlines date from the 2008-2020 imagery" must be conditional on `!fp.fallbackFrom` and a LARIAC source.
4. Show `fp.attribution` when Overture was used.

## Tests
`node --test core/tests/*.test.mjs`: 441 pass, 0 fail (overture 23, parcel-registry 16, county-lookup 8, providers 37). Overture fixtures are the REAL header/root and leaf bytes; tiles are re-encoded from the real decoded features (a 200 KB real tile is too large to store). Existing expectations changed: three registry-list assertions in `providers.test.mjs`; two `parcel.test.mjs` cases moved from Cook County IL (now has a service) to McLean County IL.

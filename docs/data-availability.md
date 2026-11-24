# Data availability for the address-to-earnings flow (2026-11-24, second pass)

**Status:** Verified from publisher pages today: Nominatim policy, OSM copyright/ODbL, Census geocoder (one live sample), LA County parcel layer description (fields, maxRecordCount).
**Still not verified:** Overpass usage text and NREL limits (hosts did not resolve, even via curl); LA Home-Sharing rules (page is script-rendered, rule text absent from fetched HTML; /requirements, /faq, /overview paths returned 404); Census terms of use; LA parcel use terms (layer copyright/description empty); all other publishers (not allowed).

## Property attributes
Legend: tag = provenance tag the value would carry. NV = not verified.

| attribute | best source | coverage | tag | licence + key constraint | cost | may store? | recommend |
|---|---|---|---|---|---|---|---|
| geocode | Census geocoder, then Nominatim (both already in CP sources.ts:121) | US | measured | Census: no terms text found on the fetched API (terms NV). Nominatim: max 1 req/s, identifying User-Agent/Referer, attribution, no autocomplete, ODbL share-alike. Mapbox temporary geocoding must not be stored (audit, unverified at source) | free | Census: NV. Nominatim: policy requires results be cached for bulk use; storing otherwise not addressed (ODbL applies). Mapbox: no | use now: Census first, from a server. Nominatim only for user-triggered lookups behind our own proxy with caching, not browser-direct, not autocomplete |
| parcel id + boundary | County ArcGIS registry via CP `parcelAt`; LA County Assessor layer `LACounty_Parcel/MapServer/0` (has AIN, geometry) | LA yes; CA/US partial (CP README) | measured | LA layer copyrightText and description are empty; no use limitation stated on the layer page. Terms elsewhere NV | free | NV (no restriction stated on the layer page) | use now (LA); registry for other markets |
| lot area | Parcel polygon area, or assessor field | as above | measured (polygon) | as above | free | NV | use now |
| building footprints | OSM via Overpass (CP `osmNearby`); Overture/Microsoft as fallback | OSM US, uneven; MS US-wide | estimated | OSM: ODbL, credit OpenStreetMap and contributors, adaptations shared under same licence. Microsoft: ODbL | free | ODbL allows copy/adapt with credit; derived databases share-alike | use now, with attribution |
| roof area | footprint x pitch factor (CP roofAreaEngine, "unsourced rule of thumb") | derived | estimated | no data licence | free | yes (own derivation) | use now, labelled estimate |
| yard area | parcel polygon minus building polygons | derived | estimated | inherits parcel + footprint terms | free | NV | use now, labelled |
| driveway area | none found | none | unavailable | n/a | n/a | n/a | later (owner-entered) |
| parking count | LA assessor fields do not include a garage/parking field in the first 40 listed (full list has 92 fields; not checked past that) | NV | unavailable (owner-confirmed if entered) | NV | free | NV | later; ask owner |
| pool presence | OSM `leisure=swimming_pool` flag | OSM, incomplete | estimated | ODbL | free | as ODbL | use now, absence is not proof |
| zoning | LA ZIMAS/GeoHub (NV); parcel UseCode/UseType/UseDescription as proxy (fields exist) | LA | unavailable / estimated (use code) | NV | NV | NV | later |
| STR regulatory status | LA Home-Sharing page (rule text not retrievable) | LA only | unavailable | NV | NV | NV | later; see rules section |
| transit proximity | OSM transit_stops/rail_stations; LA Metro GTFS (NV) | OSM US | estimated | ODbL (OSM); GTFS NV | free | as ODbL | use now (OSM) |
| demand generators / venues / events | ES `VENUES` list (index.html:8852); OSM POIs | hand-made, LA | estimated | own data, "typical figures", unsourced | free | yes | use now, label unsourced |
| solar yield | NREL PVWatts v8 (CP `pvwattsV8`) | US | estimated | NREL limits NV (host unreachable). DEMO_KEY shared and rate-limited (audit) | free (assumption); needs own key | NV | use now with own key |
| listing photos | none obtainable | n/a | unavailable | scraping listing sites not allowed | n/a | no | avoid; owner uploads |

LA parcel fields present: AIN, SitusFullAddress, UseCode, UseType, UseDescription, SQFTmain1, Units1, YearBuilt1, Bedrooms1 (all 9 exist). maxRecordCount 1000.

## Market comparables
| space category | legally usable price/occupancy source | licence / cost | verdict |
|---|---|---|---|
| STR whole home | Inside Airbnb (licence NV); AirDNA (commercial, pricing NV); HUD FMR is rent, not STR | NV | paid, requires owner approval (AirDNA); free option not verified |
| STR room | none verified | NV | unavailable -> owner-entered + disclosed low confidence |
| parking | none verified (ES VENUES $/car unsourced) | n/a | unavailable -> owner-entered + disclosed low confidence |
| storage | none verified | n/a | unavailable -> owner-entered + disclosed low confidence |
| pool | none verified | n/a | unavailable -> owner-entered + disclosed low confidence |
| event space | none verified | n/a | unavailable -> owner-entered + disclosed low confidence |
| RV/land | none verified | n/a | unavailable -> owner-entered + disclosed low confidence |

## Los Angeles short-term rental rules (official)
Page fetched: https://planning.lacity.gov/project-review/home-sharing (and /plans-policies/initiatives-policies/home-sharing). Both return only the menu (Overview, Requirements, How to Apply, Registered Hosts, Enforcement, Resources, FAQ); tab content is not in the HTML.

| rule | verbatim quote | URL |
|---|---|---|
| primary-residence requirement | not stated on the fetched page (not verified) | https://planning.lacity.gov/project-review/home-sharing |
| registration requirement | not stated on the fetched page (not verified) | same |
| annual day cap / extended home-sharing | not stated on the fetched page (not verified) | same |
| registration fee | not stated on the fetched page (not verified) | same |
| excluded housing types | not stated on the fetched page (not verified) | same |

## Sources
All "retrieved" dates are 2026-11-24. Rows marked "repo" were read from local code, not from the publisher.

| source | URL | retrieved | quoted constraint |
|---|---|---|---|
| Nominatim policy: rate | https://operations.osmfoundation.org/policies/nominatim/ | 2026-11-24 | "No heavy uses (an absolute maximum of 1 request per second)." |
| Nominatim: identification | same | 2026-11-24 | "Provide a valid HTTP Referer or User-Agent identifying the application (stock User-Agents as set by http libraries will not do)." |
| Nominatim: end-user apps | same | 2026-11-24 | "Use that is directly triggered by the end-user (for example, user searches for something) is ok, provided that your number of users is moderate." |
| Nominatim: shared limit | same | 2026-11-24 | "the usage limits above apply per website/application: the sum of traffic by all your users should not exceed the limits." |
| Nominatim: switchable, proxy | same | 2026-11-24 | "Apps must make sure that they can switch the service at our request at any time" |
| Nominatim: caching | same | 2026-11-24 | "Results must be cached on your side." (stated under bulk geocoding); "set up a proxy and also enable caching of requests" |
| Nominatim: autocomplete | same | 2026-11-24 | "Auto-complete search This is not yet supported by Nominatim and you must not implement such a service on the client side" |
| Nominatim: systematic/periodic | same | 2026-11-24 | "periodic requests from apps are considered bulk geocoding and as such are strongly discouraged." |
| Nominatim: licence | same | 2026-11-24 | "Data is provided under the ODbL license which requires to share alike" |
| Nominatim: change notice | same | 2026-11-24 | "this usage policy may change without notice" |
| OSM licence | https://www.openstreetmap.org/copyright | 2026-11-24 | "open data, licensed under the Open Data Commons Open Database License (ODbL) by the OpenStreetMap Foundation" |
| OSM share-alike | same | 2026-11-24 | "If you alter or build upon our data, you may distribute the result only under the same license." |
| OSM attribution | same | 2026-11-24 | "Provide credit to OpenStreetMap by displaying our attribution notice." and "Make clear that the data is available under the Open Database License." Exact wording not on page; repo uses "© OpenStreetMap contributors" |
| Census geocoder sample | https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?... (200 N Spring St) | 2026-11-24 | HTTP 200; matched "200 S SPRING ST, LOS ANGELES, CA, 90012" (street was returned as S, not N: verify matches). Terms/limits not fetched |
| LA County Parcel layer | https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0?f=pjson | 2026-11-24 | name "Parcels"; copyrightText "" ; description "" ; maxRecordCount 1000 |
| LA Home-Sharing page | https://planning.lacity.gov/project-review/home-sharing | 2026-11-24 | menu only; no rule text retrievable |
| Overpass usage | https://overpass-api.de/ | 2026-11-24 | not verified: host did not resolve |
| NREL rate limits, PVWatts | https://developer.nrel.gov/docs/rate-limits/ , /docs/solar/pvwatts/ | 2026-11-24 | not verified: host did not resolve |
| Microsoft US Building Footprints | https://github.com/microsoft/USBuildingFootprints | 2026-11-24 | "This data is licensed by Microsoft under the Open Data Commons Open Database License (ODbL)." |
| Google Solar (repo, CP sources.ts:723) | n/a | 2026-11-24 | "solar feasibility only", 30-day max cache (audit paraphrase) |
| FEMA NRI (repo, CP sources.ts:392) | n/a | 2026-11-24 | "meant for planning purposes only" |
| Overture, Google Solar pricing, Regrid, Mapbox, HUD, GTFS, Inside Airbnb, AirDNA, ZIMAS | not attempted (hosts not allowed) | n/a | not verified |

## Verified / Assumptions / Recommendations
**Verified**
- Nominatim: 1 req/s max per application (all users combined), identifying User-Agent/Referer, attribution, no client-side autocomplete, switchable without a software update.
- OSM data is ODbL: credit required, adaptations share-alike. Microsoft footprints are ODbL.
- Census geocoder answers a public one-line request; JSON paths: result.addressMatches[0].matchedAddress, .coordinates.x (lon) / .coordinates.y (lat), .geographies.Counties[0].GEOID ("06037"); also .tigerLine, .addressComponents.
- LA County parcel layer has all 9 requested fields; maxRecordCount 1000; no copyright or use-limitation text on the layer.
- CP wires Census, county parcel services, Overpass, PVWatts, Google Solar, HUD, FEMA; ES VENUES and roof constants are unsourced (audit).

**Assumptions**
- Census geocoder is free; its terms, rate limit and storage rights were not on the pages fetched.
- Empty parcel-layer copyright text is not a licence grant; county terms still need review.
- PVWatts needs an own key for production; limits unconfirmed.
- LA home-sharing: registration, primary residence and a day cap probably exist; unconfirmed, do not encode as rules.
- Census returned "S SPRING ST" for an "N Spring St" query; treat matchedAddress as the canonical form and show it to the user.

**Recommendations**
- Call Nominatim only server-side, behind our proxy with caching, a real User-Agent and a global 1 req/s limit; never from end-user browsers directly at scale and never for autocomplete (policy forbids it). Prefer Census for US geocodes. Paid geocoder fallback requires owner approval.
- Show "© OpenStreetMap contributors" with a link to openstreetmap.org/copyright wherever OSM-derived data appears; plan for share-alike on any derived footprint database.
- Do not encode any LA STR rule until read from the official page (use the Requirements tab in a browser, or the allowed host's PDF/FAQ).
- Paid STR data (AirDNA), Regrid and Google Solar spend require owner approval; treat other market comparables as owner-entered.
- Re-check Overpass and NREL hosts (DNS failure, possibly allow-list propagation) before relying on those cells.

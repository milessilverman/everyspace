# Data availability for the address-to-earnings flow (2026-11-24)

**BLOCKER: web access was mostly blocked.** Only github.com resolved. These hosts failed DNS (outside the session's allowed network domains): operations.osmfoundation.org, www.openstreetmap.org, docs.overturemaps.org, developers.google.com, developer.nrel.gov. I stopped after the first batch, as the error told me to. Everything not in the Sources table is "not verified". Items marked "assumption" are from memory, not from an official page. Allow those hosts (plus the LA County, Census, HUD, Regrid, Inside Airbnb and LA City hosts) to complete this.

## Property attributes
Legend: tag = provenance tag the value would carry. NV = not verified.

| attribute | best source | coverage | tag | licence + key constraint | cost | may store? | recommend |
|---|---|---|---|---|---|---|---|
| geocode | Census geocoder, then Nominatim (both already in CP sources.ts:121) | US | measured | Census terms NV. Nominatim policy NV (assumption: rate-limited, bulk use barred). Mapbox temporary geocoding must not be stored (shared-infra audit, unverified at source) | free (assumption) | Census: NV. Nominatim: NV. Mapbox: no | use now (Census first; keep Nominatim to low volume) |
| parcel id + boundary | County ArcGIS registry via CP `parcelAt`; LA County Assessor for LA (ES index.html:19399) | LA yes; CA/US partial (27 states + DC + ~8 counties per CP README) | measured | each registry entry has a `terms` URL, "not a licence grant" (audit). LA terms NV | free | NV | use now (LA); registry for other markets |
| lot area | Parcel polygon area, or assessor field | as above | measured (polygon) | as above | free | NV | use now |
| building footprints | OSM via Overpass (CP `osmNearby`); Overture/Microsoft as fallback | OSM US, uneven; MS US-wide | estimated | OSM and Microsoft footprints are ODbL. Attribution "© OpenStreetMap contributors"; share-alike may apply to derived databases | free | NV (assumption: ODbL allows storage with attribution) | use now |
| roof area | footprint x pitch factor (CP roofAreaEngine, pitches "unsourced rule of thumb") | derived | estimated | no data licence | free | yes (own derivation) | use now, labelled estimate |
| yard area | parcel polygon minus building polygons | derived | estimated | inherits parcel + footprint terms | free | NV | use now, labelled |
| driveway area | none found in any repo or source | none | unavailable | n/a | n/a | n/a | later (owner-entered) |
| parking count | assessor garage field if present (NV); else none | NV | unavailable (owner-confirmed if entered) | NV | free | NV | later; ask owner |
| pool presence | OSM `leisure=swimming_pool` flag | OSM, incomplete | estimated | ODbL | free | NV | use now, absence is not proof |
| zoning | LA ZIMAS/GeoHub (NV); parcel use code as proxy | LA NV; elsewhere none | unavailable / estimated (use code) | NV | NV | NV | later |
| STR regulatory status | LA Home-Sharing Ordinance page (NV) | LA only | unavailable | NV | NV | NV | later. Assumption: registration, primary-residence and 120-day cap exist, to be checked officially |
| transit proximity | OSM transit_stops/rail_stations; LA Metro GTFS (NV) | OSM US | estimated | ODbL (OSM); GTFS terms NV | free | NV | use now (OSM) |
| demand generators / venues / events | ES's own `VENUES` list (index.html:8852); OSM POIs | hand-made, LA | estimated | own data, "typical figures", no sources | free | yes | use now, label as unsourced |
| solar yield | NREL PVWatts v8 (CP `pvwattsV8`) | US | estimated | rate limits NV; DEMO_KEY is shared and rate-limited (audit) | free (assumption); needs own key | NV | use now with own key |
| listing photos | none obtainable | n/a | unavailable | scraping listing sites is not allowed here | n/a | no | avoid; owner uploads |

## Market comparables
| space category | legally usable price/occupancy source | licence / cost | verdict |
|---|---|---|---|
| STR whole home | Inside Airbnb (licence NV); AirDNA (commercial, pricing NV); HUD FMR is rent, not STR | NV | paid, needs owner approval (AirDNA); free option not verified |
| STR room | none verified | NV | unavailable -> owner-entered + disclosed low confidence |
| parking | none verified (ES VENUES $/car are unsourced) | n/a | unavailable -> owner-entered + disclosed low confidence |
| storage | none verified | n/a | unavailable -> owner-entered + disclosed low confidence |
| pool | none verified | n/a | unavailable -> owner-entered + disclosed low confidence |
| event space | none verified | n/a | unavailable -> owner-entered + disclosed low confidence |
| RV/land | none verified | n/a | unavailable -> owner-entered + disclosed low confidence |

## Sources
All "retrieved" dates are 2026-11-24. Rows marked "repo" were read from local code, not from the publisher.

| source | URL | retrieved | quoted constraint |
|---|---|---|---|
| Microsoft US Building Footprints | https://github.com/microsoft/USBuildingFootprints | 2026-11-24 | "This data is licensed by Microsoft under the Open Data Commons Open Database License (ODbL)." |
| OSM attribution (repo, CP sources.ts:1227) | not fetched | 2026-11-24 | "ODbL 1.0 — attribution required: © OpenStreetMap contributors" |
| Google Solar API (repo, CP sources.ts:723) | https://solar.googleapis.com/v1/buildingInsights | 2026-11-24 | "solar feasibility only", 30-day max cache (paraphrase in audit) |
| FEMA NRI (repo, CP sources.ts:392) | not fetched | 2026-11-24 | "meant for planning purposes only" |
| Nominatim policy | https://operations.osmfoundation.org/policies/nominatim/ | blocked | not verified |
| Overture licence | https://docs.overturemaps.org/attribution/ | blocked | not verified |
| Google Solar pricing | https://developers.google.com/maps/documentation/solar/usage-and-billing | blocked | not verified |
| NREL rate limits | https://developer.nrel.gov/docs/rate-limits/ | blocked | not verified |
| LA Assessor, Census geocoder, Regrid, Mapbox, HUD, GTFS, Inside Airbnb, AirDNA, LA STR page, ZIMAS | not attempted | n/a | not verified |

## Verified / Assumptions / Recommendations
**Verified**
- Microsoft US footprints are ODbL (fetched from the publisher's GitHub page).
- CP already wires Census geocoder, per-county ArcGIS parcel services, Overpass, PVWatts, Google Solar, HUD, FEMA, FHFA (grep of sources.ts and parcels.ts).
- CP and ES roof and solar constants are unsourced; ES VENUES figures are "typical figures", no sources (audit files).
- No driveway, yard, pool or event-demand code exists in the sibling repos (shared-infra audit).
- Parcel registry entries carry a `terms` URL only; this is not a licence grant (audit).

**Assumptions**
- Census geocoder and public ArcGIS parcel layers are free to call; storage rights are unknown.
- Nominatim bars bulk use and needs a low request rate; unconfirmed.
- OSM ODbL permits storing a derived profile with attribution; the share-alike effect is unconfirmed.
- PVWatts needs an own (free) key for production use.
- LA's home-sharing rules include registration, primary residence and a 120-day cap.

**Recommendations**
- Use now: Census/Nominatim geocode, parcel via the registry, OSM footprints and pools, PVWatts, OSM transit. Tag each as measured or estimated and carry the `Sourced<>` wrapper.
- Treat every market comparable except STR as owner-entered, with a visible low-confidence label.
- Paid STR data (AirDNA or similar) requires owner approval; so does any Regrid or Google Solar spend.
- Re-run this research once the blocked hosts are allowed, before relying on any storage or licence cell.
- Design: a per-market source registry (as CP does), so a non-LA market fails with `ok:false` and a reason, never a guess.

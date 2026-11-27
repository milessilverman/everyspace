# Zillow data for Everyspace: what is legitimately available (2026-11-27)

## Short answer
- **No** for self-serve use: Zillow has no public lot-size or footprint API. Property data is by application only.
- The one programme with parcel/assessor data is the Bridge Public Records API: invite only, commercial terms, price and storage rules not published (S3).
- **Building footprints: no footprint data offering found on the pages fetched.**
- Zillow's Terms of Use (S1) and Bridge docs could not be fetched (403 / JS app), so restrictions beyond "TOS" are **not verified**.

## What Zillow offers
| Programme | Data | Eligibility / access | Cost | Key restrictions | Verified? |
|---|---|---|---|---|---|
| Bridge Public Records API | "parcel, assessment and transactional county data" across the US, ~15 years | "currently invite only"; request via help button | not stated | Agreement "TOS, depending on use-case"; "really for commercial use cases by businesses" | Yes (S3); fields (lot size, beds, baths) not verified |
| Zestimate API | Property, rental, foreclosure Zestimates, ~100M properties | request access via help button | not stated | Agreement "TOS"; commercial use | Yes (S4); no home facts listed |
| Bridge Listing Output (MLS/RESO) | MLS listings, RESO-normalized | invite only; "at the discretion of our individual MLS partners" | not stated | MLS partner rules | Yes (S5); listings only, not owner profiles |
| Real Estate Metrics (research CSVs) | Aggregate values, rents, inventory by region | free download | free | "Proper and clear attribution... is required"; aggregate only, no per-property facts | Yes (S6) |
| Building footprints | none | n/a | n/a | n/a | no footprint data offering found on the pages fetched |
| Bridge docs (bridgedataoutput.com/docs) | field list, pricing, storage/display rules | n/a | n/a | n/a | Not verified: docs are a JS app; no readable text retrieved |

## What is not allowed
- Zillow Terms of Use (automation, scraping, data mining, competing products): **not verified — publisher blocked automated access** (HTTP 403 on www.zillow.com).
- The Zillow developer pages say the Public Records and Zestimate APIs are for businesses under TOS, and that only the research CSVs carry "a looser Terms of Use" (S3, S4).
- Storage, caching, display and derived-data rules for Bridge: **not verified**.
- Assumption (unverified): scraping zillow.com pages is prohibited by its Terms, as is typical. Do not do it until the Terms are read by a person.

## Where Zillow's numbers come from, and what Everyspace already has
- Zillow's statement of its property-facts sources: **not verified** (zillow.com blocked). The Public Records API is described as "county data" (S3), consistent with assessor records.
- Assumption: Zillow lot size and home facts largely derive from the same county assessor data Everyspace already reads, plus user and listing edits.
- Assumption: Zillow's value over the assessor is coverage in counties without a usable parcel service, and a single schema.

## Options for the owner
| Option | What it gives | What it needs | Recommendation |
|---|---|---|---|
| Use county assessor records directly (already built) | Lot size, home facts where the county publishes them | Per-county terms review | Keep as the primary source |
| Apply for Zillow/Bridge Public Records access | Nationwide parcel, assessment and transaction data via one API | Owner approval, their application (describe app, use), cost and TOS unknown | Only if counties outside LA prove thin; owner decides |
| Link out to Zillow | Owner clicks to the property's Zillow page | Terms on linking not verified | Low risk but confirm terms first |
| Scrape Zillow | Nothing legitimate | Not permitted: Terms unverified; developer pages direct data users to licensed APIs | Do not do |
| Building footprints from open sources | Footprints | Overture/OSM already in the app | Keep; Zillow offers none |

## Address autofill outside Los Angeles: Photon
| Finding | Quote | URL |
|---|---|---|
| Intended use | "search as you type with OpenStreetMap" | S7 |
| Usage policy | "please be fair - extensive usage will be throttled" | S7 |
| No guarantee | "We do not guarantee for the availability and usage might be subject of change" | S7 |
| Data/attribution | "Made with OpenStreetMap" (ODbL and attribution text not stated on page; assumption) | S7 |
| Location bias | page lists `lat` and `lon` ("priority to a geo position"), `limit`, `lang` | S7 |
| Country / bbox | Not listed on the page. A `bbox` query was accepted (HTTP 200) but its effect is not verified | S7 |
| Response shape | top level `type`, `features`; each feature `type`, `properties`, `geometry`; properties include `osm_type, osm_id, osm_key, osm_value, type, housenumber, name, street, locality, district, city, county, state, country, postcode, countrycode, extent` | live query, 200 N Spring St |

Recommendation: usable as a free, best-effort fallback for typeahead outside LA, with debouncing, caching, a visible OpenStreetMap credit, and a fallback if it fails. Do not rely on it for a production SLA; consider self-hosting Photon if usage grows.

## Sources
| ID | Source | URL | Retrieved | Quote |
|---|---|---|---|---|
| S1 | Zillow Terms of Use | https://www.zillow.com/z/corp/terms/ | 2026-11-27 | not verified — publisher blocked automated access (403) |
| S2 | Zillow Group developers | https://www.zillowgroup.com/developers/ | 2026-11-27 | "close to 20 APIs available" |
| S3 | Public Records API | https://www.zillowgroup.com/developers/api/public-data/public-records-api/ | 2026-11-27 | "The platform is currently invite only, so please contact us for access." |
| S4 | Zestimate API | https://www.zillowgroup.com/developers/api/zestimate/zestimates-api/ | 2026-11-27 | "This resource is really for commercial use cases by businesses." |
| S5 | MLS Listings | https://www.zillowgroup.com/developers/api/mls-broker-data/mls-listings/ | 2026-11-27 | "All data access is at the discretion of our individual MLS partners" |
| S6 | Real Estate Metrics | https://www.zillowgroup.com/developers/api/public-data/real-estate-metrics/ | 2026-11-27 | "Proper and clear attribution of all data to Zillow is required." |
| S7 | Photon | https://photon.komoot.io/ | 2026-11-27 | "You can use the API for your project, but please be fair" |
| S8 | Bridge docs | https://bridgedataoutput.com/docs/platform/ | 2026-11-27 | not verified — JS-rendered, no text; bridgeinteractive.com also 403 |

## Verified / Assumptions / Recommendations
**Verified**
- Bridge Public Records and Zestimate APIs are invite/request only, commercial, under TOS.
- No footprint offering on the developer pages fetched.
- Photon page: fair-use throttling, no guarantee, search-as-you-type purpose.
- Photon response field names (live query).

**Assumptions**
- Zillow home facts derive from county records.
- Scraping Zillow is barred by its Terms.
- Photon data is ODbL.

**Recommendations**
- Keep county assessor records as primary; do not scrape.
- Have the owner decide on applying to Bridge, after a person reads Zillow's Terms and the Bridge docs.
- Use Photon as best-effort autofill with an OSM credit.

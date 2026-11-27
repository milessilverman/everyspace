# Reuse from City Pretty (CP) and StreetForge (SF): roof, transit, floors

2026-11-27. CP = `/home/user/milessilverman/city-pretty`, SF = `/home/user/streetforge` (read-only). No data directories were read; no network was used. Everything below was re-checked against the code, not against `docs/audit/shared-infra.md`.

| capability | CP / SF file:lines | what it really does | how well-founded (their own words) | ported to | profile field |
|---|---|---|---|---|---|
| Roof surface | CP `src/engines/roofAreaEngine.js:30-120` | plan area (outline, or living area / stories) + garage + eaves, x sqrt(144+rise^2)/12, x shape factor | header :5-8: default pitches are "a rule of thumb by state and build era, with no source"; an 18 Nov edit credited NREL ResStock and IRC R905, "no report with that number was found", credit removed. Lines 14, 24: "(rule of thumb; no source)". Shape factors and the 18 in overhang: no comment at all | `core/roof.js` | `roof_sqft` (when no roof provider answers) |
| Default pitch | CP `roofAreaEngine.js:10-28` | rise per 12 by state and era | as above | `core/roof.js` `defaultPitchRise` | `roof_sqft`, `details.roof` |
| Transit radius and nearest stop | CP `src/engines/gtfsWalkshedEngine.js:6-58` | haversine straight line; 0.5 mile default; nearest heavy rail / light rail / frequent bus (needs `tripsPerHour >= 4`) | no comments on the 0.5 (docs tie it to California statutory proximity tests, `docs/GRAND-VISION-AND-ECOSYSTEM.md:99`). Header claims "network-distance" and "headways": the code has neither | `core/transit.js` | `transit_distance_m`, `transit_stops_nearby`, `rail_station_nearby` |
| Non-transit rail stations | CP `pipeline/osm_extract.py:22-37`; rule quoted at `docs/ERRATA-round8.4.md:201` | drops tourist, heritage, miniature, zoo, museum-run, private stations; trams are "street stops" | written from real mis-hits (Balboa Park, Grapevine, Fairview streetcar) | `core/transit.js` `isTransitStation` | same |
| Floors from levels / height | SF `streetforge2d.html:13730, 14177, 14384` | `building:levels`, else `round(height_m / 3.4)`, clamp 1..60 | 3.4 m has no comment or source (a drawing default). CP `workers/sources.ts:1167-1170` says levels->height "is an estimate" and does not convert | `core/building-size.js` | `floors` |
| Lot size | CP `workers/parcels.ts`, SF `lotFrom` `:1322,13391,13409` | reads a parcel-service value or the polygon area | nothing beyond what `core/geometry.js polygonAreaSqft` already does | not ported | none |

## Constants brought over (all from CP unless stated)
- Pitch rise per 12 (`roofAreaEngine.js:14-27`): AZ/NV/NM 3.5; MN WI MI NY MA VT NH ME WA OR 7.0, or 8.0 if built before 1940; else before 1940 7.5; 1945-1978 4.5; else 5.5. Unknown year gives 5.5. State defaults to CA (:11). All "rule of thumb; no source".
- Pitch clamp 0.5..18 (:104). Slope factor sqrt(144+rise^2)/12, 4 decimals (:109). Roof "flat" when rise <= 2 (:112).
- Shape factors flat 1.01, gable 1.05, hip 1.08, complex 1.16 (:113-116). No source.
- Outline must exceed 200 sq ft (:40); living area floor 200 (:34). Traced outline: no garage, no eaves (:75, :86, :91).
- Not an outline: garage 380 (400 if over one storey) (:86); eaves 18 in on a 1:1.4 rectangle (:91, :95-98).
- Transit: walk radius 0.5 mile = 804.672 m (`gtfsWalkshedEngine.js:6`); the nearest-stop search stays at Everyspace's existing 1,500 m. Station exclusion regexes copied from `osm_extract.py:24-29`.
- SF: 3.4 m per storey (:14384), 60 floors max, feet/metre 3.28084 (:13730). The 1..4 clamp and 4.5 ratio limit are Everyspace's own, moved unchanged from `property-profile.js`.

## Everyspace results
- Roof: 1,400 sq ft outline, built 1952 -> 4.5:12 -> 1400 x 1.068 x 1.05 = 1,570 sq ft. Confidence 0.25 with the default pitch (0.5 owner pitch, 0.55 owner pitch and roof type). The note says plainly it is a typical pitch, not this roof's. Owner input: `query.roofPitchRise`, `query.roofType`.
- Condo / multi-family: roof unavailable (Everyspace guard; CP has none).
- Owner "flat" with no pitch uses rise 0.5 (CP would keep the era pitch with a flat factor; inconsistent).
- Floors order: records provider, then `levels` on a footprint building (no provider emits it yet), then ratio. LARIAC height is NOT used: its unit is unverified, so it stays a note.
- Transit is opt-in so a profile makes no hidden call: pass `ctx.osm` (an `overpassNear` answer) or `ctx.transit: true` (one `overpassNear` call, reported as provider `overpass-transit`). Otherwise the three fields are unavailable with "not looked up".

## Not ported, and why
- Frequent-bus test and buses per hour: OSM has no timetable. Reported as `frequencyKnown: false`; a stop is never called frequent.
- CP solar outputs (panels, kW, usable share 64%/88%, 18% setback): CP itself says these are assumptions (`parcelHouseAuditor.js:190`); yield and cost are null there.
- CP county bundles (`counties/bundle_<fips>.json.gz`, 1,385 files; transit layers built by `pipeline/` from GTFS and OSM, per-feed metas): not imported and not opened. The app reads precomputed `dist_to_heavy_rail_mi` / `dist_to_frequent_bus_or_brt_mi` per block group from them, not live queries. CP's own audit says the GTFS layers have no licence statement (see `shared-infra.md`). Coverage and licence of the LA bundle were not checked.
- Statutory zoning, valuation: out of scope for owner earnings.

## Where CP's docs claim more than its code
- `gtfsWalkshedEngine.js:2-3` promises network walksheds and headways; the code is straight-line only. `evaluateTransitWalkshed` has no caller (`app/app.js:1028` is a copy). `shared-infra.md` said it "is partial"; it is effectively unused.
- `shared-infra.md` said roof has "no roof-specific test": true for numeric results; two checks exist (`tests/unit/safetyRules.test.ts:17`, `tests/e2e/site.spec.ts:1907`) and are reproduced in `core/tests/roof.test.mjs`.
- The old NREL/IRC pitch credit was removed by CP itself on 18 Nov.

## Changed existing expectation
`core/tests/property-profile.test.mjs:65`: `roof_sqft` 1400 -> 1570 and its method text (plan area only -> City Pretty method). Nothing else changed.

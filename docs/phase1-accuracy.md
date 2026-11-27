# Phase 1 accuracy check (keyless providers, Los Angeles)

Run 2026-11-27T06:58:31.114Z by `node scripts/phase1-accuracy.mjs`; 40 live requests (public.gis.lacounty.gov 30, geocoding.geo.census.gov 10). Raw numbers: this file only; no owner names or values recorded.

## How the addresses were chosen

Rule fixed before looking at results: ZIP list in a set order (90003, 90049, 91344, 90032, 90731, 90019, 91605, 90066, 90041, 91356, 90016, 90065, 90061, 91402); for each ZIP, the first parcels by OBJECTID with `UseCode_2='01' AND UseType='Residential'` (single-family use codes), `SQFTmain1>0`, `SitusCity LIKE 'LOS ANGELES%'`, a complete situs (house number and street), taking up to the first 4 and keeping the first with exactly ONE LARIAC building record on the parcel (after the provider's own filtering). A ZIP with no qualifying parcel is skipped; the first 10 ZIPs that qualify are used. Bias: parcels with a detached garage or second building are under-represented. The run takes only the 10 addresses as input.

1. 5847 S FIGUEROA ST LOS ANGELES CA 90003
2. 15739 MULHOLLAND PL LOS ANGELES CA 90049
3. 13300 MISSION TIERRA WAY LOS ANGELES CA 91344
4. 3207 AMETHYST ST LOS ANGELES CA 90032
5. 2106 BARRYWOOD AVE LOS ANGELES CA 90731
6. 1829 S COCHRAN AVE LOS ANGELES CA 90019
7. 7723 VARNA AVE LOS ANGELES CA 91605
8. 5313 S CENTINELA AVE LOS ANGELES CA 90066
9. 2705 W LYTELLE PL LOS ANGELES CA 90041
10. 5741 CORBIN AVE LOS ANGELES CA 91356

## Important: what is and is not measured

With no RentCast key, `house_sqft`, `beds`, `baths`, `year_built`, `property_type` and `apn` come FROM the assessor. Their agreement with the assessor is true by construction and is NOT an accuracy measurement. The checks that mean something now are the geocoder, parcel identity, polygon vs stored area, footprint checks and the yard invariant. No ground truth exists in this run for living area, beds, baths or year.

## Per-field comparison with the assessor

| field | profile source | confidence | RentCast | Google Solar | n | median abs diff | max abs diff |
|---|---|---|---|---|---|---|---|
| lot_sqft (polygon vs assessor stored area, independent, %) | LA County Assessor (via LA County GIS) | 0.85 | not run: API key needed | n/a | 10 | 0.03 | 0.04 |
| house_sqft (%) vs SQFTmain1 | LA County Assessor (via LA County GIS) | 0.8 | not run: API key needed | n/a | 10 | 0.00 | 0.00 (by construction) |
| beds (%) | LA County Assessor (via LA County GIS) | 0.8 | not run: API key needed | n/a | 10 | 0.00 | 0.00 (by construction) |
| baths (%) | LA County Assessor (via LA County GIS) | 0.8 | not run: API key needed | n/a | 10 | 0.00 | 0.00 (by construction) |
| year_built (years) | LA County Assessor (via LA County GIS) | 0.8 | not run: API key needed | n/a | 10 | 0.00 | 0.00 (by construction) |
| roof_sqft | footprint plan area (estimated) | 0.3 | n/a | not run: API key needed | - | - | - |

Rows with an assessor value: house 10, beds 10, baths 10, year 10 of 10. Rows with extra improvement records (SQFTmain2..5 > 0, summed in the profile): 0.

## Independent checks

- County locator: 9/10 match, 0 different street/number, 1 failed. Census geocoder: 9/10 match, 1 different street/number, 0 failed ("different" = house number, direction or street differs from the input).
- Matched parcel situs equals the input address: 10/10.
- Polygon area vs stored Shape.STArea: n 10, median 0.03%, max 0.04%.
- Parcels with a building outline: 10/10. Computed footprint vs the layer's own AREA: n 10, median 0.00%, max 0.00%.
- Living area / footprint (plausible 0.5-4.5): n 10, median 0.83, max 1.45; outside range: 0. Estimated floors (not checkable here): 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.
- Yard: split produced for 10/10; front+back+side = open area (within 2 sq ft rounding) for 10/10; results with warnings: 10. The front edge comes from the Census street-side point, so it is only as good as that point.

## Per address

| # | locator/Census | situs = input | poly vs stored % | footprint sq ft | living sq ft | ratio | open / f+b+s | yard warnings |
|---|---|---|---|---|---|---|---|---|
| 1 | match/match | yes | 0.04 | 2164 | 1362 | 0.63 | 3238 / 3238 | 1 |
| 2 | match/match | yes | 0.01 | 3029 | 1934 | 0.64 | 5408 / 5408 | 2 |
| 3 | match/match | yes | 0.03 | 2870 | 2493 | 0.87 | 8729 / 8729 | 2 |
| 4 | match/match | yes | 0.03 | 1719 | 1346 | 0.78 | 5783 / 5783 | 2 |
| 5 | match/match | yes | 0.02 | 1944 | 1934 | 0.99 | 6379 / 6379 | 1 |
| 6 | match/match | yes | 0.04 | 1654 | 1439 | 0.87 | 3425 / 3426 | 1 |
| 7 | match/match | yes | 0.03 | 2515 | 2599 | 1.03 | 19957 / 19956 | 1 |
| 8 | match/match | yes | 0.04 | 1688 | 1083 | 0.64 | 3312 / 3313 | 1 |
| 9 | fail/mismatch | yes | 0.01 | 1149 | 1662 | 1.45 | 6716 / 6716 | 3 |
| 10 | match/match | yes | 0.03 | 3739 | 2655 | 0.71 | 13181 / 13181 | 2 |

## Failures and warnings

- #1 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence
- #2 warning: yard: the front point is 25.1 m from the nearest parcel edge (more than 16 m); front chosen with lower confidence
- #2 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence
- #3 warning: yard: flag lot or irregular front: the front line is 17% of the lot width (under 35%); front and back yards follow depth from that short line
- #3 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence
- #4 warning: yard: front point lies inside the parcel; the parcel edge nearest to it was used as the front
- #4 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence
- #5 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence
- #6 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence
- #7 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence
- #8 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence
- #9 la-cams-address: no address match
- #9 warning: geocoder matched a different address (direction W missing in match): "2705 LYTELLE PL, LOS ANGELES, CA, 90065"
- #9 warning: yard: the front point is 16.5 m from the nearest parcel edge (more than 16 m); front chosen with lower confidence
- #9 warning: yard: flag lot or irregular front: the front line is 9% of the lot width (under 35%); front and back yards follow depth from that short line
- #9 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence
- #10 warning: yard: the front point is 35.8 m from the nearest parcel edge (more than 16 m); front chosen with lower confidence
- #10 warning: yard: no street centreline: the front was chosen from a geocoded front point, with lower confidence

Not run (no key): RentCast records and Google Solar roof area. Their columns above are empty by design; the roof and floors values are footprint-based estimates.

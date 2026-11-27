# Yards from street lines, an estimated lot and aerial photos: what was measured (2026-11-27)

Run: `NODE_USE_ENV_PROXY=1 node scripts/yard-accuracy.mjs --cache <dir>` (the ten LA addresses of `docs/phase1-accuracy.md`; answers cached, so re-runs are free). Live requests for all of this work: 88 in total (LA County GIS 30, Overture tiles and catalog 34, Planetary Computer 22 incl. probes, USGS 2), all to the six allowed hosts. No images are stored in the repository. Street-side point = the **LA County locator** point (the Census geocoder was not an allowed host, so this differs from phase 1).

## Stage 1: street centrelines nationwide (ON)
Method: `core/providers/overture-roads.js` reads Overture's `transportation.pmtiles` (same release catalog and range reader as the buildings provider; checked live: 206 + `access-control-allow-origin: *`). StreetForge's road filters ported (streetforge2d.html 13718-13727, 13824-13831, 13541, 13974): no footpaths, sidewalks, steps, tracks, motorways, links, driveways, parking aisles; service roads only as flagged alleys or when named. `core/street-ref.js` matches the address street ("S COCHRAN AVE" = "South Cochran Avenue"); alleys are passed only alongside a matched street. The builder now uses centrelines first and the locator point only as fallback.
One rule was added to `core/yard.js` after looking at #8 (a corner lot where the centreline bends round a junction): with centrelines, the front is the edge that FACES the street (rays cast outward, square to the edge, must meet it), not merely the nearest edge. This is tuning seen on these addresses; it changed #8 (now agrees with the point) and #9 (a cul-de-sac arc: both answers are short, flagged arcs). All 60 earlier yard tests unchanged.

| # | ref | same front | front pt / line | back pt / line | conf pt / line |
|---|---|---|---|---|---|
| 1 | named | yes | 690 / 690 | 1860 / 1860 | 0.35 / 0.6 |
| 2 | named | yes | 424 / 388 | 718 / 666 | 0.12 / 0.29 |
| 3 | named | yes | 1097 / 1239 | 5849 / 5938 | 0.17 / 0.51 |
| 4 | named | yes | 823 / 823 | 3630 / 3630 | 0.28 / 0.51 |
| 5 | named | yes | 1143 / 1143 | 4576 / 4576 | 0.35 / 0.6 |
| 6 | named | yes | 862 / 862 | 1796 / 1796 | 0.35 / 0.6 |
| 7 | named | n/a | point 93 m away: fail / 8232 | fail / 8501 | - / 0.6 |
| 8 | named | yes | 920 / 920 | 1547 / 1547 | 0.35 / 0.51 |
| 9 | nearest ("LYTELLE" vs Overture "Lytle") | n/a | locator no match / 144 | - / 2768 | - / 0.25 |
| 10 | named | yes | 3161 / 3165 | 7515 / 7524 | 0.25 / 0.51 |

Split produced: centrelines 10/10 (address street matched 9/10), locator point 8/10. Same front side (inward bearing within 20°) 8/8; |front difference| median 0, max 142 sq ft; |back| median 0, max 89. Looking at the drawings: where they differ the centreline is better (#3: the point picked a 17%-wide corner piece of the frontage, the line picked the whole frontage; #2 hillside arc: both weak). Centreline is more trustworthy: it works without a locator, names the street and sees corner lots and rear alleys; it fails on cul-de-sac bulbs (Overture draws no bulb) and spelling differences. Cost: 1-4 requests, 49-467 KB per property (a z14 tile; a downtown tile is ~0.8 MB).

## Stage 2: estimated lot without a parcel record (OFF by default)
Method: `core/lot-estimate.js`, StreetForge's "estimate" lots (streetforge2d.html 13345-13409): Voronoi split of building centres with distances along the street stretched 3x so lot lines run square to it, garage rule (under 450 sq ft near a bigger building), plus a simplification (no drafted block): the street edge = centreline offset by an ASSUMED half right-of-way by road class (30 ft residential, 9 ft alley), cut 25 m from the house where nothing bounds it. Measured with Overture buildings + Overture roads against the assessor parcel:

| # | estimated | parcel | error % | IoU | front est/true | back est/true |
|---|---|---|---|---|---|---|
| 1 | 5281 | 5402 | -2.2 | 0.76 | 653/690 | 1769/1860 |
| 2 | 31515 | 8437 | +273.5 | 0.24 | 16188/388 | 9382/666 |
| 3 | 11071 | 11598 | -4.5 | 0.82 | 1209/1239 | 5372/5938 |
| 4 | 6312 | 7502 | -15.9 | 0.52 | 0/823 | 3355/3630 |
| 5 | 8147 | 8323 | -2.1 | 0.89 | 1402/1143 | 4143/4576 |
| 6 | 4505 | 5079 | -11.3 | 0.75 | 647/862 | 1351/1796 |
| 7 | 17641 | 22472 | -21.5 | 0.74 | 5653/8232 | 7336/8501 |
| 8 | 5337 | 5001 | +6.7 | 0.80 | 911/920 | 1683/1547 |
| 9 | 6235 | 7865 | -20.7 | 0.38 | 0/144 | 4099/2768 |
| 10 | 13604 | 16920 | -19.6 | 0.72 | 2936/3165 | 4437/7524 |

|Error| median 13.6%, max 273.5%; IoU median 0.75, min 0.24. DECISION RULE (median <= 20% AND max <= 50%): NOT MET (hillside #2: no neighbours, street 32 m away). Nothing was tuned. The code and tests stay; the builder estimates a lot only with `estimateLotWithoutParcel: true` (then tagged `estimated`, confidence 0.15, method "estimated from neighbouring buildings and the street; no parcel record").

## Stage 3: reading the yard from the aerial photo (partly on)
Method: `core/providers/naip-aerial.js` = StreetForge's NAIP path (streetforge2d.html 12980-13005: Planetary Computer STAC + data API, USGS `USGSNAIPPlus` fallback) but asking `.npy` of bands 1-4 + mask in WGS84 (raw bytes, no canvas, NIR available). 2 requests, median 55 KB per property; newest flight 2024-05. CORS: `access-control-allow-origin: *` on STAC, data API and USGS (checked with both site origins). `core/aerial.js`: NDVI >= 0.2 = vegetation (textbook cut, not tuned), StreetForge's canopy rule (tone < 0.88, 12902-12904) for tree vs lawn, water = NIR below 0.75x blue and green, dark = shadow, the rest paved or bare. Zones use `yardZoneAt` (the same depth bands as `core/yard.js`).

| # | open ground: geometry / pixels | green | paved or bare | water regions (sq ft) | roof pixels read as vegetation | front band mostly paved |
|---|---|---|---|---|---|---|
| 1 | 3238 / 3383 | 575 | 2758 | 31, 8, 12 | 0.7% | yes |
| 2 | 5408 / 5415 | 2494 | 2399 | 381 and 122 "pool-shaped" | 2.1% | no |
| 3 | 8729 / 8732 | 2927 | 5805 | - | 0% | yes |
| 4 | 5783 / 5783 | 4610 | 1173 | - | 35% | no |
| 5 | 6379 / 6378 | 737 | 5303 | 338 pool-shaped | 0% | no |
| 6 | 3425 / 3412 | 1420 | 1992 | - | 3.5% | no |
| 7 | 19957 / 19970 | 12637 | 7333 | - | 7% | no |
| 8 | 3312 / 3297 | 2118 | 1179 | - | 9.3% | no |
| 9 | 6716 / 6717 | 3164 | 3554 | - | 52% | yes |
| 10 | 13181 / 13323 | 9036 | 4279 | 8 | 0.3% | no |

Georeferencing: open ground from geometry and from pixels agree within 0.5% on 8 of 10 (#1 +4.5%, #10 +1.1%). Roof pixels read as vegetation (a misregistration or overhang check): high on #4 (35%) and #9 (52%): trees over the roof or outline offset. No ground truth exists for green/paved: NOT validated. Pools, looked at in the images: #5 a real pool, outline and size look right; #2 the larger "pool" is a light-blue neighbouring roof/structure inside the parcel line (false positive); #10 has a visible pool inside the LARIAC outline, so it was never looked at (missed). So **pool reading is OFF by default** (`aerialPools: true` enables it) and "no pool" is never reported.
Seen in the images: tree canopy and lawn are NOT told apart (the canopy rule put 97-100% of vegetation under canopy at NAIP brightness), so `tree_cover_sqft` stays unavailable; brown/dry lawn reads as bare; trees over a driveway read as green; shed roofs not in the outline read as paved; deep shadow was rare in these May flights (0 sq ft) but is excluded when present. ON by default: `green_area_sqft`, `paved_area_sqft` (estimated, confidence <= 0.35, photo date in the source, per-zone split in the note), the front-band paving check (lowers yard confidence x0.8; text only in `details`).

## Stage 4: remodeled year (ON) and wiring
`la-assessor` returns `remodeled_year` = `EffectiveYear` of the main improvement when it is later than the year built (estimated, method "assessor's effective year (updated after major remodels)"). Checked on the live assessor answers of this run: 5 of 10 have one (1914->1960, 1965->1980, 1937->1951, 1925->1965, 1948->1960). All new providers are in `providers[]`; roads and the photo run in parallel with records and footprints (test: four 300 ms groups finish in ~300 ms); a failed photo or road lookup only leaves its facts empty.

## Owner additions
- Side yard: still computed (it is part of the yard total) but `fields.side_yard_sqft.hidden = true` and left out of `toSourcedProfile`.
- Usable yard (`core/usable-yard.js`): open ground at least 10 ft wide (an Everyspace modelling assumption, `minWidthFt`), 0.25 m grid, morphological opening; pool excluded when given. On the ten lots: usable is 82-100% of the open ground (table printed by the script); test lot 50x100 ft: front 989, back 1,989 (the 10 ft disc cannot reach 5.4 sq ft per lot corner), the 15 ft side strip counts and the 5 ft strip does not. With the photo, `details.usable_yard.photo` gives the green/paved shares (nothing subtracted).
- `result.geometry` and `core/measure.js` `measureFromGeometry` (same functions as the builder; a test proves identical numbers).

## Limits and what would make it better
Image recognition today gives an owner: how much of the open ground is green vs paved/bare, at 60 cm, from a 2024 photo, unvalidated. It does not give: trees vs lawn, pools reliably, fences, slope, sheds missing from outlines. Better: sharper licensed imagery (<= 15 cm county orthophotos or a paid source) or a vision model on the lot crop; both need the owner's approval (licence and per-lookup cost).

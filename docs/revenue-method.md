# Revenue method: estimation, validation, communication

Code: `core/revenue.js`, `core/optimizer.js`, `core/opportunities.js`, `core/regulatory.js`, data in `core/data/`. All deterministic pure functions with unit tests; no LLM computes a number.

## 1. What is estimated
One estimate per opportunity (a category on a specific property), then one optimized combination per owner goal. Existing assets (`basis` existing/setup) and investments (`permit`/`construction`) are reported separately.

## 2. Inputs (each is a `Sourced` value: value, tag, source, date, confidence)
| input | default source today | tag / confidence | owner can override |
|---|---|---|---|
| price per unit | `TYPICAL` table already in `index.html:5298` (no citation) | estimated / 0.2 | yes -> owner-confirmed / 0.9 |
| units sold per month | occupancy assumptions already in `index.html:17744-17790` (no citation) | estimated / 0.15 | yes |
| capacity units per month | arithmetic from the unit (30.4 nights; owner-set hours x days) | measured for nights/months; estimated for hourly | yes |
| bookings per month | units / typical booking length (assumption) | estimated / 0.15 | yes |
| platform fee | `PLATFORMS` table in `index.html:5978` (`verified:false`) | estimated / 0.3 | yes |
| cleaning, utilities, insurance | none | unavailable | yes |
| occupancy tax rate, permit cost | `core/data/jurisdictions.js` (unverified until official pages are fetched) | estimated / 0.2, or unavailable | yes |
| upfront cost | none | unavailable (0 only for `existing` basis with a note) | yes |
| seasonality | flat 1.0 x 12 (no data) | estimated / 0.1 | yes |

No comparable market data source is licensed or verified yet (`docs/data-availability.md`). Until one is, every default is labelled "Everyspace planning default (uncited)" and overall confidence cannot exceed **low**.

## 3. Formulas (monthly m = 1..12, s = seasonality multiplier)
| quantity | formula |
|---|---|
| units_m | `min(capacity, unitsPerMonth x volumeFactor x s_m)` |
| gross_m | `round(priceCents x priceFactor x units_m)` |
| platform fee_m | `round(gross_m x platformFeeRate)` |
| cleaning_m | `round(cleaningCentsPerBooking x bookingsPerMonth x units_m / unitsPerMonth)` |
| tax + permit_m | `round(gross_m x taxRate) + round(permitCentsPerYear / 12)` |
| NOI_m | `gross_m - fee_m - cleaning_m - utilities - insurance - tax_permit_m` |
| per-year figures | sum of the 12 months; "per month" = year / 12 rounded |
| occupancy | `sum(units_m) / (12 x capacity)` |
| ROI | `NOI_year / upfront` (null if upfront = 0) |
| payback months | `upfront / (NOI_year / 12)`, 1 decimal (null if NOI <= 0 or upfront = 0) |

## 4. Scenarios (`core/data/scenarios.js`; modelling assumptions, not market data)
| spread set | when used | conservative (price, volume) | baseline | optimistic |
|---|---|---|---|---|
| uncalibrated | price or volume is a planning default | 0.85, 0.60 | 1, 1 | 1.10, 1.30 |
| owner-history | price and volume are both owner-confirmed | 0.95, 0.85 | 1, 1 | 1.05, 1.15 |

## 5. Missing data
| case | behaviour |
|---|---|
| price or volume unavailable | estimate is `available: false`, no number shown, the input is listed under `missing` |
| a cost input unavailable | excluded from the math, listed as "not included", confidence capped at 0.3 |
| regulatory status unknown or rule unverified | shown as "check local rules"; not selected by the optimizer unless the owner allows it; confidence capped at 0.3 |

## 6. Confidence
`confidence = min(price, volume, evidence, feasibility)`, then the caps above. Labels: low < 0.4 <= medium < 0.75 <= high.

## 7. Optimization (most profitable feasible combination, not a sum)
Exhaustive search over subsets (max 20 opportunities). A subset is feasible when: no pair is in `conflictsWith`; summed `resourceUse` fits `resourceCapacity`; every member passes the owner constraints (upfront cap, effort, privacy, no strangers in home, excluded categories, regulatory status). Ties break on higher confidence, then fewer opportunities, then ids alphabetically.
| goal | objective |
|---|---|
| max_net_income | highest NOI per year |
| min_upfront | highest first-year net cash (`NOI_year - upfront`) |
| min_effort | only opportunities with effort <= 2 (or `maxEffort`), then highest NOI |
| privacy | only privacy impact <= 1 and no strangers in the home, then highest NOI |
| fastest_payback | lowest combined payback months, then highest NOI |
The result always reports `naiveSumNoiCentsPerYear` next to the optimized total so the owner sees why they differ.

## 8. Communication rules (estimator UI)
Show three scenarios side by side; show every input with its source tag and an edit control; show what is not included; show confidence in words; never show a single headline number without its range; never say "you will earn".

## 9. Validation plan (Phase 4, not built)
Compare projections with actual `revenue_entries` per space after 3, 6, 12 months from consenting hosts; report median absolute percentage error per category and whether actuals fell inside the conservative-optimistic band; recalibrate defaults only from authorised, aggregated host data (minimum cohort size before any aggregate is used).

**Verified:** the default tables exist in the repo and are uncited (`docs/audit/integrations-booking.md`). **Assumptions:** scenario spreads, effort and privacy scores. **Recommendation:** license one market-data source per category only after owner approval (`docs/costs.md`).

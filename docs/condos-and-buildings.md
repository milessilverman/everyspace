# Condos and apartment buildings

Added 2026-11-27 (core: `core/parcel.js`, `core/providers/la-assessor.js`, `core/property-profile.js`, `core/opportunities.js`, `core/regulatory.js`, `core/revenue.js`, `core/optimizer.js`). Tests: `core/tests/condo-building.test.mjs` (synthetic fixtures only).

## What the LA County records look like (25 public queries on 2026-11-27; shapes and counts only, no addresses)
- Residential use groups are the first two characters of `UseCode`: 01 "Single", 02 "Two Units", 03 "Three Units (Any Combination)", 04 "Four Units (Any Combination)", 05 "Five or more apartments", 07 mobile homes, 08 rooming houses, 09 mobile home parks.
- **Condominium units are one record each**, with the unit in `SitusUnit` (padded text: `UNIT   1`, `NO   101`, `NO 18`, `A`, `57`; 114,401 "NO ", 49,681 "UNIT", 12,085 "APT", 3,080 "#", 57 "STE" among "Single" records) and the SAME lot polygon and `Shape.STArea()` on every unit of a complex. Each carries its own `SQFTmain1`, `Bedrooms1`, `Bathrooms1`, `YearBuilt1`, `Units1: 1`.
- **Use code, 4th character.** Seen in the data: `010C` (234,977 records; 187,313 have a unit; 140,455 have a legal description naming a condominium) and `012C`, `01HC` are unit-numbered records on a shared lot. NOT confirmed, so not read as condo from the code alone: `010E` (51,355; 49,560 have a unit; 25,632 name a condominium; the rest include co-ops and typos such as "COND O"), `010D` (65,019; the three records sampled were unit-numbered on their own small lots, no condominium in the legal text), `010H` (1,975; the records sampled were "APTS OYO" apartments on a shared lot), `010G` (3,995; not sampled). `010V` is mostly vacant land (only 869 of 89,184 have a building area; those are unit-numbered airspace condos). A `C` on the two-to-five-unit codes (`020C`, `050C`, `055C`) is mixed (some whole buildings, some condos) and is not read as condo.
- **Multi-unit buildings** use `Units1..5`, `Bedrooms1..5`, `SQFTmain1..5`: "Five or more apartments" has one slot with the count (Units1 20, 30, 59; Bedrooms1 can be 0 = not recorded); "Two Units" is `[1,1]` or `[2]`; "Three Units" can be `[1,1,0]` (sums to 2 although the use says 3). `units` is the sum of the slots; a mismatch with the use description is noted.

## Decision table: several records at one house number and street (`la-assessor`)
| records | typed unit | `ownsWholeBuilding` | result |
|---|---|---|---|
| 1 | any | any | that record (a condo record is a condo unit; `unit_label` from the record) |
| 2+ reading as condo units | matches exactly one | no | that unit's record |
| 2+ condo units | none, no match, or matches several | no | `{ok:false, code:'needs_unit', needsUnit:true, units:[{unit,label}], complex:{address, unitCount}}` (units in natural order, max 400, then `unitsTruncated`); the builder returns this early after the locator and ONE county query |
| 2+ condo units | any | yes | the whole building: `multi_family`, `units` = unit records, living area/beds/baths = SUMS of the unit records (stated), the shared lot |
| 2+ not condo (lot split, own lots) | any | any | `multiple_matches` with candidates, as before |
A unit record is "condo" by `condoBasis` (`core/parcel.js`): code `01..C`, or a legal description naming a condominium plus a unit number.

## What each owner gets
- **House** (`single_family`): unchanged.
- **Condo** (`condo`, from the record or `ownerPropertyType`): the unit's `living_area_sqft`, `bedrooms`, `bathrooms`, `year_built`, `remodeled_year`, `unit_label`, `apn`. Context, never the owner's: `complex_unit_count`, `complex_lot_area_sqft` (measured; "shared by all owners in the building"). Unavailable with reason `shared with the building`: lot, yards (front/back/side/usable), driveway, roof, footprint, garage, ADU, green/paved/tree/pool, floors. No aerial, street-line or yard work is done. `geometry.shared: true` (shared lot, building outlines, no zones or driveway). Options: whole unit, private room; a parking space only with `assigned_parking_spaces` >= 1; storage only with `storage_unit_present`. `hoa_allows_rentals` `no`: guest and renter uses are `prohibited` ("Your HOA does not allow this (you told us)"); `unsure` or unanswered: requirement "Check your HOA's rental rules" (an Everyspace checklist item, `verified:false`); `yes`: nothing.
- **Building** (`multi_family`): everything a house gets, `units`, building totals, `roof_area_sqft` only when the owner gives a roof type (flat, gable, hip; flat = flat factor, no pitch; otherwise unavailable "tell us the roof type"). Options: `apartment_unit` with quantity = `units_available_to_rent` (unanswered: listed as needing it, never totalled), parking with quantity = owner-confirmed `parking_spaces`, roof options only with `roof_access_present` or an owner-typed roof.

## Query options and keys
- Query: `unit` (also read from the typed address), `ownsWholeBuilding`, `ownerPropertyType` (`single_family|condo|multi_family|land`, owner-confirmed). Result: `ownership {kind: house|unit|building|land|commercial|unknown, property_type, units, unit_label, complex_unit_count, shared_lot, source, basis}`, always equal to the `property_type` field (`null` = `unknown`).
- Attributes: `unit_label`, `complex_unit_count`, `complex_lot_area_sqft` (flat result: `complex_lot_sqft`), owner-supplied `assigned_parking_spaces`, `storage_unit_present`, `balcony_present`, `hoa_allows_rentals` (`CONDO_OWNER_KEYS`), `units_available_to_rent`, `parking_spaces`, `laundry_room_present`, `roof_access_present` (`BUILDING_OWNER_KEYS`). `balcony_present` and `laundry_room_present` are recorded but no earning option uses them yet.
- Money: `Opportunity.quantity` (>= 1); estimates carry `quantity`, `perUnit` and the totals (`docs/revenue-method.md`, "Several identical units").

## Not known
- The meaning of use-code characters other than the confirmed `C`; whether `010E` records without "CONDOMINIUM" in the legal text are condos (co-ops exist among them). Such condos read as houses unless the owner says `condo`.
- Coverage outside LA County: records rarely state a use, so `property_type` stays unknown until the owner says; no unit list exists there. The unit count of a complex is the number of records at the typed street number (a complex may have several numbers).
- Whether the county's shared lot polygon is the owner's share of anything (it is not; no ownership share is published).
- A lookup for an LA address now waits for the county record before the photo, street-line and outline requests start (one county round trip).

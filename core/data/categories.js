// @ts-check
// Category data for opportunity identification. Pure data, no logic.
//
// Provenance of each field:
//  - key, label, group, terms, measure: copied from index.html CATEGORIES (lines 5151-5251); `sourceRef` names the line.
//  - unit: mapped from the index.html `terms` to the contract's DurationUnit, taking the SHORTEST natural unit:
//      hourly->hour, daily->day (night for group 'living'), weekly->week, monthly->month,
//      lease->month, infrastructure->month (flat monthly lease/rent). Empty terms (container) -> month.
//  - effort (1-5), privacyImpact (0-3), strangersInHome, basisDefault, basisOverrides, conflictsWith, resourceUse:
//      EVERYSPACE MODELLING ASSUMPTIONS, not facts about any market or rule. Effort/privacy are set per group
//      (living 4/3, outdoor 3/2, parking 1/1, storage 1/1, land 2/1, energy 1/0, commercial 1/1, gear 3/1)
//      with three overrides (adu privacy 2 and not in the home itself, kitchen privacy 3 with strangers in the home,
//      signage privacy 0). 'basisDefault' follows the checklists (permit/registration -> permit; installer-built -> construction).
//  - requires: declarative rule over profile attributes (see core/opportunities.js evaluateRule).
//      Operators: {attr} presence (non-null; numbers must be > 0), {attr, equals}, {attr, in}, {attr, notIn},
//      {attr, min}, {attr, includes}, {all:[...]}, {any:[...]}, {never:true}.
//      Property-type gating is ported from index.html: HOME_ONLY / BUSINESS_ONLY (lines 5317-5318) and PROP_HAVE for
//      land and condo (lines 17656-17664). Assumption: the profile's property_type 'commercial' stands for the
//      index.html business/other owner types. No numeric threshold exists in the index.html quiz logic for any
//      category (the only candidate, SOLAR.minKw at index.html:8806, is a kW size and is NOT converted to sqft),
//      so every area/count requirement is presence-only (> 0).
//  - attributes outside the AttributeKey list in core/types.js (not in the list): attic_present,
//      basement_present, shed_present, waterfront_access, equipment_owned. They are asked via missingEvidence
//      until the owner supplies them.
//
// Conflicts are stored symmetrically here, and opportunities.js symmetrises again so a data entry added one-sided still works.

/**
 * @typedef {{attr:string, equals?:any, in?:any[], notIn?:any[], min?:number, includes?:any}
 *   | {all:Rule[]} | {any:Rule[]} | {never:true}} Rule
 * @typedef {Object} CategoryDef
 * @property {string} key
 * @property {string} label
 * @property {string} group
 * @property {import('../types.js').DurationUnit} unit
 * @property {number} effort
 * @property {number} privacyImpact
 * @property {boolean} strangersInHome
 * @property {import('../types.js').OpportunityBasis} basisDefault
 * @property {Array<{when:Rule, basis:import('../types.js').OpportunityBasis}>} [basisOverrides]
 * @property {Rule} requires
 * @property {string[]} conflictsWith
 * @property {Record<string, number>} resourceUse
 * @property {string[]} [terms]    original index.html terms
 * @property {string} [measure]    original index.html measure
 * @property {string} sourceRef
 * @property {string} [gatingRef]
 */

/** @type {CategoryDef[]} */
export const CATEGORIES = [
  {
    key: "entire_home",
    label: "Entire home",
    group: "living",
    unit: "night",
    effort: 4,
    privacyImpact: 3,
    strangersInHome: true,
    basisDefault: "permit",
    conflictsWith: ["apartment_unit","backyard","film_location","kitchen","pool","private_room","workspace","yard_campsite"],
    resourceUse: {},
    terms: ["daily","weekly","monthly","lease"],
    measure: "whole",
    sourceRef: "index.html:5153",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]}]},
  },
  {
    key: "apartment_unit",
    label: "Apartment / unit",
    group: "living",
    unit: "night",
    effort: 4,
    privacyImpact: 3,
    strangersInHome: true,
    basisDefault: "permit",
    conflictsWith: ["entire_home"],
    resourceUse: {},
    terms: ["daily","monthly","lease"],
    measure: "whole",
    sourceRef: "index.html:5156",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"units"}]},
  },
  {
    key: "adu",
    label: "ADU / guest house",
    group: "living",
    unit: "night",
    effort: 4,
    privacyImpact: 2,
    strangersInHome: false,
    basisDefault: "construction",
    conflictsWith: [],
    resourceUse: {},
    terms: ["daily","weekly","monthly","lease"],
    measure: "whole",
    sourceRef: "index.html:5158",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family"]},{"any":[{"attr":"adu_present","equals":true},{"attr":"lot_area_sqft"}]}]},
    basisOverrides: [{"when":{"attr":"adu_present","equals":true},"basis":"permit"}],
  },
  {
    key: "private_room",
    label: "Private room",
    group: "living",
    unit: "night",
    effort: 4,
    privacyImpact: 3,
    strangersInHome: true,
    basisDefault: "setup",
    conflictsWith: ["entire_home"],
    resourceUse: {"bathroom":1},
    terms: ["daily","weekly","monthly","lease"],
    measure: "whole",
    sourceRef: "index.html:5160",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family"]},{"attr":"bedrooms"}]},
  },
  {
    key: "backyard",
    label: "Backyard",
    group: "outdoor",
    unit: "hour",
    effort: 3,
    privacyImpact: 2,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: ["entire_home","garden_plot","sport_court","yard_campsite"],
    resourceUse: {"yard":1,"bathroom":1},
    terms: ["hourly","daily"],
    measure: "whole",
    sourceRef: "index.html:5164",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family"]},{"attr":"yard_area_sqft"}]},
  },
  {
    key: "yard_campsite",
    label: "Yard campsite",
    group: "outdoor",
    unit: "day",
    effort: 3,
    privacyImpact: 2,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: ["backyard","beehive_site","entire_home","garden_plot","pasture","pool","sport_court"],
    resourceUse: {"yard":1,"bathroom":1},
    terms: ["daily","weekly"],
    measure: "site",
    sourceRef: "index.html:5166",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"any":[{"attr":"yard_area_sqft"},{"attr":"lot_area_sqft"}]}]},
  },
  {
    key: "pool",
    label: "Pool",
    group: "outdoor",
    unit: "hour",
    effort: 3,
    privacyImpact: 2,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: ["entire_home","yard_campsite"],
    resourceUse: {"pool":1},
    terms: ["hourly"],
    measure: "whole",
    sourceRef: "index.html:5168",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"pool_present","equals":true}]},
  },
  {
    key: "workspace",
    label: "Workspace / studio / workshop",
    group: "outdoor",
    unit: "hour",
    effort: 3,
    privacyImpact: 2,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: ["entire_home","garage_storage"],
    resourceUse: {"garage":1},
    terms: ["hourly","daily","monthly"],
    measure: "whole",
    sourceRef: "index.html:5170",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]},{"any":[{"attr":"garage_present","equals":true},{"attr":"adu_present","equals":true}]}]},
  },
  {
    key: "film_location",
    label: "Filming / photo location",
    group: "outdoor",
    unit: "hour",
    effort: 3,
    privacyImpact: 2,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: ["entire_home"],
    resourceUse: {},
    terms: ["hourly","daily"],
    measure: "whole",
    sourceRef: "index.html:5172",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"living_area_sqft"}]},
  },
  {
    key: "kitchen",
    label: "Kitchen",
    group: "outdoor",
    unit: "hour",
    effort: 3,
    privacyImpact: 3,
    strangersInHome: true,
    basisDefault: "setup",
    conflictsWith: ["entire_home"],
    resourceUse: {},
    terms: ["hourly","daily","monthly"],
    measure: "whole",
    sourceRef: "index.html:5174",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]},{"attr":"living_area_sqft"}]},
  },
  {
    key: "sport_court",
    label: "Sport court",
    group: "outdoor",
    unit: "hour",
    effort: 3,
    privacyImpact: 2,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: ["backyard","garden_plot","pasture","yard_campsite"],
    resourceUse: {"yard":1},
    terms: ["hourly"],
    measure: "whole",
    sourceRef: "index.html:5176",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"any":[{"attr":"yard_area_sqft"},{"attr":"lot_area_sqft"}]}]},
  },
  {
    key: "meeting_room",
    label: "Meeting / event room",
    group: "outdoor",
    unit: "hour",
    effort: 3,
    privacyImpact: 2,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: [],
    resourceUse: {"bathroom":1},
    terms: ["hourly","daily"],
    measure: "whole",
    sourceRef: "index.html:5178",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"building_footprint_sqft"}]},
  },
  {
    key: "parking_spot",
    label: "Parking spot",
    group: "parking",
    unit: "hour",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: ["fleet_parking","rv_parking"],
    resourceUse: {"parking":1},
    terms: ["hourly","daily","weekly","monthly","lease"],
    measure: "spot",
    sourceRef: "index.html:5182",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","land","commercial"]},{"any":[{"attr":"parking_spaces"},{"attr":"driveway_area_sqft"},{"attr":"garage_present","equals":true},{"all":[{"attr":"property_type","in":["land"]},{"attr":"lot_area_sqft"}]}]}]},
  },
  {
    key: "rv_parking",
    label: "RV / boat / trailer parking",
    group: "parking",
    unit: "week",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: ["parking_spot"],
    resourceUse: {"parking":1},
    terms: ["weekly","monthly","lease"],
    measure: "spot",
    sourceRef: "index.html:5184",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"any":[{"attr":"driveway_area_sqft"},{"attr":"yard_area_sqft"},{"attr":"lot_area_sqft"}]}]},
  },
  {
    key: "ev_charging",
    label: "EV charging",
    group: "parking",
    unit: "hour",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: [],
    resourceUse: {"parking":1},
    terms: ["hourly","daily","monthly"],
    measure: "charger",
    sourceRef: "index.html:5186",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]},{"any":[{"attr":"garage_present","equals":true},{"attr":"parking_spaces"},{"attr":"driveway_area_sqft"}]}]},
  },
  {
    key: "dock_slip",
    label: "Boat dock / slip",
    group: "parking",
    unit: "day",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: [],
    resourceUse: {},
    terms: ["daily","weekly","monthly","lease"],
    measure: "slip",
    sourceRef: "index.html:5188",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","land","commercial"]},{"attr":"waterfront_access","equals":true}]},
  },
  {
    key: "lot_parking",
    label: "Parking lot spaces",
    group: "parking",
    unit: "hour",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: ["fleet_parking"],
    resourceUse: {"parking":1},
    terms: ["hourly","daily","monthly"],
    measure: "spot",
    sourceRef: "index.html:5190",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"parking_spaces"}]},
  },
  {
    key: "garage_storage",
    label: "Garage storage",
    group: "storage",
    unit: "week",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: ["workspace"],
    resourceUse: {"garage":1},
    terms: ["weekly","monthly","lease"],
    measure: "sqft",
    sourceRef: "index.html:5194",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family"]},{"attr":"garage_present","equals":true}]},
  },
  {
    key: "attic_storage",
    label: "Attic storage",
    group: "storage",
    unit: "month",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: [],
    resourceUse: {},
    terms: ["monthly","lease"],
    measure: "sqft",
    sourceRef: "index.html:5196",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family"]},{"attr":"attic_present","equals":true}]},
  },
  {
    key: "basement_storage",
    label: "Basement / closet / shed",
    group: "storage",
    unit: "week",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: [],
    resourceUse: {},
    terms: ["weekly","monthly","lease"],
    measure: "sqft",
    sourceRef: "index.html:5198",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]},{"any":[{"attr":"basement_present","equals":true},{"attr":"shed_present","equals":true}]}]},
  },
  {
    key: "warehouse_storage",
    label: "Warehouse / pallet storage",
    group: "storage",
    unit: "month",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: [],
    resourceUse: {},
    terms: ["monthly","lease"],
    measure: "sqft",
    sourceRef: "index.html:5200",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"building_footprint_sqft"}]},
  },
  {
    key: "garden_plot",
    label: "Garden bed space",
    group: "land",
    unit: "month",
    effort: 2,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: ["backyard","pasture","sport_court","yard_campsite"],
    resourceUse: {"yard":1},
    terms: ["monthly","lease"],
    measure: "sqft",
    sourceRef: "index.html:5204",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"any":[{"attr":"yard_area_sqft"},{"attr":"lot_area_sqft"}]}]},
  },
  {
    key: "beehive_site",
    label: "Beehive / small-ag site",
    group: "land",
    unit: "month",
    effort: 2,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: ["yard_campsite"],
    resourceUse: {"yard":1},
    terms: ["monthly","lease"],
    measure: "site",
    sourceRef: "index.html:5206",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"any":[{"attr":"yard_area_sqft"},{"attr":"lot_area_sqft"}]}]},
  },
  {
    key: "pasture",
    label: "Pasture / paddock",
    group: "land",
    unit: "month",
    effort: 2,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: ["garden_plot","sport_court","yard_campsite"],
    resourceUse: {"yard":1},
    terms: ["monthly","lease"],
    measure: "acre",
    sourceRef: "index.html:5208",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"attr":"lot_area_sqft"}]},
  },
  {
    key: "rooftop_solar",
    label: "Rooftop solar",
    group: "energy",
    unit: "month",
    effort: 1,
    privacyImpact: 0,
    strangersInHome: false,
    basisDefault: "construction",
    conflictsWith: ["telecom_site"],
    resourceUse: {"roof":1},
    terms: ["infrastructure"],
    measure: "sqft",
    sourceRef: "index.html:5212",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"roof_area_sqft"}]},
  },
  {
    key: "battery_site",
    label: "Battery wall or pad",
    group: "energy",
    unit: "month",
    effort: 1,
    privacyImpact: 0,
    strangersInHome: false,
    basisDefault: "construction",
    conflictsWith: [],
    resourceUse: {},
    terms: ["infrastructure"],
    measure: "site",
    sourceRef: "index.html:5214",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"building_footprint_sqft"}]},
  },
  {
    key: "charger_site",
    label: "EV chargers in your parking lot",
    group: "energy",
    unit: "month",
    effort: 1,
    privacyImpact: 0,
    strangersInHome: false,
    basisDefault: "construction",
    conflictsWith: [],
    resourceUse: {"parking":1},
    terms: ["infrastructure"],
    measure: "site",
    sourceRef: "index.html:5216",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"parking_spaces"}]},
  },
  {
    key: "telecom_site",
    label: "Telecom / sensor site",
    group: "energy",
    unit: "month",
    effort: 1,
    privacyImpact: 0,
    strangersInHome: false,
    basisDefault: "construction",
    conflictsWith: ["rooftop_solar"],
    resourceUse: {"roof":1},
    terms: ["infrastructure"],
    measure: "site",
    sourceRef: "index.html:5218",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"roof_area_sqft"}]},
  },
  {
    key: "fleet_parking",
    label: "Fleet & van parking",
    group: "commercial",
    unit: "month",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: ["lot_parking","parking_spot"],
    resourceUse: {"parking":1},
    terms: ["monthly","lease"],
    measure: "spot",
    sourceRef: "index.html:5222",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"any":[{"attr":"parking_spaces"},{"attr":"lot_area_sqft"}]}]},
  },
  {
    key: "signage",
    label: "Sign / billboard site",
    group: "commercial",
    unit: "month",
    effort: 1,
    privacyImpact: 0,
    strangersInHome: false,
    basisDefault: "construction",
    conflictsWith: [],
    resourceUse: {},
    terms: ["lease","infrastructure"],
    measure: "site",
    sourceRef: "index.html:5224",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"lot_area_sqft"}]},
  },
  {
    key: "parcel_locker",
    label: "Parcel locker wall",
    group: "commercial",
    unit: "month",
    effort: 1,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: [],
    resourceUse: {},
    terms: ["lease","infrastructure"],
    measure: "site",
    sourceRef: "index.html:5226",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"building_footprint_sqft"}]},
  },
  {
    key: "atv",
    label: "ATV / side-by-side",
    group: "gear",
    unit: "hour",
    effort: 3,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: [],
    resourceUse: {},
    terms: ["hourly","daily","weekly"],
    measure: "unit",
    sourceRef: "index.html:5230",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"atv"}]},
  },
  {
    key: "snowmobile",
    label: "Snowmobile",
    group: "gear",
    unit: "hour",
    effort: 3,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: [],
    resourceUse: {},
    terms: ["hourly","daily","weekly"],
    measure: "unit",
    sourceRef: "index.html:5233",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"snowmobile"}]},
  },
  {
    key: "kayak",
    label: "Kayak / canoe / paddleboard",
    group: "gear",
    unit: "hour",
    effort: 3,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: [],
    resourceUse: {},
    terms: ["hourly","daily","weekly"],
    measure: "unit",
    sourceRef: "index.html:5236",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"kayak"}]},
  },
  {
    key: "boat",
    label: "Boat / pontoon",
    group: "gear",
    unit: "hour",
    effort: 3,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: [],
    resourceUse: {},
    terms: ["hourly","daily"],
    measure: "unit",
    sourceRef: "index.html:5238",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"boat"}]},
  },
  {
    key: "jet_ski",
    label: "Jet ski / PWC",
    group: "gear",
    unit: "hour",
    effort: 3,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: [],
    resourceUse: {},
    terms: ["hourly","daily"],
    measure: "unit",
    sourceRef: "index.html:5241",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"jet_ski"}]},
  },
  {
    key: "ebike",
    label: "E-bike / bike",
    group: "gear",
    unit: "hour",
    effort: 3,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: [],
    resourceUse: {},
    terms: ["hourly","daily","weekly"],
    measure: "unit",
    sourceRef: "index.html:5244",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"ebike"}]},
  },
  {
    key: "camper",
    label: "Camper / travel trailer",
    group: "gear",
    unit: "day",
    effort: 3,
    privacyImpact: 1,
    strangersInHome: false,
    basisDefault: "setup",
    conflictsWith: [],
    resourceUse: {},
    terms: ["daily","weekly"],
    measure: "unit",
    sourceRef: "index.html:5246",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"camper"}]},
  },
  {
    key: "building",
    label: "Building / container",
    group: "container",
    unit: "month",
    effort: 1,
    privacyImpact: 0,
    strangersInHome: false,
    basisDefault: "existing",
    conflictsWith: [],
    resourceUse: {},
    terms: [],
    measure: "whole",
    sourceRef: "index.html:5250",
    gatingRef: "index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"never":true},
  },
];

/** Questions shown to the owner when an attribute is unavailable. Generic fallback in opportunities.js. */
export const ATTRIBUTE_QUESTIONS = {
  property_type: 'What type of property is it (house, condo, multi-family, land, commercial)?',
  yard_area_sqft: 'Do you have a yard? About how many square feet?',
  lot_area_sqft: 'How big is the lot, in square feet?',
  driveway_area_sqft: 'Do you have a driveway? How many cars fit?',
  parking_spaces: 'How many parking spaces do you have?',
  garage_present: 'Do you have a garage?',
  pool_present: 'Do you have a pool?',
  adu_present: 'Is there a guest house or ADU on the lot?',
  bedrooms: 'How many bedrooms are there?',
  living_area_sqft: 'About how many square feet is the living area?',
  units: 'How many units are in the building?',
  roof_area_sqft: 'About how many square feet of roof do you have?',
  building_footprint_sqft: 'About how many square feet is the building footprint?',
  attic_present: 'Do you have an attic you could store things in?',
  basement_present: 'Do you have a basement?',
  shed_present: 'Do you have a shed or storage closet?',
  waterfront_access: 'Do you have water access, such as a dock?',
  equipment_owned: 'Do you own gear you could rent out (ATV, kayak, bikes, boat, camper...)?',
};

/** Raw index.html checklists (per category): the generic requirement lists used to seed core/data/jurisdictions.js. */
export const CHECKLISTS = [
  {
    "key": "entire_home",
    "line": 5153,
    "items": [
      "Short-term rental permit / registration",
      "Occupancy tax account",
      "Smoke & CO detectors",
      "Host insurance"
    ]
  },
  {
    "key": "apartment_unit",
    "line": 5156,
    "items": [
      "Rental registration",
      "Habitability inspection",
      "Smoke & CO detectors"
    ]
  },
  {
    "key": "adu",
    "line": 5158,
    "items": [
      "Permitted ADU",
      "Short-term rental permit (if < 30 nights)",
      "Smoke & CO detectors"
    ]
  },
  {
    "key": "private_room",
    "line": 5160,
    "items": [
      "House rules for shared areas",
      "Smoke & CO detectors"
    ]
  },
  {
    "key": "backyard",
    "line": 5164,
    "items": [
      "Noise curfew",
      "Max guests",
      "Restroom access plan"
    ]
  },
  {
    "key": "yard_campsite",
    "line": 5166,
    "items": [
      "Restroom access",
      "Fire policy"
    ]
  },
  {
    "key": "pool",
    "line": 5168,
    "items": [
      "Pool fencing / gate",
      "Liability waiver",
      "Insurance confirmation"
    ]
  },
  {
    "key": "workspace",
    "line": 5170,
    "items": [
      "Tool / equipment rules"
    ]
  },
  {
    "key": "film_location",
    "line": 5172,
    "items": [
      "City film permit (if required)",
      "Neighbor notice"
    ]
  },
  {
    "key": "kitchen",
    "line": 5174,
    "items": [
      "Cottage food / food handler rules",
      "Cleaning checklist",
      "Allergen disclosure"
    ]
  },
  {
    "key": "sport_court",
    "line": 5176,
    "items": [
      "Lighting hours",
      "Liability waiver"
    ]
  },
  {
    "key": "meeting_room",
    "line": 5178,
    "items": [
      "Max occupancy posted",
      "Restroom access"
    ]
  },
  {
    "key": "parking_spot",
    "line": 5182,
    "items": [
      "Spot photos & dimensions",
      "Access instructions"
    ]
  },
  {
    "key": "rv_parking",
    "line": 5184,
    "items": [
      "Max length",
      "HOA allows RV storage"
    ]
  },
  {
    "key": "ev_charging",
    "line": 5186,
    "items": [
      "Charger type & kW"
    ]
  },
  {
    "key": "dock_slip",
    "line": 5188,
    "items": [
      "Max boat length & draft",
      "Dock condition & insurance"
    ]
  },
  {
    "key": "lot_parking",
    "line": 5190,
    "items": [
      "Hours renters may park are posted",
      "Spaces renters may use are marked or described"
    ]
  },
  {
    "key": "garage_storage",
    "line": 5194,
    "items": [
      "No hazardous materials policy",
      "Access hours"
    ]
  },
  {
    "key": "attic_storage",
    "line": 5196,
    "items": [
      "Weight limit",
      "Ladder / access disclosure"
    ]
  },
  {
    "key": "basement_storage",
    "line": 5198,
    "items": [
      "Moisture disclosure",
      "Access hours"
    ]
  },
  {
    "key": "warehouse_storage",
    "line": 5200,
    "items": [
      "No hazardous materials policy",
      "Access hours"
    ]
  },
  {
    "key": "garden_plot",
    "line": 5204,
    "items": [
      "Water access",
      "HOA front-yard rules",
      "Chemical policy"
    ]
  },
  {
    "key": "beehive_site",
    "line": 5206,
    "items": [
      "Local apiary rules"
    ]
  },
  {
    "key": "pasture",
    "line": 5208,
    "items": [
      "Fencing & water",
      "Livestock zoning"
    ]
  },
  {
    "key": "rooftop_solar",
    "line": 5212,
    "items": [
      "I own the building or have the owner's OK",
      "I know of no major roof damage"
    ]
  },
  {
    "key": "battery_site",
    "line": 5214,
    "items": [
      "I own the property or have the owner's OK",
      "There is a wall or pad near the electric panel"
    ]
  },
  {
    "key": "charger_site",
    "line": 5216,
    "items": [
      "I own the lot or have the owner's OK",
      "Drivers can reach the spaces from the street"
    ]
  },
  {
    "key": "telecom_site",
    "line": 5218,
    "items": [
      "I own the property or have the owner's OK"
    ]
  },
  {
    "key": "fleet_parking",
    "line": 5222,
    "items": [
      "Zoning allows commercial vehicles",
      "I can share overnight access"
    ]
  },
  {
    "key": "signage",
    "line": 5224,
    "items": [
      "I own the property or have the owner's OK"
    ]
  },
  {
    "key": "parcel_locker",
    "line": 5226,
    "items": [
      "I own the property or have the owner's OK",
      "There is a standard outlet nearby"
    ]
  },
  {
    "key": "atv",
    "line": 5230,
    "items": [
      "Helmet for every rider",
      "A place to ride (trails, land or a nearby riding area)",
      "Registration & insurance up to date"
    ]
  },
  {
    "key": "snowmobile",
    "line": 5233,
    "items": [
      "Helmet for every rider",
      "Trail access or a trailhead nearby",
      "Registration & insurance up to date"
    ]
  },
  {
    "key": "kayak",
    "line": 5236,
    "items": [
      "Life jacket for every paddler",
      "Paddles included"
    ]
  },
  {
    "key": "boat",
    "line": 5238,
    "items": [
      "Life jackets & safety kit on board",
      "Boat insurance that allows rentals",
      "Local boater-license rules explained to renters"
    ]
  },
  {
    "key": "jet_ski",
    "line": 5241,
    "items": [
      "Life jacket for every rider",
      "Insurance that allows rentals",
      "Local boater-license rules explained to renters"
    ]
  },
  {
    "key": "ebike",
    "line": 5244,
    "items": [
      "Helmet & lock included",
      "Charged battery at pickup"
    ]
  },
  {
    "key": "camper",
    "line": 5246,
    "items": [
      "Hitch & towing details for renters",
      "Clean water tank & propane"
    ]
  },
  {
    "key": "building",
    "line": 5250,
    "items": []
  }
];

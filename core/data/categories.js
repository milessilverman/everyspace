// @ts-check
// Category data for opportunity identification. Pure data, no logic.
//
// Provenance of each field:
//  - key, label, group, terms, measure: copied from everyspace-demo index.html CATEGORIES (lines 5151-5251); `sourceRef` names the line.
//  - unit: mapped from the everyspace-demo index.html `terms` to the contract's DurationUnit, taking the SHORTEST natural unit:
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
//      Property-type gating is ported from everyspace-demo index.html: HOME_ONLY / BUSINESS_ONLY (lines 5317-5318) and PROP_HAVE for
//      land and condo (lines 17656-17664). Assumption: the profile's property_type 'commercial' stands for the
//      everyspace-demo index.html business/other owner types. No numeric threshold exists in the everyspace-demo index.html quiz logic for any
//      category (the only candidate, SOLAR.minKw at everyspace-demo index.html:8806, is a kW size and is NOT converted to sqft),
//      so every area/count requirement is presence-only (> 0).
//  - attributes outside the AttributeKey list in core/types.js: the owner keys (see OWNER_ATTRIBUTE_KEYS in
//      opportunities.js): attic_present, basement_present, shed_present, waterfront_access, equipment_owned and
//      `<category>_available`. They are asked via missingEvidence until the owner supplies them.
//
// EVIDENCE POLICY (2026-11-24 fix): every category has `evidence.class`:
//  - 'auto':  the automated profile can evidence the asset directly (real attribute: property_type + bedrooms/units,
//             yard_area_sqft, pool_present, parking_spaces/driveway_area_sqft, garage_present, roof/footprint area, adu_present).
//  - 'owner': cannot be seen from data; emitted only once the owner confirms (leaf rules carry `ownerOnly: true`, so
//             only an 'owner-confirmed' attribute counts). `evidence.ownerKeys` lists the boolean owner attributes
//             (`<category>_available`, or the older `*_present` / `waterfront_access` / `equipment_owned` keys);
//             `evidence.question` is the plain-language question for the UI.
//  - 'none':  the 'building' container, never an opportunity.
//  `evidence.investment` (adu, ev_charging) is an optional idea for something that does not exist yet; it is emitted
//  only when identifyOpportunities is called with includeInvestmentIdeas:true, basis construction, cost/feasibility unknown.
//  Presence of a yard or lot is NOT evidence of a sport court, pasture, hives, kitchen, RV pad, film location etc.
//  resourceUse (Everyspace modelling assumption): home_interior / yard (+pool) / parking / garage / roof, see opportunities.js.
//
// CONDOS AND BUILDINGS (2026-11-27, docs/condos-and-buildings.md): a condo owner owns one unit and shares the lot, yard, roof, garage and driveway with the
// building, so a condo gets the unit itself (entire_home, private_room), an assigned parking space only when the owner confirms assigned_parking_spaces >= 1
// (parking_spot, via `ownerConfirmed`: the category stays 'auto', but this branch counts only an owner-confirmed value), and storage only when the owner
// confirms storage_unit_present (basement_storage). A multi-family building also gets apartment_unit (quantity = units_available_to_rent, see
// opportunities.js) and roof options only with roof_access_present or a roof area that came from an owner-given roof type.
// `ownerConfirmed` = like `ownerOnly` (only an owner-confirmed value counts) but allowed inside an 'auto' category for one branch.
//
// Conflicts are stored symmetrically here, and opportunities.js symmetrises again so a data entry added one-sided still works.

/**
 * @typedef {{attr:string, equals?:any, in?:any[], notIn?:any[], min?:number, includes?:any, ownerOnly?:boolean, ownerConfirmed?:boolean}
 *   | {all:Rule[]} | {any:Rule[]} | {never:true}} Rule
 * @typedef {Object} EvidencePolicy
 * @property {'auto'|'owner'|'none'} class
 * @property {string[]} [attrs]       auto: the attribute keys that can evidence it (documentation)
 * @property {string[]} [ownerKeys]   owner: attribute keys the owner answers
 * @property {string} [question]      owner: plain-language question for the UI
 * @property {Record<string,string>} [questions]  owner: one question per key when a category has several keys (never one question for two things)
 * @property {{requires:Rule, basis:import('../types.js').OpportunityBasis}} [investment]  idea for something not built yet
 *
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
 * @property {EvidencePolicy} evidence
 * @property {string[]} conflictsWith
 * @property {Record<string, number>} resourceUse
 * @property {string[]} [terms]    original everyspace-demo index.html terms
 * @property {string} [measure]    original everyspace-demo index.html measure
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
    conflictsWith: ["apartment_unit","backyard","film_location","garage_storage","kitchen","pool","private_room","workspace","yard_campsite"],
    resourceUse: {"home_interior":1},
    terms: ["daily","weekly","monthly","lease"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5153",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]}]},
    evidence: {"class":"auto","attrs":["property_type"]},
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
    resourceUse: {"home_interior":1},
    terms: ["daily","monthly","lease"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5156",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    // A separate unit must exist: a one-unit single-family home is `entire_home`, not an apartment (definition, not a market threshold).
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"units","min":2}]},
    evidence: {"class":"auto","attrs":["property_type","units"]},
  },
  {
    key: "adu",
    label: "ADU / guest house",
    group: "living",
    unit: "night",
    effort: 4,
    privacyImpact: 2,
    strangersInHome: false,
    basisDefault: "permit",
    conflictsWith: [],
    resourceUse: {},
    terms: ["daily","weekly","monthly","lease"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5158",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family"]},{"attr":"adu_present","equals":true}]},
    evidence: {"class":"auto","attrs":["adu_present"],"investment":{"requires":{"all":[{"attr":"property_type","in":["single_family","multi_family"]},{"attr":"lot_area_sqft"}]},"basis":"construction"}},
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
    resourceUse: {"home_interior":1},
    terms: ["daily","weekly","monthly","lease"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5160",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family"]},{"attr":"bedrooms"}]},
    evidence: {"class":"auto","attrs":["property_type","bedrooms"]},
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
    resourceUse: {"yard":1},
    terms: ["hourly","daily"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5164",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family"]},{"attr":"yard_area_sqft"}]},
    evidence: {"class":"auto","attrs":["yard_area_sqft"]},
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
    resourceUse: {"yard":1},
    terms: ["daily","weekly"],
    measure: "site",
    sourceRef: "everyspace-demo index.html:5166",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"attr":"yard_campsite_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["yard_campsite_available"],"question":"Would you let guests camp in your yard?"},
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
    resourceUse: {"yard":1,"pool":1},
    terms: ["hourly"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5168",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"pool_present","equals":true}]},
    evidence: {"class":"auto","attrs":["pool_present"]},
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
    conflictsWith: ["entire_home"],
    resourceUse: {"home_interior":1},
    terms: ["hourly","daily","monthly"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5170",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]},{"attr":"workspace_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["workspace_available"],"question":"Do you have a room or studio you could rent as a workspace?"},
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
    resourceUse: {"home_interior":1},
    terms: ["hourly","daily"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5172",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"film_location_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["film_location_available"],"question":"Would you let film crews shoot at your place?"},
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
    resourceUse: {"home_interior":1},
    terms: ["hourly","daily","monthly"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5174",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]},{"attr":"kitchen_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["kitchen_available"],"question":"Do you have a kitchen you could rent out?"},
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
    sourceRef: "everyspace-demo index.html:5176",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"attr":"sport_court_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["sport_court_available"],"question":"Do you have a sport court, like tennis or basketball?"},
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
    resourceUse: {"home_interior":1},
    terms: ["hourly","daily"],
    measure: "whole",
    sourceRef: "everyspace-demo index.html:5178",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"meeting_room_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["meeting_room_available"],"question":"Do you have a room people could rent for meetings?"},
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
    sourceRef: "everyspace-demo index.html:5182",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"any":[{"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"any":[{"attr":"parking_spaces"},{"attr":"driveway_area_sqft"}]}]},{"all":[{"attr":"property_type","equals":"condo"},{"attr":"assigned_parking_spaces","min":1,"ownerConfirmed":true}]}]},
    evidence: {"class":"auto","attrs":["parking_spaces","driveway_area_sqft","assigned_parking_spaces"]},
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
    sourceRef: "everyspace-demo index.html:5184",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"attr":"rv_parking_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["rv_parking_available"],"question":"Is there space to park an RV or trailer?"},
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
    sourceRef: "everyspace-demo index.html:5186",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]},{"attr":"ev_charging_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["ev_charging_available"],"question":"Do you have an EV charger you would let others use?","investment":{"requires":{"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]},{"any":[{"attr":"parking_spaces"},{"attr":"driveway_area_sqft"},{"attr":"garage_present","equals":true}]}]},"basis":"construction"}},
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
    sourceRef: "everyspace-demo index.html:5188",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","condo","multi_family","land","commercial"]},{"attr":"waterfront_access","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["waterfront_access"],"question":"Do you have a dock or boat slip?"},
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
    sourceRef: "everyspace-demo index.html:5190",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"lot_parking_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["lot_parking_available"],"question":"Do you have a parking lot with spare spaces?"},
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
    conflictsWith: ["entire_home"],
    resourceUse: {"garage":1},
    terms: ["weekly","monthly","lease"],
    measure: "sqft",
    sourceRef: "everyspace-demo index.html:5194",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family"]},{"attr":"garage_present","equals":true}]},
    evidence: {"class":"auto","attrs":["garage_present"]},
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
    sourceRef: "everyspace-demo index.html:5196",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family"]},{"attr":"attic_present","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["attic_present"],"question":"Do you have an attic you could use for storage?"},
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
    sourceRef: "everyspace-demo index.html:5198",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"any":[{"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"any":[{"attr":"basement_present","equals":true,"ownerOnly":true},{"attr":"shed_present","equals":true,"ownerOnly":true}]}]},{"all":[{"attr":"property_type","equals":"condo"},{"attr":"storage_unit_present","equals":true,"ownerOnly":true}]}]},
    evidence: {"class":"owner","ownerKeys":["basement_present","shed_present","storage_unit_present"],"question":"Do you have a basement you could use for storage?","questions":{"basement_present":"Do you have a basement you could use for storage?","shed_present":"Do you have a shed or outbuilding you could use for storage?","storage_unit_present":"Does your unit come with a storage unit?"}},
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
    sourceRef: "everyspace-demo index.html:5200",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"warehouse_storage_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["warehouse_storage_available"],"question":"Do you have a large indoor space, like a warehouse?"},
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
    sourceRef: "everyspace-demo index.html:5204",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"attr":"yard_area_sqft"}]},
    evidence: {"class":"auto","attrs":["yard_area_sqft"]},
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
    sourceRef: "everyspace-demo index.html:5206",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"beehive_site_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["beehive_site_available"],"question":"Would you let a beekeeper keep hives here?"},
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
    sourceRef: "everyspace-demo index.html:5208",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","land","commercial"]},{"attr":"pasture_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["pasture_available"],"question":"Do you have pasture where animals could graze?"},
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
    sourceRef: "everyspace-demo index.html:5212",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"any":[{"all":[{"attr":"property_type","in":["single_family","commercial"]},{"any":[{"attr":"roof_area_sqft"},{"attr":"building_footprint_sqft"}]}]},{"all":[{"attr":"property_type","equals":"multi_family"},{"any":[{"attr":"roof_area_sqft"},{"attr":"roof_access_present","equals":true,"ownerConfirmed":true}]}]}]},
    evidence: {"class":"auto","attrs":["building_footprint_sqft","roof_area_sqft","roof_access_present"]},
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
    sourceRef: "everyspace-demo index.html:5214",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"battery_site_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["battery_site_available"],"question":"Would you host a large battery for the power grid?"},
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
    sourceRef: "everyspace-demo index.html:5216",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"charger_site_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["charger_site_available"],"question":"Would you host EV chargers for the public?"},
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
    sourceRef: "everyspace-demo index.html:5218",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"telecom_site_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["telecom_site_available"],"question":"Would you lease roof space for phone or internet equipment?"},
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
    sourceRef: "everyspace-demo index.html:5222",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"fleet_parking_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["fleet_parking_available"],"question":"Could you rent parking to a company with vans or trucks?"},
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
    sourceRef: "everyspace-demo index.html:5224",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"signage_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["signage_available"],"question":"Would you let someone put up a sign or billboard?"},
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
    sourceRef: "everyspace-demo index.html:5226",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["multi_family","commercial"]},{"attr":"parcel_locker_available","equals":true,"ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["parcel_locker_available"],"question":"Would you host a parcel locker here?"},
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
    sourceRef: "everyspace-demo index.html:5230",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"atv","ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own any gear you would rent out?"},
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
    sourceRef: "everyspace-demo index.html:5233",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"snowmobile","ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own any gear you would rent out?"},
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
    sourceRef: "everyspace-demo index.html:5236",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"kayak","ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own any gear you would rent out?"},
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
    sourceRef: "everyspace-demo index.html:5238",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"boat","ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own any gear you would rent out?"},
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
    sourceRef: "everyspace-demo index.html:5241",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"jet_ski","ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own any gear you would rent out?"},
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
    sourceRef: "everyspace-demo index.html:5244",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"ebike","ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own any gear you would rent out?"},
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
    sourceRef: "everyspace-demo index.html:5246",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"all":[{"attr":"property_type","in":["single_family","multi_family","commercial"]},{"attr":"equipment_owned","includes":"camper","ownerOnly":true}]},
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own any gear you would rent out?"},
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
    sourceRef: "everyspace-demo index.html:5250",
    gatingRef: "everyspace-demo index.html:5317-5318 (HOME_ONLY/BUSINESS_ONLY), everyspace-demo index.html:17656-17664 (PROP_HAVE/allowedFor)",
    requires: {"never":true},
    evidence: {"class":"none"},
  },
];

/** Questions shown to the owner when an attribute is unavailable. Generic fallback in opportunities.js. */
export const ATTRIBUTE_QUESTIONS = {
  property_type: 'What do you own here?',
  yard_area_sqft: 'About how big is your yard, in square feet?',
  lot_area_sqft: 'How big is the lot, in square feet?',
  driveway_area_sqft: 'How many cars fit in your driveway?',
  parking_spaces: 'How many parking spaces do you have?',
  garage_present: 'Do you have a garage?',
  pool_present: 'Do you have a pool?',
  adu_present: 'Is there a guest house or ADU on the lot?',
  bedrooms: 'How many bedrooms are there?',
  living_area_sqft: 'About how many square feet is the living area?',
  units: 'How many units are in the building?',
  roof_area_sqft: 'About how many square feet of roof do you have?',
  building_footprint_sqft: 'About how many square feet is the building footprint?',
  attic_present: 'Do you have an attic you could use for storage?',
  basement_present: 'Do you have a basement you could use for storage?',
  shed_present: 'Do you have a shed or outbuilding you could use for storage?',
  waterfront_access: 'Do you have a dock or boat slip?',
  equipment_owned: 'Do you own any gear you would rent out?',
  assigned_parking_spaces: 'How many parking spaces are assigned to your unit?',
  storage_unit_present: 'Does your unit come with a storage unit?',
  balcony_present: 'Does your unit have a balcony or patio?',
  hoa_allows_rentals: "Does your HOA allow rentals?",
  units_available_to_rent: 'How many units could you rent out?',
  laundry_room_present: 'Does the building have a laundry room?',
  roof_access_present: 'Can you get onto the roof?',
};

/**
 * What the page asks a CONDO owner (one unit in a building). `type` says how to show the question: 'number' (whole number), 'yesno' (a yes or no),
 * 'choice' (one of `choices`, stored as that string). The answers are owner-confirmed attributes with these keys.
 * @type {ReadonlyArray<{key:string, question:string, type:'number'|'yesno'|'choice', choices?:string[]}>}
 */
export const CONDO_OWNER_KEYS = Object.freeze([
  { key: 'assigned_parking_spaces', question: 'How many parking spaces are assigned to your unit?', type: /** @type {const} */ ('number') },
  { key: 'storage_unit_present', question: 'Does your unit come with a storage unit?', type: /** @type {const} */ ('yesno') },
  { key: 'balcony_present', question: 'Does your unit have a balcony or patio?', type: /** @type {const} */ ('yesno') },
  { key: 'hoa_allows_rentals', question: 'Does your HOA allow rentals?', type: /** @type {const} */ ('choice'), choices: ['yes', 'no', 'unsure'] },
].map((x) => Object.freeze(x)));

/**
 * What the page asks the owner of a whole multi-unit BUILDING (same shape as CONDO_OWNER_KEYS). `parking_spaces` is the existing key.
 * @type {ReadonlyArray<{key:string, question:string, type:'number'|'yesno'|'choice', choices?:string[]}>}
 */
export const BUILDING_OWNER_KEYS = Object.freeze([
  { key: 'units_available_to_rent', question: 'How many units could you rent out?', type: /** @type {const} */ ('number') },
  { key: 'parking_spaces', question: 'How many parking spaces does the building have?', type: /** @type {const} */ ('number') },
  { key: 'laundry_room_present', question: 'Does the building have a laundry room?', type: /** @type {const} */ ('yesno') },
  { key: 'roof_access_present', question: 'Can you get onto the roof?', type: /** @type {const} */ ('yesno') },
].map((x) => Object.freeze(x)));

/** Raw everyspace-demo index.html checklists (per category): the generic requirement lists used to seed core/data/jurisdictions.js. */
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

// ---------------------------------------------------------------------------------------------------------------------
// The guided owner questions (used by ownerQuestions() in opportunities.js).
// ---------------------------------------------------------------------------------------------------------------------

/**
 * QUESTION-RELEVANCE CUT-OFFS. These are rules Everyspace chose for deciding whether to ASK a question. They are not a claim about the
 * property: a smaller lot could still keep bees. They are deliberately conservative, and when the lot size is unknown the question is
 * not asked by default (it stays reachable under "less common ideas").
 */
export const ASK_CUTOFFS = Object.freeze({
  /** lot area (sq ft) from which "would you let guests camp?" and "would you let a beekeeper keep hives?" are asked: half an acre */
  smallLand: 21780,
  /** lot area (sq ft) from which "do you have pasture?" is asked: two acres */
  pasture: 87120,
});

/**
 * Relevance rule of a question (declarative, evaluated by evaluateAskWhen in opportunities.js). Leaves:
 *   {propertyType:[...]}  the profile's property type is one of these
 *   {lotAtLeast:'name'}   the lot area is known and at least ASK_CUTOFFS[name]  (an unknown lot size is never "large")
 *   {attrTrue:'key'}      the profile says this is true (an attribute that does not exist is never true)
 *   {attrKnown:'key'} / {attrUnknown:'key'}
 * and {all:[...]}, {any:[...]}, {not:rule}. A question with no rule is always asked when it is otherwise relevant.
 * @typedef {Object} AskRule
 */

/**
 * @typedef {Object} QuestionDef
 * @property {string} key                 the owner attribute the answer is stored under
 * @property {number} order               position in the guided flow (follow-ups sit right after their parent)
 * @property {'yesno'|'number'|'choice'|'gear'} type
 * @property {string} question            one idea, everyday words
 * @property {Record<string,string>} [questionFor]  property type -> a different wording of the same question
 * @property {string} [unit]              unit shown next to a number
 * @property {Array<{value:string,label:string}>} [choices]
 * @property {string} [unknownValue]      for a choice question: the stored value that means "I don't know" (otherwise "I don't know" stores nothing)
 * @property {string[]} [types]           property types this question is for (when absent: asked when some category could still use the answer)
 * @property {AskRule} [askWhen]
 * @property {{key:string, question:string}} [size]  a Yes is followed by "about how big?", stored under this key (square feet)
 * @property {string} hold                the line on the earnings page when this answer is "I don't know" and an option waits for it
 */

const COMMERCIAL = { propertyType: ['multi_family', 'commercial'] };
const WATER_NEAR = { attrTrue: 'water_nearby' }; // no lookup supplies this today, so water questions are never asked by default
/** @type {ReadonlyArray<QuestionDef>} */
export const QUESTION_DEFS = Object.freeze([
  // a condo owner: one unit
  { key: 'hoa_allows_rentals', order: 10, type: 'choice', types: ['condo'], question: 'Does your HOA allow rentals?', choices: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], unknownValue: 'unsure', hold: 'Tell us if your HOA allows rentals to see what a unit could earn' },
  { key: 'assigned_parking_spaces', order: 20, type: 'number', types: ['condo'], question: 'How many parking spaces are assigned to your unit?', unit: 'spaces', hold: 'Tell us how many parking spaces come with your unit to see parking income' },
  { key: 'storage_unit_present', order: 30, type: 'yesno', types: ['condo'], question: 'Does your unit come with a storage unit?', size: { key: 'storage_unit_area_sqft', question: 'About how big is the storage unit?' }, hold: 'Tell us if you have a storage unit to see storage income' },
  { key: 'balcony_present', order: 40, type: 'yesno', types: ['condo'], question: 'Does your unit have a balcony or patio?', hold: 'Tell us if you have a balcony or patio' },
  // an apartment building
  { key: 'units_available_to_rent', order: 10, type: 'number', types: ['multi_family'], question: 'How many units could you rent out?', unit: 'units', hold: 'Tell us how many units you could rent out to see unit income' },
  { key: 'parking_spaces', order: 20, type: 'number', types: ['multi_family'], question: 'How many parking spaces does the building have?', unit: 'spaces', hold: 'Tell us how many parking spaces you have to see parking income' },
  { key: 'laundry_room_present', order: 30, type: 'yesno', types: ['multi_family'], question: 'Does the building have a laundry room?', hold: 'Tell us if there is a laundry room' },
  { key: 'roof_access_present', order: 40, type: 'yesno', types: ['multi_family'], question: 'Can you get onto the roof?', hold: 'Tell us if you can get onto the roof to see roof income' },
  { key: 'roof_type', order: 50, type: 'choice', types: ['multi_family'], question: 'What shape is the roof?', choices: [{ value: 'flat', label: 'Flat' }, { value: 'gable', label: 'Gable' }, { value: 'hip', label: 'Hip' }], unknownValue: 'unsure', hold: 'Tell us the roof shape to see roof income' },
  // a house, a building, land
  { key: 'parking_spaces', order: 100, type: 'number', types: ['single_family', 'land', 'commercial'], question: 'How many cars can park on your property?', unit: 'spaces', hold: 'Tell us how many cars can park here to see parking income' },
  { key: 'pool_present', order: 110, type: 'yesno', question: 'Do you have a swimming pool?', hold: 'Tell us if you have a pool to see pool income' },
  { key: 'garage_present', order: 120, type: 'yesno', question: 'Do you have a garage?', size: { key: 'garage_area_sqft', question: 'About how big is the garage?' }, hold: 'Tell us if you have a garage to see storage income' },
  { key: 'attic_present', order: 130, type: 'yesno', question: 'Do you have an attic you could use for storage?', size: { key: 'attic_area_sqft', question: 'About how big is the attic?' }, hold: 'Tell us if you have an attic to see storage income' },
  { key: 'basement_present', order: 140, type: 'yesno', question: 'Do you have a basement you could use for storage?', size: { key: 'basement_area_sqft', question: 'About how big is the basement?' }, hold: 'Tell us if you have a basement to see storage income' },
  { key: 'shed_present', order: 150, type: 'yesno', question: 'Do you have a shed or outbuilding you could use for storage?', size: { key: 'shed_area_sqft', question: 'About how big is the shed?' }, hold: 'Tell us if you have a shed to see storage income' },
  { key: 'yard_area_sqft', order: 160, type: 'number', question: 'About how big is your yard, in square feet?', unit: 'sq ft', hold: 'Tell us how big your yard is to see yard income' },
  { key: 'adu_present', order: 170, type: 'yesno', question: 'Is there a guest house on the lot?', hold: 'Tell us if there is a guest house' },
  { key: 'workspace_available', order: 180, type: 'yesno', question: 'Do you have a room or studio you could rent as a workspace?', hold: 'Tell us if you have a room or studio to see workspace income' },
  { key: 'rv_parking_available', order: 190, type: 'yesno', question: 'Is there space to park an RV or trailer?', hold: 'Tell us if an RV could park here to see RV parking income' },
  { key: 'ev_charging_available', order: 200, type: 'yesno', question: 'Do you have an EV charger you would let others use?', hold: 'Tell us if you have an EV charger to see charging income' },
  { key: 'sport_court_available', order: 210, type: 'yesno', question: 'Do you have a sport court, like tennis or basketball?', hold: 'Tell us if you have a sport court to see court income' },
  { key: 'film_location_available', order: 220, type: 'yesno', question: 'Would you let film crews shoot at your place?', hold: 'Tell us if you would host film crews to see filming income' },
  { key: 'equipment_owned', order: 230, type: 'gear', question: 'Do you own any gear you would rent out?', hold: 'Tell us if you own gear to rent to see gear income' },
  // land uses: asked only when the lot is large enough to make the question worth asking
  { key: 'yard_campsite_available', order: 300, type: 'yesno', question: 'Would you let guests camp in your yard?', askWhen: { lotAtLeast: 'smallLand' }, hold: 'Tell us if you would let guests camp to see camping income' },
  { key: 'beehive_site_available', order: 310, type: 'yesno', question: 'Would you let a beekeeper keep hives here?', askWhen: { lotAtLeast: 'smallLand' }, hold: 'Tell us if you would host hives to see hive income' },
  { key: 'pasture_available', order: 320, type: 'yesno', question: 'Do you have pasture where animals could graze?', askWhen: { lotAtLeast: 'pasture' }, hold: 'Tell us if you have pasture to see grazing income' },
  // water: only when the lookup says there is water within reach
  { key: 'waterfront_access', order: 330, type: 'yesno', question: 'Do you have a dock or boat slip?', askWhen: WATER_NEAR, hold: 'Tell us if you have a dock or boat slip to see dock income' },
  // business-style uses: asked of buildings and commercial property
  { key: 'kitchen_available', order: 400, type: 'yesno', question: 'Do you have a kitchen you could rent out?', askWhen: COMMERCIAL, hold: 'Tell us if you have a kitchen to rent to see kitchen income' },
  { key: 'meeting_room_available', order: 410, type: 'yesno', question: 'Do you have a room people could rent for meetings?', askWhen: COMMERCIAL, hold: 'Tell us if you have a meeting room to see room income' },
  { key: 'lot_parking_available', order: 420, type: 'yesno', question: 'Do you have a parking lot with spare spaces?', askWhen: COMMERCIAL, hold: 'Tell us if you have a parking lot to see lot income' },
  { key: 'warehouse_storage_available', order: 430, type: 'yesno', question: 'Do you have a large indoor space, like a warehouse?', askWhen: COMMERCIAL, size: { key: 'warehouse_area_sqft', question: 'About how big is the space?' }, hold: 'Tell us if you have a large indoor space to see storage income' },
  { key: 'battery_site_available', order: 440, type: 'yesno', question: 'Would you host a large battery for the power grid?', askWhen: COMMERCIAL, hold: 'Tell us if you would host a battery to see battery income' },
  { key: 'charger_site_available', order: 450, type: 'yesno', question: 'Would you host EV chargers for the public?', askWhen: COMMERCIAL, hold: 'Tell us if you would host public chargers to see charger income' },
  { key: 'telecom_site_available', order: 460, type: 'yesno', question: 'Would you lease roof space for phone or internet equipment?', askWhen: COMMERCIAL, hold: 'Tell us if you would lease roof space to see telecom income' },
  { key: 'fleet_parking_available', order: 470, type: 'yesno', question: 'Could you rent parking to a company with vans or trucks?', askWhen: COMMERCIAL, hold: 'Tell us if you could rent parking to a company to see fleet income' },
  { key: 'signage_available', order: 480, type: 'yesno', question: 'Would you let someone put up a sign or billboard?', askWhen: COMMERCIAL, hold: 'Tell us if you would host a sign to see sign income' },
  { key: 'parcel_locker_available', order: 490, type: 'yesno', question: 'Would you host a parcel locker here?', askWhen: COMMERCIAL, hold: 'Tell us if you would host a parcel locker to see locker income' },
].map((d) => Object.freeze(d)));

/** The gear a person can tick, in the order shown (the keys match the `includes` values the gear categories look for). */
export const GEAR_CHOICES = Object.freeze([['atv', 'ATV'], ['snowmobile', 'Snowmobile'], ['kayak', 'Kayak'], ['boat', 'Boat'], ['jet_ski', 'Jet ski'], ['ebike', 'E-bike'], ['camper', 'Camper']]);

/**
 * Which revenue input (a key of core/revenue.js INPUT_KEYS) each size answer feeds, per category. EMPTY ON PURPOSE: the revenue model has no
 * size-dependent input today (price per space and bookings are planning defaults), so a size is kept and shown but never changes an estimate.
 * Add an entry here only when revenue.js gets an input that really depends on size.
 * @type {Readonly<Record<string,{sizeKey:string, input:string}>>}
 */
export const SIZE_INPUTS = Object.freeze({});
/** The size answers that belong to each category (so its details can say honestly that the size is not used yet). */
export const CATEGORY_SIZE_KEYS = Object.freeze({
  attic_storage: ['attic_area_sqft'],
  basement_storage: ['basement_area_sqft', 'shed_area_sqft', 'storage_unit_area_sqft'],
  garage_storage: ['garage_area_sqft'],
  warehouse_storage: ['warehouse_area_sqft'],
});

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
    evidence: {"class":"owner","ownerKeys":["workspace_available"],"question":"Do you have a room, garage or studio you could rent out as a workspace?"},
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
    evidence: {"class":"owner","ownerKeys":["film_location_available"],"question":"Would you let film or photo crews shoot at the property?"},
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
    evidence: {"class":"owner","ownerKeys":["kitchen_available"],"question":"Do you have a kitchen suitable for rent (commercial or shared-use) and would you rent it out?"},
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
    evidence: {"class":"owner","ownerKeys":["sport_court_available"],"question":"Do you have a sport court (tennis, basketball, pickleball...) on the property?"},
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
    evidence: {"class":"owner","ownerKeys":["meeting_room_available"],"question":"Do you have a meeting or event room you could rent by the hour?"},
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
    evidence: {"class":"owner","ownerKeys":["rv_parking_available"],"question":"Is there a pad or space where an RV or trailer could park?"},
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
    evidence: {"class":"owner","ownerKeys":["ev_charging_available"],"question":"Do you have an EV charger installed that you would share?","investment":{"requires":{"all":[{"attr":"property_type","in":["single_family","condo","multi_family","commercial"]},{"any":[{"attr":"parking_spaces"},{"attr":"driveway_area_sqft"},{"attr":"garage_present","equals":true}]}]},"basis":"construction"}},
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
    evidence: {"class":"owner","ownerKeys":["waterfront_access"],"question":"Do you have water access, such as a dock or boat slip?"},
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
    evidence: {"class":"owner","ownerKeys":["lot_parking_available"],"question":"Do you have a parking lot with spaces you could rent out?"},
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
    evidence: {"class":"owner","ownerKeys":["attic_present"],"question":"Do you have an attic you could store things in?"},
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
    evidence: {"class":"owner","ownerKeys":["basement_present","shed_present","storage_unit_present"],"question":"Do you have a basement or shed you could rent for storage?"},
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
    evidence: {"class":"owner","ownerKeys":["warehouse_storage_available"],"question":"Do you have warehouse or large indoor space you could rent for storage?"},
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
    evidence: {"class":"owner","ownerKeys":["beehive_site_available"],"question":"Would you allow a beekeeper to place hives on the property?"},
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
    evidence: {"class":"owner","ownerKeys":["pasture_available"],"question":"Do you have grazing land or pasture you could rent out?"},
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
    evidence: {"class":"owner","ownerKeys":["battery_site_available"],"question":"Would you host an energy-storage battery on the property?"},
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
    evidence: {"class":"owner","ownerKeys":["charger_site_available"],"question":"Would you host public or shared EV chargers on the property?"},
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
    evidence: {"class":"owner","ownerKeys":["telecom_site_available"],"question":"Would you lease roof or tower space to a telecom provider?"},
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
    evidence: {"class":"owner","ownerKeys":["fleet_parking_available"],"question":"Could you rent parking space to a vehicle fleet (vans, trucks)?"},
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
    evidence: {"class":"owner","ownerKeys":["signage_available"],"question":"Would you lease space on the property for signage or billboards?"},
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
    evidence: {"class":"owner","ownerKeys":["parcel_locker_available"],"question":"Would you host a parcel locker on the property?"},
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
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own a ATV you could rent out?"},
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
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own a snowmobile you could rent out?"},
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
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own a kayak you could rent out?"},
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
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own a boat you could rent out?"},
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
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own a jet ski you could rent out?"},
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
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own a e-bike you could rent out?"},
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
    evidence: {"class":"owner","ownerKeys":["equipment_owned"],"question":"Do you own a camper you could rent out?"},
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
  assigned_parking_spaces: 'How many parking spaces are assigned to your unit?',
  storage_unit_present: 'Do you have a storage unit or locker that belongs to your unit?',
  balcony_present: 'Does your unit have a balcony or patio?',
  hoa_allows_rentals: "Does your HOA allow you to rent out your unit or a room in it?",
  units_available_to_rent: 'How many of the units in the building could you offer this way?',
  laundry_room_present: 'Does the building have a laundry room?',
  roof_access_present: 'Can you get to the roof, and is it yours to use?',
};

/**
 * What the page asks a CONDO owner (one unit in a building). `type` says how to show the question: 'number' (whole number), 'yesno' (a yes or no),
 * 'choice' (one of `choices`, stored as that string). The answers are owner-confirmed attributes with these keys.
 * @type {ReadonlyArray<{key:string, question:string, type:'number'|'yesno'|'choice', choices?:string[]}>}
 */
export const CONDO_OWNER_KEYS = Object.freeze([
  { key: 'assigned_parking_spaces', question: 'How many parking spaces are assigned to your unit?', type: /** @type {const} */ ('number') },
  { key: 'storage_unit_present', question: 'Do you have a storage unit or locker that belongs to your unit?', type: /** @type {const} */ ('yesno') },
  { key: 'balcony_present', question: 'Does your unit have a balcony or patio?', type: /** @type {const} */ ('yesno') },
  { key: 'hoa_allows_rentals', question: 'Does your HOA allow you to rent out your unit or a room in it?', type: /** @type {const} */ ('choice'), choices: ['yes', 'no', 'unsure'] },
].map((x) => Object.freeze(x)));

/**
 * What the page asks the owner of a whole multi-unit BUILDING (same shape as CONDO_OWNER_KEYS). `parking_spaces` is the existing key.
 * @type {ReadonlyArray<{key:string, question:string, type:'number'|'yesno'|'choice', choices?:string[]}>}
 */
export const BUILDING_OWNER_KEYS = Object.freeze([
  { key: 'units_available_to_rent', question: 'How many of the units in the building could you offer this way?', type: /** @type {const} */ ('number') },
  { key: 'parking_spaces', question: 'How many parking spaces does the building have?', type: /** @type {const} */ ('number') },
  { key: 'laundry_room_present', question: 'Does the building have a laundry room?', type: /** @type {const} */ ('yesno') },
  { key: 'roof_access_present', question: 'Can you get to the roof, and is it yours to use?', type: /** @type {const} */ ('yesno') },
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

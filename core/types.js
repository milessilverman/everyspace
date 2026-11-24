// @ts-check
// Everyspace core contracts. Plain ES modules, zero dependencies, no I/O: every module in /core runs unchanged in
// the browser (GitHub Pages), Node (tests) and Deno (edge functions). This file is the interface between modules;
// change it only together with docs/STATE.md.
//
// Rules that every module follows:
//  - Money is integer cents. Rates are fractions (0.03 = 3%). Times are ISO-8601 strings. No Date.now() inside
//    pure functions: `now` is always passed in.
//  - Nothing is guessed. A value that cannot be obtained is returned as tag 'unavailable' with a reason, never 0.
//  - Every number shown to an owner is a Sourced value, so its source and confidence can be displayed.

/**
 * Provenance tag for any property attribute or model input.
 *  - measured:        read from an authoritative record or computed from recorded geometry (assessor, parcel polygon)
 *  - estimated:       derived by a rule of thumb, model or uncited planning default
 *  - owner-confirmed: typed or confirmed by the owner; always overrides automated values
 *  - unavailable:     not obtainable; `value` is null and `note` says why
 * @typedef {'measured'|'estimated'|'owner-confirmed'|'unavailable'} ProvenanceTag
 */

/**
 * A value with its provenance.
 * @template T
 * @typedef {Object} Sourced
 * @property {T|null} value
 * @property {string} [unit]            e.g. 'sqft', 'cents', 'm', 'fraction'
 * @property {ProvenanceTag} tag
 * @property {string} source            who published or supplied it, e.g. 'LA County Assessor', 'Owner'
 * @property {string} [sourceUrl]
 * @property {string} [license]         licence or terms note, e.g. 'ODbL 1.0'
 * @property {string|null} retrievedAt  ISO time the value was fetched or entered; null for static defaults
 * @property {number} confidence        0..1. 'unavailable' is always 0.
 * @property {string} [method]          how it was derived, e.g. 'parcel polygon area minus building footprints'
 * @property {string} [note]            caveat shown to the owner
 */

/** @typedef {'low'|'medium'|'high'} ConfidenceLabel  low < 0.4 <= medium < 0.75 <= high */

/**
 * Canonical attribute keys of a property profile. New keys may be added without schema changes.
 * @typedef {'address'|'location'|'jurisdiction'|'parcel_id'|'parcel_boundary'|'lot_area_sqft'|'property_type'
 *   |'use_type'|'year_built'|'bedrooms'|'living_area_sqft'|'units'|'buildings'|'building_footprint_sqft'
 *   |'roof_area_sqft'|'yard_area_sqft'|'driveway_area_sqft'|'parking_spaces'|'garage_present'|'pool_present'
 *   |'adu_present'|'zoning'|'transit_distance_m'|'demand_generators'} AttributeKey
 */

/**
 * Value shapes for the structured keys:
 *  location          {lat:number, lng:number}
 *  jurisdiction      {country:'US', state:string, countyFips?:string, county?:string, city?:string}
 *  parcel_boundary   GeoJSON Polygon or MultiPolygon (WGS84)
 *  property_type     'single_family'|'condo'|'multi_family'|'land'|'commercial'|'unknown'
 *  buildings         Array<{footprintSqft:number, polygon?:object}>
 *  demand_generators Array<{name:string, kind:string, distanceM:number}>
 * @typedef {Object} PropertyProfile
 * @property {Record<string, Sourced<any>>} attributes  the current winning value per key (see provenance.resolve)
 * @property {Record<string, Sourced<any>[]>} history   every value ever recorded per key, oldest first
 */

/** @typedef {'hour'|'day'|'night'|'week'|'month'} DurationUnit */

/**
 * How ready an opportunity is.
 *  existing: the asset is there and usable now · setup: needs minor purchases or preparation
 *  permit: needs a permit or registration first · construction: needs building work or major investment
 * @typedef {'existing'|'setup'|'permit'|'construction'} OpportunityBasis
 */

/**
 * @typedef {Object} Feasibility
 * @property {'feasible'|'restricted'|'prohibited'|'unknown'} status
 * @property {Array<{ruleId:string, summary:string, effect:'allow'|'restrict'|'prohibit'|'require', verified:boolean, sourceUrl?:string}>} rules
 * @property {number} confidence  0..1; unverified rules cap this at 0.3
 * @property {string[]} requirements  e.g. 'Home-sharing registration number'
 * @property {string} [note]
 */

/**
 * A way a property could earn. Produced by opportunities.identifyOpportunities, consumed by revenue and optimizer.
 * @typedef {Object} Opportunity
 * @property {string} id               stable within one profile, e.g. 'driveway_parking'
 * @property {string} categoryKey      key in core/data/categories.js
 * @property {string} label
 * @property {OpportunityBasis} basis
 * @property {DurationUnit} unit       the unit its price is quoted in
 * @property {string[]} evidence       attribute keys that justify it, e.g. ['driveway_area_sqft']
 * @property {number} evidenceConfidence  min confidence of the evidence attributes
 * @property {Feasibility} feasibility
 * @property {string[]} conflictsWith  ids of opportunities that cannot run together with this one
 * @property {Record<string, number>} resourceUse  shared resources consumed, e.g. {parking: 1, bathroom: 1}
 * @property {number} effort           1 (hands-off) .. 5 (daily work); a labelled assumption
 * @property {number} privacyImpact    0 (no one on the property) .. 3 (strangers inside the home)
 * @property {boolean} strangersInHome
 * @property {string[]} notes
 */

/**
 * Inputs to the revenue model for one opportunity. Every field is Sourced so it can be displayed and overridden.
 * @typedef {Object} EstimateInputs
 * @property {Sourced<number>} priceCents            price per `unit`, before fees
 * @property {Sourced<number>} unitsPerMonth         billable units sold in an average month
 * @property {Sourced<number>} capacityUnitsPerMonth units that could be sold in a month (for occupancy)
 * @property {Sourced<number>} bookingsPerMonth      number of separate bookings (drives per-booking costs)
 * @property {Sourced<number>} platformFeeRate       host-side marketplace fee, fraction of gross
 * @property {Sourced<number>} cleaningCentsPerBooking
 * @property {Sourced<number>} utilitiesCentsPerMonth
 * @property {Sourced<number>} insuranceCentsPerMonth
 * @property {Sourced<number>} taxRate               occupancy/sales tax borne by the host, fraction of gross
 * @property {Sourced<number>} permitCentsPerYear
 * @property {Sourced<number>} upfrontCents          one-time cost to start
 * @property {Sourced<number[]>} seasonality         12 monthly multipliers (Jan..Dec) averaging 1.0
 */

/** @typedef {'conservative'|'baseline'|'optimistic'} ScenarioName */

/**
 * @typedef {Object} ScenarioResult
 * @property {number} grossCentsPerMonth
 * @property {number} platformFeeCentsPerMonth
 * @property {number} cleaningCentsPerMonth
 * @property {number} utilitiesCentsPerMonth
 * @property {number} insuranceCentsPerMonth
 * @property {number} taxAndPermitCentsPerMonth
 * @property {number} noiCentsPerMonth      gross minus every cost above
 * @property {number} grossCentsPerYear
 * @property {number} noiCentsPerYear
 * @property {number[]} noiCentsByMonth     12 values, seasonality applied
 * @property {number} occupancy             0..1
 * @property {number} upfrontCents
 * @property {number|null} roi              first-year NOI / upfront; null when upfront is 0
 * @property {number|null} paybackMonths    null when NOI <= 0 or upfront is 0
 */

/**
 * @typedef {Object} OpportunityEstimate
 * @property {string} opportunityId
 * @property {boolean} available            false when a required input is 'unavailable'; scenarios is then null
 * @property {Record<ScenarioName, ScenarioResult>|null} scenarios
 * @property {number} confidence            0..1, never above the weakest material input
 * @property {ConfidenceLabel} confidenceLabel
 * @property {EstimateInputs} inputs        exactly what was used, for display
 * @property {Array<{key:string, text:string, source:string}>} assumptions
 * @property {string[]} missing             input names that were unavailable
 */

/**
 * @typedef {'max_net_income'|'min_upfront'|'min_effort'|'privacy'|'fastest_payback'} OwnerGoal
 *
 * @typedef {Object} OwnerConstraints
 * @property {number} [maxUpfrontCents]
 * @property {number} [maxEffort]                 1..5
 * @property {number} [maxPrivacyImpact]          0..3
 * @property {boolean} [noStrangersInHome]
 * @property {string[]} [preferredCategories]     tie-breaker and, with `onlyPreferred`, a filter
 * @property {boolean} [onlyPreferred]
 * @property {string[]} [excludedCategories]
 * @property {boolean} [allowUnknownRegulatory]   default false: 'unknown' feasibility is listed but not selected
 * @property {boolean} [includeInvestments]       default false: 'permit'/'construction' reported separately
 * @property {Record<string, number>} [resourceCapacity]  e.g. {parking: 2}
 *
 * @typedef {Object} OptimizationResult
 * @property {OwnerGoal} goal
 * @property {ScenarioName} scenario
 * @property {string[]} selected                       opportunity ids in the best feasible combination
 * @property {Array<{id:string, reason:string}>} rejected
 * @property {{noiCentsPerMonth:number, noiCentsPerYear:number, grossCentsPerYear:number, upfrontCents:number,
 *   paybackMonths:number|null, effort:number, privacyImpact:number}} totals
 * @property {string[]} investments                    ids needing permit/construction, evaluated separately
 * @property {number} naiveSumNoiCentsPerYear          sum over all available opportunities, shown to explain
 *                                                     why the combination is lower than "everything added up"
 * @property {number} confidence
 */

export {};

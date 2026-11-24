// @ts-check
// Scenario spread sets for the revenue model. MODELLING ASSUMPTIONS, not market data.
// Copied from docs/revenue-method.md §4 ("Scenarios"). `price` multiplies priceCents, `volume` multiplies
// unitsPerMonth (before the capacity cap).
//  - uncalibrated:  used when price or volume is a planning default (anything but owner-confirmed)
//  - owner-history: used when price AND volume are both owner-confirmed

/** @typedef {import('../types.js').ScenarioName} ScenarioName */
/** @typedef {{price:number, volume:number}} ScenarioFactors */
/** @typedef {'uncalibrated'|'owner-history'} SpreadSetName */

export const SCENARIO_NAMES = /** @type {ScenarioName[]} */ (Object.freeze(['conservative', 'baseline', 'optimistic']));

export const SPREAD_SOURCE = 'docs/revenue-method.md §4 (Everyspace modelling assumption)';

/** @type {Readonly<Record<SpreadSetName, Readonly<Record<ScenarioName, Readonly<ScenarioFactors>>>>>} */
export const SPREAD_SETS = Object.freeze({
  uncalibrated: Object.freeze({
    conservative: Object.freeze({ price: 0.85, volume: 0.60 }),
    baseline: Object.freeze({ price: 1, volume: 1 }),
    optimistic: Object.freeze({ price: 1.10, volume: 1.30 }),
  }),
  'owner-history': Object.freeze({
    conservative: Object.freeze({ price: 0.95, volume: 0.85 }),
    baseline: Object.freeze({ price: 1, volume: 1 }),
    optimistic: Object.freeze({ price: 1.05, volume: 1.15 }),
  }),
});

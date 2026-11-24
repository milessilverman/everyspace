// @ts-check
// Regulatory rules as data. Adding a jurisdiction = adding an entry here (or passing `jurisdictions` to
// checkFeasibility); no code change.
//
// HARD RULE: official sources could not be fetched on 2026-11-24, so EVERY rule below has verified:false,
// verifiedAt:null, sourceUrl:null. `sourceRef` points to where the statement lives in THIS repo. Nothing here comes
// from memory. Do not flip `verified` until someone checks the official page and records `sourceUrl` + `verifiedAt`.
//
// Seeds:
//  1. Los Angeles: only what platform/docs/PLAN.md lines 126-127 state.
//  2. Generic (no jurisdiction): the per-category requirement checklists from index.html CATEGORIES, as `require` rules.
import { CHECKLISTS } from './categories.js';

/**
 * @typedef {Object} JurisdictionRule
 * @property {string} id
 * @property {{state?:string, county?:string, city?:string}|null} jurisdiction  null = generic (applies anywhere)
 * @property {string[]} [categoryKeys]
 * @property {string[]} [groups]
 * @property {'allow'|'restrict'|'prohibit'|'require'} effect
 * @property {string} summary
 * @property {string[]} requirements
 * @property {Record<string, any>} params
 * @property {boolean} verified
 * @property {string|null} verifiedAt
 * @property {string|null} sourceUrl
 * @property {string} sourceRef
 */

const LA = { state: 'CA', county: 'Los Angeles', city: 'Los Angeles' };

/** @type {JurisdictionRule[]} */
const LOS_ANGELES = [
  {
    id: 'us-ca-los-angeles/home-sharing',
    jurisdiction: LA,
    categoryKeys: ['entire_home'],
    effect: 'restrict',
    summary: "LA's Home-Sharing Ordinance applies: primary residence, a registration number on every listing, and a 120-day cap without an extended permit.",
    requirements: ['Home-sharing registration number on every listing', 'Must be the host\'s primary residence'],
    params: { primaryResidenceOnly: true, registrationNumberRequired: true, maxDaysPerYearWithoutExtendedPermit: 120 },
    verified: false,
    verifiedAt: null,
    sourceUrl: null,
    sourceRef: 'platform/docs/PLAN.md:126',
  },
  {
    id: 'us-ca-los-angeles/hourly-spaces',
    jurisdiction: LA,
    categoryKeys: ['pool', 'parking_spot'],
    effect: 'require',
    summary: 'Hourly spaces (pools, driveways) follow different rules than home-sharing. The specific rules are not on file.',
    requirements: ['Check the hourly-space rules with the City of Los Angeles'],
    params: {},
    verified: false,
    verifiedAt: null,
    sourceUrl: null,
    sourceRef: 'platform/docs/PLAN.md:127',
  },
];

/** @type {JurisdictionRule[]} */
const GENERIC = CHECKLISTS.filter((c) => c.items.length > 0).map((c) => ({
  id: `generic/checklist/${c.key}`,
  jurisdiction: null,
  categoryKeys: [c.key],
  effect: /** @type {'require'} */ ('require'),
  summary: 'Everyspace requirement checklist for this kind of space (not a legal rule).',
  requirements: [...c.items],
  params: {},
  verified: false,
  verifiedAt: null,
  sourceUrl: null,
  sourceRef: `index.html:${c.line}`,
}));

/** @type {JurisdictionRule[]} */
export const JURISDICTIONS = [...LOS_ANGELES, ...GENERIC];

/**
 * Per-jurisdiction defaults. Nothing in the repo states a tax rate or permit cost, so every value is unavailable.
 * @type {Array<{id:string, jurisdiction:{state?:string,county?:string,city?:string}, taxRate:{status:'unavailable', value:null, reason:string}, permitCentsPerYear:{status:'unavailable', value:null, reason:string}}>}
 */
export const JURISDICTION_DEFAULTS = [
  {
    id: 'us-ca-los-angeles',
    jurisdiction: LA,
    taxRate: { status: 'unavailable', value: null, reason: 'Not stated anywhere in this repo; official source not fetched on 2026-11-24.' },
    permitCentsPerYear: { status: 'unavailable', value: null, reason: 'Not stated anywhere in this repo; official source not fetched on 2026-11-24.' },
  },
];

// @ts-check
// Default revenue-model assumptions.
//
// NONE OF THESE NUMBERS ARE MARKET DATA. They are Everyspace planning defaults copied verbatim from tables that
// already exist in index.html, which carry no citation. Every value is tagged 'estimated', source
// 'Everyspace planning default (uncited)', and can be overridden by the owner. A category/unit with no entry here
// has no default, and the revenue model reports that input as 'unavailable' (never 0).
//
//  - Prices: index.html TYPICAL (lines 5298-5313; rows 5299-5312), in dollars per term; confidence 0.2.
//      Term -> unit mapping uses index.html TERMS (lines 5118-5125): hourly=hour, daily=day (also night: "Nightly /
//      daily"), weekly=week, monthly=month, lease=month (fixed lease priced per month), infrastructure=year.
//      For a 'month' unit, monthly is used first, then lease; infrastructure (per year) is divided by 12 exactly as
//      the existing estimate engine does (index.html:17872 `rate / (t === 'infrastructure' ? 12 : 1)`).
//  - Volumes: the default usage level of the index.html earnings quiz (estimateItem, lines 17744-17880). New
//      items start at freq 1 = "Often" (index.html:17689), so the value is USE[...].amounts[1] (index.html:17642-17652)
//      for the usage kind that useFor picks (index.html:17670-17684); confidence 0.15.
//      'occupancy' entries are a fraction of the time rented; the model converts them to units with the
//      capacity of the unit (month: x1, week: x 30.4/7). Only month and week units use occupancy.
//      'lease' entries (company leases, index.html:17682 "pay the same every month") are 1 billable month per month.
//      Gear rents `gearDays` days a month in season for SEASON months (index.html:17612), averaged over 12 months
//      exactly as estimateItem does (`u * rate * season / 12`).

export const DEFAULT_SOURCE = 'Everyspace planning default (uncited)';
export const PRICE_CONFIDENCE = 0.2;
export const VOLUME_CONFIDENCE = 0.15;

/** Verbatim copy of index.html TYPICAL (dollars per term), with the line each row came from. */
export const TYPICAL = Object.freeze({
  entire_home: { line: 5299, terms: { daily: 180, weekly: 1100, monthly: 3500, lease: 3200 } },
  apartment_unit: { line: 5299, terms: { daily: 120, monthly: 2000, lease: 1850 } },
  adu: { line: 5300, terms: { daily: 110, weekly: 650, monthly: 1800, lease: 1700 } },
  private_room: { line: 5300, terms: { daily: 70, weekly: 420, monthly: 1100, lease: 1000 } },
  backyard: { line: 5301, terms: { hourly: 30, daily: 150 } },
  yard_campsite: { line: 5301, terms: { daily: 30, weekly: 180 } },
  pool: { line: 5301, terms: { hourly: 40 } },
  workspace: { line: 5302, terms: { hourly: 15, daily: 80, monthly: 400 } },
  film_location: { line: 5302, terms: { hourly: 150, daily: 900 } },
  kitchen: { line: 5303, terms: { hourly: 25, daily: 150, monthly: 900 } },
  sport_court: { line: 5303, terms: { hourly: 20 } },
  parking_spot: { line: 5304, terms: { hourly: 4, daily: 15, weekly: 70, monthly: 130, lease: 120 } },
  rv_parking: { line: 5304, terms: { weekly: 70, monthly: 220, lease: 200 } },
  ev_charging: { line: 5305, terms: { hourly: 5, daily: 25, monthly: 120 } },
  dock_slip: { line: 5305, terms: { daily: 40, weekly: 220, monthly: 350, lease: 320 } },
  garage_storage: { line: 5306, terms: { weekly: 25, monthly: 90, lease: 80 } },
  attic_storage: { line: 5306, terms: { monthly: 50, lease: 45 } },
  basement_storage: { line: 5306, terms: { weekly: 20, monthly: 60, lease: 55 } },
  garden_plot: { line: 5307, terms: { monthly: 25, lease: 20 } },
  beehive_site: { line: 5307, terms: { monthly: 15, lease: 12 } },
  pasture: { line: 5307, terms: { monthly: 120, lease: 100 } },
  rooftop_solar: { line: 5308, terms: { infrastructure: 1000 } },
  battery_site: { line: 5308, terms: { infrastructure: 600 } },
  charger_site: { line: 5308, terms: { infrastructure: 1500 } },
  telecom_site: { line: 5308, terms: { infrastructure: 3500 } },
  fleet_parking: { line: 5309, terms: { monthly: 180, lease: 160 } },
  signage: { line: 5309, terms: { lease: 400, infrastructure: 4200 } },
  parcel_locker: { line: 5309, terms: { lease: 75, infrastructure: 900 } },
  lot_parking: { line: 5310, terms: { hourly: 4, daily: 15, monthly: 90 } },
  warehouse_storage: { line: 5310, terms: { monthly: 45, lease: 40 } },
  meeting_room: { line: 5310, terms: { hourly: 35, daily: 220 } },
  atv: { line: 5311, terms: { hourly: 45, daily: 225, weekly: 1000 } },
  snowmobile: { line: 5311, terms: { hourly: 60, daily: 275, weekly: 1200 } },
  kayak: { line: 5311, terms: { hourly: 15, daily: 45, weekly: 180 } },
  boat: { line: 5312, terms: { hourly: 95, daily: 450 } },
  jet_ski: { line: 5312, terms: { hourly: 85, daily: 350 } },
  ebike: { line: 5312, terms: { hourly: 12, daily: 50, weekly: 220 } },
  camper: { line: 5312, terms: { daily: 110, weekly: 650 } },
});

/** Which TYPICAL terms can price each DurationUnit, in order of preference, and the divisor to reach that unit. */
const TERM_FOR_UNIT = Object.freeze({
  hour: [['hourly', 1]],
  day: [['daily', 1]],
  night: [['daily', 1]],
  week: [['weekly', 1]],
  month: [['monthly', 1], ['lease', 1], ['infrastructure', 12]],
});

/**
 * Default price for a category and unit, or null when TYPICAL has no matching term.
 * @param {string} categoryKey
 * @param {string} unit
 * @returns {{valueCents:number, term:string, source:string, sourceRef:string, confidence:number, method:string}|null}
 */
export function defaultPrice(categoryKey, unit) {
  const row = own(TYPICAL, categoryKey) ? TYPICAL[/** @type {keyof typeof TYPICAL} */ (categoryKey)] : null;
  const options = own(TERM_FOR_UNIT, unit) ? TERM_FOR_UNIT[/** @type {keyof typeof TERM_FOR_UNIT} */ (unit)] : null;
  if (!row || !options) return null;
  /** @type {Record<string, number>} */
  const terms = row.terms;
  for (const [term, divisor] of options) {
    if (terms[term] == null) continue;
    const valueCents = Math.round((terms[term] * 100) / /** @type {number} */ (divisor));
    return {
      valueCents,
      term: /** @type {string} */ (term),
      source: DEFAULT_SOURCE,
      sourceRef: `index.html:${row.line} TYPICAL`,
      confidence: PRICE_CONFIDENCE,
      method: divisor === 1
        ? `TYPICAL.${categoryKey}.${term} = $${terms[term]} per ${unit}`
        : `TYPICAL.${categoryKey}.${term} = $${terms[term]} per year / ${divisor} (as index.html:17872)`,
    };
  }
  return null;
}

// Volume defaults per category and unit.
//  kind 'units':     value is billable units per month
//  kind 'occupancy': value is the fraction of time rented (converted with the unit's capacity)
const NIGHTLY = { kind: 'units', value: 16, sourceRef: 'index.html:17643 USE.nightly[1] (home_full nightly, 17673)' };
const STAY_NIGHTS = { kind: 'units', value: 12, sourceRef: 'index.html:17644 USE.stayNights[1] (17675-17676)' };
const OCCUPANCY = { kind: 'occupancy', value: 0.75, sourceRef: 'index.html:17645 USE.occupancy[1] (17673-17681)' };
const HOURS = { kind: 'units', value: 16, sourceRef: 'index.html:17647 USE.hours[1] (hourly kind, 17677)' };
const PARK_DAYS = { kind: 'units', value: 8, sourceRef: 'index.html:17648 USE.parkDays[1] (parking daily, 17678)' };
const EV_SLOW = { kind: 'units', value: 30, sourceRef: 'index.html:17649 USE.evSlow[1] (slow charger default, 17679, 17696)' };
const LEASE = { kind: 'units', value: 1, sourceRef: 'index.html:17682 "company leases pay the same every month"' };
const GEAR_DAYS = 5; // index.html:17651 USE.gearDays[1]
/** @param {number} season months a year, index.html:17612 SEASON */
const gear = (season) => ({
  kind: 'units',
  value: (GEAR_DAYS * season) / 12,
  sourceRef: `index.html:17651 USE.gearDays[1]=5 x SEASON=${season} (17612) / 12`,
});

/** @typedef {{kind:'units'|'occupancy', value:number, sourceRef:string}} VolumeDefault */

/** @type {Readonly<Record<string, Readonly<Record<string, VolumeDefault>>>>} */
export const VOLUMES = /** @type {any} */ (Object.freeze({
  entire_home: { night: NIGHTLY, day: NIGHTLY, month: OCCUPANCY },
  apartment_unit: { night: STAY_NIGHTS, day: STAY_NIGHTS, month: OCCUPANCY },
  adu: { night: STAY_NIGHTS, day: STAY_NIGHTS, month: OCCUPANCY },
  private_room: { night: STAY_NIGHTS, day: STAY_NIGHTS, month: OCCUPANCY },
  backyard: { hour: HOURS },
  pool: { hour: HOURS },
  workspace: { hour: HOURS },
  kitchen: { hour: HOURS },
  sport_court: { hour: HOURS },
  meeting_room: { hour: HOURS },
  film_location: { hour: HOURS },
  yard_campsite: { night: STAY_NIGHTS, day: STAY_NIGHTS },
  parking_spot: { day: PARK_DAYS, month: OCCUPANCY },
  lot_parking: { day: PARK_DAYS, month: OCCUPANCY },
  ev_charging: { hour: EV_SLOW },
  garage_storage: { week: OCCUPANCY, month: OCCUPANCY },
  basement_storage: { week: OCCUPANCY, month: OCCUPANCY },
  attic_storage: { week: OCCUPANCY, month: OCCUPANCY },
  warehouse_storage: { week: OCCUPANCY, month: OCCUPANCY },
  rv_parking: { week: OCCUPANCY, month: OCCUPANCY },
  dock_slip: { week: OCCUPANCY, month: OCCUPANCY },
  garden_plot: { week: OCCUPANCY, month: OCCUPANCY },
  beehive_site: { week: OCCUPANCY, month: OCCUPANCY },
  pasture: { week: OCCUPANCY, month: OCCUPANCY },
  fleet_parking: { week: OCCUPANCY, month: OCCUPANCY },
  rooftop_solar: { month: LEASE },
  battery_site: { month: LEASE },
  charger_site: { month: LEASE },
  telecom_site: { month: LEASE },
  signage: { month: LEASE },
  parcel_locker: { month: LEASE },
  atv: { day: gear(12) },
  snowmobile: { day: gear(4) },
  kayak: { day: gear(6) },
  boat: { day: gear(5) },
  jet_ski: { day: gear(5) },
  ebike: { day: gear(10) },
  camper: { day: gear(7) },
}));

/**
 * @param {string} categoryKey
 * @param {string} unit
 * @returns {VolumeDefault|null}
 */
export function defaultVolume(categoryKey, unit) {
  const row = own(VOLUMES, categoryKey) ? VOLUMES[categoryKey] : null;
  return row && own(row, unit) ? row[unit] : null;
}

/** @param {object} o @param {string} k */
function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

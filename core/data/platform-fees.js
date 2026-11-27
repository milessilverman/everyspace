// @ts-check
// Host-side marketplace fees, copied from everyspace-demo index.html PLATFORMS (lines 5978-6001). That table's own header
// (everyspace-demo index.html:5947-5949, 5974-5977) says these are ASSUMPTIONS to verify before launch; `verified` is preserved
// exactly. NOT market data verified by Everyspace. Default confidence 0.2: an uncited, unverified number (docs/STATE.md hard rule).
//
// Only `hostFeePct` is used by the revenue model (EstimateInputs.platformFeeRate is a fraction of gross that the
// host pays). `perBookingFee` (dollars) is kept for display; the model has no per-booking fee input, so it is
// listed as "not included" in an estimate's assumptions when non-zero. Guest-side fees are not host costs.

/**
 * @typedef {Object} PlatformFee
 * @property {string} name
 * @property {number} hostFeeRate        fraction of gross kept by the platform
 * @property {number} perBookingFeeCents
 * @property {boolean} verified
 * @property {string} sourceRef
 */

export const FEE_SOURCE = 'everyspace-demo index.html PLATFORMS fee table (estimates, verified:false unless stated)';
export const FEE_CONFIDENCE = 0.2;

/** @type {Readonly<Record<string, Readonly<PlatformFee>>>} */
export const PLATFORM_FEES = Object.freeze({
  airbnb: { name: 'Airbnb', hostFeeRate: 0.155, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5979 PLATFORMS' },
  vrbo: { name: 'Vrbo', hostFeeRate: 0.12, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5980 PLATFORMS' },
  booking_com: { name: 'Booking.com', hostFeeRate: 0.15, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5981 PLATFORMS' },
  expedia: { name: 'Expedia', hostFeeRate: 0.17, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5982 PLATFORMS' },
  furnished_finder: { name: 'Furnished Finder', hostFeeRate: 0, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5983 PLATFORMS' },
  neighbor: { name: 'Neighbor', hostFeeRate: 0.049, perBookingFeeCents: 30, verified: false, sourceRef: 'everyspace-demo index.html:5984 PLATFORMS' },
  spothero: { name: 'SpotHero', hostFeeRate: 0.30, perBookingFeeCents: 250, verified: false, sourceRef: 'everyspace-demo index.html:5985 PLATFORMS' },
  swimply: { name: 'Swimply', hostFeeRate: 0.15, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5986 PLATFORMS' },
  peerspace: { name: 'Peerspace', hostFeeRate: 0.20, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5987 PLATFORMS' },
  sniffspot: { name: 'Sniffspot', hostFeeRate: 0.22, perBookingFeeCents: 22, verified: false, sourceRef: 'everyspace-demo index.html:5988 PLATFORMS' },
  hipcamp: { name: 'Hipcamp', hostFeeRate: 0.15, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5989 PLATFORMS' },
  giggster: { name: 'Giggster', hostFeeRate: 0.15, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5990 PLATFORMS' },
  evmatch: { name: 'EVmatch', hostFeeRate: 0.10, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5991 PLATFORMS' },
  kitchen_door: { name: 'The Kitchen Door', hostFeeRate: 0, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5992 PLATFORMS' },
  liquidspace: { name: 'LiquidSpace', hostFeeRate: 0.15, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5993 PLATFORMS' },
  spareroom: { name: 'SpareRoom', hostFeeRate: 0, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5994 PLATFORMS' },
  zillow: { name: 'Zillow Rentals', hostFeeRate: 0, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5995 PLATFORMS' },
  craigslist: { name: 'Craigslist', hostFeeRate: 0, perBookingFeeCents: 0, verified: true, sourceRef: 'everyspace-demo index.html:5996 PLATFORMS' },
  facebook: { name: 'Facebook Marketplace', hostFeeRate: 0, perBookingFeeCents: 0, verified: true, sourceRef: 'everyspace-demo index.html:5997 PLATFORMS' },
  getmyboat: { name: 'GetMyBoat', hostFeeRate: 0.10, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5998 PLATFORMS' },
  outdoorsy: { name: 'Outdoorsy', hostFeeRate: 0.20, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:5999 PLATFORMS' },
  rvshare: { name: 'RVshare', hostFeeRate: 0.25, perBookingFeeCents: 0, verified: false, sourceRef: 'everyspace-demo index.html:6000 PLATFORMS' },
});

// Category -> default channel, ONLY where everyspace-demo index.html's channel-fit RULES (lines 8315-8348, read by sitesFor at
// 8350) already rank a site first for that category with no feature requirement, for the given price unit.
// Ties at the same rank follow sitesFor's order (first rule wins). The catch-all
// `facebook` rule (rank 7, everyspace-demo index.html:8341) is NOT used as a default: it matches almost every category and implies
// no fit. Categories/units absent here have no implied channel, so platformFeeRate is 'unavailable'.
/** @type {Readonly<Record<string, ReadonlyArray<{units:string[], channel:string, sourceRef:string}>>>} */
export const DEFAULT_CHANNEL = Object.freeze({
  entire_home: [{ units: ['night', 'day', 'week', 'month'], channel: 'airbnb', sourceRef: 'everyspace-demo index.html:8316 RULES' }],
  apartment_unit: [{ units: ['night', 'day', 'week', 'month'], channel: 'airbnb', sourceRef: 'everyspace-demo index.html:8316 RULES' }],
  adu: [{ units: ['night', 'day', 'week', 'month'], channel: 'airbnb', sourceRef: 'everyspace-demo index.html:8316 RULES' }],
  private_room: [{ units: ['night', 'day', 'week', 'month'], channel: 'airbnb', sourceRef: 'everyspace-demo index.html:8316 RULES' }],
  pool: [{ units: ['hour'], channel: 'swimply', sourceRef: 'everyspace-demo index.html:8324 RULES' }],
  sport_court: [{ units: ['hour'], channel: 'swimply', sourceRef: 'everyspace-demo index.html:8324 RULES' }],
  backyard: [
    { units: ['hour'], channel: 'swimply', sourceRef: 'everyspace-demo index.html:8325 RULES' },
    { units: ['day'], channel: 'peerspace', sourceRef: 'everyspace-demo index.html:8326 RULES' },
  ],
  workspace: [
    { units: ['hour', 'day'], channel: 'peerspace', sourceRef: 'everyspace-demo index.html:8326 RULES' },
    { units: ['week', 'month'], channel: 'liquidspace', sourceRef: 'everyspace-demo index.html:8333 RULES' },
  ],
  meeting_room: [{ units: ['hour', 'day'], channel: 'peerspace', sourceRef: 'everyspace-demo index.html:8326 RULES' }],
  film_location: [{ units: ['hour', 'day'], channel: 'peerspace', sourceRef: 'everyspace-demo index.html:8326 RULES' }],
  kitchen: [{ units: ['hour', 'day', 'week', 'month'], channel: 'kitchen_door', sourceRef: 'everyspace-demo index.html:8334 RULES' }],
  yard_campsite: [{ units: ['day', 'night'], channel: 'hipcamp', sourceRef: 'everyspace-demo index.html:8332 RULES' }],
  rv_parking: [
    { units: ['week', 'month'], channel: 'neighbor', sourceRef: 'everyspace-demo index.html:8335 RULES' },
    { units: ['day', 'night'], channel: 'hipcamp', sourceRef: 'everyspace-demo index.html:8332 RULES' },
  ],
  pasture: [
    { units: ['day', 'night'], channel: 'hipcamp', sourceRef: 'everyspace-demo index.html:8332 RULES' },
    { units: ['month'], channel: 'craigslist', sourceRef: 'everyspace-demo index.html:8340 RULES' },
  ],
  dock_slip: [{ units: ['month'], channel: 'craigslist', sourceRef: 'everyspace-demo index.html:8340 RULES' }],
  garage_storage: [{ units: ['hour', 'day', 'week', 'month'], channel: 'neighbor', sourceRef: 'everyspace-demo index.html:8335 RULES' }],
  attic_storage: [{ units: ['hour', 'day', 'week', 'month'], channel: 'neighbor', sourceRef: 'everyspace-demo index.html:8335 RULES' }],
  basement_storage: [{ units: ['hour', 'day', 'week', 'month'], channel: 'neighbor', sourceRef: 'everyspace-demo index.html:8335 RULES' }],
  warehouse_storage: [{ units: ['hour', 'day', 'week', 'month'], channel: 'neighbor', sourceRef: 'everyspace-demo index.html:8335 RULES' }],
  parking_spot: [
    { units: ['month'], channel: 'neighbor', sourceRef: 'everyspace-demo index.html:8336 RULES' },
    { units: ['hour', 'day'], channel: 'spothero', sourceRef: 'everyspace-demo index.html:8338 RULES' },
  ],
  lot_parking: [
    { units: ['month'], channel: 'neighbor', sourceRef: 'everyspace-demo index.html:8336 RULES' },
    { units: ['hour', 'day', 'week'], channel: 'spothero', sourceRef: 'everyspace-demo index.html:8337 RULES' },
  ],
  ev_charging: [{ units: ['hour', 'day', 'week', 'month'], channel: 'evmatch', sourceRef: 'everyspace-demo index.html:8339 RULES' }],
  boat: [{ units: ['hour', 'day', 'week'], channel: 'getmyboat', sourceRef: 'everyspace-demo index.html:8343 RULES' }],
  jet_ski: [{ units: ['hour', 'day', 'week'], channel: 'getmyboat', sourceRef: 'everyspace-demo index.html:8343 RULES' }],
  kayak: [{ units: ['hour', 'day', 'week'], channel: 'getmyboat', sourceRef: 'everyspace-demo index.html:8343 RULES' }],
  camper: [{ units: ['day', 'night', 'week'], channel: 'outdoorsy', sourceRef: 'everyspace-demo index.html:8344 RULES' }],
  atv: [{ units: ['hour', 'day', 'week'], channel: 'craigslist', sourceRef: 'everyspace-demo index.html:8347 RULES' }],
  snowmobile: [{ units: ['hour', 'day', 'week'], channel: 'craigslist', sourceRef: 'everyspace-demo index.html:8347 RULES' }],
  ebike: [{ units: ['hour', 'day', 'week'], channel: 'craigslist', sourceRef: 'everyspace-demo index.html:8347 RULES' }],
});

/**
 * The implied default channel for a category and price unit, or null.
 * @param {string} categoryKey
 * @param {string} unit
 * @returns {{channel:string, fee:Readonly<PlatformFee>, ruleRef:string}|null}
 */
export function defaultChannelFor(categoryKey, unit) {
  const rows = Object.prototype.hasOwnProperty.call(DEFAULT_CHANNEL, categoryKey) ? DEFAULT_CHANNEL[categoryKey] : null;
  const row = rows?.find((r) => r.units.includes(unit));
  if (!row) return null;
  return { channel: row.channel, fee: PLATFORM_FEES[row.channel], ruleRef: row.sourceRef };
}

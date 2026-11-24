// @ts-check
// Immutable property profile. Every function returns a new profile; `history` keeps every value ever recorded and
// `attributes[key]` is always resolve(history[key]), so an owner correction survives later automated refreshes.

import { ownerConfirmed, resolve, unavailable, confidenceLabel } from './provenance.js';

/** @typedef {import('./types.js').PropertyProfile} PropertyProfile */
/** @typedef {import('./types.js').Sourced<any>} AnySourced */

/** @returns {PropertyProfile} */
export function createProfile() {
  return { attributes: {}, history: {} };
}

/**
 * Record a value for `key`. The winner is recomputed from the whole history.
 * @param {PropertyProfile} profile
 * @param {string} key
 * @param {AnySourced} sourcedValue
 * @returns {PropertyProfile}
 */
export function setAttribute(profile, key, sourcedValue) {
  if (!key || typeof key !== 'string') throw new TypeError('setAttribute: key is required');
  if (!sourcedValue || typeof sourcedValue !== 'object' || typeof sourcedValue.tag !== 'string') {
    throw new TypeError('setAttribute: value must be a Sourced value (see provenance.sourced)');
  }
  const nextHistory = [...(profile.history[key] ?? []), sourcedValue];
  return {
    attributes: { ...profile.attributes, [key]: resolve(nextHistory) },
    history: { ...profile.history, [key]: nextHistory },
  };
}

/**
 * Owner typed or confirmed a value; it overrides every automated value, present and future.
 * @param {PropertyProfile} profile
 * @param {string} key
 * @param {any} value
 * @param {string} at ISO time
 * @param {string} [unit]
 * @returns {PropertyProfile}
 */
export function applyOwnerCorrection(profile, key, value, at, unit) {
  return setAttribute(profile, key, ownerConfirmed(value, { unit, at }));
}

/**
 * @param {PropertyProfile} profile
 * @param {string} key
 * @returns {AnySourced}
 */
export function getAttribute(profile, key) {
  return profile.attributes[key] ?? unavailable('not recorded');
}

/**
 * Flat rows for display, in the order the attributes were first recorded.
 * @param {PropertyProfile} profile
 */
export function summarize(profile) {
  return Object.entries(profile.attributes).map(([key, s]) => ({
    key,
    value: s.value,
    unit: s.unit,
    tag: s.tag,
    source: s.source,
    confidence: s.confidence,
    confidenceLabel: confidenceLabel(s.confidence),
    retrievedAt: s.retrievedAt,
  }));
}

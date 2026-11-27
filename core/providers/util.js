// @ts-check
// Shared helpers for provider adapters: an HTTP call that classifies failures and never echoes secrets, Sourced-value
// builders, and the cross-check comparison used by the profile assembler. Reuses fetchJson/isoNow from core/parcel.js.

import { fetchJson, isoNow, num, pos, text } from '../parcel.js';
import { sourced, unavailable } from '../provenance.js';

export { isoNow, num, pos, text, sourced, unavailable };

/**
 * Replace every occurrence of a secret (raw or URL-encoded) in a message.
 * @param {string} message @param {Array<string|undefined|null>} secrets
 */
export function redact(message, secrets = []) {
  let out = String(message ?? '');
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 4) continue;
    for (const variant of new Set([s, encodeURIComponent(s)])) out = out.split(variant).join('[redacted]');
  }
  return out;
}

/**
 * GET/POST JSON through the injected fetch. Never throws. Failures carry a stable `code`:
 * auth (401/403), not_found (404), rate_limited (429), server_error (5xx), http_error (other), timeout, network,
 * malformed_json, no_fetch. `secrets` are removed from every message.
 * @param {string} url @param {any} deps @param {any} [init] @param {Array<string|undefined>} [secrets]
 * @returns {Promise<{ok:true, json:any}|{ok:false, reason:string, code:string, status?:number}>}
 */
export async function callJson(url, deps, init = {}, secrets = []) {
  const r = await fetchJson(url, deps, init);
  if (r.ok) return r;
  let code = r.code ?? 'no_fetch';
  if (code === 'http') {
    const s = r.status ?? 0;
    code = s === 401 || s === 403 ? 'auth' : s === 404 ? 'not_found' : s === 429 ? 'rate_limited' : s >= 500 ? 'server_error' : 'http_error';
  }
  return { ok: false, reason: redact(r.reason, secrets), code, ...(r.status ? { status: r.status } : {}) };
}

/** @param {string} reason @param {string} code @param {any} [extra] @returns {{ok:false, reason:string, code:string}} */
export const fail = (reason, code, extra = {}) => ({ ok: false, reason, code, ...extra });

/**
 * Attach a cross-check to a Sourced value without touching the original (sourced() itself drops unknown keys).
 * @param {any} s @param {any} crossCheck
 */
export const withCrossCheck = (s, crossCheck) => ({ ...s, crossCheck });

export const round = (/** @type {number} */ n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Compare two values of the same field. kind 'exact' (beds, baths, year, floors, units): equal = match, else conflict.
 * kind 'area': within 5% of `other` = match, within 15% = minor, else conflict. difference = value - other;
 * differencePct = |difference| / |other| * 100 (null when other is 0). Pure.
 * @param {number} value @param {number} other @param {'exact'|'area'} kind
 * @returns {{value:number, other:number, difference:number, differencePct:number|null, agreement:'match'|'minor'|'conflict'}}
 */
export function compareValues(value, other, kind) {
  const difference = round(value - other, 4);
  const differencePct = other === 0 ? null : round((Math.abs(value - other) / Math.abs(other)) * 100, 2);
  /** @type {'match'|'minor'|'conflict'} */
  let agreement;
  if (kind === 'exact') agreement = difference === 0 ? 'match' : 'conflict';
  else if (differencePct === null) agreement = difference === 0 ? 'match' : 'conflict';
  else agreement = differencePct <= 5 ? 'match' : differencePct <= 15 ? 'minor' : 'conflict';
  return { value, other, difference, differencePct, agreement };
}

/** Which comparison each profile field uses. */
export const COMPARE_KIND = /** @type {Record<string,'exact'|'area'>} */ ({
  lot_sqft: 'area', house_sqft: 'area', roof_sqft: 'area', floors: 'exact', beds: 'exact', baths: 'exact', year_built: 'exact', units: 'exact',
});

// @ts-check
// Provenance helpers: build Sourced values and pick the winning value from a history.
// Pure functions. No clock: callers pass times in. Contract types live in ./types.js.

/** @typedef {import('./types.js').Sourced<any>} AnySourced */
/** @typedef {import('./types.js').ProvenanceTag} ProvenanceTag */
/** @typedef {import('./types.js').ConfidenceLabel} ConfidenceLabel */

const TAGS = ['measured', 'estimated', 'owner-confirmed', 'unavailable'];

/** @param {string|null|undefined} iso */
const ms = (iso) => {
  if (iso == null) return -Infinity;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * Build a Sourced value. Throws on an invalid tag or confidence, or an inconsistent 'unavailable'.
 * Unknown meta keys are dropped.
 * @param {any} value
 * @param {{tag:ProvenanceTag, source:string, confidence:number, retrievedAt?:string|null, unit?:string,
 *   sourceUrl?:string, license?:string, method?:string, note?:string}} meta
 * @returns {AnySourced}
 */
export function sourced(value, meta) {
  if (!meta || typeof meta !== 'object') throw new TypeError('sourced: meta is required');
  const { tag, source, confidence } = meta;
  if (!TAGS.includes(tag)) throw new RangeError(`sourced: invalid tag ${String(tag)}`);
  if (typeof source !== 'string' || !source) throw new TypeError('sourced: source is required');
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) {
    throw new RangeError(`sourced: confidence must be a number in 0..1, got ${String(confidence)}`);
  }
  if (tag === 'unavailable') {
    if (value !== null) throw new RangeError("sourced: 'unavailable' must have value null");
    if (confidence !== 0) throw new RangeError("sourced: 'unavailable' must have confidence 0");
  } else if (value === null || value === undefined) {
    throw new RangeError(`sourced: tag '${tag}' needs a value; use unavailable() when there is none`);
  }
  /** @type {AnySourced} */
  const out = { value, tag, source, retrievedAt: meta.retrievedAt ?? null, confidence };
  for (const k of /** @type {const} */ (['unit', 'sourceUrl', 'license', 'method', 'note'])) {
    if (meta[k] !== undefined) out[k] = meta[k];
  }
  return out;
}

/**
 * A value that could not be obtained. `reason` is stored as the note.
 * @param {string} reason
 * @param {string} [source]
 * @returns {AnySourced}
 */
export function unavailable(reason, source = 'unknown') {
  return sourced(null, { tag: 'unavailable', source, confidence: 0, retrievedAt: null, note: reason });
}

/**
 * A value typed or confirmed by the owner. Always confidence 1.
 * @param {any} value
 * @param {{unit?:string, at:string}} opts
 * @returns {AnySourced}
 */
export function ownerConfirmed(value, { unit, at }) {
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new TypeError('ownerConfirmed: at must be an ISO time');
  return sourced(value, { tag: 'owner-confirmed', source: 'Owner', confidence: 1, retrievedAt: at, unit });
}

/**
 * The winning value of a history (oldest first): newest owner-confirmed; else highest confidence, then newest
 * retrievedAt (later entry wins a full tie); 'unavailable' only if nothing else exists. Does not mutate the input.
 * @param {AnySourced[]|undefined|null} history
 * @returns {AnySourced}
 */
export function resolve(history) {
  const list = Array.isArray(history) ? history : [];
  if (!list.length) return unavailable('no value recorded');
  const pick = (/** @type {AnySourced[]} */ items, /** @type {(a:AnySourced,b:AnySourced)=>number} */ better) =>
    items.reduce((best, cur) => (better(cur, best) >= 0 ? cur : best));
  const byTime = (/** @type {AnySourced} */ a, /** @type {AnySourced} */ b) => ms(a.retrievedAt) - ms(b.retrievedAt);
  const owner = list.filter((s) => s.tag === 'owner-confirmed');
  if (owner.length) return pick(owner, byTime);
  const usable = list.filter((s) => s.tag !== 'unavailable');
  if (usable.length) return pick(usable, (a, b) => a.confidence - b.confidence || byTime(a, b));
  return pick(list, byTime);
}

/**
 * low < 0.4 <= medium < 0.75 <= high
 * @param {number} n
 * @returns {ConfidenceLabel}
 */
export function confidenceLabel(n) {
  return n < 0.4 ? 'low' : n < 0.75 ? 'medium' : 'high';
}

/**
 * True when the value was retrieved more than maxAgeDays before `now`. A value with no retrievedAt (static default)
 * is never stale; an unparseable time is treated as stale.
 * @param {AnySourced} s
 * @param {string} now ISO time
 * @param {number} maxAgeDays
 */
export function isStale(s, now, maxAgeDays) {
  if (s.retrievedAt == null) return false;
  const t = Date.parse(s.retrievedAt);
  const n = Date.parse(now);
  if (Number.isNaN(t) || Number.isNaN(n)) return true;
  return n - t > maxAgeDays * 86400000;
}

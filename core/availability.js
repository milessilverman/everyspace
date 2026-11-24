// @ts-check
// Availability and conflict rules, mirrored from the database (migration 20261124050000_availability.sql).
//
// The database is authoritative for bookings (ADR 3): create_booking / import_reservations run the SQL version of
// these rules under the property lock. This module answers the same question in the browser, in Node and in Deno
// (previews, the optimizer), with no I/O and without reading the clock. platform/tests/availability_parity.test.mjs
// runs the shared fixture cases through both and fails if they ever disagree.
//
// Rules (docs/schema-proposal.md, "Availability rules (M5)"):
//   - Time ranges are half-open [startsAt, endsAt): back-to-back bookings do not overlap.
//   - A reservation or hold occupies its own space for [start - setupMinutes, end + cleanupMinutes). Buffers never
//     extend onto related spaces or onto shared resources.
//   - A space is blocked by bookings on itself, its ancestors and its descendants, and by bookings on any space with a
//     relation that blocks it (A blocks B: a booking on A blocks B; symmetric: both ways). Relations are not
//     transitive. Siblings with no relation are independent.
//   - quantity n: up to n bookings may overlap on the space itself (peak concurrent use, buffers included).
//   - A shared resource: the units of all bookings using it at the same moment (peak, not total) plus the candidate's
//     units must stay <= capacity.
//   - Holds in the model count as occupancy. The database also drops expired holds; here the caller passes only live
//     holds (this module never reads `now`).
//   - Cancelled reservations never count; kinds 'block' and 'owner_block' occupy like bookings.
// Result rows are sorted by kind, spaceId, reservationId, holdId, resourceId (nulls last), the same order as SQL.

/**
 * @typedef {string | number | Date} Instant ISO-8601 string, epoch milliseconds or Date.
 * @typedef {{id: string, parentId?: string|null, quantity?: number, setupMinutes?: number, cleanupMinutes?: number}} AvSpace
 * @typedef {{spaceId: string, blocksSpaceId: string, symmetric?: boolean}} AvRelation
 * @typedef {{id: string, capacity: number}} AvResource
 * @typedef {{spaceId: string, resourceId: string, units?: number}} AvSpaceResource
 * @typedef {{id: string, spaceId: string, startsAt: Instant, endsAt: Instant, status?: string, kind?: string}} AvReservation
 * @typedef {{id: string, spaceId: string, startsAt: Instant, endsAt: Instant}} AvHold
 * @typedef {{spaces: AvSpace[], relations?: AvRelation[], resources?: AvResource[], spaceResources?: AvSpaceResource[],
 *   reservations?: AvReservation[], holds?: AvHold[]}} AvModel
 * @typedef {{spaceId: string, startsAt: Instant, endsAt: Instant, ignoreReservationId?: string|null}} AvCandidate
 * @typedef {'overlap'|'buffer'|'capacity'|'resource'|'hold'} ConflictKind
 * @typedef {{kind: ConflictKind, spaceId: string, reservationId: string|null, holdId: string|null,
 *   resourceId: string|null, detail: string}} Conflict
 */

const MAX_DEPTH = 20; // same limit as space_ancestors / related_spaces in SQL
const MINUTE = 60000;

/** @param {Instant} v @param {string} label */
function toMs(v, label) {
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(ms)) throw new RangeError(`${label} is not a valid time.`);
  return ms;
}

/** @param {AvModel} model @param {string} id */
function spaceOf(model, id) {
  return model.spaces.find((s) => s.id === id);
}

/**
 * Spaces whose bookings block `spaceId`: itself, ancestors, descendants, and spaces related to it.
 * @param {AvModel} model @param {string} spaceId @returns {string[]} sorted ids
 */
export function blockingSpaces(model, spaceId) {
  const out = new Set([spaceId]);
  // Ancestors.
  let cur = spaceOf(model, spaceId);
  for (let d = 0; cur?.parentId && d < MAX_DEPTH; d++) {
    out.add(cur.parentId);
    cur = spaceOf(model, cur.parentId);
  }
  // Descendants.
  let frontier = [spaceId];
  for (let d = 0; frontier.length && d < MAX_DEPTH; d++) {
    const next = [];
    for (const s of model.spaces) if (s.parentId && frontier.includes(s.parentId)) { out.add(s.id); next.push(s.id); }
    frontier = next;
  }
  for (const r of model.relations ?? []) {
    if (r.blocksSpaceId === spaceId) out.add(r.spaceId);
    if (r.spaceId === spaceId && r.symmetric) out.add(r.blocksSpaceId);
  }
  return [...out].sort(cmpStr);
}

/** @param {string} a @param {string} b */
function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
/** @param {string|null} a @param {string|null} b nulls last */
function cmpNullable(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmpStr(a, b);
}
/** @param {Conflict} a @param {Conflict} b */
function cmpConflict(a, b) {
  return cmpStr(a.kind, b.kind) || cmpStr(a.spaceId, b.spaceId) || cmpNullable(a.reservationId, b.reservationId)
    || cmpNullable(a.holdId, b.holdId) || cmpNullable(a.resourceId, b.resourceId);
}

/** @param {number} as @param {number} ae @param {number} bs @param {number} be */
const overlaps = (as, ae, bs, be) => as < be && bs < ae;

/**
 * Highest sum of `units` in use at any instant inside [s, e). Ends sort before starts at the same instant.
 * @param {{s: number, e: number, units: number}[]} uses @param {number} s @param {number} e
 */
function peak(uses, s, e) {
  /** @type {[number, number][]} */
  const ev = [];
  for (const u of uses) { ev.push([Math.max(u.s, s), u.units]); ev.push([Math.min(u.e, e), -u.units]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, top = 0;
  for (const [, d] of ev) { cur += d; top = Math.max(top, cur); }
  return top;
}

/**
 * Everything that stops `candidate` from being booked.
 * @param {AvModel} model @param {AvCandidate} candidate @returns {Conflict[]}
 */
export function findConflicts(model, candidate) {
  const cs = toMs(candidate.startsAt, 'startsAt'), ce = toMs(candidate.endsAt, 'endsAt');
  if (ce <= cs) throw new RangeError('The end has to be after the start.');
  const space = spaceOf(model, candidate.spaceId);
  if (!space) throw new Error('Space not found.');
  const ignore = candidate.ignoreReservationId ?? null;
  const qty = space.quantity ?? 1;
  const buf = (/** @type {AvSpace|undefined} */ sp) => [(sp?.setupMinutes ?? 0) * MINUTE, (sp?.cleanupMinutes ?? 0) * MINUTE];
  const [cSetup, cClean] = buf(space);
  const cbs = cs - cSetup, cbe = ce + cClean;

  // Every live occupancy, with raw and buffered (own-space) ranges.
  const occ = [
    ...(model.reservations ?? []).filter((r) => (r.status ?? 'confirmed') === 'confirmed' && r.id !== ignore)
      .map((r) => ({ reservationId: r.id, holdId: null, spaceId: r.spaceId, startsAt: r.startsAt, endsAt: r.endsAt })),
    ...(model.holds ?? []).filter((h) => h.id !== ignore)
      .map((h) => ({ reservationId: null, holdId: h.id, spaceId: h.spaceId, startsAt: h.startsAt, endsAt: h.endsAt })),
  ].map((o) => {
    const s = toMs(o.startsAt, 'startsAt'), e = toMs(o.endsAt, 'endsAt');
    const [su, cl] = buf(spaceOf(model, o.spaceId));
    return { ...o, s, e, bs: s - su, be: e + cl };
  });

  /** @type {Conflict[]} */
  const out = [];
  /** @param {ConflictKind} kind @param {typeof occ[number]} o @param {string|null} resourceId @param {string} detail */
  const add = (kind, o, resourceId, detail) => out.push({ kind, spaceId: o.spaceId, reservationId: o.reservationId,
    holdId: o.holdId, resourceId, detail });

  // 1. The space itself: buffered ranges on both sides.
  const same = occ.filter((o) => o.spaceId === space.id && overlaps(o.bs, o.be, cbs, cbe));
  if (qty <= 1) {
    for (const o of same) {
      if (o.holdId) add('hold', o, null, 'held for a pending request');
      else if (overlaps(o.s, o.e, cs, ce)) add('overlap', o, null, 'already booked');
      else add('buffer', o, null, 'inside setup or cleaning time');
    }
  } else {
    const top = peak(same.map((o) => ({ s: o.bs, e: o.be, units: 1 })), cbs, cbe);
    if (top + 1 > qty) for (const o of same) add('capacity', o, null, `all ${qty} units in use`);
  }

  // 2. Related spaces: raw ranges only (buffers stay on their own space).
  const blockers = new Set(blockingSpaces(model, space.id));
  blockers.delete(space.id);
  for (const o of occ) {
    if (!blockers.has(o.spaceId) || !overlaps(o.s, o.e, cs, ce)) continue;
    if (o.holdId) add('hold', o, null, 'related space held for a pending request');
    else add('overlap', o, null, 'related space booked');
  }

  // 3. Shared resources: peak concurrent units over raw ranges.
  const links = model.spaceResources ?? [];
  for (const mine of links.filter((l) => l.spaceId === space.id)) {
    const res = (model.resources ?? []).find((r) => r.id === mine.resourceId);
    if (!res) continue;
    const users = new Map(links.filter((l) => l.resourceId === res.id).map((l) => [l.spaceId, l.units ?? 1]));
    const using = occ.filter((o) => users.has(o.spaceId) && overlaps(o.s, o.e, cs, ce));
    const top = peak(using.map((o) => ({ s: o.s, e: o.e, units: /** @type {number} */ (users.get(o.spaceId)) })), cs, ce);
    if (top + (mine.units ?? 1) > res.capacity) {
      for (const o of using) add('resource', o, res.id, `shared resource capacity ${res.capacity} reached`);
    }
  }

  return out.sort(cmpConflict);
}

/** @param {AvModel} model @param {AvCandidate} candidate @returns {boolean} */
export function isAvailable(model, candidate) {
  return findConflicts(model, candidate).length === 0;
}

// The SQL engine (availability_conflicts, blocking_spaces) and the JS mirror (core/availability.js) must agree on every
// shared case. This is the guard against the two implementations drifting (ADR 3).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/db.mjs';
import { CASES } from '../../core/tests/fixtures/availability-cases.js';
import { findConflicts, blockingSpaces } from '../../core/availability.js';

const MAYA = '11111111-1111-1111-1111-111111111111';
let db, one;
const loaded = []; // per case: { toUuid, toName }

// Every id in a case gets a uuid that sorts like the name does, so the SQL order can be compared with the JS order.
function idMap(c, caseNo) {
  const m = c.model;
  const names = new Set([...m.spaces.map((s) => s.id), ...(m.resources ?? []).map((r) => r.id),
    ...(m.reservations ?? []).map((r) => r.id), ...(m.holds ?? []).map((h) => h.id)]);
  if (c.candidate.ignoreReservationId) names.add(c.candidate.ignoreReservationId);
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const prefix = caseNo.toString(16).padStart(8, '0');
  const toUuid = new Map(sorted.map((n, i) => [n, `${prefix}-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`]));
  const toName = new Map([...toUuid].map(([n, u]) => [u, n]));
  return { toUuid, toName };
}

before(async () => {
  ({ db, one } = await freshDb());
  await db.query(`insert into auth.users (id) values ($1)`, [MAYA]);
  for (const [n, c] of CASES.entries()) {
    const { toUuid, toName } = idMap(c, n + 1);
    const u = (x) => (x == null ? null : toUuid.get(x));
    const prop = (await one(`insert into public.properties (host_id, title) values ($1, $2) returning id`, [MAYA, `case ${n + 1}`])).id;
    // Parents first.
    const pending = [...c.model.spaces];
    const done = new Set();
    while (pending.length) {
      const i = pending.findIndex((s) => !s.parentId || done.has(s.parentId));
      const s = pending.splice(i, 1)[0];
      await db.query(`insert into public.spaces (id, property_id, parent_space_id, category, title, quantity, setup_minutes, cleanup_minutes)
        values ($1, $2, $3, 'other', $4, $5, $6, $7)`, [u(s.id), prop, u(s.parentId), s.id, s.quantity ?? 1, s.setupMinutes ?? 0, s.cleanupMinutes ?? 0]);
      done.add(s.id);
    }
    for (const r of c.model.relations ?? []) {
      await db.query(`insert into public.space_relations (space_id, blocks_space_id, "symmetric") values ($1, $2, $3)`, [u(r.spaceId), u(r.blocksSpaceId), !!r.symmetric]);
    }
    for (const r of c.model.resources ?? []) {
      await db.query(`insert into public.resources (id, property_id, name, capacity) values ($1, $2, $3, $4)`, [u(r.id), prop, r.id, r.capacity]);
    }
    for (const l of c.model.spaceResources ?? []) {
      await db.query(`insert into public.space_resources (space_id, resource_id, units) values ($1, $2, $3)`, [u(l.spaceId), u(l.resourceId), l.units ?? 1]);
    }
    for (const r of c.model.reservations ?? []) {
      await db.query(`insert into public.reservations (id, space_id, channel, external_uid, source, starts_at, ends_at, status, kind)
        values ($1, $2, 'airbnb', $3, 'manual', $4, $5, $6, $7)`, [u(r.id), u(r.spaceId), r.id, r.startsAt, r.endsAt, r.status ?? 'confirmed', r.kind ?? 'booking']);
    }
    for (const h of c.model.holds ?? []) {
      // Default expiry is 24 hours from now: a live hold.
      await db.query(`insert into public.booking_holds (id, space_id, channel, starts_at, ends_at) values ($1, $2, 'vrbo', $3, $4)`, [u(h.id), u(h.spaceId), h.startsAt, h.endsAt]);
    }
    loaded.push({ toUuid, toName });
  }
});

for (const [n, c] of CASES.entries()) {
  test(`parity: ${c.name}`, async () => {
    const { toUuid, toName } = loaded[n];
    const cand = c.candidate;
    const args = [toUuid.get(cand.spaceId), cand.startsAt, cand.endsAt, cand.ignoreReservationId ? toUuid.get(cand.ignoreReservationId) : null];
    const sql = `select kind, space_id, reservation_id, hold_id, resource_id, detail from public.availability_conflicts($1, $2, $3, $4)`;
    if (c.throws) {
      await assert.rejects(db.query(sql, args), /end has to be after the start/);
      assert.throws(() => findConflicts(c.model, cand), /end has to be after the start/);
      return;
    }
    const name = (x) => (x == null ? null : toName.get(x));
    const fromSql = (await db.query(sql, args)).rows.map((r) => ({ kind: r.kind, spaceId: name(r.space_id),
      reservationId: name(r.reservation_id), holdId: name(r.hold_id), resourceId: name(r.resource_id), detail: r.detail }));
    const fromJs = findConflicts(c.model, cand);
    assert.deepEqual(fromSql.map((r) => r.kind), c.expectedKinds, 'SQL kinds');
    assert.deepEqual(fromJs.map((r) => r.kind), c.expectedKinds, 'JS kinds');
    // Same rows, same order, same wording.
    assert.deepEqual(fromSql, fromJs);
    const blockSql = (await db.query(`select b from public.blocking_spaces($1) b`, [args[0]])).rows.map((r) => name(r.b)).sort();
    assert.deepEqual(blockSql, blockingSpaces(c.model, cand.spaceId));
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts, blockingSpaces, isAvailable } from '../availability.js';
import { CASES } from './fixtures/availability-cases.js';

test('there are at least 24 named cases with unique names', () => {
  assert.ok(CASES.length >= 24, `${CASES.length} cases`);
  assert.equal(new Set(CASES.map((c) => c.name)).size, CASES.length);
});

for (const c of CASES) {
  test(`availability: ${c.name}`, () => {
    if (c.throws) {
      assert.throws(() => findConflicts(c.model, c.candidate), /end has to be after the start/);
      return;
    }
    const got = findConflicts(c.model, c.candidate);
    assert.deepEqual(got.map((r) => r.kind), c.expectedKinds);
    assert.equal(isAvailable(c.model, c.candidate), c.expectedKinds.length === 0);
    for (const r of got) {
      assert.ok(r.reservationId || r.holdId, 'every row names what it conflicts with');
      assert.equal(r.resourceId !== null, r.kind === 'resource');
      assert.equal(typeof r.detail, 'string');
    }
  });
}

test('blockingSpaces: family plus relations in either stored direction, not siblings', () => {
  const m = {
    spaces: [{ id: 'house' }, { id: 'room1', parentId: 'house' }, { id: 'room2', parentId: 'house' }, { id: 'yard' }, { id: 'tub' }],
    relations: [{ spaceId: 'house', blocksSpaceId: 'yard' }, { spaceId: 'yard', blocksSpaceId: 'tub' }],
  };
  assert.deepEqual(blockingSpaces(m, 'room1'), ['house', 'room1']);
  assert.deepEqual(blockingSpaces(m, 'house'), ['house', 'room1', 'room2', 'yard']);
  assert.deepEqual(blockingSpaces(m, 'yard'), ['house', 'tub', 'yard']);
  assert.deepEqual(blockingSpaces(m, 'tub'), ['tub', 'yard']);
});

test('relations are mutual: b blocks a exactly when a blocks b, in every shared case', () => {
  for (const c of CASES) {
    for (const a of c.model.spaces) {
      for (const b of blockingSpaces(c.model, a.id)) {
        assert.ok(blockingSpaces(c.model, b).includes(a.id), `${c.name}: ${b} blocks ${a.id} but not the reverse`);
      }
    }
  }
});

// Guard against a vacuous suite: each conflict kind, and relations in both arrival orders, must really be exercised.
export const MIN_CASES_PER_KIND = 2;
test(`every conflict kind appears in at least ${MIN_CASES_PER_KIND} cases, and relations are checked in both orders`, () => {
  for (const kind of ['overlap', 'buffer', 'capacity', 'resource', 'hold']) {
    const n = CASES.filter((c) => c.expectedKinds.includes(kind)).length;
    assert.ok(n >= MIN_CASES_PER_KIND, `${kind}: only ${n} case(s)`);
  }
  assert.ok(CASES.filter((c) => c.expectedKinds.length === 0 && !c.throws).length >= 5, 'free-slot cases');
  // A relation case where the candidate is the stored blocksSpaceId, and one where it is the stored spaceId.
  const rel = CASES.filter((c) => (c.model.relations ?? []).length && c.expectedKinds.length);
  assert.ok(rel.some((c) => c.model.relations.some((r) => r.blocksSpaceId === c.candidate.spaceId)), 'candidate on blocksSpaceId side');
  assert.ok(rel.some((c) => c.model.relations.some((r) => r.spaceId === c.candidate.spaceId)), 'candidate on spaceId side');
});

test('results are deterministic and the model is not mutated', () => {
  const c = CASES.find((x) => x.name.startsWith('several reasons'));
  const snapshot = JSON.stringify(c.model);
  const a = findConflicts(c.model, c.candidate), b = findConflicts(c.model, c.candidate);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(c.model), snapshot);
});

test('unknown space and invalid times are errors, not "available"', () => {
  const m = { spaces: [{ id: 'a' }] };
  assert.throws(() => findConflicts(m, { spaceId: 'nope', startsAt: '2027-01-01', endsAt: '2027-01-02' }), /Space not found/);
  assert.throws(() => findConflicts(m, { spaceId: 'a', startsAt: 'not a date', endsAt: '2027-01-02' }), /not a valid time/);
  assert.equal(isAvailable(m, { spaceId: 'a', startsAt: new Date('2027-01-01'), endsAt: Date.parse('2027-01-02') }), true);
});

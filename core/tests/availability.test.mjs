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

test('blockingSpaces: family plus relations, not siblings, directional unless symmetric', () => {
  const m = {
    spaces: [{ id: 'house' }, { id: 'room1', parentId: 'house' }, { id: 'room2', parentId: 'house' }, { id: 'yard' }, { id: 'tub' }],
    relations: [{ spaceId: 'house', blocksSpaceId: 'yard' }, { spaceId: 'yard', blocksSpaceId: 'tub', symmetric: true }],
  };
  assert.deepEqual(blockingSpaces(m, 'room1'), ['house', 'room1']);
  assert.deepEqual(blockingSpaces(m, 'house'), ['house', 'room1', 'room2']);
  assert.deepEqual(blockingSpaces(m, 'yard'), ['house', 'tub', 'yard']);
  assert.deepEqual(blockingSpaces(m, 'tub'), ['tub', 'yard']);
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

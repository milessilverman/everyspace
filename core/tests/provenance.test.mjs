import test from 'node:test';
import assert from 'node:assert/strict';
import { sourced, unavailable, ownerConfirmed, resolve, confidenceLabel, isStale } from '../provenance.js';

const m = (over = {}) => ({ tag: 'measured', source: 'Assessor', confidence: 0.8, retrievedAt: '2026-01-01T00:00:00Z', ...over });

test('sourced builds a value and keeps only known meta', () => {
  const s = sourced(5, m({ unit: 'sqft', license: 'x', bogus: 1 }));
  assert.deepEqual(s, { value: 5, tag: 'measured', source: 'Assessor', retrievedAt: '2026-01-01T00:00:00Z', confidence: 0.8, unit: 'sqft', license: 'x' });
});

test('sourced validates tag, confidence range and source', () => {
  assert.throws(() => sourced(1, m({ tag: 'guess' })), /invalid tag/);
  assert.throws(() => sourced(1, m({ confidence: 1.2 })), /0\.\.1/);
  assert.throws(() => sourced(1, m({ confidence: -0.1 })), /0\.\.1/);
  assert.throws(() => sourced(1, m({ confidence: NaN })), /0\.\.1/);
  assert.throws(() => sourced(1, m({ source: '' })), /source/);
});

test("'unavailable' must have value null and confidence 0; other tags need a value", () => {
  assert.throws(() => sourced(3, { tag: 'unavailable', source: 's', confidence: 0 }), /value null/);
  assert.throws(() => sourced(null, { tag: 'unavailable', source: 's', confidence: 0.2 }), /confidence 0/);
  assert.throws(() => sourced(null, m()), /needs a value/);
  assert.equal(sourced(false, m()).value, false, 'false is a real value');
});

test('unavailable() carries the reason as the note', () => {
  const u = unavailable('not mapped', 'OSM');
  assert.deepEqual([u.value, u.tag, u.confidence, u.note, u.source], [null, 'unavailable', 0, 'not mapped', 'OSM']);
});

test('ownerConfirmed is confidence 1, source Owner, needs a time', () => {
  const o = ownerConfirmed(1200, { unit: 'sqft', at: '2026-02-01T00:00:00Z' });
  assert.equal(o.tag, 'owner-confirmed');
  assert.equal(o.confidence, 1);
  assert.equal(o.source, 'Owner');
  assert.equal(o.unit, 'sqft');
  assert.throws(() => ownerConfirmed(1, { at: 'nope' }), /ISO/);
});

test('resolve: owner-confirmed beats higher-confidence automated and newer data', () => {
  const owner = ownerConfirmed(1200, { at: '2026-01-02T00:00:00Z' });
  const newer = sourced(1500, m({ confidence: 0.99, retrievedAt: '2026-06-01T00:00:00Z' }));
  assert.equal(resolve([owner, newer]), owner);
  assert.equal(resolve([newer, owner]), owner);
});

test('resolve: newest owner-confirmed wins among several', () => {
  const a = ownerConfirmed(1, { at: '2026-01-01T00:00:00Z' });
  const b = ownerConfirmed(2, { at: '2026-03-01T00:00:00Z' });
  assert.equal(resolve([b, a]), b);
});

test('resolve: highest confidence, then newest retrievedAt', () => {
  const lo = sourced(1, m({ confidence: 0.5, retrievedAt: '2026-09-01T00:00:00Z' }));
  const hiOld = sourced(2, m({ confidence: 0.9, retrievedAt: '2026-01-01T00:00:00Z' }));
  const hiNew = sourced(3, m({ confidence: 0.9, retrievedAt: '2026-02-01T00:00:00Z' }));
  assert.equal(resolve([lo, hiOld]), hiOld);
  assert.equal(resolve([hiNew, lo, hiOld]), hiNew);
});

test('resolve: unavailable only when nothing else; empty history is unavailable; input untouched', () => {
  const u = unavailable('no data');
  const v = sourced(1, m({ confidence: 0.1 }));
  assert.equal(resolve([u, v]), v);
  assert.equal(resolve([u]).tag, 'unavailable');
  assert.equal(resolve([]).tag, 'unavailable');
  assert.equal(resolve(undefined).tag, 'unavailable');
  const hist = [u, v];
  resolve(hist);
  assert.deepEqual(hist, [u, v]);
});

test('confidenceLabel boundaries', () => {
  assert.deepEqual([0, 0.39, 0.4, 0.74, 0.75, 1].map(confidenceLabel), ['low', 'low', 'medium', 'medium', 'high', 'high']);
});

test('isStale uses the injected now; static defaults never stale', () => {
  const s = sourced(1, m({ retrievedAt: '2026-01-01T00:00:00Z' }));
  assert.equal(isStale(s, '2026-01-31T00:00:00Z', 30), false);
  assert.equal(isStale(s, '2026-02-02T00:00:00Z', 30), true);
  assert.equal(isStale(sourced(1, m({ retrievedAt: null })), '2030-01-01T00:00:00Z', 1), false);
  assert.equal(isStale(sourced(1, m({ retrievedAt: 'garbage' })), '2026-01-01T00:00:00Z', 1), true);
});

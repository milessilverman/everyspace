// The suggestion list's address check (estimate/address-suggest.js): the county's `suggest` call offers a house number in
// every community its street runs through; only addresses its matcher confirms are shown. Shapes as seen live 2026-11-28.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streetPart, realAddresses, onlyRealAddresses, MIN_MATCH_SCORE } from '../../estimate/address-suggest.js';

const cand = (address, score = 100) => ({ address, score, location: { x: -118.5, y: 34.1 } });

test('streetPart: the street address of a house-numbered suggestion, null otherwise', () => {
  assert.equal(streetPart('5741 Corbin Avenue, Chatsworth, CA'), '5741 Corbin Avenue');
  assert.equal(streetPart('  200  North Spring St , Los Angeles, CA'), '200 North Spring St');
  assert.equal(streetPart('123A Main St, Alhambra, CA'), '123A Main St');
  assert.equal(streetPart('123 1/2 Main St, Alhambra, CA'), '123 1/2 Main St');
  assert.equal(streetPart('Corbin Avenue, Chatsworth, CA'), null);
  assert.equal(streetPart('Spring Street Park, Los Angeles, CA'), null);
  assert.equal(streetPart('5741 Corbin Avenue'), null, 'no city part: not a county suggestion shape');
  assert.equal(streetPart(null), null);
});

test('realAddresses: same house number, at or above the cutoff, best first, zip tidied, no repeats', () => {
  const json = { candidates: [cand('5742 Corbin Avenue, Los Angeles, CA, 91356', 79), cand('5741 Corbin Avenue, Tarzana, CA, 91356', 98), cand('5741 Corbin Avenue, Los Angeles, CA, 91356'), cand('5741 Corbin Avenue, Los Angeles, CA, 91356'), cand('5741 Corbin Avenue, Reseda, CA, 91335', MIN_MATCH_SCORE - 0.1), cand('5742 Corbin Avenue, Tarzana, CA, 91356', 100)] };
  assert.deepEqual(realAddresses('5741 Corbin Avenue', json), ['5741 Corbin Avenue, Los Angeles, CA 91356', '5741 Corbin Avenue, Tarzana, CA 91356']);
  assert.deepEqual(realAddresses('5741 Corbin Avenue', { candidates: [] }), []);
  assert.equal(realAddresses('5741 Corbin Avenue', {}), null, 'an answer without candidates is not an answer');
  assert.equal(realAddresses('5741 Corbin Avenue', null), null);
  assert.deepEqual(realAddresses('5741 Corbin Avenue', { candidates: [{ address: 5, score: 100 }, { score: 100 }, { address: '5741 Corbin Avenue, Tarzana, CA', score: 'x' }] }), []);
});

test('onlyRealAddresses: real addresses replace the suggestions of their street; nothing real drops them; a failed check keeps them', async () => {
  const sug = ['5741 Corbin Avenue, Chatsworth, CA', '5741 Corbin Avenue, Los Angeles, CA', 'Corbin Avenue, Chatsworth, CA', '9 Nowhere Rd, Northridge, CA', '7 Unsure St, Reseda, CA', '5741 Corbin Avenue, Northridge, CA'];
  const asked = [];
  const check = async (street) => { asked.push(street); if (street.startsWith('5741')) return ['5741 Corbin Avenue, Los Angeles, CA 91356', '5741 Corbin Avenue, Tarzana, CA 91356']; if (street.startsWith('9 ')) return []; return null; };
  assert.deepEqual(await onlyRealAddresses(sug, check), ['5741 Corbin Avenue, Los Angeles, CA 91356', '5741 Corbin Avenue, Tarzana, CA 91356', 'Corbin Avenue, Chatsworth, CA', '7 Unsure St, Reseda, CA']);
  assert.deepEqual(asked.sort(), ['5741 Corbin Avenue', '7 Unsure St', '9 Nowhere Rd'], 'each street address is asked once');
  assert.deepEqual(await onlyRealAddresses(sug, async () => { throw new Error('down'); }), sug, 'a check that throws changes nothing');
  assert.deepEqual(await onlyRealAddresses([], check), []);
});

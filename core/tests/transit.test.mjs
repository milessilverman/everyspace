import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTransit, transitAttributes, isTransitStation, WALK_RADIUS_M } from '../transit.js';
import { distanceM } from '../geometry.js';

const NOW = '2026-11-27T12:00:00Z';
const P = { lat: 34.05, lng: -118.25 };
// ~111.2 m per 0.001 degree of latitude
const at = (dLat, tags, id) => ({ type: 'node', id, lat: P.lat + dLat, lon: P.lng, tags });
const FIX = [
  at(0.0018, { highway: 'bus_stop', name: 'Main & 1st' }, 1),                                  // ~200 m bus
  at(0.0045, { highway: 'bus_stop', public_transport: 'platform', name: 'Main & 3rd' }, 2),    // ~500 m, both tags: counted once
  at(0.0070, { public_transport: 'platform', name: 'Platform only' }, 3),                      // ~780 m, inside the 0.5 mile walk
  at(0.0090, { railway: 'station', station: 'subway', name: 'Civic Center' }, 4),              // ~1000 m rail: outside walk, inside search
  at(0.0010, { railway: 'station', usage: 'tourism', name: 'Park Railroad' }, 5),              // heritage: not transit
  at(0.0012, { railway: 'station', station: 'tram', name: 'Tram' }, 6),                        // tram: not rail
  at(0.0200, { highway: 'bus_stop', name: 'Far' }, 7),                                          // ~2200 m, beyond search radius
  { type: 'way', id: 8, tags: { building: 'yes' } },                                            // not a node
];

test('summary on a fixture with bus stops and a rail station at known distances', () => {
  const s = summarizeTransit(FIX, P);
  const d = (e) => distanceM(P, { lat: e.lat, lng: e.lon });
  assert.equal(s.nearest.name, 'Main & 1st'); assert.equal(s.nearest.kind, 'bus_stop'); assert.equal(s.nearest.distanceM, Math.round(d(FIX[0])));
  assert.ok(Math.abs(s.nearest.distanceM - 200) < 3);
  assert.equal(s.walkRadiusM, 805); assert.ok(Math.abs(WALK_RADIUS_M - 804.672) < 1e-9);
  assert.equal(d(FIX[2]) < WALK_RADIUS_M && d(FIX[3]) > WALK_RADIUS_M, true);
  assert.equal(s.countWithinWalk, 3); assert.equal(s.railWithinWalk, 0);
  assert.equal(s.frequencyKnown, false); assert.match(s.method, /straight-line/);
});

test('a rail station inside the walk radius counts as rail; a wider search finds a farther stop', () => {
  const rail = [at(0.0050, { railway: 'station', station: 'light_rail', name: 'Pico' }, 9)];
  const s = summarizeTransit(rail, P);
  assert.deepEqual([s.nearest.kind, s.railWithinWalk, s.countWithinWalk], ['rail_station', 1, 1]);
  assert.equal(summarizeTransit(FIX, P, { searchRadiusM: 3000 }).nearest.name, 'Main & 1st');
  assert.equal(summarizeTransit([FIX[6]], P).nearest, null);
  assert.equal(summarizeTransit([FIX[6]], P, { searchRadiusM: 3000 }).nearest.name, 'Far');
  assert.equal(summarizeTransit([FIX[3]], P, { walkRadiusM: 1200 }).railWithinWalk, 1);
});

test('City Pretty non-transit filter (osm_extract.py is_transit_station)', () => {
  assert.equal(isTransitStation({ railway: 'station', name: 'Balboa Park Miniature Railroad' }), false);
  assert.equal(isTransitStation({ railway: 'station', name: 'San Antonio Zoo' }), false);
  assert.equal(isTransitStation({ railway: 'station', name: 'Houston Zoo', network: 'Metro' }), true);
  assert.equal(isTransitStation({ railway: 'station', operator: 'Dayton History' }), false);
  assert.equal(isTransitStation({ railway: 'station', access: 'private' }), false);
  assert.equal(isTransitStation({ railway: 'station', name: 'Historic Gardner', network: 'TRAX' }), true);
  assert.equal(isTransitStation({ railway: 'station', name: 'Union Station', station: 'subway' }), true);
});

test('empty, malformed or missing elements -> no stops, never a crash', () => {
  for (const e of [[], null, undefined, [{}, null, { type: 'node' }]]) { const s = summarizeTransit(e, P); assert.deepEqual([s.nearest, s.countWithinWalk, s.railWithinWalk], [null, 0, 0]); }
});

test('attributes: Sourced estimated values with source and caveat; unavailable with a reason; deterministic; inputs not mutated', () => {
  const frozen = Object.freeze(FIX.map((e) => Object.freeze({ ...e })));
  const s = summarizeTransit(frozen, P);
  const a = transitAttributes(s, { now: NOW, source: 'OpenStreetMap contributors via Overpass API', license: 'ODbL 1.0' });
  assert.equal(a.transit_distance_m.value, s.nearest.distanceM); assert.equal(a.transit_distance_m.unit, 'm'); assert.equal(a.transit_distance_m.tag, 'estimated'); assert.equal(a.transit_distance_m.retrievedAt, NOW);
  assert.match(a.transit_distance_m.note, /not proof/); assert.match(a.transit_distance_m.note, /frequency/i);
  assert.equal(a.transit_stops_nearby.value, 3); assert.equal(a.rail_station_nearby.value, false); assert.equal(a.rail_station_nearby.license, 'ODbL 1.0');
  assert.deepEqual(a, transitAttributes(summarizeTransit(frozen, P), { now: NOW, source: 'OpenStreetMap contributors via Overpass API', license: 'ODbL 1.0' }));
  const none = transitAttributes(summarizeTransit([], P), { now: NOW });
  assert.equal(none.transit_distance_m.tag, 'unavailable'); assert.match(none.transit_distance_m.note, /no transit stop mapped within 1500 m/);
  assert.equal(none.transit_stops_nearby.value, 0, 'a successful empty lookup is a real zero');
  const off = transitAttributes(null, { now: NOW, unavailableReason: 'OpenStreetMap transit lookup failed: HTTP 502' });
  for (const k of ['transit_distance_m', 'transit_stops_nearby', 'rail_station_nearby']) { assert.equal(off[k].tag, 'unavailable'); assert.match(off[k].note, /HTTP 502/); }
});

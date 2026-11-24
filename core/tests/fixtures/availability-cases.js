// @ts-check
// Shared availability cases. Run through the JS engine (core/tests/availability.test.mjs) and through the SQL engine
// on PGlite (platform/tests/availability_parity.test.mjs); both must return exactly `expectedKinds`, in order.
// A case with `throws: true` must be rejected by both (bad time range). Ids are plain names; the parity test maps them
// to uuids that sort the same way. Holds listed here are live (the DB test inserts them with a future expiry).

/** @typedef {import('../../availability.js').AvModel} AvModel */
/** @typedef {import('../../availability.js').AvCandidate} AvCandidate */
/** @typedef {{name: string, model: AvModel, candidate: AvCandidate, expectedKinds: string[], throws?: boolean}} AvCase */

const T = (day, hm = '00:00') => `2027-01-${String(day).padStart(2, '0')}T${hm}:00Z`;
const sp = (id, extra = {}) => ({ id, parentId: null, quantity: 1, setupMinutes: 0, cleanupMinutes: 0, ...extra });
const bk = (id, spaceId, startsAt, endsAt, extra = {}) => ({ id, spaceId, startsAt, endsAt, status: 'confirmed', kind: 'booking', ...extra });
/** @param {Partial<AvModel> & {spaces: AvModel['spaces']}} m @returns {AvModel} */
const model = (m) => ({ relations: [], resources: [], spaceResources: [], reservations: [], holds: [], ...m });

// A house with two rooms inside it, a backyard and driveway beside it, and a detached ADU.
const houseSpaces = () => [sp('house'), sp('room1', { parentId: 'house' }), sp('room2', { parentId: 'house' }),
  sp('backyard'), sp('driveway'), sp('adu')];

/** @type {AvCase[]} */
export const CASES = [
  {
    name: 'whole house blocks backyard (directional relation)',
    model: model({ spaces: houseSpaces(), relations: [{ spaceId: 'house', blocksSpaceId: 'backyard', symmetric: false }],
      reservations: [bk('stay', 'house', T(10), T(13))] }),
    candidate: { spaceId: 'backyard', startsAt: T(11, '15:00'), endsAt: T(11, '18:00') },
    expectedKinds: ['overlap'],
  },
  {
    name: 'independent ADU does not block the driveway',
    model: model({ spaces: houseSpaces(), reservations: [bk('adu-stay', 'adu', T(10), T(13))] }),
    candidate: { spaceId: 'driveway', startsAt: T(11), endsAt: T(12) },
    expectedKinds: [],
  },
  {
    name: 'a room booking blocks the whole house',
    model: model({ spaces: houseSpaces(), reservations: [bk('r1', 'room1', T(10), T(12))] }),
    candidate: { spaceId: 'house', startsAt: T(11), endsAt: T(14) },
    expectedKinds: ['overlap'],
  },
  {
    name: 'a whole-house booking blocks a room inside it',
    model: model({ spaces: houseSpaces(), reservations: [bk('stay', 'house', T(10), T(13))] }),
    candidate: { spaceId: 'room2', startsAt: T(12), endsAt: T(15) },
    expectedKinds: ['overlap'],
  },
  {
    name: 'sibling rooms are independent',
    model: model({ spaces: houseSpaces(), reservations: [bk('r1', 'room1', T(10), T(12))] }),
    candidate: { spaceId: 'room2', startsAt: T(10), endsAt: T(12) },
    expectedKinds: [],
  },
  {
    name: 'symmetric privacy relation: studio booking blocks hot tub',
    model: model({ spaces: [sp('studio'), sp('hottub')], relations: [{ spaceId: 'studio', blocksSpaceId: 'hottub', symmetric: true }],
      reservations: [bk('s1', 'studio', T(5), T(7))] }),
    candidate: { spaceId: 'hottub', startsAt: T(6, '19:00'), endsAt: T(6, '21:00') },
    expectedKinds: ['overlap'],
  },
  {
    name: 'symmetric privacy relation: hot tub booking blocks studio',
    model: model({ spaces: [sp('studio'), sp('hottub')], relations: [{ spaceId: 'studio', blocksSpaceId: 'hottub', symmetric: true }],
      reservations: [bk('h1', 'hottub', T(6, '19:00'), T(6, '21:00'))] }),
    candidate: { spaceId: 'studio', startsAt: T(5), endsAt: T(7) },
    expectedKinds: ['overlap'],
  },
  {
    name: 'directional relation: an event on the lawn blocks the pool',
    model: model({ spaces: [sp('lawn'), sp('pool')], relations: [{ spaceId: 'lawn', blocksSpaceId: 'pool', symmetric: false }],
      reservations: [bk('party', 'lawn', T(8, '17:00'), T(8, '23:00'))] }),
    candidate: { spaceId: 'pool', startsAt: T(8, '18:00'), endsAt: T(8, '20:00') },
    expectedKinds: ['overlap'],
  },
  {
    name: 'directional relation does not block the other way',
    model: model({ spaces: [sp('lawn'), sp('pool')], relations: [{ spaceId: 'lawn', blocksSpaceId: 'pool', symmetric: false }],
      reservations: [bk('swim', 'pool', T(8, '18:00'), T(8, '20:00'))] }),
    candidate: { spaceId: 'lawn', startsAt: T(8, '17:00'), endsAt: T(8, '23:00') },
    expectedKinds: [],
  },
  {
    name: 'back-to-back without a buffer is fine (half-open ranges)',
    model: model({ spaces: [sp('adu')], reservations: [bk('a', 'adu', T(10, '16:00'), T(12, '11:00'))] }),
    candidate: { spaceId: 'adu', startsAt: T(12, '11:00'), endsAt: T(14, '11:00') },
    expectedKinds: [],
  },
  {
    name: 'back-to-back with a 3-hour cleaning buffer is a buffer conflict',
    model: model({ spaces: [sp('adu', { cleanupMinutes: 180 })], reservations: [bk('a', 'adu', T(10, '16:00'), T(12, '11:00'))] }),
    candidate: { spaceId: 'adu', startsAt: T(12, '11:00'), endsAt: T(14, '11:00') },
    expectedKinds: ['buffer'],
  },
  {
    name: 'cleaning buffer respected: start after cleaning ends',
    model: model({ spaces: [sp('adu', { cleanupMinutes: 180 })], reservations: [bk('a', 'adu', T(10, '16:00'), T(12, '11:00'))] }),
    candidate: { spaceId: 'adu', startsAt: T(12, '14:00'), endsAt: T(14, '11:00') },
    expectedKinds: [],
  },
  {
    name: 'setup buffer before the next booking',
    model: model({ spaces: [sp('studio', { setupMinutes: 60 })], reservations: [bk('shoot', 'studio', T(9, '13:00'), T(9, '17:00'))] }),
    candidate: { spaceId: 'studio', startsAt: T(9, '10:00'), endsAt: T(9, '12:30') },
    expectedKinds: ['buffer'],
  },
  {
    name: 'setup plus cleanup: both buffers must fit between bookings',
    model: model({ spaces: [sp('studio', { setupMinutes: 30, cleanupMinutes: 60 })], reservations: [bk('am', 'studio', T(9, '09:00'), T(9, '10:00'))] }),
    candidate: { spaceId: 'studio', startsAt: T(9, '11:00'), endsAt: T(9, '12:00') },
    expectedKinds: ['buffer'],
  },
  {
    name: 'a buffer does not leak onto a related space',
    model: model({ spaces: [sp('house'), sp('room1', { parentId: 'house', cleanupMinutes: 240 })],
      reservations: [bk('r1', 'room1', T(10, '16:00'), T(12, '11:00'))] }),
    candidate: { spaceId: 'house', startsAt: T(12, '11:00'), endsAt: T(14, '11:00') },
    expectedKinds: [],
  },
  {
    name: 'capacity 3 with 2 overlapping bookings accepts a third',
    model: model({ spaces: [sp('kayaks', { quantity: 3 })],
      reservations: [bk('k1', 'kayaks', T(4, '09:00'), T(4, '12:00')), bk('k2', 'kayaks', T(4, '10:00'), T(4, '13:00'))] }),
    candidate: { spaceId: 'kayaks', startsAt: T(4, '10:30'), endsAt: T(4, '11:30') },
    expectedKinds: [],
  },
  {
    name: 'capacity 3 with 3 overlapping bookings is full',
    model: model({ spaces: [sp('kayaks', { quantity: 3 })],
      reservations: [bk('k1', 'kayaks', T(4, '09:00'), T(4, '12:00')), bk('k2', 'kayaks', T(4, '10:00'), T(4, '13:00')),
        bk('k3', 'kayaks', T(4, '11:00'), T(4, '14:00'))] }),
    candidate: { spaceId: 'kayaks', startsAt: T(4, '11:15'), endsAt: T(4, '11:45') },
    expectedKinds: ['capacity', 'capacity', 'capacity'],
  },
  {
    name: 'capacity 3: three bookings in the window but never more than two at once',
    model: model({ spaces: [sp('kayaks', { quantity: 3 })],
      reservations: [bk('k1', 'kayaks', T(4, '09:00'), T(4, '10:00')), bk('k2', 'kayaks', T(4, '10:00'), T(4, '11:00')),
        bk('k3', 'kayaks', T(4, '09:30'), T(4, '10:30'))] }),
    candidate: { spaceId: 'kayaks', startsAt: T(4, '09:00'), endsAt: T(4, '11:00') },
    expectedKinds: [],
  },
  {
    name: 'shared bathroom (capacity 1) across two rooms that are otherwise independent',
    model: model({ spaces: houseSpaces(), resources: [{ id: 'bath', capacity: 1 }],
      spaceResources: [{ spaceId: 'room1', resourceId: 'bath', units: 1 }, { spaceId: 'room2', resourceId: 'bath', units: 1 }],
      reservations: [bk('r1', 'room1', T(10), T(12))] }),
    candidate: { spaceId: 'room2', startsAt: T(11), endsAt: T(13) },
    expectedKinds: ['resource'],
  },
  {
    name: 'parking capacity 2 uses peak, not total: two sequential cars plus one more fit',
    model: model({ spaces: [sp('rv'), sp('spot'), sp('adu')], resources: [{ id: 'parking', capacity: 2 }],
      spaceResources: [{ spaceId: 'rv', resourceId: 'parking', units: 1 }, { spaceId: 'spot', resourceId: 'parking', units: 1 },
        { spaceId: 'adu', resourceId: 'parking', units: 1 }],
      reservations: [bk('car1', 'rv', T(3), T(5)), bk('car2', 'spot', T(6), T(8))] }),
    candidate: { spaceId: 'adu', startsAt: T(3), endsAt: T(9) },
    expectedKinds: [],
  },
  {
    name: 'parking capacity 2 with two cars at once is full',
    model: model({ spaces: [sp('rv'), sp('spot'), sp('adu')], resources: [{ id: 'parking', capacity: 2 }],
      spaceResources: [{ spaceId: 'rv', resourceId: 'parking', units: 1 }, { spaceId: 'spot', resourceId: 'parking', units: 1 },
        { spaceId: 'adu', resourceId: 'parking', units: 1 }],
      reservations: [bk('car1', 'rv', T(3), T(7)), bk('car2', 'spot', T(6), T(8))] }),
    candidate: { spaceId: 'adu', startsAt: T(3), endsAt: T(9) },
    expectedKinds: ['resource', 'resource'],
  },
  {
    name: 'a space needing 2 parking units does not fit next to one car with capacity 2',
    model: model({ spaces: [sp('rv'), sp('adu')], resources: [{ id: 'parking', capacity: 2 }],
      spaceResources: [{ spaceId: 'rv', resourceId: 'parking', units: 2 }, { spaceId: 'adu', resourceId: 'parking', units: 1 }],
      reservations: [bk('car1', 'adu', T(3), T(7))] }),
    candidate: { spaceId: 'rv', startsAt: T(5), endsAt: T(6) },
    expectedKinds: ['resource'],
  },
  {
    name: 'a live hold blocks the space',
    model: model({ spaces: [sp('adu')], holds: [{ id: 'h1', spaceId: 'adu', startsAt: T(20), endsAt: T(23) }] }),
    candidate: { spaceId: 'adu', startsAt: T(22), endsAt: T(25) },
    expectedKinds: ['hold'],
  },
  {
    name: 'a hold on the whole house blocks a room',
    model: model({ spaces: houseSpaces(), holds: [{ id: 'h1', spaceId: 'house', startsAt: T(20), endsAt: T(23) }] }),
    candidate: { spaceId: 'room1', startsAt: T(21), endsAt: T(22) },
    expectedKinds: ['hold'],
  },
  {
    name: 'cancelled reservations are ignored',
    model: model({ spaces: [sp('adu')], reservations: [bk('gone', 'adu', T(10), T(13), { status: 'cancelled' })] }),
    candidate: { spaceId: 'adu', startsAt: T(10), endsAt: T(13) },
    expectedKinds: [],
  },
  {
    name: 'editing a booking ignores itself',
    model: model({ spaces: [sp('adu', { cleanupMinutes: 120 })], reservations: [bk('mine', 'adu', T(10), T(13))] }),
    candidate: { spaceId: 'adu', startsAt: T(11), endsAt: T(14), ignoreReservationId: 'mine' },
    expectedKinds: [],
  },
  {
    name: 'editing a booking still sees the others',
    model: model({ spaces: [sp('adu')], reservations: [bk('mine', 'adu', T(10), T(13)), bk('next', 'adu', T(13), T(15))] }),
    candidate: { spaceId: 'adu', startsAt: T(11), endsAt: T(14), ignoreReservationId: 'mine' },
    expectedKinds: ['overlap'],
  },
  {
    name: 'hourly bookings on the same day that do not touch',
    model: model({ spaces: [sp('pool')], reservations: [bk('swim1', 'pool', T(15, '18:00'), T(15, '20:00'))] }),
    candidate: { spaceId: 'pool', startsAt: T(15, '21:00'), endsAt: T(15, '23:00') },
    expectedKinds: [],
  },
  {
    name: 'hourly bookings on the same day that overlap by an hour',
    model: model({ spaces: [sp('pool')], reservations: [bk('swim1', 'pool', T(15, '18:00'), T(15, '20:00'))] }),
    candidate: { spaceId: 'pool', startsAt: T(15, '19:00'), endsAt: T(15, '21:00') },
    expectedKinds: ['overlap'],
  },
  {
    name: 'a month-long stay blocks an hourly booking inside it',
    model: model({ spaces: [sp('adu')], reservations: [bk('month', 'adu', '2027-02-01T08:00:00Z', '2027-03-01T08:00:00Z')] }),
    candidate: { spaceId: 'adu', startsAt: '2027-02-14T19:00:00Z', endsAt: '2027-02-14T21:00:00Z' },
    expectedKinds: ['overlap'],
  },
  {
    // Los Angeles springs forward on 2027-03-14: 01:00-03:00 local is one real hour (09:00Z-10:00Z).
    name: 'DST transition day: back-to-back across the skipped hour is fine',
    model: model({ spaces: [sp('studio')], reservations: [bk('early', 'studio', '2027-03-14T01:00:00-08:00', '2027-03-14T03:00:00-07:00')] }),
    candidate: { spaceId: 'studio', startsAt: '2027-03-14T10:00:00Z', endsAt: '2027-03-14T04:00:00-07:00' },
    expectedKinds: [],
  },
  {
    name: 'DST transition day: overlap measured in real time, not wall-clock time',
    model: model({ spaces: [sp('studio')], reservations: [bk('early', 'studio', '2027-03-14T01:00:00-08:00', '2027-03-14T03:00:00-07:00')] }),
    candidate: { spaceId: 'studio', startsAt: '2027-03-14T01:30:00-08:00', endsAt: '2027-03-14T04:00:00-07:00' },
    expectedKinds: ['overlap'],
  },
  {
    name: 'owner block and closed dates occupy like bookings',
    model: model({ spaces: [sp('adu')], reservations: [bk('own', 'adu', T(10), T(12), { kind: 'owner_block' }), bk('closed', 'adu', T(12), T(14), { kind: 'block' })] }),
    candidate: { spaceId: 'adu', startsAt: T(11), endsAt: T(13) },
    expectedKinds: ['overlap', 'overlap'],
  },
  {
    name: 'several reasons at once come back sorted by kind',
    model: model({ spaces: houseSpaces(), resources: [{ id: 'bath', capacity: 1 }],
      spaceResources: [{ spaceId: 'room1', resourceId: 'bath', units: 1 }, { spaceId: 'room2', resourceId: 'bath', units: 1 }],
      reservations: [bk('stay', 'house', T(10), T(12)), bk('r2', 'room2', T(11), T(13))],
      holds: [{ id: 'h1', spaceId: 'room1', startsAt: T(12), endsAt: T(13) }] }),
    candidate: { spaceId: 'room1', startsAt: T(11), endsAt: T(14) },
    // The hold on room1 also uses the bathroom, so it shows up twice: as a hold and as resource use.
    expectedKinds: ['hold', 'overlap', 'resource', 'resource'],
  },
  {
    name: 'zero-length range is rejected',
    model: model({ spaces: [sp('adu')] }),
    candidate: { spaceId: 'adu', startsAt: T(10), endsAt: T(10) },
    expectedKinds: [],
    throws: true,
  },
  {
    name: 'negative range is rejected',
    model: model({ spaces: [sp('adu')] }),
    candidate: { spaceId: 'adu', startsAt: T(12), endsAt: T(10) },
    expectedKinds: [],
    throws: true,
  },
];

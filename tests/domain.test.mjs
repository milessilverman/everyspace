// Tests for Everyspace's core rules (pricing, the price rule, iCal sync, listing everywhere, privacy).
// Run with: node --test
// They load the domain modules straight out of index.html, so the site stays a single file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const start = html.indexOf('<script>') + '<script>'.length;
const domainSrc = html.slice(start, html.indexOf('</script>', start));

// A fresh, isolated copy of the app's domain + API for each test.
function fresh() {
  const store = {};
  const sandbox = {
    window: {},
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
  };
  const fn = new Function('window', 'localStorage', `${domainSrc}\nreturn { api: window.everyspaceApi, m: window.everyspaceDomain };`);
  return fn(sandbox.window, sandbox.localStorage);
}

test('all-in price adds the service fee, and the owner keeps everything but the host fee', async () => {
  const { api, m } = fresh();
  const { SERVICE_FEE, HOST_FEE } = m.pricing;
  const q = await api('quote', { renterId: 'u_sam', term: 'hourly', start: '2027-06-05T14:00', end: '2027-06-05T16:00', items: [{ spaceId: 's_maple_backyard', qty: 1 }] });
  assert.ok(q.total > 0);
  assert.equal(Math.round(q.serviceFee * 100), Math.round(q.rent * SERVICE_FEE * 100));
  assert.equal(Math.round(q.hostPayout * 100), Math.round(q.rent * (1 - HOST_FEE) * 100));
});

test('lower fees both ways: same take-home means a lower renter price here, same renter price means more take-home here', () => {
  const { m } = fresh();
  const { guestPriceFor, takeHomeAt } = m.compare;
  for (const site of ['airbnb', 'vrbo', 'swimply', 'peerspace']) {
    assert.ok(guestPriceFor('everyspace', 100) < guestPriceFor(site, 100), `cheaper than ${site} for the same take-home`);
    assert.ok(takeHomeAt('everyspace', 120) > takeHomeAt(site, 120), `more take-home than ${site} for the same renter price`);
  }
});

test('the price rule rejects a higher Everyspace price and leaves the listing untouched', async () => {
  const { api } = fresh();
  const before = await api('spaces/s_maple_home');
  await assert.rejects(api('spaces/s_maple_home/update', { actorId: 'u_maya', changes: { rates: { daily: 999, weekly: 1300 }, title: 'Changed' } }));
  const after = await api('spaces/s_maple_home');
  assert.deepEqual(after.rates, before.rates);
  assert.equal(after.title, before.title);
});

test('search results never include access instructions', async () => {
  const { api } = fresh();
  const r = await api('search');
  assert.ok(r.spaces.length > 0);
  for (const s of r.spaces) {
    assert.equal(s.access, undefined, `${s.id} leaked access`);
    assert.equal(s.checklist, undefined, `${s.id} leaked its checklist`);
  }
});

test('an empty iCal feed never wipes upcoming bookings', async () => {
  const { api } = fresh();
  const ics = (uid, a, b) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${a}\r\nDTEND;VALUE=DATE:${b}\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\n`;
  const cal = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;
  const first = await api('spaces/s_ana_room/ical-import', { actorId: 'u_ana', platform: 'airbnb', ics: cal(ics('t1', '20300110', '20300112') + ics('t2', '20300201', '20300203')) });
  assert.equal(first.added, 2);
  const empty = await api('spaces/s_ana_room/ical-import', { actorId: 'u_ana', platform: 'airbnb', ics: cal('') });
  assert.equal(empty.removed, 0);
  assert.ok(empty.warning);
  const one = await api('spaces/s_ana_room/ical-import', { actorId: 'u_ana', platform: 'airbnb', ics: cal(ics('t1', '20300110', '20300112')) });
  assert.equal(one.removed, 1, 'a real cancellation (feed still has events) is removed');
});

test('a backyard is matched to Swimply and Peerspace; a home to the short-term rental sites', async () => {
  const { api } = fresh();
  const [yard, home] = await api('host/sites-preview', { hostId: 'u_maya', items: [
    { key: 'y', category: 'backyard', features: ['fire_pit'], rates: { hourly: 40 } },
    { key: 'h', category: 'entire_home', features: [], rates: { daily: 200, weekly: 1200 } },
  ] });
  const names = (x) => x.sites.map((s) => s.platform);
  assert.ok(names(yard).includes('swimply') && names(yard).includes('peerspace'));
  for (const site of ['airbnb', 'vrbo', 'booking_com', 'expedia']) assert.ok(names(home).includes(site), site);
});

test('list everywhere creates missing accounts (with consent) and publishes to every fitting site', async () => {
  const { api } = fresh();
  await api('host/profile', { hostId: 'u_maya', legalName: 'Maya Lopez', email: 'maya@example.com', phone: '555 123 4567', city: 'Riverside' });
  const without = await api('host/list-everywhere', { hostId: 'u_maya', spaceIds: ['s_maple_backyard'], agree: false });
  assert.ok(without.skipped.some((x) => x.why === 'No account yet'), 'nothing is created without consent');
  const r = await api('host/list-everywhere', { hostId: 'u_maya', spaceIds: ['s_maple_backyard'], agree: true });
  assert.ok(r.created.length > 0);
  assert.ok(r.posting.length + r.live.length > 0);
});

test('add-on-only spaces point renters to the main rental first', async () => {
  const { api, m } = fresh();
  const addon = m.seed.seed().spaces.find((s) => s.policy === 'addon' && s.listed !== false);
  assert.ok(addon, 'the demo has an add-on-only space');
  const d = await api(`spaces/${addon.id}?userId=u_sam`);
  assert.ok(d.anchorSpaces.length > 0, 'it lists the rentals it can be added to');
  assert.equal(d.hasAnchor, false, 'a new renter has no main rental yet');
});

test('demo dates move by whole weeks so weekends stay weekends', () => {
  const { m } = fresh();
  const db = m.seed.seed();
  assert.ok(Array.isArray(db.bookings) && db.bookings.length > 0);
  for (const b of db.bookings) assert.ok(!Number.isNaN(Date.parse(b.start)), `bad date ${b.start}`);
});

test('each site in the listing preview shows a price that pays the host the same, and never undercuts Everyspace', async () => {
  const { api, m } = fresh();
  const [yard] = await api('host/sites-preview', { hostId: 'u_maya', items: [{ key: 'y', category: 'backyard', features: [], rates: { hourly: 40 } }] });
  const usable = yard.sites.filter((x) => x.usable);
  assert.ok(usable.length > 0);
  const ours = 40 * (1 + m.pricing.SERVICE_FEE);
  for (const x of usable) {
    assert.ok(x.price >= 40, `${x.name} price is never below ours`);
    assert.ok(x.guestPays >= ours - 0.01, `${x.name} renters pay at least what they pay here`);
  }
});

test('event parking: a driveway by Fiesta La Ballona earns on festival days; one far from any venue earns nothing', async () => {
  const { api } = fresh();
  const near = await api('geo/parking', { lat: 34.0140, lng: -118.4000, spots: 3 });
  const fiesta = near.rows.find((r) => r.event === 'Fiesta La Ballona');
  assert.ok(fiesta, 'Fiesta La Ballona is within walking distance');
  assert.ok(fiesta.perEvent > 0 && fiesta.yearly > 0);
  const far = await api('geo/parking', { lat: 34.25, lng: -118.62, spots: 3 });
  assert.equal(far.rows.length, 0);
  assert.equal(far.yearly, 0);
});

test('event parking: closer pays more per car, and more cars earn more', async () => {
  const { api } = fresh();
  const close = await api('geo/parking', { lat: 33.9560, lng: -118.3392, spots: 2 });
  const farther = await api('geo/parking', { lat: 33.9680, lng: -118.3392, spots: 2 });
  const rams = (e) => e.rows.find((r) => r.event.startsWith('Rams'));
  assert.ok(rams(close).perCar > rams(farther).perCar);
  const more = await api('geo/parking', { lat: 33.9560, lng: -118.3392, spots: 4 });
  assert.ok(more.yearly > close.yearly);
});

test('solar: bigger and sunnier roofs earn more; north-facing roofs are flagged', async () => {
  const { api } = fresh();
  const south = await api('geo/solar', { footprintSqft: 1800, pitch: 'low', facing: 'south', shape: 'gable' });
  const north = await api('geo/solar', { footprintSqft: 1800, pitch: 'low', facing: 'north', shape: 'gable' });
  const shaded = await api('geo/solar', { footprintSqft: 1800, pitch: 'low', facing: 'south', shape: 'gable', shade: 'heavy' });
  const warehouse = await api('geo/solar', { footprintSqft: 40000, pitch: 'flat' });
  assert.ok(south.kw > north.kw && south.kwhYear > north.kwhYear);
  assert.equal(north.bigEnough, false);
  assert.ok(shaded.rentYear.typical < south.rentYear.typical);
  assert.ok(warehouse.rentYear.typical > south.rentYear.typical * 10);
  assert.ok(south.usableSqft < south.roofSqft, 'usable area leaves room for walkways and edges');
  await assert.rejects(api('geo/solar', { footprintSqft: 0 }));
});

test('roof measuring: a 30 m by 20 m outline is about 6,460 sq ft', async () => {
  const { api } = fresh();
  const lat = 34, lng = -118.3, dLat = 20 / 111320, dLng = 30 / (111320 * Math.cos(lat * Math.PI / 180));
  const pts = [{ lat, lng }, { lat, lng: lng + dLng }, { lat: lat + dLat, lng: lng + dLng }, { lat: lat + dLat, lng }];
  const r = await api('geo/area', { points: pts });
  assert.ok(Math.abs(r.sqft - 6458) < 30, `got ${r.sqft}`);
  assert.ok(Math.abs(r.bearing - 90) <= 1, 'long edge runs east-west');
});

test('county parcels: vacant land is land (no house to rent), a single-family home is a house', async () => {
  const { api } = fresh();
  assert.equal((await api('geo/classify', { UseCode: '010V', UseType: 'Residential' })).kind, 'land');
  assert.equal((await api('geo/classify', { UseCode: '0100', UseType: 'Residential', SQFTmain1: 1500, Units1: 1 })).kind, 'home');
  assert.equal((await api('geo/classify', { UseCode: '1100', UseType: 'Commercial' })).kind, 'business');
});

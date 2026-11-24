// Tenant isolation for every table in public. Tables are enumerated from the catalog, so a new table fails this test
// until it is classified below as GLOBAL (reference data) or given a TENANT entry (fixture + attack statements).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { freshDb, as } from './helpers/db.mjs';

const MAYA = '11111111-1111-1111-1111-111111111111'; // owner of org A (personal)
const SAM = '22222222-2222-2222-2222-222222222222'; // owner of org B, the other tenant
const VIC = '33333333-3333-3333-3333-333333333333'; // viewer in A
const MAX = '44444444-4444-4444-4444-444444444444'; // manager in A
const ADA = '55555555-5555-5555-5555-555555555555'; // admin in A
const DENIED = /row-level security|permission denied|does not belong|cannot add yourself|above your own|own role|immutable|append-only/;

// Reference data: readable by everyone signed in; the ones in ANON_READABLE also by signed-out visitors.
const GLOBAL = ['app_settings', 'roles', 'channels', 'space_categories', 'amenities', 'regulatory_rules'];
const ANON_READABLE = ['channels', 'space_categories', 'amenities', 'regulatory_rules'];

const F = {}; // fixture ids for org A
let db, one;

// Per tenant table: where = the org-A fixture row; viewer = whether a viewer member can read it;
// insert(me) = an insert targeting org A; owner = whether the org-A owner may run that insert (positive control);
// set = an update clause.
const TENANT = {
  organizations: { where: () => `id = '${F.org}'`, viewer: true, owner: false, set: `name = 'pwned'`,
    insert: () => `insert into public.organizations (name, kind) values ('Intruder', 'team')` },
  memberships: { where: () => `id = '${F.vicMembership}'`, viewer: true, owner: true, set: `role_key = 'owner'`,
    insert: () => `insert into public.memberships (org_id, user_id, role_key) values ('${F.org}', '${SAM}', 'viewer')` },
  // Only your own row; teammates' names come from org_member_profiles() (review finding 7).
  profiles: { where: () => `id = '${MAYA}'`, viewer: false, owner: false, set: `full_name = 'pwned'`,
    insert: () => `insert into public.profiles (id) values ('${MAYA}')` },
  properties: { where: () => `id = '${F.prop}'`, viewer: true, owner: true, set: `title = 'pwned'`,
    insert: (me) => `insert into public.properties (host_id, org_id, title) values ('${me}', '${F.org}', 'Intruder')` },
  spaces: { where: () => `id = '${F.space}'`, viewer: true, owner: true, set: `title = 'pwned'`,
    insert: () => `insert into public.spaces (property_id, category, title) values ('${F.prop}', 'pool', 'Intruder')` },
  channel_connections: { where: () => `id = '${F.conn}'`, viewer: true, owner: true, set: `status = 'error'`,
    insert: (me) => `insert into public.channel_connections (host_id, org_id, channel, method) values ('${me}', '${F.org}', 'vrbo', 'ical')` },
  channel_listings: { where: () => `id = '${F.listing}'`, viewer: true, owner: true, set: `status = 'paused'`,
    insert: () => `insert into public.channel_listings (space_id, channel) values ('${F.space2}', 'vrbo')` },
  calendar_imports: { where: () => `id = '${F.import}'`, viewer: false, owner: true, set: `url = 'https://evil.test/x'`,
    insert: () => `insert into public.calendar_imports (space_id, channel, url) values ('${F.space2}', 'vrbo', 'https://evil.test/x')` },
  calendar_feeds: { where: () => `id = '${F.feed}'`, viewer: false, owner: true, set: `last_fetched_at = now()`,
    insert: () => `insert into public.calendar_feeds (space_id, for_channel) values ('${F.space2}', 'vrbo')` },
  // Direct writes are revoked from signed-in users (M5): bookings go through create_booking / import_reservations.
  reservations: { where: () => `id = '${F.res1}'`, viewer: true, owner: false, set: `status = 'cancelled'`,
    insert: () => `insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at) values ('${F.space2}', 'direct', 'X-${uuid()}', 'manual', '2027-05-01', '2027-05-02')` },
  conflicts: { where: () => `id = '${F.conflict}'`, viewer: true, owner: false, set: `resolved_at = now()`,
    insert: () => `insert into public.conflicts (space_id, a_reservation_id, b_reservation_id) values ('${F.space}', '${F.res2}', '${F.res1}')` },
  earnings_ledger: { where: () => `id = '${F.ledger}'`, viewer: false, owner: false, set: `fee_cents = 0`,
    insert: (me) => `insert into public.earnings_ledger (host_id, reservation_id, period, gross_cents, attributed, share_pct, fee_cents) values ('${me}', '${F.res2}', '2026-11-01', 1, false, 0, 0)` },
  booking_holds: { where: () => `id = '${F.hold}'`, viewer: true, owner: false, set: `status = 'released'`,
    insert: () => `insert into public.booking_holds (space_id, channel, starts_at, ends_at) values ('${F.space}', 'airbnb', '2027-06-01', '2027-06-02')` },
  booking_alerts: { where: () => `id = '${F.alert}'`, viewer: true, owner: false, set: `resolved_at = now()`,
    insert: () => `insert into public.booking_alerts (space_id, kind, channel, reservation_id, message) values ('${F.space}', 'door_open', 'vrbo', '${F.res2}', 'x')` },
  space_amenities: { where: () => `space_id = '${F.space}' and amenity_key = 'wifi'`, viewer: true, owner: true, set: `provenance_tag = 'estimated'`,
    insert: () => `insert into public.space_amenities (space_id, amenity_key) values ('${F.space}', 'kitchen')` },
  parcels: { where: () => `id = '${F.parcel}'`, viewer: true, owner: true, set: `apn = 'pwned'`,
    insert: () => `insert into public.parcels (property_id, apn) values ('${F.prop}', 'APN-2')` },
  buildings: { where: () => `id = '${F.building}'`, viewer: true, owner: true, set: `stories = 9`,
    insert: () => `insert into public.buildings (property_id, kind) values ('${F.prop}', 'garage')` },
  property_attributes: { where: () => `id = '${F.attr}'`, viewer: true, owner: true, set: `superseded_at = now()`,
    insert: () => `insert into public.property_attributes (property_id, key, value, provenance_tag, source_name, confidence) values ('${F.prop}', 'lot_area_sqft', '1', 'measured', 'Test', 0.5)` },
  property_photos: { where: () => `id = '${F.photo}'`, viewer: true, owner: true, set: `license = 'pwned'`,
    insert: () => `insert into public.property_photos (property_id, storage_path) values ('${F.prop}', 'a/b.jpg')` },
  property_regulatory: { where: () => `id = '${F.propReg}'`, viewer: true, owner: true, set: `status = 'compliant'`,
    insert: () => `insert into public.property_regulatory (property_id, rule_id) values ('${F.prop}', '${F.rule2}')` },
  projections: { where: () => `id = '${F.projection}'`, viewer: true, owner: true, set: `goal = 'pwned'`,
    insert: () => `insert into public.projections (property_id, org_id, model_version, inputs, assumptions, scenarios) values ('${F.prop}', '${F.org}', 'v1', '{}', '{}', '{}')` },
  opportunities: { where: () => `id = '${F.opp}'`, viewer: true, owner: true, set: `status = 'dismissed'`,
    insert: () => `insert into public.opportunities (property_id, category_key) values ('${F.prop}', 'parking_spot')` },
  provider_data: { where: () => `id = '${F.provider}'`, viewer: true, owner: false, set: `payload = '{}'`,
    insert: () => `insert into public.provider_data (channel_key, org_id, kind, payload, expires_at) values ('airbnb', '${F.org}', 'x', '{}', now() + interval '1 day')` },
  pricing_rules: { where: () => `id = '${F.price}'`, viewer: true, owner: true, set: `amount_cents = 1`,
    insert: () => `insert into public.pricing_rules (space_id, rule_type, unit, amount_cents) values ('${F.space}', 'base', 'night', 100)` },
  expenses: { where: () => `id = '${F.expense}'`, viewer: false, owner: true, set: `amount_cents = 1`,
    insert: () => `insert into public.expenses (org_id, property_id, category, amount_cents, incurred_on) values ('${F.org}', '${F.prop}', 'repairs', 100, '2026-11-01')` },
  revenue_entries: { where: () => `id = '${F.revenue}'`, viewer: false, owner: true, set: `gross_cents = 1`,
    insert: () => `insert into public.revenue_entries (org_id, property_id, gross_cents, earned_on) values ('${F.org}', '${F.prop}', 100, '2026-11-01')` },
  maintenance_tasks: { where: () => `id = '${F.task}'`, viewer: true, owner: true, set: `status = 'done'`,
    insert: () => `insert into public.maintenance_tasks (property_id, kind) values ('${F.prop}', 'repair')` },
  space_relations: { where: () => `id = '${F.relation}'`, viewer: true, owner: true, set: `note = 'pwned'`,
    insert: () => `insert into public.space_relations (space_id, blocks_space_id) values ('${F.space2}', '${F.space3}')` },
  resources: { where: () => `id = '${F.resource}'`, viewer: true, owner: true, set: `capacity = 99`,
    insert: () => `insert into public.resources (property_id, name, capacity) values ('${F.prop}', 'Intruder', 1)` },
  space_resources: { where: () => `space_id = '${F.space}' and resource_id = '${F.resource}'`, viewer: true, owner: true, set: `units = 9`,
    insert: () => `insert into public.space_resources (space_id, resource_id) values ('${F.space2}', '${F.resource}')` },
  communications: { where: () => `id = '${F.comm}'`, viewer: true, owner: true, set: `body = 'pwned'`,
    insert: () => `insert into public.communications (org_id, space_id, direction, body) values ('${F.org}', '${F.space}', 'note', 'x')` },
};

const count = async (sql) => (await one(sql)).n;
async function refused(promise, label) {
  try {
    const r = await promise;
    assert.equal(r.affectedRows ?? 0, 0, `${label}: changed ${r.affectedRows} row(s)`);
  } catch (e) {
    assert.match(e.message, DENIED, `${label}: unexpected error ${e.message}`);
  }
}

before(async () => {
  ({ db, one } = await freshDb());
  await db.query(`insert into auth.users (id) values ($1), ($2), ($3), ($4), ($5)`, [MAYA, SAM, VIC, MAX, ADA]);
  F.org = (await one(`select id from public.organizations where created_by = $1`, [MAYA])).id;
  F.vicMembership = (await one(`insert into public.memberships (org_id, user_id, role_key) values ($1, $2, 'viewer') returning id`, [F.org, VIC])).id;
  await db.query(`insert into public.memberships (org_id, user_id, role_key) values ($1, $2, 'manager'), ($1, $3, 'admin')`, [F.org, MAX, ADA]);
  const ins = async (sql, params = []) => (await one(`${sql} returning id`, params)).id;
  F.prop = await ins(`insert into public.properties (host_id, title) values ($1, 'Maple St')`, [MAYA]);
  F.space = await ins(`insert into public.spaces (property_id, category, title) values ($1, 'pool', 'Pool')`, [F.prop]);
  F.space2 = await ins(`insert into public.spaces (property_id, category, title) values ($1, 'parking_spot', 'Driveway')`, [F.prop]);
  F.space3 = await ins(`insert into public.spaces (property_id, category, title) values ($1, 'backyard', 'Lawn')`, [F.prop]);
  F.conn = await ins(`insert into public.channel_connections (host_id, channel, method) values ($1, 'airbnb', 'ical')`, [MAYA]);
  F.listing = await ins(`insert into public.channel_listings (space_id, channel) values ($1, 'airbnb')`, [F.space]);
  F.import = await ins(`insert into public.calendar_imports (space_id, channel, url) values ($1, 'swimply', 'https://example.test/s.ics')`, [F.space]);
  F.feed = await ins(`insert into public.calendar_feeds (space_id, for_channel) values ($1, 'airbnb')`, [F.space]);
  F.res1 = await ins(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at, payout_cents) values ($1, 'airbnb', 'A1', 'ical', '2027-01-01', '2027-01-03', 1000)`, [F.space]);
  F.res2 = await ins(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at) values ($1, 'swimply', 'S1', 'ical', '2027-01-02', '2027-01-04')`, [F.space]);
  await one(`select public.detect_conflicts($1)`, [F.space]);
  F.conflict = (await one(`select id from public.conflicts`)).id;
  F.ledger = await ins(`insert into public.earnings_ledger (host_id, reservation_id, period, gross_cents, attributed, share_pct, fee_cents) values ($1, $2, '2027-01-01', 1000, false, 0, 0)`, [MAYA, F.res1]);
  F.hold = await ins(`insert into public.booking_holds (space_id, channel, starts_at, ends_at) values ($1, 'swimply', '2027-02-01', '2027-02-02')`, [F.space]);
  F.alert = await ins(`insert into public.booking_alerts (space_id, kind, channel, reservation_id, message) values ($1, 'door_open', 'airbnb', $2, 'Close it')`, [F.space, F.res2]);
  await db.query(`insert into public.space_amenities (space_id, amenity_key) values ($1, 'wifi')`, [F.space]);
  F.parcel = await ins(`insert into public.parcels (property_id, apn) values ($1, 'APN-1')`, [F.prop]);
  F.building = await ins(`insert into public.buildings (property_id, parcel_id) values ($1, $2)`, [F.prop, F.parcel]);
  F.attr = await ins(`insert into public.property_attributes (property_id, key, value, provenance_tag, source_name, confidence) values ($1, 'lot_area_sqft', '6000', 'measured', 'County', 0.8)`, [F.prop]);
  F.photo = await ins(`insert into public.property_photos (property_id, storage_path) values ($1, 'p/1.jpg')`, [F.prop]);
  F.rule = await ins(`insert into public.regulatory_rules (jurisdiction_key, category_key, rule_type, effect, summary) values ('test_city', 'pool', 'permit', 'unknown', 'Test rule')`);
  F.rule2 = await ins(`insert into public.regulatory_rules (jurisdiction_key, category_key, rule_type, effect, summary) values ('test_city', 'adu', 'permit', 'unknown', 'Test rule 2')`);
  F.propReg = await ins(`insert into public.property_regulatory (property_id, rule_id) values ($1, $2)`, [F.prop, F.rule]);
  F.projection = await ins(`insert into public.projections (property_id, model_version, inputs, assumptions, scenarios) values ($1, 'v1', '{}', '{}', '{}')`, [F.prop]);
  F.opp = await ins(`insert into public.opportunities (property_id, category_key, projection_id) values ($1, 'pool', $2)`, [F.prop, F.projection]);
  F.provider = await ins(`insert into public.provider_data (channel_key, org_id, kind, payload, expires_at) values ('airbnb', $1, 'listing', '{}', now() + interval '1 day')`, [F.org]);
  F.price = await ins(`insert into public.pricing_rules (space_id, rule_type, unit, amount_cents) values ($1, 'base', 'hour', 4500)`, [F.space]);
  F.expense = await ins(`insert into public.expenses (property_id, category, amount_cents, incurred_on) values ($1, 'cleaning', 5000, '2026-11-01')`, [F.prop]);
  F.revenue = await ins(`insert into public.revenue_entries (property_id, reservation_id, gross_cents, earned_on) values ($1, $2, 1000, '2027-01-03')`, [F.prop, F.res1]);
  F.task = await ins(`insert into public.maintenance_tasks (property_id, space_id, kind) values ($1, $2, 'cleaning')`, [F.prop, F.space]);
  F.relation = await ins(`insert into public.space_relations (space_id, blocks_space_id) values ($1, $2)`, [F.space, F.space2]);
  F.resource = await ins(`insert into public.resources (property_id, name, capacity) values ($1, 'Parking', 2)`, [F.prop]);
  await db.query(`insert into public.space_resources (space_id, resource_id) values ($1, $2)`, [F.space, F.resource]);
  F.comm = await ins(`insert into public.communications (space_id, direction, body) values ($1, 'inbound', 'Hi')`, [F.space]);
  // Sam's own data, so "0 rows" means isolation rather than an empty database.
  const sp = await ins(`insert into public.properties (host_id, title) values ($1, 'Sam place')`, [SAM]);
  await db.query(`insert into public.spaces (property_id, category, title) values ($1, 'pool', 'Sam pool')`, [sp]);
});

test('row-level security is enabled on every table in public, and every view runs as the caller', async () => {
  const off = (await db.query(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity`)).rows;
  assert.deepEqual(off, []);
  const views = (await db.query(`select relname, coalesce(reloptions, '{}') as o from pg_class where relnamespace = 'public'::regnamespace and relkind in ('v', 'm')`)).rows;
  for (const v of views) assert.ok(v.o.includes('security_invoker=true'), `${v.relname} must be security_invoker`);
});

test('every table in public is classified (new tables must be added to this test)', async () => {
  const tables = (await db.query(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by 1`)).rows.map((r) => r.relname);
  const known = new Set([...GLOBAL, ...Object.keys(TENANT)]);
  assert.deepEqual(tables.filter((t) => !known.has(t)), [], 'unclassified tables: add them to GLOBAL or TENANT in tests/rls.test.mjs');
  assert.deepEqual([...known].filter((t) => !tables.includes(t)), []);
});

for (const [table, spec] of Object.entries(TENANT)) {
  test(`${table}: another org sees 0 rows and cannot insert, update or delete; a viewer reads but cannot write`, async () => {
    const sel = `select count(*)::int as n from public.${table} where ${spec.where()}`;
    assert.equal(await count(sel), 1, 'fixture row exists');
    // Positive control: the statements are valid and the owner may run them.
    if (spec.owner) {
      await db.exec('begin');
      try { await as(db, MAYA, () => db.query(spec.insert(MAYA))); } finally { await db.exec('rollback'); }
    }
    await as(db, SAM, async () => {
      assert.equal(await count(sel), 0, 'other org reads');
      await refused(db.query(spec.insert(SAM)), `${table} insert by other org`);
      await refused(db.query(`update public.${table} set ${spec.set} where ${spec.where()}`), `${table} update by other org`);
      await refused(db.query(`delete from public.${table} where ${spec.where()}`), `${table} delete by other org`);
    });
    await as(db, VIC, async () => {
      assert.equal(await count(sel), spec.viewer ? 1 : 0, 'viewer reads');
      await refused(db.query(spec.insert(VIC)), `${table} insert by viewer`);
      await refused(db.query(`update public.${table} set ${spec.set} where ${spec.where()}`), `${table} update by viewer`);
      await refused(db.query(`delete from public.${table} where ${spec.where()}`), `${table} delete by viewer`);
    });
    await as(db, null, async () => {
      try { assert.equal(await count(sel), 0, 'anon reads'); } catch (e) { assert.match(e.message, /permission denied|anon reads/); if (!/permission denied/.test(e.message)) throw e; }
      await refused(db.query(spec.insert(MAYA)), `${table} insert by anon`);
    });
    assert.equal(await count(sel), 1, 'fixture row untouched');
  });
}

test('anon reads only the public lookups; nobody but the service role writes them', async () => {
  const objects = (await db.query(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v') order by 1`)).rows.map((r) => r.relname);
  await as(db, null, async () => {
    for (const t of objects) {
      let n;
      try { n = await count(`select count(*)::int as n from public.${t}`); } catch (e) { assert.match(e.message, /permission denied/); n = 0; }
      if (ANON_READABLE.includes(t)) assert.ok(n > 0, `anon should read ${t}`);
      else assert.equal(n, 0, `anon must not read ${t}`);
    }
    await refused(db.query(`insert into public.channels (key, name) values ('anon_site', 'x')`), 'anon channel insert');
  });
  await as(db, MAYA, async () => {
    assert.equal(await count(`select count(*)::int as n from public.channels`), 19);
    assert.equal(await count(`select count(*)::int as n from public.roles`), 5);
    assert.ok(await count(`select count(*)::int as n from public.space_categories`) >= 39);
    for (const t of GLOBAL) {
      await refused(db.query(`delete from public.${t}`), `${t} delete by member`);
    }
    await refused(db.query(`insert into public.channels (key, name) values ('my_site', 'x')`), 'member channel insert');
    await refused(db.query(`update public.roles set permissions = permissions || '{org.manage}' where key = 'viewer'`), 'member role edit');
    await refused(db.query(`insert into public.regulatory_rules (jurisdiction_key, rule_type, effect, summary) values ('x', 'x', 'allowed', 'x')`), 'member rule insert');
  });
});

test('a manager can write spaces but not manage members', async () => {
  await as(db, MAX, async () => {
    const id = (await one(`insert into public.spaces (property_id, category, title) values ($1, 'kayak', 'Kayak') returning id`, [F.prop])).id;
    assert.equal((await db.query(`update public.spaces set title = 'Red kayak' where id = $1`, [id])).affectedRows, 1);
    assert.equal(await count(`select count(*)::int as n from public.calendar_imports`), 1);
    await refused(db.query(`update public.memberships set role_key = 'admin' where user_id = $1 and org_id = $2`, [VIC, F.org]), 'manager promotes');
    await refused(db.query(`update public.memberships set role_key = 'owner' where user_id = $1 and org_id = $2`, [MAX, F.org]), 'manager self-promotes');
    await refused(db.query(`insert into public.memberships (org_id, user_id, role_key) values ($1, $2, 'viewer')`, [F.org, SAM]), 'manager adds member');
    assert.equal(await count(`select count(*)::int as n from public.revenue_entries`), 1); // finance.read
    await refused(db.query(spec('revenue_entries').insert()), 'manager writes revenue');
  });
});

test('self role escalation and self-adds are refused', async () => {
  const role = async (u) => (await one(`select role_key from public.memberships where org_id = $1 and user_id = $2`, [F.org, u])).role_key;
  await as(db, VIC, async () => {
    await refused(db.query(`update public.memberships set role_key = 'owner' where user_id = $1 and org_id = $2`, [VIC, F.org]), 'viewer self-promotes');
    await refused(db.query(`insert into public.memberships (org_id, user_id, role_key) values ((select id from public.organizations where created_by = $1), $2, 'owner')`, [SAM, VIC]), 'viewer joins another org');
  });
  await as(db, ADA, async () => {
    await assert.rejects(db.query(`update public.memberships set role_key = 'owner' where user_id = $1 and org_id = $2`, [ADA, F.org]), /own role/);
    await assert.rejects(db.query(`update public.memberships set role_key = 'owner' where user_id = $1`, [VIC]), /above your own/);
    await assert.rejects(db.query(`update public.memberships set role_key = 'viewer' where user_id = $1 and org_id = $2`, [MAYA, F.org]), /above your own/);
    await refused(db.query(`insert into public.memberships (org_id, user_id, role_key) values ((select id from public.organizations where created_by = $1), $2, 'viewer')`, [SAM, ADA]), 'admin joins another org');
    assert.equal((await db.query(`update public.memberships set role_key = 'operator' where user_id = $1`, [VIC])).affectedRows, 1);
    assert.equal((await db.query(`update public.memberships set role_key = 'viewer' where user_id = $1`, [VIC])).affectedRows, 1);
  });
  await as(db, MAYA, async () => {
    await assert.rejects(db.query(`delete from public.memberships where user_id = $1 and org_id = $2`, [MAYA, F.org]), /at least one owner/);
    // A new team org makes the caller its owner; nobody can insert their own membership directly.
    const team = (await one(`select public.create_organization('Maple Team') as id`)).id;
    assert.equal((await one(`select role_key from public.memberships where org_id = $1 and user_id = $2`, [team, MAYA])).role_key, 'owner');
  });
  assert.deepEqual([await role(VIC), await role(ADA), await role(MAYA)], ['viewer', 'admin', 'owner']);
});

// Every SECURITY DEFINER function is classified: the ones a signed-in user may call are listed here (a new one fails
// this test until it is added, with its own caller check); none is callable by anon or PUBLIC; all pin search_path.
const AUTHENTICATED_RPC = ['accept_invite', 'availability_conflicts', 'can_manage_space', 'can_view_space', 'cancel_booking',
  'create_booking', 'create_organization', 'decline_invite', 'dismiss_alert', 'has_org_permission', 'has_property_permission',
  'has_space_permission', 'import_reservations', 'is_org_member', 'org_member_profiles', 'org_role_rank', 'owns_space',
  'place_hold', 'release_hold', 'reschedule_booking'];
test('every SECURITY DEFINER function is classified, pins search_path and is closed to anon and PUBLIC', async () => {
  const names = async (where) => (await db.query(`select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and ${where} order by 1`)).rows.map((r) => r.proname);
  assert.deepEqual(await names(`p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')`), AUTHENTICATED_RPC);
  assert.deepEqual(await names(`has_function_privilege('anon', p.oid, 'execute')`), ['site_name']);
  assert.deepEqual(await names(`p.prosecdef and not ('search_path=""' = any (coalesce(p.proconfig, '{}')))`), []);
  assert.deepEqual(await names(`p.prosecdef and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where a.grantee = 0 and a.privilege_type = 'EXECUTE')`), []);
  // Internal helpers: not even the service role calls them directly.
  assert.deepEqual(await names(`p.proname = 'apply_import' and has_function_privilege('service_role', p.oid, 'execute')`), []);
  assert.deepEqual(await names(`p.proname = 'sync_calendar_import' and has_function_privilege('service_role', p.oid, 'execute')`), ['sync_calendar_import']);
});

function spec(name) { return TENANT[name]; }

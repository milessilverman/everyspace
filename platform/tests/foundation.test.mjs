// M1-M4 foundation: personal orgs, the legacy (Host Console) write path, data-driven catalogs, provenance,
// append-only and immutable records, provider-data purge and revenue math. Runs every migration on PGlite.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, as } from './helpers/db.mjs';

const MAYA = '11111111-1111-1111-1111-111111111111';
const SAM = '22222222-2222-2222-2222-222222222222';
const OPI = '33333333-3333-3333-3333-333333333333';
const LEGACY = '44444444-4444-4444-4444-444444444444';
const DENIED = /row-level security|permission denied|does not belong|append-only|immutable|only update the status/;
let db, one, prop, space, orgA;

before(async () => {
  // Seed a pre-M1 host with legacy rows (enum channel, free-text category) to prove the backfill and conversion.
  ({ db, one } = await freshDb({ pause: { before: '20261124010000', run: async (d) => {
    await d.query(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name":"Lee"}')`, [LEGACY]);
    const p = (await d.query(`insert into public.properties (host_id, title) values ($1, 'Old place') returning id`, [LEGACY])).rows[0].id;
    const s = (await d.query(`insert into public.spaces (property_id, category, title) values ($1, 'treehouse', 'Treehouse') returning id`, [p])).rows[0].id;
    await d.query(`insert into public.channel_connections (host_id, channel, method) values ($1, 'airbnb', 'ical')`, [LEGACY]);
    await d.query(`insert into public.reservations (space_id, channel, external_uid, source, starts_at, ends_at) values ($1, 'hipcamp', 'H1', 'ical', '2026-12-01', '2026-12-02')`, [s]);
  } } }));
  await db.query(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name":"Maya"}'), ($2, '{"full_name":"Sam"}'), ($3, '{}')`, [MAYA, SAM, OPI]);
  orgA = (await one(`select id from public.organizations where created_by = $1 and kind = 'personal'`, [MAYA])).id;
  await db.query(`insert into public.memberships (org_id, user_id, role_key) values ($1, $2, 'operator')`, [orgA, OPI]);
});

test('every profile gets a personal org with an owner membership, including profiles that existed before M1', async () => {
  const rows = (await db.query(`select p.id, o.name, o.kind, m.role_key from public.profiles p
    join public.organizations o on o.created_by = p.id and o.kind = 'personal'
    join public.memberships m on m.org_id = o.id and m.user_id = p.id order by p.id`)).rows;
  assert.deepEqual(rows.map((r) => [r.id, r.name, r.role_key]), [
    [MAYA, 'Maya', 'owner'], [SAM, 'Sam', 'owner'], [OPI, 'Personal', 'owner'], [LEGACY, 'Lee', 'owner']]);
  const legacy = await one(`select p.org_id = o.id as same, c.org_id = o.id as conn from public.properties p, public.channel_connections c, public.organizations o
    where p.host_id = $1 and c.host_id = $1 and o.created_by = $1`, [LEGACY]);
  assert.deepEqual(legacy, { same: true, conn: true });
  // The legacy free-text category and enum channel survived as rows.
  assert.equal((await one(`select count(*)::int as n from public.space_categories where key = 'treehouse'`)).n, 1);
  assert.equal((await one(`select channel, pg_typeof(channel)::text as t from public.reservations where external_uid = 'H1'`)).t, 'text');
  assert.equal((await one(`select count(*)::int as n from pg_type where typname = 'channel' and typnamespace = 'public'::regnamespace`)).n, 0);
});

test('the Host Console write path works unchanged: properties with only host_id, channels as plain strings', async () => {
  await as(db, MAYA, async () => {
    prop = (await one(`insert into public.properties (host_id, title, address, city) values ($1, '412 Maple St', null, 'Los Angeles') returning id, org_id`, [MAYA]));
    assert.equal(prop.org_id, orgA);
    prop = prop.id;
    space = (await one(`insert into public.spaces (property_id, title, category, parent_space_id, quantity) values ($1, 'Garage', 'garage', null, 1) returning id`, [prop])).id;
    await db.query(`insert into public.channel_listings (space_id, channel, status, booking_mode) values ($1, $2, 'live', 'request')`, [space, 'airbnb']);
    await db.query(`insert into public.calendar_feeds (space_id, for_channel) values ($1, $2)`, [space, 'airbnb']);
    await db.query(`insert into public.calendar_imports (space_id, channel, url) values ($1, $2, 'https://example.test/a.ics')
                    on conflict (space_id, channel) do update set url = excluded.url`, [space, 'vrbo']);
    assert.equal((await one(`select public.site_name('booking_com') as n`)).n, 'Booking.com');
    await assert.rejects(db.query(`insert into public.channel_listings (space_id, channel) values ($1, 'myspace')`, [space]), /foreign key/);
    await assert.rejects(db.query(`insert into public.spaces (property_id, title, category) values ($1, 'X', 'not_a_category')`, [prop]), /foreign key/);
    // host_id cannot be reassigned by a signed-in user.
    await assert.rejects(db.query(`update public.properties set host_id = $1 where id = $2`, [SAM, prop]), /host_id cannot be changed/);
  });
});

test('a new platform or category is a plain INSERT, no migration', async () => {
  await db.exec(`set role service_role`);
  await db.query(`insert into public.channels (key, name, kind) values ('test_platform', 'Test Platform', 'marketplace')`);
  await db.query(`insert into public.space_categories (key, label, group_key, units) values ('test_category', 'Test category', 'outdoor', '{hour,day}')`);
  await db.exec(`reset role`);
  const c = await one(`select cap_calendar, cap_booking, capabilities_verified_at from public.channels where key = 'test_platform'`);
  assert.deepEqual(c, { cap_calendar: 'L0', cap_booking: 'L0', capabilities_verified_at: null });
  await as(db, MAYA, async () => {
    const s = (await one(`insert into public.spaces (property_id, title, category) values ($1, 'New thing', 'test_category') returning id`, [prop])).id;
    await db.query(`insert into public.channel_listings (space_id, channel) values ($1, 'test_platform')`, [s]);
    assert.equal((await one(`select public.site_name('test_platform') as n`)).n, 'Test Platform');
  });
  await assert.rejects(db.query(`update public.channels set cap_listing = 'L5' where key = 'test_platform'`), /check constraint/);
  const seeded = (await db.query(`select key from public.channels where cap_calendar <> 'L0' order by key`)).rows.map((r) => r.key);
  assert.deepEqual(seeded, ['airbnb', 'booking_com', 'vrbo']);
  assert.equal((await one(`select count(*)::int as n from public.channels where capabilities_verified_at is not null`)).n, 0);
});

test('provenance: owner_confirmed beats a later, higher-confidence measured value; unavailable only wins alone', async () => {
  const add = (key, val, tag, conf, src = 'County assessor') => db.query(
    `insert into public.property_attributes (property_id, key, value, provenance_tag, source_name, confidence) values ($1, $2, $3, $4, $5, $6)`,
    [prop, key, val, tag, src, conf]);
  const cur = async (key) => one(`select value, provenance_tag, confidence::float as c from public.property_profile where property_id = $1 and key = $2`, [prop, key]);
  await as(db, MAYA, async () => {
    await add('lot_area_sqft', '6000', 'measured', 0.6);
    await add('lot_area_sqft', '5800', 'estimated', 0.3);
    assert.equal((await cur('lot_area_sqft')).value, 6000); // highest confidence
    await one(`select public.confirm_attribute($1, 'lot_area_sqft', '6250', 'sqft') as id`, [prop]);
    await add('lot_area_sqft', '6400', 'measured', 0.95); // later and more confident, still loses
    assert.deepEqual(await cur('lot_area_sqft'), { value: 6250, provenance_tag: 'owner_confirmed', c: 1 });
    await one(`select public.confirm_attribute($1, 'lot_area_sqft', '6300', 'sqft')`, [prop]);
    assert.equal((await cur('lot_area_sqft')).value, 6300); // newest owner confirmation
    await add('pool_area_sqft', null, 'unavailable', null, 'Parcel service');
    assert.equal((await cur('pool_area_sqft')).provenance_tag, 'unavailable');
    await add('pool_area_sqft', '400', 'estimated', 0.1, 'Everyspace planning default (uncited)');
    assert.deepEqual(await cur('pool_area_sqft'), { value: 400, provenance_tag: 'estimated', c: 0.1 });
    // Rules from STATE: uncited numbers are estimated with confidence <= 0.2; unavailable never carries a value.
    await assert.rejects(add('x', '1', 'estimated', 0.5, 'Everyspace planning default (uncited)'), /check constraint/);
    await assert.rejects(add('x', '0', 'unavailable', null), /check constraint/);
    // An attribute about a space must name a space of this property.
    await assert.rejects(db.query(`insert into public.property_attributes (property_id, subject_type, subject_id, key, value, provenance_tag, source_name)
      values ($1, 'space', gen_random_uuid(), 'k', '1', 'measured', 's')`, [prop]), /does not belong/);
  });
});

test('property_attributes is append-only', async () => {
  const id = (await one(`select id from public.property_attributes where property_id = $1 and provenance_tag = 'measured' limit 1`, [prop])).id;
  await as(db, MAYA, async () => {
    await assert.rejects(db.query(`update public.property_attributes set value = '1' where id = $1`, [id]), DENIED);
    await assert.rejects(db.query(`delete from public.property_attributes where id = $1`, [id]), DENIED);
    assert.equal((await db.query(`update public.property_attributes set superseded_at = now() where id = $1`, [id])).affectedRows, 1);
    await assert.rejects(db.query(`update public.property_attributes set superseded_at = now() + interval '1 day' where id = $1`, [id]), /append-only/);
  });
  // Even the service role cannot rewrite a value.
  await assert.rejects(db.query(`update public.property_attributes set value = '2' where id = $1`, [id]), /append-only/);
});

test('provider_data requires expires_at and is purged by the service role only', async () => {
  const ins = (exp) => db.query(`insert into public.provider_data (channel_key, org_id, kind, payload, retrieved_at, expires_at) values ('airbnb', $1, 'listing', '{"a":1}', now() - interval '2 days', $2)`, [orgA, exp]);
  await assert.rejects(ins(null), /not-null|null value/);
  await ins(new Date(Date.now() - 86400000).toISOString());
  await ins(new Date(Date.now() + 86400000).toISOString());
  await as(db, MAYA, async () => {
    assert.equal((await one(`select count(*)::int as n from public.provider_data`)).n, 2);
    await assert.rejects(db.query(`select public.purge_expired_provider_data()`), /permission denied/);
    await assert.rejects(db.query(`insert into public.provider_data (channel_key, org_id, kind, payload, expires_at) values ('airbnb', $1, 'x', '{}', now() + interval '1 day')`, [orgA]), DENIED);
  });
  await db.exec(`set role service_role`);
  assert.equal((await one(`select public.purge_expired_provider_data() as n`)).n, 1);
  await db.exec(`reset role`);
  assert.equal((await one(`select count(*)::int as n from public.provider_data`)).n, 1);
  // No table references provider_data (it is never joined into intelligence).
  assert.equal((await one(`select count(*)::int as n from pg_constraint where contype = 'f' and confrelid = 'public.provider_data'::regclass`)).n, 0);
});

test('projections are immutable', async () => {
  const id = await as(db, MAYA, async () => {
    const p = await one(`insert into public.projections (property_id, model_version, goal, inputs, assumptions, scenarios, confidence)
      values ($1, 'rev-1', 'max_revenue', '{}', '{}', '{"base":1}', 0.2) returning id, org_id`, [prop]);
    assert.equal(p.org_id, orgA); // filled from the property
    await assert.rejects(db.query(`update public.projections set goal = 'x' where id = $1`, [p.id]), DENIED);
    await assert.rejects(db.query(`delete from public.projections where id = $1`, [p.id]), DENIED);
    return p.id;
  });
  await assert.rejects(db.query(`update public.projections set scenarios = '{}' where id = $1`, [id]), /immutable/);
  await as(db, MAYA, async () => {
    await db.query(`insert into public.opportunities (property_id, category_key, projection_id) values ($1, 'pool', $2)`, [prop, id]);
  });
});

test('revenue_entries: net is computed, org filled from the property, cross-tenant references refused', async () => {
  await as(db, MAYA, async () => {
    const r = await one(`insert into public.revenue_entries (property_id, space_id, channel_key, gross_cents, platform_fee_cents, cleaning_cents, tax_cents, earned_on)
      values ($1, $2, 'airbnb', 100000, 3000, 5000, 12000, '2026-11-20') returning net_cents::int as net, org_id`, [prop, space]);
    assert.deepEqual(r, { net: 80000, org_id: orgA });
    await assert.rejects(db.query(`insert into public.revenue_entries (property_id, gross_cents, net_cents, earned_on) values ($1, 1, 1, '2026-11-20')`, [prop]), /generated|non-DEFAULT/);
    await assert.rejects(db.query(`insert into public.revenue_entries (property_id, gross_cents, platform_fee_cents, earned_on) values ($1, 100, -1, '2026-11-20')`, [prop]), /check constraint/);
    const legacySpace = await db.query(`select id from public.spaces where title = 'Treehouse'`);
    assert.equal(legacySpace.rows.length, 0); // RLS: another host's space is invisible
  });
  const theirs = (await one(`select id from public.spaces where title = 'Treehouse'`)).id;
  await as(db, MAYA, async () => {
    await assert.rejects(db.query(`insert into public.revenue_entries (org_id, space_id, gross_cents, earned_on) values ($1, $2, 100, '2026-11-20')`, [orgA, theirs]), /does not belong/);
    await assert.rejects(db.query(`insert into public.expenses (org_id, space_id, category, amount_cents, incurred_on) values ($1, $2, 'x', 1, '2026-11-01')`, [orgA, theirs]), /does not belong/);
  });
});

test('an assigned operator may update only the status of their task', async () => {
  const task = await as(db, MAYA, async () => (await one(`insert into public.maintenance_tasks (property_id, space_id, kind, title, assigned_to) values ($1, $2, 'turnover', 'Clean', $3) returning id`, [prop, space, OPI])).id);
  await assert.rejects(as(db, MAYA, () => db.query(`insert into public.maintenance_tasks (property_id, kind, assigned_to) values ($1, 'repair', $2)`, [prop, SAM])), /member of this organization/);
  await as(db, OPI, async () => {
    assert.equal((await db.query(`update public.maintenance_tasks set status = 'done' where id = $1`, [task])).affectedRows, 1);
    await assert.rejects(db.query(`update public.maintenance_tasks set title = 'Nap' where id = $1`, [task]), /only update the status/);
    await assert.rejects(db.query(`insert into public.maintenance_tasks (property_id, kind) values ($1, 'repair')`, [prop]), DENIED);
    // Operators keep booking access (owns_space = booking.write) but cannot manage spaces.
    assert.equal((await one(`select public.owns_space($1) as ok`, [space])).ok, true);
    assert.equal((await db.query(`update public.spaces set title = 'X' where id = $1`, [space])).affectedRows, 0);
  });
});

test('every SECURITY DEFINER function pins search_path and is not callable by anon', async () => {
  const fns = (await db.query(`select p.oid::regprocedure::text as sig, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef order by 1`)).rows;
  assert.ok(fns.length > 30);
  for (const f of fns) {
    assert.ok((f.proconfig ?? []).some((c) => c === 'search_path=""' || c === 'search_path=' ), `${f.sig} search_path`);
    assert.equal(f.anon, false, `${f.sig} is executable by anon`);
  }
  assert.ok(fns.some((f) => f.sig === 'owns_space(uuid)'));
});

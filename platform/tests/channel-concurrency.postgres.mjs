// Separate connections to a disposable PostgreSQL server exercise advisory locks and SKIP LOCKED.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { AUTH_STUB } from './helpers/db.mjs';

const docker = promisify(execFile);
const container = `everyspace-reservation-test-${randomUUID().slice(0, 8)}`;
const image = 'postgres:17.7-alpine';
let started = false;
let legacySpace;

function query(sql, name = 'everyspace-test') {
  const child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${name}`, container,
    'psql', '-XAtq', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1']);
  const lines = createInterface({ input: child.stdout });
  let output = '';
  let error = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { error += chunk; });
  child.stdin.on('error', () => {}); // A command that exits early may close the pipe.
  const first = new Promise((resolve) => {
    lines.once('line', resolve);
    lines.once('close', () => resolve(null));
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error.trim())));
  });
  child.stdin.end(sql);
  return { first, done };
}
const execute = (sql) => query(sql).done;
const service = (sql) => execute(`set role service_role; ${sql}`);

before(async () => {
  await docker('docker', ['run', '--detach', '--rm', '--name', container, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
  started = true;
  for (let attempt = 0; ; attempt++) {
    try {
      await execute('select 1;');
      break;
    } catch (error) {
      if (attempt === 80) throw error;
      await delay(250);
    }
  }
  const directory = new URL('../supabase/migrations/', import.meta.url);
  await execute(AUTH_STUB);
  for (const name of (await readdir(directory)).sort()) {
    if (name.includes('_universal_channel_catalog')) {
      ({ space: legacySpace } = await fixture([]));
      await execute(`insert into public.reservations(space_id, channel, external_uid, source, starts_at, ends_at)
        values ('${legacySpace}', 'vrbo', 'legacy-ical', 'ical', '2037-07-10T07:00Z','2037-07-11T07:00Z');`);
    }
    await execute(await readFile(new URL(name, directory), 'utf8'));
  }
});
after(async () => { if (started) await docker('docker', ['stop', '-t', '2', container]); });

async function fixture(channels) {
  const host = randomUUID();
  const property = randomUUID();
  const space = randomUUID();
  await execute(`
    insert into auth.users(id) values ('${host}');
    insert into public.properties(id, host_id, title) values ('${property}', '${host}', 'Cabin');
    insert into public.spaces(id, property_id, category, title) values ('${space}', '${property}', 'entire_home', 'Cabin');
  `);
  for (const channel of channels) {
    await execute(`
      insert into public.channel_listings(space_id, channel, status) values ('${space}', '${channel}', 'live');
      insert into public.channel_api_listings(space_id, channel, account_ref, listing_ref, authorized, approval_supported, auto_approve)
      values ('${space}', '${channel}', '${host}', '${space}', true, true, true);
    `);
  }
  return { host, space };
}

async function enqueue({ host, space }, channel) {
  assert.equal(await service(`select public.enqueue_channel_reservation_event('${channel}', '${host}', '${space}', 'e', '${channel}');`), 'queued');
}

async function claim() {
  return JSON.parse(await service('select public.claim_channel_reservation_work();') || 'null');
}

async function observe(work, netMinor) {
  const pending = JSON.stringify({ checkIn: '2037-07-10', checkOut: '2037-07-13', quote: { netMinor, currency: 'USD' } });
  return service(`select public.record_channel_reservation_result('${work.id}', '${work.token}', 'pending', '${pending}');`);
}

async function eligible(work) {
  await execute(`update public.channel_reservation_requests set eligible_at = clock_timestamp(), next_attempt_at = clock_timestamp() where id = '${work.id}';`);
  return claim();
}

function prepare(work, listingIds) {
  const proof = listingIds.map((id) => `jsonb_build_object('listingId', '${id.toString()}', 'state',
    'clear', 'bookingMode', 'request', 'observedAt', clock_timestamp())`).join(',');
  return `select public.prepare_channel_reservation_approval('${work.id}', '${work.token}', jsonb_build_array(${proof}));`;
}

async function isWaiting(name) {
  for (let i = 0; i < 20; i++) {
    const waiting = await execute(`select exists(select 1 from pg_stat_activity
      where application_name = '${name}' and wait_event = 'advisory' and cardinality(pg_blocking_pids(pid)) > 0);`);
    if (waiting === 't') return true;
    await delay(25);
  }
  return false;
}

test('two database sessions cannot approve overlapping requests in the same property', async () => {
  const data = await fixture(['airbnb', 'vrbo']);
  await enqueue(data, 'airbnb');
  const airbnb = await claim();
  assert.equal(await observe(airbnb, 30_000), 'waiting_for_requests');
  await enqueue(data, 'vrbo');
  const vrbo = await claim();
  assert.equal(await observe(vrbo, 25_000), 'waiting_for_requests');
  const winner = await eligible(airbnb);
  const loser = await eligible(vrbo);
  assert.equal(await observe(winner, 30_000), 'ready');
  assert.equal(await observe(loser, 25_000), 'ready');
  const listings = [winner.listingId, loser.listingId];
  const first = query(`begin; set role service_role; ${prepare(winner, listings)} select pg_sleep(2); commit;`);
  const result = await first.first;
  const second = query(`set role service_role; ${prepare(loser, listings)}`, 'competing-approval');
  const waited = await isWaiting('competing-approval');
  const [approved, blocked] = await Promise.all([first.done, second.done]);
  assert.equal(result, 'approving');
  assert.equal(waited, true, 'the second backend waited on the first transaction');
  assert.equal(approved, 'approving');
  assert.equal(blocked, 'dates_taken');
  assert.equal(await execute(`select count(*) from public.channel_reservation_requests
    where id in ('${winner.id}', '${loser.id}') and status = 'approving';`), '1');
});

test('a calendar reservation written before approval commits under the same property lock', async () => {
  const data = await fixture(['airbnb']);
  await enqueue(data, 'airbnb');
  const initial = await claim();
  assert.equal(await observe(initial, 25_000), 'waiting_for_requests');
  const work = await eligible(initial);
  assert.equal(await observe(work, 25_000), 'ready');
  const first = query(`begin;
    insert into public.reservations(space_id, channel, external_uid, source, starts_at, ends_at)
    values ('${data.space}', 'vrbo', 'provider-calendar-event', 'ical', '2037-07-10T07:00Z', '2037-07-11T07:00Z');
    select 'inserted'; select pg_sleep(2); commit;`);
  const result = await first.first;
  const second = query(`set role service_role; ${prepare(work, [work.listingId])}`, 'approval-after-calendar');
  const waited = await isWaiting('approval-after-calendar');
  const [, blocked] = await Promise.all([first.done, second.done]);
  assert.equal(result, 'inserted');
  assert.equal(waited, true);
  assert.equal(blocked, 'dates_taken');
});

test('parallel workers skip a claimed row rather than acquiring the same provider job', async () => {
  const data = await fixture(['airbnb']);
  await enqueue(data, 'airbnb');
  const first = query('begin; set role service_role; select public.claim_channel_reservation_work(); select pg_sleep(2); commit;');
  const lease = JSON.parse(await first.first);
  const loss = await claim();
  await first.done;
  assert.equal(lease.request.externalRequestId, 'airbnb');
  assert.equal(loss, null);
});

test('concurrent multi-unit holds cannot both consume the same remaining capacity', async () => {
  const { space } = await fixture(['airbnb']);
  await execute(`update public.spaces set quantity = 3 where id = '${space}';`);
  const hold = `select public.place_inventory_hold('${space}', 'direct', '2037-07-10T18:00Z', '2037-07-10T20:00Z', false, null, null, 2);`;
  const first = query(`begin; set role service_role; ${hold} select pg_sleep(2); commit;`);
  assert.match(await first.first, /^[0-9a-f-]{36}$/);
  const second = query(`set role service_role; ${hold}`, 'multi-unit-hold-waiter');
  const blocked = assert.rejects(second.done, /already taken or above capacity/);
  const waited = await isWaiting('multi-unit-hold-waiter');
  await Promise.all([first.done, blocked]);
  assert.equal(waited, true);
  assert.equal(await execute(`select coalesce(sum(units), 0) from public.booking_holds where space_id = '${space}';`), '2');
});

test('the upgrade preserves an existing iCal reservation at default capacity and cleanup', async () => {
  const row = await execute(`select r.status, r.units, s.turnover_minutes from public.reservations r
    join public.spaces s on s.id = r.space_id where s.id = '${legacySpace}' and r.external_uid = 'legacy-ical';`);
  assert.equal(row, 'confirmed|1|0');
});

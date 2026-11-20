import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { airbnbAdapter } from '../supabase/functions/_shared/airbnb-adapter.ts';
import { vrboAdapter } from '../supabase/functions/_shared/vrbo-adapter.ts';
import type { Availability, BookingRequest, Channel, ChannelAdapter, ProviderDelivery, ProviderState } from '../supabase/functions/_shared/channel-adapters.ts';
import { drainReservations, reservationStore, withProviderDeadline, type ReservationStore } from '../supabase/functions/_shared/channel-reservation-engine.ts';
import { reservationHandler } from '../supabase/functions/_shared/channel-reservation-http.ts';
import { freshDb } from './helpers/db.mjs';

let database: Awaited<ReturnType<typeof freshDb>>;
let store: ReservationStore;
const stay = { checkIn: '2037-07-10', checkOut: '2037-07-13' };

before(async () => {
  database = await freshDb();
  store = reservationStore(async (name, args = {}) => {
    const parameters = Object.values(args);
    const slots = parameters.map((_, i) => `$${i + 1}`).join(',');
    try {
      return { data: (await database.one(`select public.${name}(${slots}) as data`, parameters)).data, error: null };
    } catch (error) {
      return { data: null, error };
    }
  });
});
beforeEach(async () => {
  await database.db.exec('update public.channel_reservation_requests set next_attempt_at = null');
});
after(async () => { await database?.db.close(); });

async function fixture() {
  const { one } = database;
  const { id: host } = await one('insert into auth.users (id) values (gen_random_uuid()) returning id');
  const { id: property } = await one("insert into public.properties (host_id, title) values ($1, 'Cabin') returning id", [host]);
  const { id: space } = await one("insert into public.spaces (property_id, category, title) values ($1, 'entire_home', 'Cabin') returning id", [property]);
  async function listing(channel: Channel, spaceId = space, enabled = true) {
    const accountRef = host;
    const listingRef = spaceId;
    await one("insert into public.channel_listings (space_id, channel, status) values ($1, $2, 'live')", [spaceId, channel]);
    await one(`insert into public.channel_api_listings (space_id, channel, account_ref, listing_ref, authorized, approval_supported, auto_approve)
      values ($1, $2, $3, $4, true, true, $5)`, [spaceId, channel, accountRef, listingRef, enabled]);
    return { channel, accountRef, listingRef };
  }
  return { host, property, space, listing };
}

function pending(request: BookingRequest, netMinor = 10_000, currency = 'USD'): ProviderState {
  return { ...request, state: 'pending', ...stay, expiresAt: null, quote: { netMinor, currency } };
}

function providers() {
  const current = new Map<string, ProviderState>();
  const approved: { request: BookingRequest; operationId: string }[] = [];
  let approve: (request: BookingRequest) => void = () => {};
  let availability: (channel: Channel) => Availability = () => ({
    state: 'clear', bookingMode: 'request', observedAt: new Date().toISOString(),
  });
  const adapter = (channel: Channel): ChannelAdapter => ({
    ...(channel === 'airbnb' ? airbnbAdapter : vrboAdapter),
    supportsProgrammaticApproval: true,
    supportsAvailability: true,
    getReservation: async (request) => current.get(request.externalRequestId) ?? null,
    getAvailability: async () => availability(channel),
    approve: async (request, operationId) => {
      approved.push({ request, operationId });
      approve(request);
    },
  });
  return {
    adapters: { airbnb: adapter('airbnb'), vrbo: adapter('vrbo') },
    current, approved,
    onApprove: (fn: typeof approve) => { approve = fn; },
    availability: (fn: typeof availability) => { availability = fn; },
  };
}

async function receive(request: BookingRequest, delivery = request.externalRequestId) {
  return store.enqueue({ ...request, deliveryId: delivery });
}

async function row(ref: string) {
  return database.one('select * from public.channel_reservation_requests where external_request_ref = $1', [ref]);
}

async function makeDue(...refs: string[]) {
  await database.one(`update public.channel_reservation_requests set next_attempt_at = now() - interval '1 second',
    eligible_at = case when eligible_at is not null then now() - interval '1 second' end
    where external_request_ref = any($1::text[])`, [refs]);
}

test('competing parent and child requests are ranked by net proceeds before a provider approval', async () => {
  const { property, space, listing } = await fixture();
  const { id: child } = await database.one("insert into public.spaces (property_id, parent_space_id, category, title) values ($1, $2, 'room', 'Room') returning id", [property, space]);
  const low = { ...await listing('airbnb'), externalRequestId: 'lower' };
  const high = { ...await listing('vrbo', child), externalRequestId: 'higher' };
  const mock = providers();
  mock.current.set('lower', pending(low, 20_000));
  mock.current.set('higher', pending(high, 25_000));
  await receive(low);
  await receive(high);
  await drainReservations(store, mock.adapters);
  assert.equal(mock.approved.length, 0);
  assert.equal((await row('lower')).reason, 'waiting_for_requests');
  await makeDue('lower');
  await drainReservations(store, mock.adapters, 1);
  assert.equal((await row('lower')).reason, 'competing_request_preferred');
  assert.equal((await row('lower')).decision.preferred_request_id, (await row('higher')).id);

  await makeDue('higher');
  mock.onApprove((request) => {
    mock.current.set('higher', { ...request, ...stay, state: 'confirmed', reservationRef: 'booked-higher' });
  });
  await drainReservations(store, mock.adapters);
  assert.deepEqual(mock.approved.map(({ request }) => request.externalRequestId), ['higher']);
  const winner = await row('higher');
  assert.equal(winner.status, 'confirmed');
  assert.equal(mock.approved[0].operationId, winner.id);
  assert.equal((await database.one('select source from public.reservations where id = $1', [winner.reservation_id])).source, 'api');
  await makeDue('lower');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('lower')).reason, 'dates_taken');
  assert.equal((await row('lower')).status, 'pending');
});

test('different payout currencies and an unobserved competing request both pause automatic approval', async () => {
  const { listing } = await fixture();
  const a = { ...await listing('airbnb'), externalRequestId: 'currency-a' };
  const b = { ...await listing('vrbo'), externalRequestId: 'currency-b' };
  const mock = providers();
  mock.current.set(a.externalRequestId, pending(a, 10_000, 'USD'));
  mock.current.set(b.externalRequestId, pending(b, 12_000, 'CAD'));
  await receive(a);
  await drainReservations(store, mock.adapters);
  await receive(b);
  await makeDue(a.externalRequestId);
  await drainReservations(store, mock.adapters, 1);
  assert.equal((await row(a.externalRequestId)).reason, 'competing_request_unverified');
  await drainReservations(store, mock.adapters);
  await makeDue(a.externalRequestId, b.externalRequestId);
  await drainReservations(store, mock.adapters);
  assert.equal((await row(a.externalRequestId)).reason, 'competing_quotes_unverified');
  assert.equal((await row(b.externalRequestId)).reason, 'competing_quotes_unverified');
  assert.equal(mock.approved.length, 0);
});

test('a timed-out approval stays held and is recovered by readback without resending the approval', async () => {
  const { space, listing } = await fixture();
  const request = { ...await listing('airbnb'), externalRequestId: 'timeout' };
  const mock = providers();
  mock.current.set('timeout', pending(request));
  mock.onApprove(() => {
    mock.current.delete('timeout');
    throw new DOMException('Connection timed out', 'TimeoutError');
  });
  await receive(request);
  await drainReservations(store, mock.adapters);
  await makeDue('timeout');
  await drainReservations(store, mock.adapters);
  const uncertain = await row('timeout');
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(uncertain.reservation_id, null);
  assert.ok(Date.parse(uncertain.next_attempt_at) > Date.now());
  await assert.rejects(database.one("select public.place_hold($1, 'direct', '2037-07-11T00:00Z', '2037-07-12T00:00Z')", [space]), /already taken/);
  await assert.rejects(database.one('update public.spaces set quantity = 2 where id = $1', [space]), /confirmation is unresolved/);

  // A provider may return a successful read with the wrong listing, or omit proof of a confirmed reservation.
  mock.current.set('timeout', { ...request, ...stay, state: 'confirmed', reservationRef: 'some-other-booking', listingRef: 'wrong' });
  await makeDue('timeout');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('timeout')).status, 'uncertain');
  mock.current.set('timeout', { ...request, ...stay, state: 'confirmed', reservationRef: '' });
  await makeDue('timeout');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('timeout')).reservation_id, null);

  mock.current.set('timeout', { ...request, ...stay, state: 'confirmed', reservationRef: 'timeout-booking' });
  assert.equal(await receive(request, 'new-confirmation-event'), 'queued');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('timeout')).status, 'confirmed');
  assert.equal(mock.approved.length, 1);
});

test('expired leases recover safely after a crash between marking approval and the provider call', async () => {
  const { listing } = await fixture();
  const request = { ...await listing('airbnb'), externalRequestId: 'crash' };
  const mock = providers();
  const snapshot = pending(request);
  mock.current.set('crash', snapshot);
  await receive(request);
  await drainReservations(store, mock.adapters);
  await makeDue('crash');
  const lease = (await store.claim())!;
  assert.equal(await store.record(lease, 'pending', snapshot), 'ready');
  assert.equal(await store.prepare(lease, [{
    listingId: lease.listingId, state: 'clear', bookingMode: 'request', observedAt: new Date().toISOString(),
  }]), 'approving');
  await database.one("update public.channel_reservation_requests set lease_until = now() - interval '1 second' where id = $1", [lease.id]);
  await drainReservations(store, mock.adapters);
  assert.equal((await row('crash')).status, 'uncertain');
  assert.equal(mock.approved.length, 0);

  mock.current.set('crash', { ...request, state: 'declined' });
  await receive(request, 'crash-decline-event');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('crash')).status, 'declined');
});

test('a stale iCal feed cannot stand in for direct availability, and stale direct proof also fails closed', async () => {
  const { space, listing } = await fixture();
  const request = { ...await listing('vrbo'), externalRequestId: 'stale' };
  const mock = providers();
  mock.current.set('stale', pending(request));
  await database.one("insert into public.channel_listings(space_id, channel, status) values ($1, 'airbnb', 'live')", [space]);
  await database.one(`insert into public.calendar_imports(space_id, channel, url, last_status, last_synced_at)
    values ($1, 'airbnb', 'https://example.test/calendar', 'ok', now() - interval '1 hour')`, [space]);
  await receive(request);
  await drainReservations(store, mock.adapters);
  await makeDue('stale');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('stale')).reason, 'availability_unverified');
  await database.one(`insert into public.channel_api_listings(space_id, channel, account_ref, listing_ref, authorized)
    values ($1, 'airbnb', 'other-account', 'airbnb-listing', true)`, [space]);
  mock.availability(() => ({ state: 'clear', bookingMode: 'request', observedAt: '2020-01-01T00:00:00Z' }));
  await makeDue('stale');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('stale')).reason, 'availability_unverified');
  mock.availability(() => ({ state: 'clear', bookingMode: 'instant', observedAt: new Date().toISOString() }));
  await database.one("update public.channel_listings set booking_mode = 'instant' where space_id = $1 and channel = 'airbnb'", [space]);
  await makeDue('stale');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('stale')).reason, 'independent_instant_booking');
  assert.equal(mock.approved.length, 0);
});

test('checkout boundaries are exclusive and existing confirmed bookings are preserved', async () => {
  const { space, listing } = await fixture();
  const request = { ...await listing('vrbo'), externalRequestId: 'adjacent' };
  const mock = providers();
  mock.current.set('adjacent', pending(request, 45_000));
  const { id: existing } = await database.one(`insert into public.reservations
    (space_id, channel, external_uid, source, starts_at, ends_at)
    values ($1, 'direct', 'previous', 'manual', '2037-07-09 07:00Z', '2037-07-10 07:00Z') returning id`, [space]);
  const confirmation: ProviderState = { ...request, ...stay, state: 'confirmed', reservationRef: 'confirmed-adjacent' };
  mock.onApprove(() => mock.current.set('adjacent', confirmation));
  await receive(request);
  await drainReservations(store, mock.adapters);
  await makeDue('adjacent');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('adjacent')).status, 'confirmed');
  assert.equal((await database.one('select status from public.reservations where id = $1', [existing])).status, 'confirmed');
  assert.equal((await database.one('select count(*)::int as count from public.conflicts where space_id = $1', [space])).count, 0);
});

test('independent bookings record conflicts and an authenticated cancellation resolves them', async () => {
  const { space, listing } = await fixture();
  const request = { ...await listing('vrbo'), externalRequestId: 'independent' };
  const mock = providers();
  await database.one(`insert into public.reservations
    (space_id, channel, external_uid, source, starts_at, ends_at)
    values ($1, 'direct', 'blocking', 'manual', '2037-07-10 07:00Z', '2037-07-13 07:00Z')`, [space]);
  // A provider-verified UID may promote an iCal row, while future iCal writes cannot overwrite it.
  const { id: original } = await database.one(`insert into public.reservations
    (space_id, channel, external_uid, source, starts_at, ends_at)
    values ($1, 'vrbo', 'verified-calendar-uid', 'ical', '2037-07-10 07:00Z', '2037-07-13 07:00Z') returning id`, [space]);
  mock.current.set('independent', {
    ...request, ...stay, state: 'confirmed', reservationRef: 'provider-booking', calendarUid: 'verified-calendar-uid',
  });
  await receive(request);
  await drainReservations(store, mock.adapters);
  const result = await row('independent');
  assert.equal(result.reason, 'provider_confirmed_independently');
  assert.equal(result.reservation_id, original);
  assert.equal((await database.one('select count(*)::int as count from public.conflicts where space_id = $1 and resolved_at is null', [space])).count, 1);
  await database.one("update public.reservations set source = 'ical', status = 'cancelled' where id = $1", [original]);
  assert.deepEqual(await database.one('select status, source from public.reservations where id = $1', [original]), { status: 'confirmed', source: 'api' });
  mock.current.set('independent', { ...request, state: 'cancelled', reservationRef: 'provider-booking' });
  await receive(request, 'independent-cancelled');
  await drainReservations(store, mock.adapters);
  assert.equal((await row('independent')).status, 'cancelled');
  assert.equal((await database.one('select count(*)::int as count from public.conflicts where space_id = $1 and resolved_at is null', [space])).count, 0);
  assert.equal(mock.approved.length, 0);
});

test('new deliveries invalidate stale leases and a delivery ID cannot be reused for a different request', async () => {
  const { listing } = await fixture();
  const request = { ...await listing('airbnb'), externalRequestId: 'versioned' };
  assert.equal(await receive(request, 'version-1'), 'queued');
  const lease = (await store.claim())!;
  assert.equal(await receive(request, 'version-1'), 'duplicate');
  assert.equal(await receive({ ...request, externalRequestId: 'different' }, 'version-1'), 'mismatch');
  assert.equal(await receive({ ...request, accountRef: 'wrong' }, 'version-2'), 'unknown_listing');
  assert.equal(await receive(request, 'version-2'), 'queued');
  assert.equal(await store.record(lease, 'pending', pending(request)), 'lease_lost');
  assert.notEqual((await store.claim())?.token, lease.token);
});

test('host RLS and grants prevent cross-host reads, event writes, and fabricated confirmations', async () => {
  const { host, space, listing } = await fixture();
  const other = await fixture();
  await receive({ ...await listing('airbnb'), externalRequestId: 'private-request' });
  const { db, one } = database;
  try {
    await db.exec("set role anon");
    await assert.rejects(one('select id from public.channel_reservation_requests'), /permission denied/);
    await assert.rejects(one('select public.claim_channel_reservation_work()'), /permission denied/);
    await db.exec('reset role; set role authenticated');
    await one("select set_config('request.jwt.claim.sub', $1, false)", [other.host]);
    assert.equal(await one('select id from public.channel_api_listings'), undefined);
    assert.equal(await one('select id from public.channel_reservation_requests'), undefined);
    assert.equal(await one('select id from public.channel_reservation_audit'), undefined);
    await one("select set_config('request.jwt.claim.sub', $1, false)", [host]);
    assert.ok((await one('select id from public.channel_reservation_requests')).id);
    assert.ok((await one('select id from public.channel_reservation_audit')).id);
    await assert.rejects(one('select external_request_ref from public.channel_reservation_requests'), /permission denied/);
    await assert.rejects(one("update public.channel_api_listings set auto_approve = true"), /permission denied/);
    await assert.rejects(one("select public.enqueue_channel_reservation_event('airbnb', $1, $2, 'forged', 'forged')", [host, space]), /permission denied/);
    await assert.rejects(one(`insert into public.reservations(space_id, channel, external_uid, source, starts_at, ends_at)
      values ($1, 'airbnb', 'fabricated', 'api', '2037-07-10T00:00Z', '2037-07-11T00:00Z')`, [space]), /row-level security/);
  } finally {
    await db.exec('reset role; reset request.jwt.claim.sub');
  }
});

const encoder = new TextEncoder();
async function sign(timestamp: string, body: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', encoder.encode('synthetic-webhook-fixture-key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prefix = encoder.encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, message)).toString('hex');
}

test('webhooks verify raw bytes and replay windows, and workers require their own secret', async () => {
  const { listing } = await fixture();
  const delivery: ProviderDelivery = { ...await listing('airbnb'), externalRequestId: 'webhook', deliveryId: 'signed' };
  const airbnb: ChannelAdapter = {
    ...airbnbAdapter,
    supportsWebhooks: true,
    async verifyWebhook(headers, body) {
      const timestamp = headers.get('x-test-timestamp') ?? '';
      if (!timestamp || Math.abs(Date.now() - Number(timestamp)) > 60_000) return null;
      if (headers.get('x-test-signature') !== await sign(timestamp, body)) return null;
      return JSON.parse(new TextDecoder().decode(body));
    },
  };
  let wakes = 0;
  let processes = 0;
  const workerSecret = 'test-worker-fixture-with-more-than-32-characters';
  const handler = reservationHandler({
    adapters: { airbnb, vrbo: vrboAdapter }, store, workerSecret,
    process: async () => ++processes, wake: () => { wakes++; },
  });
  const url = 'https://example.test/functions/v1/channel-reservations';
  const body = JSON.stringify(delivery);
  const send = (path: string, body: string, headers: Record<string, string> = {}) =>
    handler(new Request(`${url}${path}`, { method: 'POST', body, headers }));
  assert.equal((await send('/webhook/airbnb', body)).status, 401);
  assert.equal((await send('/webhook/vrbo', body)).status, 503);
  const timestamp = String(Date.now());
  const headers = { 'x-test-timestamp': timestamp, 'x-test-signature': await sign(timestamp, encoder.encode(body)) };
  assert.equal((await send('/webhook/airbnb', body + ' ', headers)).status, 401);
  assert.equal((await send('/webhook/airbnb', 'a'.repeat(70_000), headers)).status, 413);
  const expired = String(Date.now() - 120_000);
  assert.equal((await send('/webhook/airbnb', body, { 'x-test-timestamp': expired, 'x-test-signature': await sign(expired, encoder.encode(body)) })).status, 401);
  assert.equal((await send('/webhook/airbnb', body, headers)).status, 202);
  assert.equal((await send('/webhook/airbnb', body, headers)).status, 202);
  assert.equal((await row('webhook')).event_version, 1);
  assert.equal(wakes, 1);
  assert.equal((await send('/process', '{}', { authorization: 'Bearer another-application-token' })).status, 401);
  assert.equal((await send('/process', '{}', { authorization: `Bearer ${workerSecret}` })).status, 200);
  assert.equal(processes, 1);
});

test('provider operations have a deadline even if the transport ignores cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  const work = withProviderDeadline((signal) => new Promise(() => {
    signal.addEventListener('abort', () => { aborted = true; });
  }));
  t.mock.timers.tick(5_000);
  await assert.rejects(work, /timed out/);
  assert.equal(aborted, true);
});

test('equal expected payouts favor the earlier request even when the later worker checks first', async () => {
  const { listing } = await fixture();
  const early = { ...await listing('airbnb'), externalRequestId: 'earlier-tie' };
  const late = { ...await listing('vrbo'), externalRequestId: 'later-tie' };
  const mock = providers();
  mock.current.set(early.externalRequestId, pending(early));
  mock.current.set(late.externalRequestId, pending(late));
  await receive(early);
  await receive(late);
  await drainReservations(store, mock.adapters);
  await makeDue(late.externalRequestId);
  await drainReservations(store, mock.adapters, 1);
  const deferred = await row(late.externalRequestId);
  assert.equal(deferred.decision.preferred_request_id, (await row(early.externalRequestId)).id);
  assert.equal(mock.approved.length, 0);
});

test('a successful approval response alone leaves the dates held until provider readback confirms', async () => {
  const { space, listing } = await fixture();
  const request = { ...await listing('airbnb'), externalRequestId: 'ack-only' };
  const mock = providers();
  mock.current.set(request.externalRequestId, pending(request));
  await receive(request);
  await drainReservations(store, mock.adapters);
  await makeDue(request.externalRequestId);
  await drainReservations(store, mock.adapters);
  assert.equal(mock.approved.length, 1);
  assert.equal((await row(request.externalRequestId)).status, 'uncertain');
  assert.equal((await database.one('select count(*)::int as count from public.reservations where space_id = $1', [space])).count, 0);

  mock.current.set(request.externalRequestId, { ...request, ...stay, state: 'confirmed', reservationRef: 'ack-only-booking' });
  await makeDue(request.externalRequestId);
  await drainReservations(store, mock.adapters);
  assert.equal((await row(request.externalRequestId)).status, 'confirmed');
  assert.equal(mock.approved.length, 1);
  assert.equal((await database.one('select public.settle_holds($1) as added', [space])).added, 0);
});

test('a formerly safe manual hold fails a recheck after a calendar booking or expiration', async () => {
  const { space } = await fixture();
  const holdSql = "select public.place_hold($1, 'direct', $2::timestamptz, $3::timestamptz) as id";
  const { one } = database;
  const { id: booked } = await one(holdSql, [space, '2037-07-10T07:00Z', '2037-07-13T07:00Z']);
  const { id: expired } = await one(holdSql, [space, '2037-07-13T07:00Z', '2037-07-14T07:00Z']);
  for (const id of [booked, expired]) {
    assert.equal((await one('select public.mark_hold_safe($1) as safe', [id])).safe, true);
  }
  await one(`insert into public.reservations(space_id, channel, external_uid, source, starts_at, ends_at)
    values ($1, 'airbnb', 'external-guest', 'ical', '2037-07-10T07:00Z', '2037-07-13T07:00Z')`, [space]);
  await one("update public.booking_holds set expires_at = now() - interval '1 second' where id = $1", [expired]);
  for (const id of [booked, expired]) {
    assert.equal((await one('select public.mark_hold_safe($1) as safe', [id])).safe, false);
  }
});

test('revoking API access stops new provider work for the listing', async () => {
  const { space, listing } = await fixture();
  const request = { ...await listing('airbnb'), externalRequestId: 'revoked' };
  assert.equal(await receive(request), 'queued');
  await database.one('update public.channel_api_listings set authorized = false, auto_approve = false where space_id = $1', [space]);
  assert.equal(await receive(request, 'post-revocation-event'), 'unknown_listing');
  assert.equal(await store.claim(), null);
});

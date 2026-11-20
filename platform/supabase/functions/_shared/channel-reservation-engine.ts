import {
  isProviderReference,
  type Availability, type BookingRequest, type Channel, type ChannelAdapter,
  type ProviderDelivery, type ProviderListing, type ProviderState,
} from './channel-adapters.ts';

export const COMPETITION_WINDOW_MS = 3_000;
const PROVIDER_TIMEOUT_MS = 5_000;

export type Work = {
  id: string;
  token: string;
  request: BookingRequest;
  listingId: string;
};
export type ScopeListing = { channel: string; listing: ProviderListing | null };
export type Proof = Availability & { listingId: string };

export interface ReservationStore {
  enqueue(event: ProviderDelivery): Promise<'queued' | 'duplicate' | 'unknown_listing' | 'mismatch'>;
  claim(): Promise<Work | null>;
  record(work: Work, state: ProviderState['state'] | 'retry', details: object): Promise<string>;
  scope(work: Work): Promise<ScopeListing[]>;
  prepare(work: Work, proof: Proof[]): Promise<string>;
}

export type Adapters = Record<Channel, ChannelAdapter>;

export async function withProviderDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Provider operation timed out'));
        }, PROVIDER_TIMEOUT_MS);
      }),
      operation(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sameRequest(expected: BookingRequest, actual: BookingRequest): boolean {
  return expected.channel === actual.channel && expected.accountRef === actual.accountRef
    && expected.listingRef === actual.listingRef && expected.externalRequestId === actual.externalRequestId;
}

const validTimestamp = (value: string) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString().slice(0, 10) === value;
}

function validSnapshot(snapshot: ProviderState): boolean {
  switch (snapshot.state) {
    case 'pending':
    case 'confirmed': {
      if (!validDate(snapshot.checkIn) || !validDate(snapshot.checkOut) || snapshot.checkIn >= snapshot.checkOut) return false;
      if (snapshot.state === 'confirmed') {
        return isProviderReference(snapshot.reservationRef) && (snapshot.calendarUid === undefined || isProviderReference(snapshot.calendarUid, 512));
      }
      const quote = snapshot.quote;
      return (snapshot.expiresAt === null || validTimestamp(snapshot.expiresAt))
        && (quote === null || (Number.isSafeInteger(quote.netMinor) && quote.netMinor >= 0 && /^[A-Z]{3}$/.test(quote.currency)));
    }
    case 'cancelled':
      return isProviderReference(snapshot.reservationRef);
    case 'declined':
    case 'expired':
      return true;
    default:
      return false;
  }
}

async function read(adapter: ChannelAdapter, work: Work): Promise<ProviderState | null> {
  try {
    const current = await withProviderDeadline((signal) => adapter.getReservation(work.request, signal));
    return current && sameRequest(work.request, current) && validSnapshot(current) ? current : null;
  } catch {
    return null;
  }
}

async function process(work: Work, store: ReservationStore, adapters: Adapters): Promise<void> {
  const adapter = adapters[work.request.channel];
  const snapshot = await read(adapter, work);
  if (!snapshot) {
    await store.record(work, 'retry', { reason: 'provider_read_failed' });
    return;
  }
  const result = await store.record(work, snapshot.state, snapshot);
  if (snapshot.state !== 'pending' || result !== 'ready') return;
  if (!adapter.supportsProgrammaticApproval) {
    await store.record(work, 'retry', { reason: 'approval_unavailable' });
    return;
  }

  const scope = await store.scope(work);
  if (!scope.some(({ listing }) => listing?.id === work.listingId)
      || scope.some(({ listing }) => !listing || !adapters[listing.channel].supportsAvailability)) {
    await store.record(work, 'retry', { reason: 'availability_unverified' });
    return;
  }
  let proof: Proof[];
  try {
    proof = await Promise.all(scope.map(async ({ listing }) => {
      const target = listing!;
      const ref = target.id === work.listingId ? work.request.externalRequestId : null;
      const availability = await withProviderDeadline((signal) =>
        adapters[target.channel].getAvailability(target, snapshot, ref, signal));
      if (!validTimestamp(availability.observedAt)) throw new Error('Invalid availability timestamp');
      return { ...availability, listingId: target.id };
    }));
  } catch {
    await store.record(work, 'retry', { reason: 'availability_unverified' });
    return;
  }
  if (await store.prepare(work, proof) !== 'approving') return;

  // The database has committed a durable hold. If the process dies here, the next worker only reads.
  try {
    await withProviderDeadline((signal) => adapter.approve(work.request, work.id, signal));
  } catch {
    // The provider may have applied the operation before the response failed.
  }
  const verified = await read(adapter, work);
  if (verified) {
    await store.record(work, verified.state, verified);
  } else {
    await store.record(work, 'retry', { reason: 'confirmation_unverified' });
  }
}

export async function drainReservations(store: ReservationStore, adapters: Adapters, limit = 6): Promise<number> {
  const stopAt = Date.now() + 30_000;
  let processed = 0;
  for (; processed < limit && Date.now() < stopAt; processed++) {
    const work = await store.claim();
    if (!work) break;
    await process(work, store, adapters);
  }
  return processed;
}

type Rpc = (name: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export function reservationStore(rpc: Rpc): ReservationStore {
  async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await rpc(name, args);
    if (error) throw new Error(`Reservation database operation failed (${name})`, { cause: error });
    return data as T;
  }
  const lease = (work: Work) => ({ p_request: work.id, p_token: work.token });
  return {
    enqueue: (event) => call('enqueue_channel_reservation_event', {
      p_channel: event.channel, p_account: event.accountRef, p_listing: event.listingRef,
      p_delivery: event.deliveryId, p_ref: event.externalRequestId,
    }),
    claim: () => call('claim_channel_reservation_work'),
    record: (work, state, details) => call('record_channel_reservation_result', {
      ...lease(work), p_state: state, p_details: details,
    }),
    scope: (work) => call('channel_approval_scope', lease(work)),
    prepare: (work, proof) => call('prepare_channel_reservation_approval', { ...lease(work), p_proof: proof }),
  };
}

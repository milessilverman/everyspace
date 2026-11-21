import { CHANNELS, enabledOperation, isProviderReference, type Channel, type ProviderDelivery } from './channel-adapters.ts';
import { type Adapters, type ReservationStore, withProviderDeadline } from './channel-reservation-engine.ts';
import { readBoundedBody, BodyLimitError } from './request-body.ts';

const MAX_WEBHOOK_BYTES = 64 * 1024;
const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

function validDelivery(value: ProviderDelivery | null, channel: Channel): value is ProviderDelivery {
  return value?.channel === channel && [value.deliveryId, value.accountRef, value.listingRef, value.externalRequestId]
    .every((ref) => isProviderReference(ref));
}

async function validWorker(request: Request, secret: string | undefined): Promise<boolean> {
  const supplied = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if (!secret || secret.length < 32 || !supplied || supplied.length > 1024) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(secret));
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(supplied));
}

type Options = {
  adapters: Adapters;
  store: ReservationStore;
  workerSecret?: string;
  process: () => Promise<number>;
  wake: () => void;
};

export function reservationHandler({ adapters, store, workerSecret, process, wake }: Options) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname.replace(/^\/(?:functions\/v1\/)?channel-reservations(?=\/|$)/, '');
    if (request.method !== 'POST') return json(405, { error: 'Use POST' });
    if (path === '/process') {
      if (!await validWorker(request, workerSecret)) return json(401, { error: 'Unauthorized' });
      try {
        return json(200, { processed: await process() });
      } catch {
        return json(503, { error: 'Reservation processing unavailable' });
      }
    }
    const channel = path.match(/^\/webhook\/(airbnb|vrbo)$/)?.[1] as Channel | undefined;
    if (!channel || !CHANNELS.includes(channel)) return json(404, { error: 'Unknown route' });
    const verifyWebhook = enabledOperation(adapters[channel], 'verifyWebhook');
    if (!verifyWebhook) return json(503, { error: 'Provider webhooks unavailable' });

    let delivery: ProviderDelivery | null;
    try {
      const body = await readBoundedBody(request, MAX_WEBHOOK_BYTES);
      delivery = await withProviderDeadline((signal) => verifyWebhook(request.headers, body, signal));
    } catch (error) {
      if (error instanceof BodyLimitError) return json(413, { error: 'Webhook too large' });
      return json(503, { error: 'Webhook verification unavailable' });
    }
    if (!validDelivery(delivery, channel)) return json(401, { error: 'Invalid webhook' });
    try {
      const result = await store.enqueue(delivery);
      if (result === 'unknown_listing' || result === 'mismatch') return json(403, { error: 'Unrecognized delivery' });
      if (result === 'queued') wake();
      return json(202, { accepted: true });
    } catch {
      return json(503, { error: 'Webhook could not be queued' });
    }
  };
}

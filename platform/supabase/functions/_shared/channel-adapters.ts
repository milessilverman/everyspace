export const CHANNELS = ['airbnb', 'vrbo'] as const;
export type Channel = typeof CHANNELS[number];

export type ProviderListing<C extends string = Channel> = {
  id: string;
  channel: C;
  accountRef: string;
  listingRef: string;
};

export type BookingRequest<C extends string = Channel> = Omit<ProviderListing<C>, 'id'> & { externalRequestId: string };
export type Stay = { checkIn: string; checkOut: string }; // Local dates, checkout exclusive.
export type ReservationWindow = Stay | { startsAt: string; endsAt: string; units: number };
export type Quote = { netMinor: number; currency: string };

export type ProviderState<C extends string = Channel> = BookingRequest<C> & (
  | ({ state: 'pending'; expiresAt: string | null; quote: Quote | null } & Stay)
  | ({ state: 'confirmed'; reservationRef: string; calendarUid?: string } & Stay)
  | { state: 'declined' | 'expired' }
  | { state: 'cancelled'; reservationRef: string }
);

export type Availability = {
  state: 'clear' | 'occupied' | 'unknown';
  bookingMode: 'request' | 'closed' | 'instant' | 'unknown';
  observedAt: string;
};

export type ProviderDelivery<C extends string = Channel> = BookingRequest<C> & { deliveryId: string };

export function isProviderReference(value: unknown, maxLength = 240): value is string {
  // deno-lint-ignore no-control-regex
  const controlCharacter = /[\x00-\x1f\x7f]/;
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && value.length <= maxLength && !controlCharacter.test(value);
}

/**
 * Every transport normalizes provider events and applies the provider's documented limitations here.
 * Provider writes need a stable operation ID and an independent read before reporting confirmation.
 * A documented vendor product never supplies an implementation or a release by itself.
 */
interface Operations<C extends string> {
  verifyWebhook(headers: Headers, body: Uint8Array, signal: AbortSignal): Promise<ProviderDelivery<C> | null>;
  getReservation(request: BookingRequest<C>, signal: AbortSignal): Promise<ProviderState<C> | null>;
  getAvailability(listing: ProviderListing<C>, stay: Stay, externalRequestId: string | null, signal: AbortSignal): Promise<Availability>;
  approve(request: BookingRequest<C>, operationId: string, signal: AbortSignal): Promise<void>;
  decline(request: BookingRequest<C>, operationId: string, signal: AbortSignal): Promise<void>;
  cancel(request: BookingRequest<C>, operationId: string, signal: AbortSignal): Promise<void>;
  modify(request: BookingRequest<C>, window: ReservationWindow, operationId: string, signal: AbortSignal): Promise<void>;
  readCalendar(listing: ProviderListing<C>, signal: AbortSignal): Promise<ReservationWindow[]>;
  publishAvailability(listing: ProviderListing<C>, windows: ReservationWindow[], operationId: string, signal: AbortSignal): Promise<void>;
  readListing(listing: ProviderListing<C>, signal: AbortSignal): Promise<{ title: string; active: boolean } | null>;
  updateListing(listing: ProviderListing<C>, changes: { title?: string; active?: boolean }, operationId: string, signal: AbortSignal): Promise<void>;
  readHealth(listing: ProviderListing<C>, signal: AbortSignal): Promise<{ state: 'healthy' | 'degraded' | 'unknown'; observedAt: string }>;
}

type Gate = { authorized: boolean; tested: boolean; enabled: boolean };
export type ChannelAdapter<C extends string = Channel> = {
  readonly channel: C;
  readonly operations: Readonly<Partial<{ [K in keyof Operations<C>]: Gate & { run: Operations<C>[K] } }>>;
};

export function enabledOperation<C extends string, K extends keyof Operations<C>>(
  adapter: ChannelAdapter<C>, capability: K,
): Operations<C>[K] | undefined {
  const entry = adapter.operations[capability];
  return entry?.authorized && entry.tested && entry.enabled ? entry.run : undefined;
}

export function unavailableAdapter<C extends string>(channel: C): ChannelAdapter<C> {
  return Object.freeze({ channel, operations: Object.freeze({}) });
}

// Provider contracts are normalized inside each approved adapter. No calendar feed implements this interface.
export const CHANNELS = ['airbnb', 'vrbo'] as const;
export type Channel = typeof CHANNELS[number];

export type ProviderListing = {
  id: string;
  channel: Channel;
  accountRef: string;
  listingRef: string;
};

export type BookingRequest = Omit<ProviderListing, 'id'> & { externalRequestId: string };
export type Stay = { checkIn: string; checkOut: string }; // Local dates, checkout exclusive.
export type Quote = { netMinor: number; currency: string }; // Expected host proceeds after provider fees.

export type ProviderState = BookingRequest & (
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

export type ProviderDelivery = BookingRequest & { deliveryId: string };

export interface ChannelAdapter {
  readonly channel: Channel;
  readonly supportsWebhooks: boolean;
  readonly supportsAvailability: boolean;
  readonly supportsProgrammaticApproval: boolean;
  readonly supportsProgrammaticDecline: boolean;
  // Verify provider-specific authentication and replay requirements against the original bytes.
  // Normalize a stable listing-scoped delivery ID and the account, listing and request it applies to.
  verifyWebhook(headers: Headers, body: Uint8Array, signal: AbortSignal): Promise<ProviderDelivery | null>;
  // A missing or inconclusive read is null. Terminal states must be authoritative for this exact request.
  getReservation(request: BookingRequest, signal: AbortSignal): Promise<ProviderState | null>;
  // Read real inventory for the specified dates. 'clear' rules out conflicting bookings. Only the
  // target's own pending request may be ignored when evaluating inventory for that listing.
  getAvailability(listing: ProviderListing, stay: Stay, externalRequestId: string | null, signal: AbortSignal): Promise<Availability>;
  // Send the stable operation ID when the approved provider contract supports idempotency.
  // A successful HTTP response still requires a separate authoritative read.
  approve(request: BookingRequest, operationId: string, signal: AbortSignal): Promise<void>;
  decline(request: BookingRequest, operationId: string, signal: AbortSignal): Promise<void>;
}

export function unavailableAdapter(channel: Channel): ChannelAdapter {
  const unavailable = () => Promise.reject(new Error('Provider API access unavailable'));
  return Object.freeze({
    channel,
    supportsWebhooks: false,
    supportsAvailability: false,
    supportsProgrammaticApproval: false,
    supportsProgrammaticDecline: false,
    verifyWebhook: unavailable,
    getReservation: unavailable,
    getAvailability: unavailable,
    approve: unavailable,
    decline: unavailable,
  });
}

// The contract every provider adapter implements. A provider is a way of exchanging availability or bookings with
// one site (or with a file the host uploads). Core sync code only talks to this interface through the registry, so
// providers can be added, replaced or removed without touching it.
//
// Honesty rules:
//   - `capabilities` says what the adapter really does, using the levels in docs/integrations.md "Capability levels"
//     (L0 manual, L1 iCal availability, L2 file/email import, L3 partner API, L4 direct booking).
//   - An operation the adapter cannot do is ABSENT (undefined), never a stub that pretends to succeed. Callers
//     feature-detect: `adapterFor(channel, 'verifyClosed')` returns undefined when nobody can do it.
//   - `limits` are plain-language caveats shown to hosts.
import type { CalendarEvent } from '../ical.ts';
import type { BusyRow } from '../sync.ts';
import type { DoorCheck } from '../door.ts';
import type { FetchOptions } from '../fetch.ts';

export type Level = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export const LEVELS: readonly Level[] = ['L0', 'L1', 'L2', 'L3', 'L4'];
export const levelRank = (l: Level): number => LEVELS.indexOf(l);

export type Capabilities = { calendar: Level; booking: Level; listing: Level; pricing: Level; messaging: Level };
export const CAPABILITY_KEYS = ['calendar', 'booking', 'listing', 'pricing', 'messaging'] as const;
export type CapabilityKey = typeof CAPABILITY_KEYS[number];

/** The shape `import_reservations(p_rows)` expects (one element per reservation). */
export type NormalizedReservation = {
  external_uid: string;
  starts_at: string; // ISO timestamp (UTC)
  ends_at: string; // exclusive
  kind?: 'booking' | 'block';
  status?: 'confirmed' | 'cancelled';
  all_day?: boolean;
  guest_count?: number;
  payout_cents?: number;
};

export const PROVIDER_ERROR_CODES = ['fetch_failed', 'timeout', 'too_large', 'blocked_url', 'parse_error', 'empty_feed', 'unsupported'] as const;
export type ProviderErrorCode = typeof PROVIDER_ERROR_CODES[number];

/** A failure with a short machine code (safe to store) and a message for the host (never contains a URL). */
export class ProviderError extends Error {
  code: ProviderErrorCode;
  /** Optional per-item detail, e.g. "Row 7: end is before start". */
  details: string[];
  constructor(code: ProviderErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.details = details;
  }
}

export type ImportContext = { url: string; timeZone: string; now?: string; io?: FetchOptions };
export type ExportContext = { rows: BusyRow[]; forChannel: string; spaceId?: string; timeZone: string; name: string; now?: string };
export type BookingFile = { name?: string; text: string };
export type ParseContext = { timeZone?: string };
export type VerifyContext = { url: string; hold: { starts_at: string; ends_at: string }; timeZone: string; io?: FetchOptions };

export type MethodName = 'importAvailability' | 'exportAvailability' | 'parseBookingFile' | 'verifyClosed';

export interface ProviderAdapter {
  /** Channel key ('airbnb'), '*' for the generic calendar-link adapter, or 'manual' for file import. */
  key: string;
  label: string;
  capabilities: Capabilities;
  /** Plain-language caveats shown to hosts. */
  limits: string[];
  /** Read the site's availability (events as they stand now). Throws ProviderError. */
  importAvailability?(ctx: ImportContext): Promise<{ events: CalendarEvent[] }>;
  /** Build what to publish to the site: everything busy elsewhere. */
  exportAvailability?(ctx: ExportContext): { body: string; contentType: string };
  /** Turn an uploaded file into reservations. Throws ProviderError('parse_error') listing row-numbered problems. */
  parseBookingFile?(file: BookingFile, ctx: ParseContext): { rows: NormalizedReservation[] };
  /** Prove (by reading the site live) that a stretch of time is closed there. Only for sites that can tell bookings from blocks. */
  verifyClosed?(ctx: VerifyContext): Promise<DoorCheck>;
}

export const NO_CAPABILITIES: Capabilities = { calendar: 'L0', booking: 'L0', listing: 'L0', pricing: 'L0', messaging: 'L0' };

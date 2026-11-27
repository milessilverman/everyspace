// Pure helpers for the property-profile function: input validation, address key, CORS, retention, redaction.
// Erasable TypeScript only (no enums, no parameter properties) so Node can run it directly in tests.

export const MAX_BODY_BYTES = 4096;
export const DEFAULT_ORIGIN = 'https://milessilverman.github.io';
/** Retention for a provider that states no limit (retentionDays null/undefined). */
export const UNLIMITED_RETENTION_DAYS = 90;
/** A profile no provider contributed to is kept only briefly, so a later run with keys enabled is not shadowed. */
export const EMPTY_PROFILE_RETENTION_DAYS = 1;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export type Query = { address: string; lat?: number; lng?: number; placeId?: string };
export type Parsed = { ok: true; query: Query } | { ok: false; message: string };

const KNOWN = new Set(['address', 'lat', 'lng', 'place_id']);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Fixed messages only: nothing from the request is ever echoed back. */
export function validateBody(body: unknown): Parsed {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, message: 'Send a JSON object.' };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!KNOWN.has(k)) return { ok: false, message: 'Unknown field in the request.' };
  const a = b.address;
  if (typeof a !== 'string') return { ok: false, message: 'address is required (text).' };
  if (CONTROL.test(a)) return { ok: false, message: 'address contains characters that are not allowed.' };
  if (a.length > 200 || a.trim().length < 5) return { ok: false, message: 'address must be 5 to 200 characters.' };
  const q: Query = { address: a.trim() };
  const hasLat = b.lat !== undefined && b.lat !== null; const hasLng = b.lng !== undefined && b.lng !== null;
  if (hasLat || hasLng) {
    if (!hasLat || !hasLng) return { ok: false, message: 'lat and lng must be sent together.' };
    if (!isNum(b.lat) || b.lat < -90 || b.lat > 90) return { ok: false, message: 'lat must be a number from -90 to 90.' };
    if (!isNum(b.lng) || b.lng < -180 || b.lng > 180) return { ok: false, message: 'lng must be a number from -180 to 180.' };
    q.lat = b.lat; q.lng = b.lng;
  }
  if (b.place_id !== undefined && b.place_id !== null) {
    if (typeof b.place_id !== 'string' || b.place_id.length < 1 || b.place_id.length > 300 || CONTROL.test(b.place_id)) {
      return { ok: false, message: 'place_id must be text up to 300 characters.' };
    }
    q.placeId = b.place_id;
  }
  return { ok: true, query: q };
}

/** Cache key: lower-cased, NFKC, no periods, single spaces, tidy commas. */
export function addressKey(address: string): string {
  return address.normalize('NFKC').toLowerCase().replace(/\./g, '').replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
}

export function allowedOrigins(raw: string | undefined): string[] {
  const list = (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
  return list.length ? list : [DEFAULT_ORIGIN];
}

/** CORS headers for an allowed origin; never a wildcard. Always varies on Origin. */
export function corsFor(origin: string | null, allowed: string[]): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'authorization, x-client-info, apikey, content-type';
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}

/** A positive whole number from an env string, else 0 (meaning "not set"). */
export function positiveInt(raw: string | undefined): number {
  if (typeof raw !== 'string' || !/^\s*[0-9]{1,9}\s*$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

type ProviderRow = { id?: unknown; status?: unknown; retentionDays?: unknown };
/** Days to keep: the smallest retentionDays among providers actually used; no stated limit counts as 90. Zero or less = do not store. */
export function retentionDays(providers: unknown): number {
  const used = (Array.isArray(providers) ? providers : []).filter((p): p is ProviderRow => !!p && typeof p === 'object' && (p as ProviderRow).status === 'used');
  if (!used.length) return EMPTY_PROFILE_RETENTION_DAYS;
  return Math.min(...used.map((p) => (typeof p.retentionDays === 'number' && Number.isFinite(p.retentionDays) ? p.retentionDays : UNLIMITED_RETENTION_DAYS)));
}

/** Remove secret values and URL query strings from anything about to leave the function (text form). */
export function scrub(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const form of new Set([s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1)])) out = out.split(form).join('[redacted]');
  }
  return out.replace(/(https?:\/\/[^\s"'\\?#]+)\?[^\s"'\\]*/g, '$1');
}

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const numIn = (v: unknown, lo: number, hi: number): number | null => (isNum(v) && v >= lo && v <= hi ? v : null);

/** Columns for store_property_profile, coerced so a stray value in the profile can never break a table check. */
export function storeArgs(key: string, query: Query, profile: Record<string, unknown>, providers: unknown[], modelVersion: string, expiresAt: string) {
  const fips = typeof profile.county_fips === 'string' && /^[0-9]{5}$/.test(profile.county_fips) ? profile.county_fips : null;
  return {
    p_address_key: key.slice(0, 400),
    p_place_id: str(profile.place_id, 300) ?? query.placeId ?? null,
    p_apn: str(profile.apn, 100),
    p_county_fips: fips,
    p_address: str(profile.address, 400) ?? query.address,
    p_lat: numIn(profile.lat, -90, 90) ?? query.lat ?? null,
    p_lng: numIn(profile.lng, -180, 180) ?? query.lng ?? null,
    p_profile: profile,
    p_providers: providers,
    p_model_version: modelVersion,
    p_expires_at: expiresAt,
  };
}

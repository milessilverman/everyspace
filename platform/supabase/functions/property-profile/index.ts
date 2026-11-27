// Public estimator endpoint: address in -> property profile out, with provider API keys kept on the server.
//
// POST /functions/v1/property-profile    JSON { address, lat?, lng?, place_id? }
// Answers { cached, expires_at, profile } or { error, code }.
//
// Order of work: CORS allow-list -> input limits -> cache lookup -> (miss) decide which paid providers may run (key present AND a
// positive daily cap AND budget left) -> build the profile -> store it with an expiry -> answer.
// verify_jwt is OFF (config.toml): this function enforces the CORS allow-list, input limits and provider budgets itself.
// The service role is used ONLY for three RPCs: get_cached_property_profile, store_property_profile, reserve_provider_call.
//
// Secrets (set per project, never in a file): RENTCAST_API_KEY, GOOGLE_SOLAR_API_KEY, RENTCAST_DAILY_CAP, GOOGLE_SOLAR_DAILY_CAP,
// ALLOWED_ORIGINS (comma-separated; default https://milessilverman.github.io and https://www.milessilverman.com). Supabase provides SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY to functions.
//
// Known limits: no per-visitor rate limit (only the global daily caps protect paid providers); a reserved budget unit is spent
// even if the builder then does not call that provider; non-browser callers send no Origin header and are not blocked by CORS.
import { MAX_BODY_BYTES, addressKey, allowedOrigins, corsFor, positiveInt, retentionDays, scrub, storeArgs, validateBody } from './logic.ts';
import type { Query } from './logic.ts';

export const MODEL_VERSION = 'property-profile-v1';

export type Keys = { rentcast?: string; googleSolar?: string };
export type Profile = Record<string, unknown> & { providers?: unknown[] };
export type CachedRow = { profile: Profile; providers?: unknown[]; expires_at?: string } | null;

export type Deps = {
  /** core/property-profile.js buildPropertyProfile, with registry and splitYard already bound. */
  buildProfile(query: Query, ctx: { fetch: typeof fetch; now: string; keys: Keys }): Promise<Profile>;
  db: {
    getCached(addressKey: string, placeId: string | null): Promise<CachedRow>;
    reserve(provider: string, dailyCap: number): Promise<boolean>;
    store(args: ReturnType<typeof storeArgs>): Promise<unknown>;
  };
  now(): Date;
  env(name: string): string | undefined;
  fetch: typeof fetch;
  /** Codes only. Defaults to console.error. */
  log?(entry: { fn: string; code: string }): void;
};

// The paid providers: which env names switch them on, and the id the profile uses for them.
const PAID = [
  { id: 'rentcast', key: 'rentcast', keyEnv: 'RENTCAST_API_KEY', capEnv: 'RENTCAST_DAILY_CAP' },
  { id: 'google-solar', key: 'googleSolar', keyEnv: 'GOOGLE_SOLAR_API_KEY', capEnv: 'GOOGLE_SOLAR_DAILY_CAP' },
] as const;

type Skip = { id: string; status: 'skipped'; reason: string };

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const log = deps.log ?? ((e) => console.error(JSON.stringify(e)));
  const code = (c: string) => log({ fn: 'property-profile', code: c });
  const origin = req.headers.get('origin');
  const allowed = allowedOrigins(deps.env('ALLOWED_ORIGINS'));
  const cors = corsFor(origin, allowed);
  const secrets = PAID.map((p) => deps.env(p.keyEnv));
  const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(scrub(JSON.stringify(body), secrets), { status, headers: { ...cors, ...extra, 'content-type': 'application/json', 'Cache-Control': 'no-store' } });
  const fail = (status: number, message: string, c: string) => { code(c); return reply({ error: message, code: c }, status); };

  // A browser that names an origin we do not list gets nothing, including for preflight.
  if (origin && !allowed.includes(origin)) return fail(403, 'This site is not allowed to use this service.', 'origin_not_allowed');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Cache-Control': 'no-store' } });
  if (req.method !== 'POST') return fail(405, 'Use POST.', 'method_not_allowed');

  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'The request is too large.', 'body_too_large');
  let text: string;
  try { text = await req.text(); } catch { return fail(400, 'The request could not be read.', 'bad_body'); }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return fail(413, 'The request is too large.', 'body_too_large');
  let body: unknown;
  try { body = JSON.parse(text); } catch { return fail(400, 'Send valid JSON.', 'bad_json'); }
  const parsed = validateBody(body);
  if (!parsed.ok) return fail(400, parsed.message, 'invalid_input');
  const query = parsed.query;
  const key = addressKey(query.address);

  // ---- cache first
  let hit: CachedRow;
  try { hit = await deps.db.getCached(key, query.placeId ?? null); } catch { return fail(502, 'The property data service is unavailable right now.', 'cache_failed'); }
  if (hit && hit.profile && typeof hit.profile === 'object') {
    return reply({ cached: true, expires_at: hit.expires_at ?? null, profile: hit.profile });
  }

  // ---- decide which paid providers may run
  const keys: Keys = {};
  const skips: Skip[] = [];
  for (const p of PAID) {
    const apiKey = deps.env(p.keyEnv);
    const skip = (reason: string) => skips.push({ id: p.id, status: 'skipped', reason });
    if (!apiKey) { skip('no API key'); continue; }
    const cap = positiveInt(deps.env(p.capEnv));
    if (!cap) { skip('daily limit not set'); continue; }
    let ok = false;
    try { ok = await deps.db.reserve(p.id, cap); } catch { code('budget_check_failed'); }
    if (!ok) { skip('daily limit reached'); continue; }
    keys[p.key] = apiKey;
  }

  // ---- build
  const now = deps.now();
  let profile: Profile;
  try {
    profile = await deps.buildProfile(query, { fetch: deps.fetch, now: now.toISOString(), keys });
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('shape');
  } catch { return fail(502, 'The property data service is unavailable right now.', 'upstream_failed'); }

  // Skip reasons decided here win over whatever the builder wrote for the same provider. An entry the builder marks 'used' is
  // never dropped (it would hide a retention limit), even though the handler had not enabled that provider.
  const built = Array.isArray(profile.providers) ? profile.providers : [];
  const isUsed = (id: string) => built.some((p) => p && typeof p === 'object' && (p as { id?: unknown; status?: unknown }).id === id && (p as { status?: unknown }).status === 'used');
  const keep = (p: unknown) => !(p && typeof p === 'object' && skips.some((s) => s.id === (p as { id?: unknown }).id) && (p as { status?: unknown }).status !== 'used');
  const providers = [...built.filter(keep), ...skips.filter((s) => !isUsed(s.id))];
  profile = { ...profile, providers };

  // ---- store with an expiry from the shortest retention among providers actually used
  const days = retentionDays(providers);
  let expiresAt: string | null = null;
  if (days > 0) {
    expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();
    try { await deps.db.store(storeArgs(key, query, profile, providers, MODEL_VERSION, expiresAt)); } catch { code('store_failed'); expiresAt = null; }
  }
  return reply({ cached: false, expires_at: expiresAt, profile });
}

// ---------------------------------------------------------------- production wiring (Deno only)
//
// BUNDLING CHECK BEFORE DEPLOY: the builder lives OUTSIDE supabase/functions/ (repo-root core/). Whether `supabase functions deploy`
// bundles files outside the functions directory MUST be verified on a deploy to a non-production project first. If it does not,
// the fallback is a deploy step that copies core/ into supabase/functions/_shared/core/ and changes the two import paths below
// to '../_shared/core/...'. The import is lazy so the pure handler above stays importable and testable without core/.

export function productionDeps(): Deps {
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any).Deno;
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { createClient } = await import('npm:@supabase/supabase-js@2.45.4');
    const admin = createClient(D.env.get('SUPABASE_URL')!, D.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const r = await admin.rpc(name, args);
    if (r.error) throw new Error(r.error.code ?? 'rpc_error');
    return r.data;
  };
  return {
    async buildProfile(query, ctx) {
      const [{ buildPropertyProfile }, { createDefaultRegistry }, { splitYard }] = await Promise.all([
        import('../../../../core/property-profile.js'), import('../../../../core/providers/registry.js'), import('../../../../core/yard.js'),
      ]);
      return await buildPropertyProfile(query, { registry: await createDefaultRegistry(), fetch: ctx.fetch, now: ctx.now, keys: ctx.keys, splitYard });
    },
    db: {
      getCached: async (k, placeId) => (await rpc('get_cached_property_profile', { p_address_key: k, p_place_id: placeId })) as CachedRow,
      reserve: async (provider, cap) => (await rpc('reserve_provider_call', { p_provider: provider, p_daily_cap: cap })) === true,
      store: (args) => rpc('store_property_profile', args),
    },
    now: () => new Date(),
    env: (n) => D.env.get(n),
    fetch: (...a) => fetch(...a),
  };
}

const deno = (globalThis as { Deno?: { serve?: (h: (r: Request) => Promise<Response>) => unknown } }).Deno;
if (typeof deno?.serve === 'function') { const deps = productionDeps(); deno.serve((req) => handle(req, deps)); }

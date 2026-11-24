// A host uploads a reservations file (CSV exported from a site) for one of their spaces.
//
// POST /functions/v1/booking-import
//   multipart/form-data: space_id, channel, file (.csv)      or      JSON: { "space_id", "channel", "csv": "<text>" }
// Answers { inserted, updated, cancelled, conflicts, rows } or { error, details? }.
//
// The file goes through the manual adapter (nothing else is read, unknown columns such as guest contact details are
// dropped) and the rows are handed to the import_reservations RPC AS THE CALLER: it runs with their JWT, not the service
// role, so row-level security and the function's own permission checks apply.
import { CORS, preflight } from '../_shared/cors.ts';
import { adapterFor, ProviderError } from '../_shared/providers/index.ts';
import type { NormalizedReservation } from '../_shared/providers/index.ts';

export const MAX_UPLOAD_BYTES = 1_048_576 + 65_536; // the CSV cap plus room for multipart framing

export type ImportDeps = {
  /** The caller's own space (row-level security applies), with its time zone; null if they have no such space. */
  findSpace(auth: string, spaceId: string): Promise<{ id: string; timeZone: string } | null>;
  /** import_reservations, called with the caller's JWT. */
  importReservations(auth: string, args: { p_space: string; p_channel: string; p_rows: NormalizedReservation[]; p_source: 'manual' }):
    Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const STATUS: Record<string, number> = { too_large: 413, parse_error: 422, empty_feed: 422, unsupported: 400 };

export async function handle(req: Request, deps: ImportDeps): Promise<Response> {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  if (!/^Bearer\s+\S+/i.test(auth)) return json({ error: 'Sign in first.' }, 401);
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return json({ error: 'That file is too large to import (over 1 MB).' }, 413);

  let spaceId = ''; let channel = ''; let text = '';
  try {
    if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      const form = await req.formData();
      spaceId = String(form.get('space_id') ?? ''); channel = String(form.get('channel') ?? '');
      const file = form.get('file');
      text = file && typeof file !== 'string' ? await file.text() : '';
    } else {
      const b = await req.json() as { space_id?: unknown; channel?: unknown; csv?: unknown };
      spaceId = String(b.space_id ?? ''); channel = String(b.channel ?? ''); text = typeof b.csv === 'string' ? b.csv : '';
    }
  } catch { return json({ error: 'Send the file as a form upload (space_id, channel, file) or as JSON (space_id, channel, csv).' }, 400); }
  if (!spaceId) return json({ error: 'space_id is required.' }, 400);
  if (!/^[a-z][a-z0-9_]*$/.test(channel)) return json({ error: 'channel is required (for example airbnb or other).' }, 400);
  if (!text.trim()) return json({ error: 'The file is empty.' }, 400);

  const adapter = adapterFor(channel, 'parseBookingFile');
  if (!adapter) return json({ error: 'File import is not available for this site.' }, 400);
  const space = await deps.findSpace(auth, spaceId);
  if (!space) return json({ error: 'Space not found' }, 404);

  let rows: NormalizedReservation[];
  try { rows = adapter.parseBookingFile({ text }, { timeZone: space.timeZone }).rows; } catch (e) {
    if (e instanceof ProviderError) return json({ error: e.message, code: e.code, details: e.details }, STATUS[e.code] ?? 400);
    return json({ error: 'That file could not be read.' }, 400);
  }

  const { data, error } = await deps.importReservations(auth, { p_space: space.id, p_channel: channel, p_rows: rows, p_source: 'manual' });
  if (error) return json({ error: error.message }, error.code === '42501' ? 403 : 400);
  return json({ ...(data && typeof data === 'object' ? data : {}), rows: rows.length });
}

// ---------------------------------------------------------------- production wiring (Deno only)

export function productionDeps(): ImportDeps {
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any).Deno;
  // The anon key plus the caller's own Authorization header: requests are made AS the host, never as the service role.
  const userClient = (auth: string) => import('npm:@supabase/supabase-js@2.45.4').then(({ createClient }) =>
    createClient(D.env.get('SUPABASE_URL')!, D.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false }, global: { headers: { Authorization: auth } } }));
  return {
    async findSpace(auth, spaceId) {
      const { data } = await (await userClient(auth)).from('spaces').select('id, properties!inner(timezone)').eq('id', spaceId).maybeSingle();
      return data ? { id: data.id, timeZone: data.properties.timezone } : null;
    },
    async importReservations(auth, args) {
      const r = await (await userClient(auth)).rpc('import_reservations', args);
      return { data: r.data, error: r.error };
    },
  };
}

const deno = (globalThis as { Deno?: { serve?: (h: (r: Request) => Promise<Response>) => unknown } }).Deno;
if (typeof deno?.serve === 'function') { const deps = productionDeps(); deno.serve((req) => handle(req, deps)); }

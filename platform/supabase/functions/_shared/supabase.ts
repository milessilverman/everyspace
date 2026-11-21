// deno-lint-ignore no-import-prefix
import { createClient } from 'npm:@supabase/supabase-js@2.119.2';

function apiKey(dictionary: string, legacy: string): string {
  const configured = Deno.env.get(dictionary);
  if (configured) {
    let key: unknown;
    try { key = JSON.parse(configured)?.default; }
    catch { throw new Error('Invalid ' + dictionary + ' configuration.'); }
    if (typeof key === 'string' && key) return key;
  }
  const fallback = Deno.env.get(legacy);
  if (!fallback) throw new Error('Missing Supabase API key configuration.');
  return fallback;
}

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = () => apiKey('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');

export function serviceClient() {
  return createClient(url, serviceKey(), { auth: { persistSession: false } });
}

export function userClient(authorization: string) {
  const key = apiKey('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
}

export function isServiceAuthorization(authorization: string) {
  if (authorization === 'Bearer ' + serviceKey()) return true;
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  return Boolean(legacy && authorization === 'Bearer ' + legacy);
}

import { serviceClient, userClient } from '../_shared/supabase.ts';
// deno-lint-ignore no-import-prefix
import PostalMime from 'npm:postal-mime@4.2.1';
import { CORS, preflight } from '../_shared/cors.ts';
import { emailFingerprint, MAX_EMAIL_BYTES, parseBookingEmail } from '../_shared/booking-email.ts';
import { BodyLimitError, readBoundedBody } from '../_shared/request-body.ts';
import { reservationRange } from '../_shared/reservation-time.ts';

const admin = serviceClient();
const response = (value: object, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const isUuid = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

function record(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type ScopedSpace = { id: string; properties: { timezone: string } };

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return response({ error: 'Use POST.' }, 405);
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return response({ error: 'Sign in to manage booking email.' }, 401);
  const user = userClient(auth);
  const { data: authenticated } = await user.auth.getUser();
  if (!authenticated.user) return response({ error: 'Sign in to manage booking email.' }, 401);

  let body: Record<string, unknown> | null;
  try {
    body = record(JSON.parse(new TextDecoder().decode(await readBoundedBody(req, MAX_EMAIL_BYTES * 3))));
  } catch (error) {
    return response({ error: error instanceof BodyLimitError ? 'Message is too large.' : 'Invalid message input.' }, error instanceof BodyLimitError ? 413 : 400);
  }
  if (!body) return response({ error: 'Invalid message input.' }, 400);

  if (body.action === 'record' || body.action === 'dismiss') {
    if (!isUuid(body.review_id)) return response({ error: 'Email review not found.' }, 404);
    const { data: item } = await user.from('booking_email_reviews').select('id, space_id').eq('id', body.review_id).maybeSingle();
    if (!item) return response({ error: 'Email review not found.' }, 404);
    if (body.action === 'dismiss') {
      const { error } = await user.rpc('review_booking_email', { p_review: item.id, p_action: 'dismiss' });
      return error ? response({ error: error.message }, 400) : response({ status: 'dismissed' });
    }
    if (body.verified_on_provider !== true) return response({ error: 'Verify the booking on the provider first.' }, 400);
    const { data: sp } = await user.from('spaces').select('id, properties!inner(timezone)').eq('id', item.space_id).maybeSingle();
    if (!sp) return response({ error: 'Space not found.' }, 404);
    const allDay = body.all_day !== false;
    try {
      const { startsAt, endsAt } = reservationRange(body.start, body.end, allDay, (sp as unknown as ScopedSpace).properties.timezone);
      const { error } = await user.rpc('review_booking_email', {
        p_review: item.id, p_action: 'record', p_start: startsAt, p_end: endsAt, p_all_day: allDay,
        p_units: body.units ?? 1, p_reference: body.reference ?? null,
      });
      return error ? response({ error: error.message }, 400) : response({ status: 'recorded' });
    } catch (error) {
      return response({ error: error instanceof Error ? error.message : 'Verify the dates first.' }, 400);
    }
  }

  if (body.action !== 'ingest' || !isUuid(body.space_id) || typeof body.channel !== 'string'
      || !/^[a-z_]{1,32}$/.test(body.channel) || typeof body.content !== 'string' || !body.content.trim()
      || !['text', 'eml'].includes(String(body.format))) {
    return response({ error: 'Choose a listing and supply a forwarded message.' }, 400);
  }

  if (new TextEncoder().encode(body.content).length > MAX_EMAIL_BYTES) return response({ error: 'Message exceeds 128 KB.' }, 413);
  // Resolve scope with the user connection under RLS before touching the service-only write path.
  const { data: listing } = await user.from('channel_listings').select('id')
    .eq('space_id', body.space_id).eq('channel', body.channel).maybeSingle();
  const { data: sp } = await user.from('spaces').select('id, properties!inner(timezone)').eq('id', body.space_id).maybeSingle();
  if (!listing || !sp) return response({ error: 'Listing not found.' }, 404);
  let text = body.content;
  let subject = '';
  if (body.format === 'eml') {
    try {
      const mail = await PostalMime.parse(body.content, { maxNestingDepth: 12, maxHeadersSize: 16 * 1024 });
      text = mail.text ?? '';
      subject = mail.subject ?? '';
    } catch {
      text = '';
    }
  }

  const parsed = parseBookingEmail({ text, subject, timeZone: (sp as unknown as ScopedSpace).properties.timezone });
  const fingerprint = await emailFingerprint(parsed, text.trim() && parsed.startsAt ? text : body.content);
  const { data: inserted, error } = await admin.from('booking_email_reviews').upsert({
    space_id: sp.id, channel: body.channel, fingerprint, reference: parsed.reference,
    starts_at: parsed.startsAt, ends_at: parsed.endsAt, all_day: parsed.allDay,
    units: parsed.units, reported_status: parsed.status, issues: parsed.issues,
  }, { onConflict: 'space_id,channel,fingerprint', ignoreDuplicates: true }).select('id');
  if (error) return response({ error: 'The message could not be added to review.' }, 503);
  return response({ status: inserted?.length ? 'needs_review' : 'duplicate' }, inserted?.length ? 201 : 200);
});

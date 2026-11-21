import { pathToFileURL } from 'node:url';

export const previewRoutes = [
  { path: '/', file: 'index.html' },
  { path: '/host/', file: 'host/index.html' },
  { path: '/host/integration-catalog.mjs', file: 'host/integration-catalog.mjs' },
];

function exactOrigin(value, hostname) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hostname.test(url.hostname) || url.port || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use the approved HTTPS staging and Access origins.');
  }
  return url.origin;
}

function accessDenied(response, accessOrigin) {
  if (response.status === 401 || response.status === 403) return true;
  if (![301, 302, 303, 307, 308].includes(response.status)) return false;
  try {
    const redirect = new URL(response.headers.get('location'));
    return redirect.origin === accessOrigin && redirect.pathname.startsWith('/cdn-cgi/access/login/');
  } catch {
    return false;
  }
}

export async function verifyPreviewAccess(
  { previewUrl, accessUrl, clientId, clientSecret, challenge, projectRef },
  fetcher = fetch,
) {
  const preview = exactOrigin(previewUrl, /^[a-z0-9-]+-everyspace-staging\.[a-z0-9-]+\.workers\.dev$/);
  const access = exactOrigin(accessUrl, /^[a-z0-9-]+\.cloudflareaccess\.com$/);
  if (!clientId || !clientSecret) throw new Error('Supply the temporary staging Access service token.');
  if (challenge !== undefined ? !/^[a-f0-9]{32}$/.test(challenge) : !/^[a-z0-9]{20}$/.test(projectRef ?? '')) {
    throw new Error('Supply the deployment challenge or expected staging project reference.');
  }
  const expected = challenge === undefined
    ? ['Everyspace staging', 'const SUPABASE_URL = "https://' + projectRef + '.supabase.co"', 'export const INTEGRATIONS']
    : previewRoutes.map(() => 'everyspace-access-probe-' + challenge);
  const evidence = [];
  for (const [index, { path }] of previewRoutes.entries()) {
    const url = preview + path;
    const anonymous = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    await anonymous.body?.cancel();
    if (!accessDenied(anonymous, access)) throw new Error('Access did not deny an anonymous request to ' + path);
    // Manual redirects keep the service token on the exact staging origin.
    const allowed = await fetcher(url, {
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret },
    });
    if (allowed.status !== 200) {
      await allowed.body?.cancel();
      throw new Error('The staging Access service token did not open ' + path);
    }
    const cacheControl = allowed.headers.get('cache-control') ?? '';
    const text = await allowed.text();
    if (!/\bprivate\b/i.test(cacheControl) || !/\bno-store\b/i.test(cacheControl)
        || !text.includes(expected[index])) {
      throw new Error('The authenticated staging asset was unexpected or cacheable at ' + path);
    }
    evidence.push({ path, anonymous: anonymous.status, authorized: allowed.status });
  }
  return evidence;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const evidence = await verifyPreviewAccess({
    previewUrl: process.env.STAGING_PREVIEW_URL,
    accessUrl: process.env.STAGING_ACCESS_URL,
    clientId: process.env.CF_ACCESS_CLIENT_ID,
    clientSecret: process.env.CF_ACCESS_CLIENT_SECRET,
    challenge: process.env.STAGING_PROBE_CHALLENGE,
    projectRef: process.env.STAGING_PROJECT_REF,
  });
  for (const result of evidence) console.log(result.path, 'anonymous', result.anonymous, 'authorized', result.authorized);
}

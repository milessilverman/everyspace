import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packagePreview } from '../staging/package-preview.mjs';
import { previewRoutes, verifyPreviewAccess } from '../staging/preview-access.mjs';

const source = await readFile(new URL('../../host/index.html', import.meta.url), 'utf8');
const productionRef = /const SUPABASE_URL = 'https:\/\/([a-z0-9]+)\.supabase\.co'/.exec(source)[1];
const stagingRef = 'syntheticstaging0000';
const publishable = 'sb_publishable_synthetic_fixture';
const local = new URL('../', import.meta.url);

test('the audited Supabase SDK version matches the browser and all Edge Functions', async () => {
  const { dependencies } = JSON.parse(await readFile(new URL('package.json', local), 'utf8'));
  const version = dependencies['@supabase/supabase-js'];
  const lock = JSON.parse(await readFile(new URL('package-lock.json', local), 'utf8'));
  assert.equal(lock.packages['node_modules/@supabase/supabase-js'].version, version);
  assert.ok(source.includes('@supabase/supabase-js@' + version + '/dist/umd/supabase.min.js" integrity="sha384-'));
  const functions = new URL('supabase/functions/', local);
  const sdk = await readFile(new URL('_shared/supabase.ts', functions), 'utf8');
  assert.ok(sdk.includes('npm:@supabase/supabase-js@' + version + "'"));
  for (const entry of await readdir(functions, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== '_shared') {
      const code = await readFile(new URL(entry.name + '/index.ts', functions), 'utf8');
      assert.match(code, /from '\.\.\/_shared\/supabase\.ts'/);
      assert.doesNotMatch(code, /npm:@supabase\/supabase-js/);
    }
  }
});

test('the preview and calendar job use only the staging project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'everyspace-preview-test-'));
  try {
    const destination = join(directory, 'preview');
    await assert.rejects(packagePreview(destination, productionRef, publishable), /separate Supabase project/);
    await assert.rejects(packagePreview(destination, stagingRef, 'sb_secret_synthetic_fixture'), /publishable/);
    assert.deepEqual(await readdir(directory), []);
    await packagePreview(destination, stagingRef, publishable);
    const config = JSON.parse(await readFile(join(destination, 'wrangler.jsonc'), 'utf8'));
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, true);
    assert.deepEqual((await readdir(join(destination, 'public'))).sort(), ['_headers', 'host', 'index.html']);
    const consolePage = await readFile(join(destination, 'public/host/index.html'), 'utf8');
    const schedule = await readFile(join(destination, 'calendar-schedule.sql'), 'utf8');
    assert.match(consolePage, /Staging environment\. Use synthetic accounts, bookings and calendar links only\./);
    assert.ok(consolePage.includes('https://' + stagingRef + '.supabase.co'));
    assert.ok(schedule.includes('https://' + stagingRef + '.supabase.co/functions/v1/calendar-sync'));
    assert.ok(!consolePage.includes(productionRef));
    assert.ok(!schedule.includes(productionRef));
    assert.doesNotMatch(schedule, /earnings|auto_approve|billing/);
    const published = { ...accessConfig, challenge: undefined, projectRef: stagingRef };
    const fetchBundle = gateFetch({ content: (path) => {
      const { file } = previewRoutes.find((route) => route.path === path);
      return readFile(join(destination, 'public', file), 'utf8');
    } });
    assert.equal((await verifyPreviewAccess(published, fetchBundle)).length, previewRoutes.length);
    await assert.rejects(verifyPreviewAccess({ ...published, projectRef: 'otherstaging00000000' }, fetchBundle), /unexpected.*\/host\//);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const stagingPreview = 'https://review-everyspace-staging.synthetic.workers.dev';
const accessOrigin = 'https://synthetic.cloudflareaccess.com';
const probeChallenge = '0123456789abcdef0123456789abcdef';
const accessConfig = {
  previewUrl: stagingPreview, accessUrl: accessOrigin, clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
  challenge: probeChallenge,
};

function gateFetch({ anonymousStatus = 302, location = accessOrigin + '/cdn-cgi/access/login/expected', cacheControl = 'private, no-store',
  content = 'everyspace-access-probe-' + probeChallenge, allowedStatus = 200 } = {}) {
  return async (url, options) => {
    assert.equal(new URL(url).origin, stagingPreview);
    assert.equal(options.redirect, 'manual');
    if (!options.headers) return new Response(null, { status: anonymousStatus, headers: { location } });
    assert.equal(options.headers['CF-Access-Client-Id'], accessConfig.clientId);
    assert.equal(options.headers['CF-Access-Client-Secret'], accessConfig.clientSecret);
    const body = typeof content === 'function' ? await content(new URL(url).pathname) : content;
    return new Response(body, { status: allowedStatus, headers: { 'cache-control': cacheControl } });
  };
}

test('the generated Access probe contains only its challenge under the actual asset routes', async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), 'everyspace-access-test-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const destination = join(scratch, 'preview');
  await packagePreview(destination, stagingRef, publishable);
  const probe = join(destination, 'access-probe');
  assert.equal(await readFile(join(probe, 'wrangler.jsonc'), 'utf8'), await readFile(join(destination, 'wrangler.jsonc'), 'utf8'));
  const challenge = (await readFile(join(probe, 'challenge.txt'), 'utf8')).trim();
  assert.match(challenge, /^[a-f0-9]{32}$/);
  for (const { file } of previewRoutes) {
    const marker = await readFile(join(probe, 'public', file), 'utf8');
    assert.ok(marker.includes('everyspace-access-probe-' + challenge));
    assert.ok(!marker.includes(stagingRef) && !marker.includes(productionRef) && !marker.includes(publishable));
  }
});

test('the access verifier requires anonymous denial and a private matching asset on every route', async () => {
  assert.deepEqual(await verifyPreviewAccess(accessConfig, gateFetch()),
    previewRoutes.map(({ path }) => ({ path, anonymous: 302, authorized: 200 })));
  await assert.rejects(verifyPreviewAccess(accessConfig, gateFetch({ anonymousStatus: 200 })), /did not deny/);
  await assert.rejects(verifyPreviewAccess(accessConfig, gateFetch({ anonymousStatus: 404 })), /did not deny/);
  await assert.rejects(verifyPreviewAccess(accessConfig, gateFetch({ location: 'https://wrong.example/login' })), /did not deny/);
  await assert.rejects(verifyPreviewAccess(accessConfig, gateFetch({ allowedStatus: 302 })), /did not open/);
  await assert.rejects(verifyPreviewAccess(accessConfig, gateFetch({ cacheControl: 'public' })), /cacheable/);
  await assert.rejects(verifyPreviewAccess(accessConfig, gateFetch({ content: 'another version' })), /unexpected/);
  await assert.rejects(verifyPreviewAccess({ ...accessConfig, previewUrl: 'https://everyspace-staging.synthetic.workers.dev' },
    () => assert.fail('Credentials must not be sent to a Worker default route')), /HTTPS staging/);
});

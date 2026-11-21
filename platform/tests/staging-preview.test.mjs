import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packagePreview } from '../staging/package-preview.mjs';

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
    assert.ok(consolePage.includes('https://' + stagingRef + '.supabase.co'));
    assert.ok(schedule.includes('https://' + stagingRef + '.supabase.co/functions/v1/calendar-sync'));
    assert.ok(!consolePage.includes(productionRef));
    assert.ok(!schedule.includes(productionRef));
    assert.doesNotMatch(schedule, /earnings|auto_approve|billing/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewRoutes } from './preview-access.mjs';

const host = new URL('../../host/', import.meta.url);
const fixtures = new URL('./', import.meta.url);
const headers = "/*\n  Cache-Control: private, no-store\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  X-Robots-Tag: noindex, nofollow\n  Content-Security-Policy: frame-ancestors 'none'\n";
const workerConfig = JSON.stringify({
  name: 'everyspace-staging',
  compatibility_date: '2026-11-20',
  workers_dev: false,
  preview_urls: true,
  assets: { directory: './public', html_handling: 'auto-trailing-slash' },
}, null, 2) + '\n';

export async function packagePreview(destination, projectRef, publishableKey) {
  if (!/^[a-z0-9]{20}$/.test(projectRef ?? '') || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey ?? '')) {
    throw new Error('A staging project reference and its publishable API key are required.');
  }
  const source = await readFile(new URL('index.html', host), 'utf8');
  const urlDeclaration = /const SUPABASE_URL = '(https:\/\/[a-z0-9]{20}\.supabase\.co)'/;
  const keyDeclaration = /const ANON_KEY = '[^']+'/;
  const current = source.match(urlDeclaration)?.[1];
  const stagingUrl = 'https://' + projectRef + '.supabase.co';
  if (!current || !keyDeclaration.test(source) || current === stagingUrl) {
    throw new Error('The preview must target a separate Supabase project.');
  }
  const publicAuth = 'const PUBLIC_AUTH_SETUP = true;';
  if (!source.includes(publicAuth)) throw new Error('The Host Console must support staging-only sign-in.');
  const consolePage = source
    .replace('<title>Everyspace Host Console</title>', '<title>Everyspace staging | Host Console</title>')
    .replace('<body>', '<body>\n<div class="wrap"><p class="callout warn small">Staging environment. Use synthetic accounts, bookings and calendar links only.</p></div>')
    .replace(publicAuth, 'const PUBLIC_AUTH_SETUP = false;')
    .replace(urlDeclaration, 'const SUPABASE_URL = ' + JSON.stringify(stagingUrl))
    .replace(keyDeclaration, 'const ANON_KEY = ' + JSON.stringify(publishableKey));
  const assets = join(destination, 'public');
  const probe = join(destination, 'access-probe');
  const fixtureProject = join(destination, 'fixtures', 'supabase');
  const fixtureFunction = join(fixtureProject, 'functions', 'staging-calendar-fixture');
  await mkdir(destination);
  await Promise.all([
    mkdir(join(assets, 'host'), { recursive: true }),
    mkdir(join(probe, 'public', 'host'), { recursive: true }),
    mkdir(fixtureFunction, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(assets, 'host/index.html'), consolePage),
    writeFile(join(assets, 'host/integration-catalog.mjs'), await readFile(new URL('integration-catalog.mjs', host))),
    writeFile(join(assets, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Everyspace staging</title><meta http-equiv="refresh" content="0;url=/host/"><a href="/host/">Open the staging Host Console</a></html>\n'),
    writeFile(join(assets, '_headers'), headers),
    writeFile(join(destination, 'wrangler.jsonc'), workerConfig),
    writeFile(join(destination, 'calendar-schedule.sql'), stagingSchedule(stagingUrl, publishableKey)),
    writeFile(join(fixtureProject, 'config.toml'), 'project_id = "everyspace-staging-fixtures"\n\n[functions.staging-calendar-fixture]\nverify_jwt = false\n'),
    writeFile(join(fixtureFunction, 'index.ts'), await readFile(new URL('calendar-fixture.ts', fixtures))),
    writeFile(join(fixtureFunction, 'calendar-fixtures.mjs'), await readFile(new URL('calendar-fixtures.mjs', fixtures))),
    writeAccessProbe(probe),
  ]);
}

async function writeAccessProbe(directory) {
  const challenge = randomBytes(16).toString('hex');
  const marker = 'everyspace-access-probe-' + challenge;
  await Promise.all([
    writeFile(join(directory, 'challenge.txt'), challenge + '\n'),
    writeFile(join(directory, 'wrangler.jsonc'), workerConfig),
    writeFile(join(directory, 'public', '_headers'), headers),
    ...previewRoutes.map(({ file }) => writeFile(join(directory, 'public', file), file.endsWith('.mjs')
      ? 'export const probe = ' + JSON.stringify(marker) + ';\n'
      : '<!doctype html><html lang="en"><meta charset="utf-8"><title>Staging Access check</title><p>' + marker + '</p></html>\n')),
  ]);
}

function stagingSchedule(url, publishableKey) {
  return `-- Run in the verified isolated staging database after deploying calendar-sync.
create extension if not exists pg_net schema extensions;
create extension if not exists pg_cron;

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'calendar_sync_cron_secret') then
    perform vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text,
      'calendar_sync_cron_secret', 'Synthetic staging calendar scheduling');
  end if;
end
$$;

select cron.schedule('everyspace-staging-calendar-sync', '*/15 * * * *', $schedule$
  select net.http_post(
    url := '${url}/functions/v1/calendar-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'apikey', '${publishableKey}',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'calendar_sync_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$schedule$);
`;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3) throw new Error('Supply one new output directory for the staging preview.');
  await packagePreview(destination, process.env.STAGING_PROJECT_REF, process.env.STAGING_PUBLISHABLE_KEY);
  console.log('Built the staging preview, Access probe and staging-only calendar schedule.');
}

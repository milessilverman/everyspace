import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as upstreamRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const migrations = join(root, 'platform/supabase/migrations');
const baselineVersion = '20261120110456';
const baselineCommit = '859af1c';
const accessMigration = '20261121002832_explicit_data_api_access.sql';
const primary = 'everyspace_staging';
const restored = 'everyspace_rollback';

export const fixturesHost = 'staging-calendars.example';
export const images = {
  database: 'postgres:17.7-alpine',
  auth: 'public.ecr.aws/supabase/gotrue:v2.188.1',
  rest: 'public.ecr.aws/supabase/postgrest:v14.10',
};

function signedToken(secret, role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const content = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ role, exp: Math.floor(Date.now() / 1000) + 14_400 });
  return content + '.' + createHmac('sha256', secret).update(content).digest('base64url');
}

async function waitFor(check, service) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check().catch(() => false)) return;
    await delay(250);
  }
  throw new Error(service + ' did not become ready.');
}

export async function createStaging() {
  const directory = await mkdtemp(join(tmpdir(), 'everyspace-staging-'));
  const name = 'everyspace-staging-' + randomBytes(5).toString('hex');
  const postgres = name + '-db';
  const secret = randomBytes(32).toString('hex');
  const restPassword = randomBytes(24).toString('hex');
  const authPassword = randomBytes(24).toString('hex');
  const cronSecret = randomBytes(32).toString('hex');
  const anon = signedToken(secret, 'anon');
  const service = signedToken(secret, 'service_role');
  const publishable = 'sb_publishable_' + randomBytes(24).toString('base64url');
  const secretKey = 'sb_secret_' + randomBytes(24).toString('base64url');
  const containers = [];
  const calendars = new Map();
  const assets = new Map();
  const browserBundles = new Map();
  const edgeLogs = [];
  let authPort, restPort, edgePort, edge, base, networkCreated;
  let activeDb = primary;
  let modernKeys = false;

  const docker = (...args) => run('docker', args, { timeout: 120_000, maxBuffer: 1_000_000 });
  const sql = (text, db = activeDb) => new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', postgres, 'psql', '-XAtq1', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1']);
    let data = '', errors = '';
    child.stdout.on('data', (bytes) => { data += bytes; });
    child.stderr.on('data', (bytes) => { errors += bytes; });
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', (code) => code === 0 ? resolve(data.trim()) : reject(new Error(errors.trim())));
    child.stdin.end(text);
  });
  async function container(suffix, image, environment, port) {
    const instance = name + '-' + suffix;
    const envFile = join(directory, suffix + '.env');
    await writeFile(envFile, Object.entries(environment).map(([key, value]) => key + '=' + value).join('\n') + '\n', { mode: 0o600 });
    const publish = port ? ['--publish', '127.0.0.1::' + port] : [];
    await docker('run', '--detach', '--name', instance, '--network', name, ...publish, '--env-file', envFile, image);
    containers.push(instance);
    if (!port) return;
    const { stdout } = await docker('port', instance, port + '/tcp');
    return Number(stdout.trim().split(':').pop());
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, base);
    const asset = assets.get(url.pathname);
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type });
      res.end(asset.body);
      return;
    }
    if (url.pathname.startsWith('/_staging/calendar/')) {
      const calendar = calendars.get(url.pathname.slice('/_staging/calendar'.length));
      res.writeHead(calendar?.status ?? 404, { 'content-type': 'text/calendar' });
      res.end(calendar?.body);
      return;
    }
    const api = /^\/(auth|rest)\/v1(\/.*)?$/.exec(url.pathname);
    const port = api ? (api[1] === 'auth' ? authPort : restPort) : url.pathname.startsWith('/functions/v1/') ? edgePort : null;
    if (!port) { res.writeHead(404).end(); return; }
    const headers = { ...req.headers, host: '127.0.0.1:' + port };
    // The local API services expect JWTs. Emulate the hosted opaque-key gateway
    // only for these two synthetic keys, preserving signed user JWTs unchanged.
    const gatewayRole = api && (headers.apikey === publishable ? anon : headers.apikey === secretKey ? service : null);
    if (gatewayRole && (!headers.authorization || headers.authorization === 'Bearer ' + headers.apikey)) {
      headers.authorization = 'Bearer ' + gatewayRole;
    }
    const outgoing = upstreamRequest({
      hostname: '127.0.0.1', port, path: api ? (api[2] ?? '/') + url.search : req.url, method: req.method,
      headers,
    }, (incoming) => {
      res.writeHead(incoming.statusCode, incoming.headers);
      incoming.pipe(res);
    });
    outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(outgoing);
  });

  function dbUri(user, password) { return 'postgres://' + user + ':' + password + '@' + postgres + ':5432/' + activeDb + '?sslmode=disable'; }
  async function auth(suffix) {
    authPort = await container(suffix + '-auth', images.auth, {
      API_EXTERNAL_URL: base + '/auth/v1', GOTRUE_SITE_URL: base, GOTRUE_API_HOST: '0.0.0.0', GOTRUE_API_PORT: 9999,
      GOTRUE_DB_DRIVER: 'postgres', GOTRUE_DB_DATABASE_URL: dbUri('everyspace_auth', authPassword),
      GOTRUE_DB_NAMESPACE: 'auth', GOTRUE_DB_MIGRATIONS_PATH: '/usr/local/etc/auth/migrations',
      GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
      GOTRUE_JWT_EXP: 3600, GOTRUE_DISABLE_SIGNUP: true, GOTRUE_MAILER_AUTOCONFIRM: false, GOTRUE_EXTERNAL_EMAIL_ENABLED: true,
      GOTRUE_RATE_LIMIT_EMAIL_SENT: 100,
    }, 9999);
    try {
      await waitFor(async () => (await fetch(base + '/auth/v1/health')).ok, 'Local GoTrue');
    } catch (error) {
      const { stdout, stderr } = await docker('logs', '--tail', '3', name + '-' + suffix + '-auth');
      const failure = (stdout + stderr).split('\n').find((line) => line.includes('"level":"fatal"')) ?? '';
      const shortFailure = failure.match(/ERROR: [^"\\]+|SQLSTATE [A-Z0-9]+/)?.[0] ?? '';
      const diagnostic = [authPassword, restPassword, secret, cronSecret].reduce(
        (message, value) => message.replaceAll(value, '[redacted]'), shortFailure,
      );
      throw new Error(error.message + (diagnostic ? '\n' + diagnostic : ''));
    }
  }

  async function rest(suffix) {
    restPort = await container(suffix + '-rest', images.rest, {
      PGRST_DB_URI: dbUri('authenticator', restPassword), PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: secret, PGRST_DB_POOL: 10, PGRST_LOG_LEVEL: 'warn',
    }, 3000);
    await waitFor(async () => (await fetch(base + '/rest/v1/')).ok, 'Local PostgREST');
  }

  async function applyMigrations(candidate) {
    for (const file of (await readdir(migrations)).filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort()) {
      if ((file.slice(0, 14) > baselineVersion) !== candidate) continue;
      await sql(await readFile(join(migrations, file), 'utf8'));
    }
    await sql("notify pgrst, 'reload schema';");
  }

  async function api(path, expected, { jwt = anon, body, ...options } = {}) {
    const key = modernKeys ? (jwt === service ? secretKey : publishable) : (jwt === service ? service : anon);
    const bearer = jwt === anon || jwt === service ? key : jwt;
    const result = await fetch(base + path, {
      ...options,
      headers: { apikey: key, authorization: 'Bearer ' + bearer, 'content-type': 'application/json', ...options.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await result.json().catch(() => null);
    // Avoid echoing fixture identifiers, authorization headers or provider responses to the caller.
    assert.equal(result.status, expected, result.status + ' from ' + path.split('?')[0] + (value?.code ? ' (' + value.code + ')' : ''));
    return value;
  }

  async function app(code = root) {
    if (edge) { edge.kill(); edgePort = undefined; }
    modernKeys = code === root && process.env.STAGING_LEGACY_KEYS !== '1';
    const original = await readFile(join(code, 'host/index.html'), 'utf8');
    const script = original.match(/(https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@(\d+\.\d+\.\d+)\/dist\/umd\/supabase\.min\.js)" integrity="sha384-([\w+/=]+)"/);
    assert.ok(script, 'Staging requires a pinned browser SDK with integrity metadata.');
    const [, sdkUrl, version, digest] = script;
    let sdk = browserBundles.get(digest);
    if (!sdk) {
      const sdkDirectory = process.env.STAGING_BROWSER_SDK_DIR;
      const sdkPath = sdkDirectory ? join(sdkDirectory, 'supabase-' + version + '.js') : (code === root ? process.env.STAGING_BROWSER_SDK_FILE : undefined);
      sdk = sdkPath ? await readFile(sdkPath)
        : (await run('curl', ['-fsSL', '--proto', '=https', '--proto-redir', '=https', '--max-time', '20', sdkUrl], { encoding: 'buffer', maxBuffer: 1_000_000 })).stdout;
      assert.equal(createHash('sha384').update(sdk).digest('base64'), digest, 'Browser SDK integrity mismatch.');
      browserBundles.set(digest, sdk);
    }
    const host = original
      .replace(/const SUPABASE_URL = '[^']+'/, 'const SUPABASE_URL = ' + JSON.stringify(base))
      .replace(/const ANON_KEY = '[^']+'/, 'const ANON_KEY = ' + JSON.stringify(modernKeys ? publishable : anon))
      .replace('const PUBLIC_AUTH_SETUP = true;', 'const PUBLIC_AUTH_SETUP = false;')
      .replace(sdkUrl, '/_staging/supabase.js');
    assert.ok(host.includes('const SUPABASE_URL = ' + JSON.stringify(base)), 'Staging could not configure the Host Console.');
    for (const [url, type, body] of [
      ['/', 'text/html', await readFile(join(code, 'index.html'))],
      ['/host/', 'text/html', host],
      ['/host/integration-catalog.mjs', 'application/javascript', await readFile(join(code, 'host/integration-catalog.mjs'))],
      ['/_staging/supabase.js', 'application/javascript', sdk],
    ]) assets.set(url, { type, body });
    const permitted = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_SECRET_KEYS', 'CALENDAR_FEED_HOST_ALLOWLIST',
      'EVERYSPACE_STAGING_CODE', 'CHANNEL_RESERVATION_WORKER_SECRET'];
    edge = spawn(process.env.DENO_BIN ?? 'deno', [
      'run', '--no-prompt', '--no-lock', '--node-modules-dir=none', '--allow-net=127.0.0.1', '--allow-env=' + permitted.join(','),
      '--allow-read=' + code, fileURLToPath(new URL('./edge.ts', import.meta.url)),
    ], {
      env: { ...process.env, SUPABASE_URL: base, SUPABASE_ANON_KEY: modernKeys ? '' : anon, SUPABASE_SERVICE_ROLE_KEY: modernKeys ? '' : service,
        SUPABASE_PUBLISHABLE_KEYS: modernKeys ? JSON.stringify({ default: publishable }) : '',
        SUPABASE_SECRET_KEYS: modernKeys ? JSON.stringify({ default: secretKey }) : '',
        CALENDAR_FEED_HOST_ALLOWLIST: fixturesHost, EVERYSPACE_STAGING_CODE: code, CHANNEL_RESERVATION_WORKER_SECRET: '' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    await new Promise((resolve, reject) => {
      const lines = createInterface({ input: edge.stdout });
      const timeout = setTimeout(() => reject(new Error('Local Edge startup exceeded 45 seconds.')), 45_000);
      const fail = (error) => { clearTimeout(timeout); reject(error); };
      edge.once('error', fail);
      edge.once('exit', (code) => fail(new Error('Local Edge stopped before startup with exit code ' + code)));
      lines.on('line', (line) => {
        if (line.startsWith('STAGING_EDGE_PORT=')) {
          edgePort = Number(line.split('=')[1]);
          clearTimeout(timeout);
          resolve();
        } else if (line.startsWith('{')) {
          edgeLogs.push(JSON.parse(line));
        }
      });
    });
  }

  async function stop() {
    edge?.kill();
    server.close();
    await Promise.allSettled(containers.map((container) => docker('rm', '-f', '-v', container)));
    if (networkCreated) await docker('network', 'rm', name);
    await rm(directory, { recursive: true, force: true });
  }

  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = 'http://127.0.0.1:' + server.address().port;
    await docker('network', 'create', name);
    networkCreated = true;
    await container('db', images.database, { POSTGRES_PASSWORD: randomBytes(24).toString('hex'), POSTGRES_DB: primary });
    await waitFor(async () => (await docker('exec', postgres, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', primary)).stdout.includes('accepting'), 'Local PostgreSQL');
    await sql(`
      create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
      create role authenticator login noinherit password '${restPassword}';
      create role everyspace_auth login password '${authPassword}';
      grant anon, authenticated, service_role to authenticator;
      create schema auth authorization everyspace_auth;
      alter role everyspace_auth set search_path = auth, public;
      grant usage on schema auth to anon, authenticated, service_role;
      grant usage on schema public to anon, authenticated, service_role;
      -- A synthetic Vault row exercises the real scheduler authorization RPC without a hosted Vault.
      create schema vault;
      create table vault.decrypted_secrets(name text primary key, decrypted_secret text not null);
      insert into vault.decrypted_secrets values ('calendar_sync_cron_secret', '${cronSecret}');
    `);
    await auth('baseline');
    // PostgREST uses the JSON claims GUC. Keep the legacy GUC fallback used by repository tests.
    await sql(`create or replace function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
    $$;`);
    await applyMigrations(false);
    // Give the pre-upgrade fixture the intended baseline API grants without
    // relying on older hosted projects' implicit default table privileges.
    await sql(await readFile(join(migrations, accessMigration), 'utf8'));
    await rest('baseline');
    return {
      base, anon, service, cronSecret, edgeLogs, api, sql, stop,
      setCalendar: (path, body, status = 200) => calendars.set(path, { body, status }),
      snapshot: () => docker('exec', postgres, 'pg_dump', '-U', 'postgres', '-d', primary, '-Fc', '-f', '/tmp/everyspace-baseline.dump'),
      async deployCandidate() {
        await applyMigrations(true);
        await waitFor(async () => Boolean(await api('/rest/v1/rpc/operational_readiness', 200, { jwt: service })),
          'Candidate schema cache');
        await app();
      },
      async restoreBaseline() {
        await docker('exec', postgres, 'createdb', '-U', 'postgres', '-T', 'template0', restored);
        await docker('exec', postgres, 'pg_restore', '-U', 'postgres', '--exit-on-error', '-d', restored, '/tmp/everyspace-baseline.dump');
        activeDb = restored;
        const previousCode = join(directory, 'baseline');
        const archive = join(directory, 'baseline.tar');
        await mkdir(previousCode);
        await run('git', ['-C', root, 'archive', '--output=' + archive, baselineCommit, 'index.html', 'host', 'platform/supabase/functions']);
        await run('tar', ['-xf', archive, '-C', previousCode]);
        await auth('rollback');
        await rest('rollback');
        await app(previousCode);
      },
    };
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
}

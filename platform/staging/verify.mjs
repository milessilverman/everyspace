import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createStaging, fixturesHost } from './stack.mjs';

import { booked, calendar, CHECKOUT, currentPool, defaultPool, houseCalendar, NIGHT, POOL_DAY } from './calendar-fixtures.mjs';

const poolFixturePath = '/pool.ics';

async function seed(stage) {
  const { api } = stage;
  const password = randomBytes(18).toString('base64url');
  async function signup(name) {
    const email = name.toLowerCase() + '@staging.example.com';
    const signup = await api('/auth/v1/signup', 200, { method: 'POST', body: { email, password, data: { full_name: name } } });
    assert.ok(signup.access_token);
    return { email, password, jwt: signup.access_token, id: signup.user.id };
  }
  const host = await signup('Avery');
  const outsider = await signup('Blair');
  const insert = (table, body, actor = host) => api('/rest/v1/' + table, 201, { method: 'POST', body, jwt: actor.jwt,
    headers: { prefer: 'return=representation' } });
  const [{ id: property }] = await insert('properties', { host_id: host.id, title: 'Practice Property', timezone: 'America/Los_Angeles' });
  await insert('properties', { host_id: outsider.id, title: 'Second Property' }, outsider);
  const [{ id: house }] = await insert('spaces', { title: 'Practice House', category: 'entire_home', property_id: property });
  const [{ id: pool }] = await insert('spaces', { title: 'Practice Pool', category: 'pool', property_id: property, parent_space_id: house, turnover_minutes: 30 });
  const [{ id: driveway }] = await insert('spaces', { title: 'Independent Driveway', category: 'parking_spot', property_id: property });
  await insert('channel_listings', [
    { space_id: house, channel: 'airbnb', status: 'live' },
    { space_id: pool, channel: 'swimply', status: 'live' },
  ]);
  await insert('calendar_imports?select=id', [
    { space_id: house, channel: 'airbnb', url: 'https://' + fixturesHost + '/house.ics' },
    { space_id: pool, channel: 'swimply', url: 'https://' + fixturesHost + poolFixturePath },
  ]);
  const [{ token: houseFeed }, { token: poolFeed }] = await insert('calendar_feeds', [
    { space_id: house, for_channel: 'airbnb' }, { space_id: pool, for_channel: 'swimply' },
  ]);
  await api('/rest/v1/rpc/record_external_booking', 200, { jwt: host.jwt, method: 'POST', body: {
    p_space: house, p_channel: 'airbnb', p_start: '2037-07-12T07:00:00Z', p_end: '2037-07-13T07:00:00Z',
    p_all_day: true, p_units: 1, p_reference: 'BASELINE-BOOKING',
  } });
  return { host, outsider, house, pool, driveway, houseFeed, poolFeed };
}

async function localPage(browser, stage, viewport) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  await page.route('**/*', (route) => new URL(route.request().url()).origin === stage.base ? route.continue() : route.abort('blockedbyclient'));
  return page;
}

async function signIn(page, host) {
  await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  await page.getByLabel('Email', { exact: true }).fill(host.email);
  await page.getByLabel('Password', { exact: true }).fill(host.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
}

async function navigate(page, tab) {
  await page.locator('nav button[data-tab="' + tab + '"]').click();
}

async function placeRequest(page, space, { day = null, start = null, end = null, blocked = false } = {}) {
  await page.getByRole('button', { name: 'New request' }).click();
  await page.locator('dialog select[name=space_id]').selectOption({ label: space });
  if (day) {
    await page.getByLabel('Check-in').fill(day[0]);
    await page.getByLabel('Check-out').fill(day[1]);
  } else {
    await page.getByRole('button', { name: 'Hourly', exact: true }).click();
    await page.getByLabel('Starts', { exact: true }).fill(start);
    await page.getByLabel('Ends', { exact: true }).fill(end);
  }
  const [response] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/functions/v1/booking-guard') && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Hold dates & check' }).click(),
  ]);
  assert.equal(response.status(), blocked ? 409 : 200);
  const verdict = await response.json();
  await page.locator('dialog').waitFor({ state: 'hidden' });
  await page.locator('#verdict').getByText(verdict.message, { exact: true }).waitFor();
  if (blocked) {
    assert.match(verdict.message, /dates are already taken|above capacity/i);
  } else {
    await page.locator('#verdict').getByText('Check the provider before accepting', { exact: true }).waitFor();
  }
}

async function importEmail(page) {
  await page.getByRole('button', { name: 'Import forwarded email' }).click();
  await page.locator('dialog select[name=listing]').selectOption({ label: 'Practice Pool · Swimply' });
  await page.getByLabel('Forwarded message').fill([
    'Status: Confirmed', 'Booking reference: STAGING-POOL-1', 'Start: ' + POOL_DAY + 'T15:00', 'End: ' + POOL_DAY + 'T17:00', 'Units: 1',
  ].join('\n'));
  await page.getByRole('button', { name: 'Add to review' }).click();
}

async function checkCalendars(stage, data) {
  const { api, setCalendar, anon, cronSecret, sql, edgeLogs } = stage;
  const { host, house, pool, houseFeed, poolFeed } = data;
  const sync = (jwt, space_id, secret = null, expected = 200) => api('/functions/v1/calendar-sync', expected, {
    jwt, method: 'POST', body: space_id ? { space_id } : {}, headers: secret ? { 'x-cron-secret': secret } : {},
  });
  const getPool = async () => {
    const rows = await api('/rest/v1/reservations?space_id=eq.' + pool + '&source=eq.ical', 200, { jwt: host.jwt });
    assert.equal(rows.length, 1);
    return rows[0];
  };
  const ageAttempt = () => sql(`update public.calendar_imports set last_attempt_at = now()-interval '35 minutes' where space_id = '${pool}'`);
  const read = () => sync(host.jwt, pool);
  setCalendar('/house.ics', houseCalendar);
  setCalendar(poolFixturePath, defaultPool);
  await sync(anon, null, 'synthetic-unauthorized-scheduler-value', 401);
  const batch = await sync(anon, null, cronSecret);
  assert.equal(batch.synced, 2);
  assert.ok(edgeLogs.some((entry) => entry.event === 'calendar_sync_run' && entry.synced === 2));
  assert.equal((await read()).skipped, 1);
  const [airbnb] = await api('/rest/v1/reservations?space_id=eq.' + house + '&source=eq.ical', 200, { jwt: host.jwt });
  assert.equal(new Date(airbnb.starts_at).toISOString(), '2037-07-14T07:00:00.000Z');
  assert.equal(new Date(airbnb.ends_at).toISOString(), '2037-07-15T07:00:00.000Z');
  const original = await getPool();
  assert.equal(new Date(original.starts_at).toISOString(), '2037-07-16T22:00:00.000Z');

  const exportFeed = (token, method = 'GET') => fetch(stage.base + '/functions/v1/calendar-feed/' + token + '.ics', { method });
  assert.equal((await exportFeed(houseFeed, 'HEAD')).status, 200);
  const [before] = await api('/rest/v1/calendar_feeds?select=last_fetched_at&space_id=eq.' + house, 200, { jwt: host.jwt });
  assert.equal(before.last_fetched_at, null);
  const home = await exportFeed(houseFeed);
  assert.equal(home.status, 200);
  const homeBody = await home.text();
  assert.match(homeBody, /DTSTART:20370716T220000Z/);
  assert.match(homeBody, /DTEND:20370717T003000Z/);
  assert.doesNotMatch(homeBody, /20370714|BASELINE-BOOKING|Practice/);
  const poolBody = await (await exportFeed(poolFeed)).text();
  assert.match(poolBody, /DTSTART;VALUE=DATE:20370714/);
  assert.doesNotMatch(poolBody, /20370716/);

  setCalendar(poolFixturePath, calendar());
  await ageAttempt();
  assert.equal((await read()).results[0].status, 'needs_review');
  assert.ok((await getPool()).calendar_missing_since);
  setCalendar(poolFixturePath, 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT', 206);
  await ageAttempt();
  assert.equal((await read()).results[0].status, 'error');
  assert.equal((await getPool()).status, 'confirmed');

  setCalendar(poolFixturePath, calendar([booked('fixture-pool-1', '20370716T223000Z', '20370717T003000Z', { revision: 2 })]));
  await ageAttempt();
  assert.equal((await read()).synced, 1);
  assert.equal((await getPool()).id, original.id);
  assert.equal(new Date((await getPool()).ends_at).toISOString(), '2037-07-17T00:30:00.000Z');
  setCalendar(poolFixturePath, defaultPool);
  await ageAttempt();
  assert.equal((await read()).results[0].status, 'needs_review');
  setCalendar(poolFixturePath, currentPool);
  await ageAttempt();
  assert.equal((await read()).synced, 1);

  setCalendar(poolFixturePath, '', 503);
  await sql(`update public.calendar_imports set last_synced_at = now()-interval '35 minutes' where space_id = '${pool}'`);
  await ageAttempt();
  assert.equal((await read()).results[0].status, 'error');
  assert.equal((await getPool()).status, 'confirmed');
  console.log('PASS scheduled authorization, both calendar directions, cleanup export, partial data, retries and provider revision order');
}

async function checkHostConsole(browser, stage, data) {
  const { host, outsider, pool, driveway, house } = data;
  const { api, sql } = stage;
  const page = await localPage(browser, stage, { width: 1280, height: 900 });
  for (const name of ['booking-guard', 'booking-email']) {
    await api('/functions/v1/' + name, 401, { method: 'POST', body: {} });
  }
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(stage.base + '/');
  await page.getByRole('link', { name: 'Explore the simulated host demo' }).click();
  await page.getByText('Demo · Bookings and connections are simulated.', { exact: false }).waitFor();
  await page.getByRole('link', { name: 'Open the Host Console' }).first().click();
  await signIn(page, host);
  await page.getByText('Calendar sync failed', { exact: true }).waitFor();
  await page.getByText('Calendar read overdue', { exact: true }).waitFor();
  const retryCalendar = async (body, status = 200) => {
    stage.setCalendar(poolFixturePath, body, status);
    await sql(`update public.calendar_imports set last_attempt_at = now()-interval '35 minutes' where space_id = '${pool}'`);
    await page.getByRole('button', { name: 'Sync calendars now' }).click();
  };
  await retryCalendar('Incomplete exported data', 206);
  await page.getByText('Calendar import incomplete', { exact: true }).waitFor();
  await retryCalendar(currentPool);
  await page.getByText('Calendar import incomplete', { exact: true }).waitFor({ state: 'hidden' });
  await navigate(page, 'channels');
  await page.getByRole('heading', { name: 'Swimply', exact: true }).waitFor();
  assert.equal(await page.locator('main article h3').count(), 22);
  await navigate(page, 'requests');

  await placeRequest(page, 'Practice Pool', { start: NIGHT + 'T15:00', end: NIGHT + 'T17:00', blocked: true });
  await placeRequest(page, 'Independent Driveway', { start: NIGHT + 'T15:00', end: NIGHT + 'T17:00' });
  await placeRequest(page, 'Practice House', { day: [POOL_DAY, '2037-07-17'], blocked: true });
  await placeRequest(page, 'Practice Pool', { start: POOL_DAY + 'T17:15', end: POOL_DAY + 'T18:00', blocked: true });
  await placeRequest(page, 'Practice Pool', { start: POOL_DAY + 'T17:30', end: POOL_DAY + 'T18:00' });
  await sql(`update public.booking_holds set expires_at = now()+interval '30 minutes' where space_id = '${driveway}'`);
  await importEmail(page);
  await page.getByText('Added to email review.').waitFor();
  await importEmail(page);
  await page.getByText('This message is already on file.').waitFor();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('button', { name: 'Record existing booking' }).click();
  await page.getByText('Verify the confirmation on the provider first.').waitFor();
  await page.getByLabel('I verified an existing confirmation directly on the provider.').check();
  await page.getByRole('button', { name: 'Record existing booking' }).click();
  await page.getByText('External booking recorded.').waitFor();

  const [recorded] = await api('/rest/v1/reservations?space_id=eq.' + pool + '&source=eq.email', 200, { jwt: host.jwt });
  await navigate(page, 'today');
  await page.getByText('Possible duplicate booking', { exact: true }).waitFor();
  await page.getByText('Booking hold needs review', { exact: true }).waitFor();
  await page.getByText(/Booking conflict on/).first().waitFor();
  await page.getByRole('button', { name: 'Compare bookings' }).click();
  await page.getByText(/Practice Pool.*STAGING-POOL-1/).waitFor();
  await page.getByRole('button', { name: 'Record change' }).click();
  assert.equal(await page.getByLabel('Starts', { exact: true }).inputValue(), POOL_DAY + 'T15:00:00-07:00');
  await page.getByLabel('Ends', { exact: true }).fill(POOL_DAY + 'T18:30');
  await page.getByLabel(/verified.*provider/i).check();
  await page.locator('dialog button[type=submit]').click();
  await page.getByText('Provider change recorded.').waitFor();
  let [updated] = await api('/rest/v1/reservations?id=eq.' + recorded.id, 200, { jwt: host.jwt });
  assert.equal(new Date(updated.ends_at).toISOString(), '2037-07-17T01:30:00.000Z');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Record cancellation' }).click();
  await page.getByText('External cancellation recorded.').waitFor();
  [updated] = await api('/rest/v1/reservations?id=eq.' + recorded.id, 200, { jwt: host.jwt });
  assert.equal(updated.status, 'cancelled');

  await sql(`
    insert into public.channel_api_listings(space_id,channel,account_ref,listing_ref)
      values ('${house}','airbnb','local-account-only','local-listing-only');
    insert into public.channel_reservation_requests(listing_id,external_request_ref,status,starts_at,ends_at,approval_started_at)
      select id,'local-job-only','uncertain','2037-07-20T07:00Z','2037-07-21T07:00Z',now()
      from public.channel_api_listings where space_id = '${house}';
  `);
  await page.reload();
  await page.getByText('Provider result needs review', { exact: true }).waitFor();
  await api('/functions/v1/channel-reservations/webhook/airbnb', 503, { jwt: host.jwt, method: 'POST', body: {} });
  const report = await api('/rest/v1/rpc/operational_readiness', 200, { jwt: stage.service });
  assert.equal(report.warnings.pending_reconciliation, 1);
  assert.doesNotMatch(JSON.stringify(report), /local-listing-only|STAGING-POOL-1|space_id/);
  await api('/rest/v1/rpc/operational_readiness', 403, { jwt: host.jwt });
  assert.equal((await api('/rest/v1/rpc/host_operational_warnings', 200, { jwt: outsider.jwt })).total, 0);
  assert.deepEqual(await api('/rest/v1/reservations?space_id=eq.' + pool, 200, { jwt: outsider.jwt }), []);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, outsider);
  await navigate(page, 'places');
  await page.getByText('Second Property', { exact: true }).waitFor();
  assert.equal(await page.getByText('Practice Property', { exact: true }).count(), 0);
  assert.equal(await page.locator('dialog').textContent(), '');
  assert.deepEqual(pageErrors, []);
  await page.close();

  const mobile = await localPage(browser, stage, { width: 390, height: 844 });
  await mobile.goto(stage.base + '/host/');
  await signIn(mobile, host);
  await mobile.getByText('Provider result needs review', { exact: true }).waitFor();
  for (const tab of ['today', 'requests', 'calendar', 'channels']) {
    await navigate(mobile, tab);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await mobile.close();

  await sql(`update public.calendar_imports set last_attempt_at = now()-interval '35 minutes' where space_id = '${pool}'`);
  stage.setCalendar(poolFixturePath, calendar([booked('fixture-pool-1', '20370716T220000Z', '20370717T000000Z', { revision: 4, cancelled: true })]));
  const syncPool = { method: 'POST', body: { space_id: pool } };
  await api('/functions/v1/calendar-sync', 401, { ...syncPool, jwt: host.jwt });
  const session = await api('/auth/v1/token?grant_type=password', 200, {
    method: 'POST', body: { email: host.email, password: host.password },
  });
  const cancellation = await api('/functions/v1/calendar-sync', 200, { ...syncPool, jwt: session.access_token });
  assert.equal(cancellation.synced, 1);
  const [cancelled] = await api('/rest/v1/reservations?space_id=eq.' + pool + '&source=eq.ical', 200, { jwt: session.access_token });
  assert.equal(cancelled.status, 'cancelled');
  console.log('PASS desktop and mobile Console, related and independent spaces, cleanup boundary, warning actions, email replay and booking edits');
  console.log('PASS host account isolation, service-only health report, and disabled real provider operations');
}

async function verifyRollback(browser, stage, data) {
  await stage.restoreBaseline();
  const check = await stage.sql("select (to_regprocedure('public.host_operational_warnings()') is null)::text;");
  assert.equal(check, 'true');
  const page = await localPage(browser, stage, { width: 1280, height: 900 });
  await page.goto(stage.base + '/host/');
  await signIn(page, data.host);
  await navigate(page, 'calendar');
  await page.getByText(/BASELINE-BOOKING/).waitFor();
  assert.equal(await page.getByText(/STAGING-POOL-1/).count(), 0);
  await stage.api('/rest/v1/rpc/host_operational_warnings', 404, { jwt: data.host.jwt });
  await navigate(page, 'requests');
  await placeRequest(page, 'Independent Driveway', { start: NIGHT + 'T15:00', end: NIGHT + 'T17:00' });
  assert.equal(await stage.sql("select count(*) from public.reservations where source = 'ical';"), '0');
  await page.close();
  console.log('PASS restored pre-upgrade database and original app and Edge handlers, including real sign-in and hold');
}

let stage, browser;
try {
  stage = await createStaging();
  const data = await seed(stage);
  await stage.snapshot();
  await stage.deployCandidate();
  const chromiumPath = existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE ?? chromiumPath, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  await checkCalendars(stage, data);
  await checkHostConsole(browser, stage, data);
  await verifyRollback(browser, stage, data);
} finally {
  await browser?.close();
  await stage?.stop();
}

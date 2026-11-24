import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adapterFor, canVerifyClosed, capabilityOf, createRegistry, labelOf, limitsOf, listAdapters, levelRank, registerAdapter, unregisterAdapter,
  ProviderError, validateAdapter, type ProviderAdapter,
} from '../supabase/functions/_shared/providers/index.ts';
import { CALENDAR_LINK_LIMIT, genericIcalAdapter, icalAdapters, makeIcalAdapter } from '../supabase/functions/_shared/providers/ical.ts';
import { manualAdapter, parseCsv, parseReservationsCsv, MAX_ROWS } from '../supabase/functions/_shared/providers/manual.ts';

const LA = 'America/Los_Angeles';
const NO = { calendar: 'L0', booking: 'L0', listing: 'L0', pricing: 'L0', messaging: 'L0' } as const;
const fakeAdapter = (key: string, extra: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
  key, label: `Fake ${key}`, capabilities: { ...NO, calendar: 'L1' }, limits: ['Fake limit.'],
  importAvailability: async () => ({ events: [] }), ...extra,
});

// ------------------------------------------------------------------ registry

test('registry: a provider is added with one register call and found by channel', () => {
  const r = createRegistry();
  r.registerAdapter(fakeAdapter('fakebnb'));
  assert.equal(r.adapterFor('fakebnb', 'importAvailability')?.key, 'fakebnb');
  assert.equal(r.labelOf('fakebnb'), 'Fake fakebnb');
  assert.deepEqual(r.listAdapters().map((a) => a.key), ['fakebnb']);
  assert.equal(r.capabilityOf('fakebnb').calendar, 'L1');
});

test('registry: registering the same key replaces the adapter', () => {
  const r = createRegistry();
  r.registerAdapter(fakeAdapter('fakebnb'));
  r.registerAdapter({ ...fakeAdapter('fakebnb'), label: 'Replacement' });
  assert.equal(r.listAdapters().length, 1);
  assert.equal(r.labelOf('fakebnb'), 'Replacement');
});

test('registry: removing a provider leaves the others and the fallbacks working', () => {
  const r = createRegistry();
  r.registerAdapter(genericIcalAdapter); r.registerAdapter(manualAdapter);
  r.registerAdapter(fakeAdapter('fakebnb')); r.registerAdapter(fakeAdapter('other_site'));
  assert.equal(r.unregisterAdapter('fakebnb'), true);
  assert.equal(r.unregisterAdapter('fakebnb'), false);
  assert.equal(r.adapterFor('other_site', 'importAvailability')?.key, 'other_site');
  assert.equal(r.adapterFor('fakebnb', 'importAvailability')?.key, '*'); // now handled by the generic adapter
  assert.equal(r.labelOf('fakebnb'), 'fakebnb');
  assert.equal(createRegistry().adapterFor('anything', 'importAvailability'), undefined); // an empty registry just answers undefined
});

test('registry: unknown channels fall back to the generic iCal adapter, then to manual import', () => {
  const r = createRegistry();
  r.registerAdapter(genericIcalAdapter); r.registerAdapter(manualAdapter);
  assert.equal(r.adapterFor('brand_new_site', 'importAvailability')?.key, '*');
  assert.equal(r.adapterFor('brand_new_site', 'exportAvailability')?.key, '*');
  assert.equal(r.adapterFor('brand_new_site', 'parseBookingFile')?.key, 'manual');
  assert.equal(r.adapterFor('brand_new_site', 'verifyClosed'), undefined);
});

test('registry: a known channel that lacks a method uses the fallback for it, but never gets verifyClosed that way', () => {
  const r = createRegistry();
  r.registerAdapter(genericIcalAdapter); r.registerAdapter(manualAdapter);
  r.registerAdapter(fakeAdapter('fakebnb'));
  assert.equal(r.adapterFor('fakebnb', 'parseBookingFile')?.key, 'manual');
  assert.equal(r.adapterFor('fakebnb', 'verifyClosed'), undefined);
  assert.equal(r.canVerifyClosed('fakebnb'), false);
});

test('registry: refuses adapters that claim what they cannot do', () => {
  assert.throws(() => validateAdapter(fakeAdapter('x', { importAvailability: undefined })), /calendar L1 but implements neither/);
  assert.throws(() => validateAdapter(fakeAdapter('x', { capabilities: { ...NO, booking: 'L2' } })), /no parseBookingFile/);
  assert.throws(() => validateAdapter(fakeAdapter('Bad Key')), /Invalid adapter key/);
  assert.throws(() => validateAdapter(fakeAdapter('x', { capabilities: { ...NO, calendar: 'L9' as never } })), /must be one of/);
  assert.throws(() => validateAdapter(fakeAdapter('x', { verifyClosed: 'yes' as never })), /must be a function or absent/);
  assert.throws(() => validateAdapter(fakeAdapter('x', { limits: undefined as never })), /limits/);
});

test('shared registry: the built-in providers are registered and a fake can be added and removed without side effects', () => {
  const before = listAdapters().map((a) => a.key);
  assert.ok(['*', 'manual', 'airbnb', 'vrbo', 'booking_com'].every((k) => before.includes(k)));
  registerAdapter(fakeAdapter('fakebnb'));
  assert.equal(adapterFor('fakebnb', 'importAvailability')?.key, 'fakebnb');
  assert.equal(unregisterAdapter('fakebnb'), true);
  assert.deepEqual(listAdapters().map((a) => a.key), before);
});

test('site facts live in adapters: names, and which calendars can prove dates are closed', () => {
  assert.equal(labelOf('airbnb'), 'Airbnb'); assert.equal(labelOf('booking_com'), 'Booking.com'); assert.equal(labelOf('other'), 'the other site');
  assert.equal(labelOf('never_heard_of_it'), 'never_heard_of_it');
  assert.equal(canVerifyClosed('airbnb'), true); assert.equal(canVerifyClosed('vrbo'), true);
  assert.equal(canVerifyClosed('booking_com'), false); assert.equal(canVerifyClosed('hipcamp'), false); assert.equal(canVerifyClosed('unknown'), false);
  assert.ok(limitsOf('booking_com').some((l) => /cannot tell a booking from a block/.test(l)));
  assert.ok(limitsOf('booking_com').includes(CALENDAR_LINK_LIMIT));
});

// ------------------------------------------------------------------ capability honesty

test('honesty: no adapter claims above L1 for calendar, and nothing claims pricing, messaging or listing', () => {
  for (const a of listAdapters()) {
    assert.ok(levelRank(a.capabilities.calendar) <= levelRank('L1'), `${a.key} calendar`);
    for (const k of ['pricing', 'messaging', 'listing'] as const) assert.equal(a.capabilities[k], 'L0', `${a.key} ${k}`);
    assert.ok(a.label && Array.isArray(a.limits));
  }
  for (const key of ['airbnb', 'vrbo', 'booking_com', 'swimply', 'brand_new_site']) {
    const c = capabilityOf(key);
    assert.ok(levelRank(c.calendar) <= 1 && c.pricing === 'L0' && c.messaging === 'L0' && c.listing === 'L0', key);
  }
});

test('honesty: every claim has the operation behind it, and unsupported operations are absent, not stubs', () => {
  for (const a of listAdapters()) {
    if (a.capabilities.calendar !== 'L0') assert.ok(a.importAvailability || a.exportAvailability, a.key);
    if (a.capabilities.booking !== 'L0') assert.ok(a.parseBookingFile, a.key);
    if (a.capabilities.calendar === 'L0') assert.equal(a.importAvailability, undefined, `${a.key} has a calendar method but claims L0`);
  }
  assert.equal(manualAdapter.importAvailability, undefined);
  assert.equal(manualAdapter.exportAvailability, undefined);
  assert.equal(manualAdapter.verifyClosed, undefined);
  assert.equal(genericIcalAdapter.parseBookingFile, undefined);
  assert.equal(genericIcalAdapter.verifyClosed, undefined, 'a site we know nothing about can never prove dates closed');
  assert.deepEqual(manualAdapter.capabilities, { ...NO, booking: 'L2' });
  assert.deepEqual(genericIcalAdapter.capabilities, { ...NO, calendar: 'L1' });
});

test('honesty: only sites whose export separates bookings from blocks can verify, and only the manual adapter claims booking L2', () => {
  assert.deepEqual(listAdapters().filter((a) => a.verifyClosed).map((a) => a.key), ['airbnb', 'vrbo']);
  assert.deepEqual(listAdapters().filter((a) => a.capabilities.booking !== 'L0').map((a) => a.key), ['manual']);
  assert.equal(capabilityOf('airbnb').booking, 'L2'); // file import works for any channel
  assert.ok(manualAdapter.limits.some((l) => /not stored/.test(l)));
  assert.ok(genericIcalAdapter.limits.includes(CALENDAR_LINK_LIMIT));
  assert.equal(icalAdapters().filter((a) => a.key === 'everyspace')[0].importAvailability, undefined);
});

// ------------------------------------------------------------------ iCal adapter (wraps the existing parser, diff and fetcher)

const ICS = (...ev: string[]) => `BEGIN:VCALENDAR\n${ev.join('\n')}\nEND:VCALENDAR`;
const stay = (uid: string, s: string, e: string, summary: string) => `BEGIN:VEVENT\nUID:${uid}\nDTSTART;VALUE=DATE:${s}\nDTEND;VALUE=DATE:${e}\nSUMMARY:${summary}\nEND:VEVENT`;
const io = (body: string) => ({ fetch: (async () => new Response(body)) as unknown as typeof fetch, resolve: async () => ['93.184.216.34'] });

test('ical adapter: reads events through the shared fetcher and parser, and reports a non-calendar as parse_error', async () => {
  const a = adapterFor('airbnb', 'importAvailability')!;
  const { events } = await a.importAvailability({ url: 'https://cal.example.com/x.ics', timeZone: LA, io: io(ICS(stay('r1', '20261201', '20261204', 'Reserved'))) });
  assert.deepEqual(events.map((e) => [e.uid, e.kind]), [['r1', 'booking']]);
  await assert.rejects(a.importAvailability({ url: 'https://cal.example.com/x.ics', timeZone: LA, io: io('<html>nope</html>') }), (e: ProviderError) => e.code === 'parse_error');
  await assert.rejects(a.importAvailability({ url: 'https://localhost/x.ics', timeZone: LA, io: io('') }), (e: ProviderError) => e.code === 'blocked_url');
});

test('ical adapter: export leaves out the reading site and carries no guest details', () => {
  const a = adapterFor('airbnb', 'exportAvailability')!;
  const out = a.exportAvailability({ forChannel: 'airbnb', timeZone: LA, name: 'Cabin · Everyspace', now: '2026-11-24T00:00:00Z', rows: [
    { id: 'own', channel: 'airbnb', status: 'confirmed', starts_at: '2026-12-01T08:00:00Z', ends_at: '2026-12-03T08:00:00Z', all_day: true },
    { id: 'vrbo1', channel: 'vrbo', status: 'confirmed', starts_at: '2026-12-10T08:00:00Z', ends_at: '2026-12-12T08:00:00Z', all_day: true },
  ] });
  assert.match(out.contentType, /text\/calendar/);
  assert.match(out.body, /DTSTART;VALUE=DATE:20261210/);
  assert.doesNotMatch(out.body, /20261201/);
});

test('ical adapter: verifyClosed (Airbnb) distinguishes closed, open and taken dates', async () => {
  const hold = { starts_at: '2026-12-01T08:00:00.000Z', ends_at: '2026-12-04T08:00:00.000Z' };
  const v = (body: string) => adapterFor('airbnb', 'verifyClosed')!.verifyClosed({ url: 'https://cal.example.com/x.ics', hold, timeZone: LA, io: io(body) });
  assert.deepEqual(await v(ICS(stay('b', '20261201', '20261204', 'Airbnb (Not available)'))), { ok: true });
  assert.equal((await v(ICS())).ok, false);
  assert.deepEqual(await v(ICS(stay('g', '20261202', '20261203', 'Reserved'))), { ok: false, reason: 'taken', uid: 'g' });
});

test('ical adapter: methods exist only where the facts allow (makeIcalAdapter is data-driven)', () => {
  const none = makeIcalAdapter({ key: 'a_site', label: 'A site' });
  assert.deepEqual([none.importAvailability, none.verifyClosed], [undefined, undefined]);
  const plain = makeIcalAdapter({ key: 'a_site', label: 'A site', calendar: true });
  assert.ok(plain.importAvailability && plain.exportAvailability && !plain.verifyClosed);
  assert.ok(makeIcalAdapter({ key: 'a_site', label: 'A site', calendar: true, verifiable: true }).verifyClosed);
});

// ------------------------------------------------------------------ manual CSV adapter

const parse = (csv: string, tz = LA) => parseReservationsCsv(csv, { timeZone: tz });
const fails = (csv: string, code = 'parse_error') => { try { parse(csv); } catch (e) { assert.ok(e instanceof ProviderError); assert.equal((e as ProviderError).code, code, (e as Error).message); return e as ProviderError; } assert.fail('should have thrown'); };

test('csv: happy path with every optional column', () => {
  const rows = parse('start,end,uid,status,kind,guests,payout\n2026-12-01,2026-12-04,ABC123,confirmed,booking,2,$1234.50\n2026-12-10,2026-12-12,,Cancelled,block,,\n');
  assert.deepEqual(rows[0], { external_uid: 'ABC123', starts_at: '2026-12-01T08:00:00.000Z', ends_at: '2026-12-04T08:00:00.000Z', all_day: true, status: 'confirmed', kind: 'booking', guest_count: 2, payout_cents: 123450 });
  assert.equal(rows[1].status, 'cancelled'); assert.equal(rows[1].kind, 'block');
  assert.ok(rows[1].external_uid.startsWith('csv-'));
  assert.ok(!('guest_count' in rows[1]) && !('payout_cents' in rows[1]));
});

test('csv: headers match tolerantly (case, spaces, punctuation, aliases)', () => {
  const rows = parse('Check-In Date , CHECK OUT,Confirmation Code,Number of Guests,Host Payout\n2026-12-01,2026-12-03,HM9,3,"$1,000.00"\n');
  assert.equal(rows[0].external_uid, 'HM9'); assert.equal(rows[0].guest_count, 3); assert.equal(rows[0].payout_cents, 100000);
  assert.equal(parse('arrival,departure\n2026-12-01,2026-12-02').length, 1);
  assert.equal(parse('start,end,payout cents\n2026-12-01,2026-12-02,5000')[0].payout_cents, 5000);
});

test('csv: RFC 4180 quoting, escaped quotes, line breaks inside quotes, CRLF and a BOM', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""q"" e","line1\nline2"\r\nx,y,z,w\r\n'), [['a', 'b,c', 'd "q" e', 'line1\nline2'], ['x', 'y', 'z', 'w']]);
  assert.deepEqual(parseCsv('a,,\n,,'), [['a', '', ''], ['', '', '']]);
  const rows = parse('﻿start,end,uid\r\n2026-12-01,2026-12-02,"UID,with,commas"\r\n');
  assert.equal(rows[0].external_uid, 'UID,with,commas');
  fails('start,end\n"2026-12-01,2026-12-02\n');
});

test('csv: date-times honour an offset, otherwise use the property time zone', () => {
  const r = parse('start,end\n2026-12-01T15:00:00Z,2026-12-01T18:00:00Z\n2026-12-02T10:00,2026-12-02T12:30\n2026-12-03T10:00:00-05:00,2026-12-03T11:00:00-05:00');
  assert.deepEqual(r.map((x) => [x.starts_at, x.all_day]), [['2026-12-01T15:00:00.000Z', false], ['2026-12-02T18:00:00.000Z', false], ['2026-12-03T15:00:00.000Z', false]]);
});

test('csv: missing required columns reject the file', () => {
  assert.match(fails('start,uid\n2026-12-01,a').message, /"end"/);
  assert.match(fails('foo,bar\n1,2').message, /"start" and "end"/);
  assert.match(fails('start,check-in,end\n2026-12-01,2026-12-01,2026-12-02').message, /more than one column/);
});

test('csv: any malformed row rejects everything, with row numbers (header is row 1)', () => {
  const e = fails('start,end,status,guests,payout\n2026-12-01,2026-12-03,confirmed,2,10\n2026-02-30,2026-03-02,confirmed,,\n2026-12-05,2026-12-04,confirmed,,\n2026-12-06,2026-12-08,maybe,,\n2026-12-09,2026-12-10,,two,\n2026-12-11,2026-12-12,,,abc\n2026-12-13,2026-12-14\n');
  assert.equal(e.details.length, 6);
  assert.match(e.details[0], /^Row 3: start is not a real date/);
  assert.match(e.details[1], /^Row 4: end must be after start/);
  assert.match(e.details[2], /^Row 5: status "maybe"/);
  assert.match(e.details[3], /^Row 6: guests must be a whole number/);
  assert.match(e.details[4], /^Row 7: payout is not an amount/);
  assert.match(e.details[5], /^Row 8: has 2 cells but the header has 5/);
  assert.match(e.message, /Nothing was imported/);
  assert.match(fails('start,end\n2026-12-01,2026-12-02T10:00').details[0], /both be dates or both be date-times/);
  assert.match(fails('start,end,payout,payout cents\n2026-12-01,2026-12-02,1,100').details[0], /not both/);
});

test('csv: empty files and header-only files are empty_feed', () => {
  fails('', 'empty_feed'); fails('\n\n', 'empty_feed'); fails('start,end\n', 'empty_feed');
});

test('csv: re-importing the same file gives the same ids; editing status or guests keeps them', () => {
  const a = parse('start,end,status\n2026-12-01,2026-12-04,confirmed\n2026-12-10,2026-12-12,confirmed');
  const b = parse('start,end,status,guests\n2026-12-01,2026-12-04,cancelled,4\n2026-12-10,2026-12-12,confirmed,2');
  assert.deepEqual(a.map((r) => r.external_uid), b.map((r) => r.external_uid));
  assert.notEqual(a[0].external_uid, a[1].external_uid);
  assert.match(a[0].external_uid, /^csv-[0-9a-f]{28}$/);
  assert.notEqual(parse('start,end\n2026-12-01,2026-12-04')[0].external_uid, parse('start,end\n2026-12-01,2026-12-05')[0].external_uid);
});

test('csv: identical rows get distinct generated ids, and a repeated supplied uid is an error', () => {
  const r = parse('start,end\n2026-12-01,2026-12-02\n2026-12-01,2026-12-02');
  assert.notEqual(r[0].external_uid, r[1].external_uid);
  assert.match(fails('start,end,uid\n2026-12-01,2026-12-02,X\n2026-12-05,2026-12-06,X').details[0], /^Row 3: uid "X" already appears on row 2/);
});

test('csv: caps on rows and size', () => {
  const header = 'start,end,uid\n';
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => `2026-12-01,2026-12-02,u${i}`).join('\n');
  assert.equal(parse(header + rowsOf(MAX_ROWS)).length, MAX_ROWS);
  fails(header + rowsOf(MAX_ROWS + 1), 'too_large');
  fails(`${header}2026-12-01,2026-12-02,${'x'.repeat(1_048_576)}`, 'too_large');
});

test('csv: columns we do not recognise are dropped, never stored', () => {
  const csv = 'Guest Name,Guest Email,Phone,start,end,Notes,uid\nJane Roe,jane@example.com,+1 555 0100,2026-12-01,2026-12-03,wants late checkout,R1\n';
  const rows = parse(csv);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['all_day', 'ends_at', 'external_uid', 'starts_at']);
  const dump = JSON.stringify(rows);
  for (const secret of ['Jane', 'jane@example.com', '555', 'late checkout']) assert.ok(!dump.includes(secret), secret);
});

test('manual adapter: parseBookingFile wraps the parser and uses the property time zone', () => {
  const { rows } = adapterFor('airbnb', 'parseBookingFile')!.parseBookingFile({ text: 'start,end\n2026-07-04,2026-07-06' }, { timeZone: LA });
  assert.equal(rows[0].starts_at, '2026-07-04T07:00:00.000Z');
  assert.equal(adapterFor('airbnb', 'parseBookingFile')!.key, 'manual');
});

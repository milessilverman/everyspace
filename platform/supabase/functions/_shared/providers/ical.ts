// The iCal calendar-link adapter (capability: calendar L1, everything else L0). It wraps the existing parser, diff and
// fetcher (_shared/ical.ts, sync.ts, fetch.ts, door.ts); nothing is duplicated here.
//
// The facts about individual sites that used to be hard-coded in guard.ts and booking-guard live in ICAL_SITES below.
import { buildIcs, parseIcs } from '../ical.ts';
import { feedEvents } from '../sync.ts';
import { fetchCalendar } from '../fetch.ts';
import { checkDoor } from '../door.ts';
import { NO_CAPABILITIES, ProviderError, type ProviderAdapter } from './adapter.ts';

export const CALENDAR_LINK_LIMIT = 'Calendar links carry availability only: no prices, guest details or messages, and other sites re-read them on their own schedule, not in real time.';

export type SiteFacts = {
  key: string;
  label: string;
  /** Does Everyspace read/write a calendar link for this site as a dedicated, known connection? */
  calendar?: boolean;
  /** Can the site's export tell a guest's booking apart from dates the host closed? Only then can it prove dates are closed. */
  verifiable?: boolean;
  limits?: string[];
};

export const ICAL_SITES: SiteFacts[] = [
  { key: 'airbnb', label: 'Airbnb', calendar: true, verifiable: true,
    limits: ['Airbnb marks guest stays "Reserved" and dates you closed "Airbnb (Not available)", so Everyspace can tell them apart. It reads other calendars only every few hours.'] },
  { key: 'vrbo', label: 'Vrbo', calendar: true, verifiable: true,
    limits: ['Vrbo marks guest stays "Reserved" and dates you closed "Blocked", so Everyspace can tell them apart.'] },
  { key: 'booking_com', label: 'Booking.com', calendar: true, verifiable: false,
    limits: ['Booking.com\'s calendar export marks both guest bookings and closed dates as "CLOSED - Not available", so Everyspace cannot tell a booking from a block and cannot use it to prove dates are closed. Switch it to request-to-book before relying on it.'] },
  // Sites with a display name only: no dedicated facts, so they use the generic calendar-link adapter.
  { key: 'everyspace', label: 'Everyspace', limits: ['Everyspace bookings are stored here; there is no link to sync.'] },
  { key: 'expedia', label: 'Expedia' }, { key: 'furnished_finder', label: 'Furnished Finder' }, { key: 'swimply', label: 'Swimply' },
  { key: 'peerspace', label: 'Peerspace' }, { key: 'neighbor', label: 'Neighbor' }, { key: 'spothero', label: 'SpotHero' },
  { key: 'sniffspot', label: 'Sniffspot' }, { key: 'hipcamp', label: 'Hipcamp' }, { key: 'getmyboat', label: 'GetMyBoat' },
  { key: 'outdoorsy', label: 'Outdoorsy' }, { key: 'rvshare', label: 'RVshare' }, { key: 'craigslist', label: 'Craigslist' },
  { key: 'facebook', label: 'Facebook' }, { key: 'direct', label: 'Direct' }, { key: 'other', label: 'the other site' },
];

const importAvailability: NonNullable<ProviderAdapter['importAvailability']> = async ({ url, timeZone, io }) => {
  const text = await fetchCalendar(url, io);
  try { return { events: parseIcs(text, { defaultTimeZone: timeZone }) }; } catch (e) {
    throw new ProviderError('parse_error', e instanceof Error ? e.message : "That doesn't look like a calendar file (.ics).");
  }
};

const exportAvailability: NonNullable<ProviderAdapter['exportAvailability']> = ({ rows, forChannel, spaceId, timeZone, name, now }) => ({
  body: buildIcs({ name, events: feedEvents({ rows, forChannel, spaceId, timeZone, now }), now }),
  contentType: 'text/calendar; charset=utf-8',
});

const verifyClosed: NonNullable<ProviderAdapter['verifyClosed']> = async ({ url, hold, timeZone, io }) => {
  const { events } = await importAvailability({ url, timeZone, io });
  return checkDoor({ hold, doorEvents: events, timeZone });
};

/** The adapter for one site's calendar link. Methods exist only where the facts allow them. */
export function makeIcalAdapter(site: SiteFacts): ProviderAdapter {
  const a: ProviderAdapter = {
    key: site.key,
    label: site.label,
    capabilities: { ...NO_CAPABILITIES, calendar: site.calendar ? 'L1' : 'L0' },
    limits: [...(site.calendar ? [CALENDAR_LINK_LIMIT] : []), ...(site.limits ?? [])],
  };
  if (site.calendar) { a.importAvailability = importAvailability; a.exportAvailability = exportAvailability; }
  if (site.calendar && site.verifiable) a.verifyClosed = verifyClosed;
  return a;
}

/** Any site that gives the host a calendar link. It cannot tell bookings from blocks, so it can never verify closed dates. */
export const genericIcalAdapter: ProviderAdapter = {
  key: '*',
  label: 'Calendar link (iCal)',
  capabilities: { ...NO_CAPABILITIES, calendar: 'L1' },
  limits: [
    CALENDAR_LINK_LIMIT,
    'For sites not listed here, Everyspace cannot tell a guest booking from dates you closed, so it cannot use their calendar to prove dates are closed.',
  ],
  importAvailability,
  exportAvailability,
};

export const icalAdapters = (): ProviderAdapter[] => [genericIcalAdapter, ...ICAL_SITES.map(makeIcalAdapter)];

// Calendar directions are from the provider's perspective. Provider documentation and
// Everyspace deployment status are separate, so partner products never imply authorization.
export const CATEGORY_NAMES = {
  lodging: 'Lodging',
  parking_storage: 'Parking and storage',
  hourly_events: 'Hourly spaces and events',
  outdoor: 'Outdoor recreation',
  vehicles: 'Vehicles and boats',
  ev_charging: 'EV charging',
  long_term: 'Long-term rentals',
};

export const CAPABILITY_LABELS = {
  implemented: 'Implemented',
  verified: 'Provider verified',
  planned: 'Planned',
  unsupported: 'Unsupported',
  unverified: 'Unverified',
};

const capability = (status, source = '', detail = '') => ({ status, source, detail });
const verified = (source, detail) => capability('verified', source, detail);
const unverified = capability('unverified');
const listing = (name, category, { priority = false, calendarImport = unverified,
  calendarExport = unverified, bookingEmail = unverified, api = unverified, other = [] } = {}) => ({
  name, category, priority, calendarImport, calendarExport, bookingEmail, api,
  apiAccess: 'disabled',
  manual: capability('implemented'),
  forwardedEmail: capability('implemented', '', 'Host-supplied messages go to review.'),
  forwardingAddress: capability('planned'),
  other,
});

const airbnbCalendar = 'https://www.airbnb.com/help/article/99';
const vrboCalendar = 'https://help.vrbo.com/articles/How-do-I-import-my-iCal-or-Google-calendar';
const bookingCalendar = 'https://www.youtube.com/watch?v=Smj-WfWpi4o';
const swimplyCalendar = 'https://swimply.zendesk.com/hc/en-us/articles/30133735282451-Syncing-Calendar';
const peerspaceCalendar = 'https://support.peerspace.com/en/articles/10119394-how-to-sync-with-airbnb-vrbo-and-other-calendars-that-provide-an-icalendar-or-ics-url-link';
const hipcampCalendar = 'https://support.hipcamp.com/hc/en-us/articles/360038626712-Can-I-sync-my-Hipcamp-calendar-with-multiple-other-calendars-Desktop';
const outdoorsyCalendar = 'https://support.outdoorsy.com/hc/en-us/articles/37985661024027-What-is-calendar-sync-How-does-it-work';
const furnishedCalendar = 'https://support.furnishedfinder.com/hc/en-us/articles/35107733754779-How-Do-I-Link-Another-Calendar';
const sniffspotNotifications = 'https://help.sniffspot.com/article/375-reservation-notifications-for-hosts';

export const INTEGRATIONS = {
  airbnb: listing('Airbnb', 'lodging', {
    priority: true, calendarImport: capability('implemented', airbnbCalendar), calendarExport: capability('implemented', airbnbCalendar),
    bookingEmail: verified('https://www.airbnb.com/help/article/2390', 'Hosts receive email when a home reservation is confirmed.'),
    api: verified('https://www.airbnb.com/help/article/3418', 'Homes connectivity requires approved partner scopes.'),
  }),
  vrbo: listing('Vrbo', 'lodging', {
    priority: true, calendarImport: capability('implemented', vrboCalendar), calendarExport: capability('implemented', vrboCalendar),
    api: verified('https://integration-central.vrbo.com/t', 'Supply connectivity requires Vrbo onboarding.'),
  }),
  booking_com: listing('Booking.com', 'lodging', {
    priority: true, calendarImport: verified(bookingCalendar, 'Available for eligible listings.'), calendarExport: verified(bookingCalendar, 'Available for eligible listings.'),
    api: verified('https://connect.booking.com/', 'The portal reports a pause on onboarding new connectivity providers.'),
  }),
  expedia: listing('Expedia', 'lodging', {
    api: verified('https://developers.expediagroup.com/supply/lodging', 'Lodging connectivity is scoped to approved partners.'),
  }),
  neighbor: listing('Neighbor', 'parking_storage', { priority: true }),
  spothero: listing('SpotHero', 'parking_storage', {
    priority: true, other: [{ name: 'Operator integration program', ...verified('https://spothero.com/sell-parking/operators', 'Operator-side integrations exist. Booking management access for Everyspace is unverified.') }],
  }),
  swimply: listing('Swimply', 'hourly_events', {
    priority: true, calendarImport: verified(swimplyCalendar), calendarExport: verified(swimplyCalendar),
    bookingEmail: verified('https://swimply.zendesk.com/hc/en-us/articles/31126279131923-Understanding-Pending-Charges-and-Booking-Requests', 'Confirmation notifications exist. Provider-specific templates need validation.'),
  }),
  peerspace: listing('Peerspace', 'hourly_events', {
    priority: true, calendarImport: verified(peerspaceCalendar),
    bookingEmail: verified('https://support.peerspace.com/en/articles/10119524-what-happens-when-i-receive-a-booking-request', 'Host booking request notifications are documented.'),
  }),
  giggster: listing('Giggster', 'hourly_events', {
    calendarImport: verified('https://help.giggster.com/en/articles/5410105-calendar-sync'),
  }),
  kitchen_door: listing('The Kitchen Door', 'hourly_events'),
  liquidspace: listing('LiquidSpace', 'hourly_events'),
  sniffspot: listing('Sniffspot', 'outdoor', {
    priority: true,
    other: [{ name: 'Add reservations to Google Calendar', ...verified(sniffspotNotifications, 'A provider-side Google Calendar option. Direct iCal support is unverified.') }],
  }),
  hipcamp: listing('Hipcamp', 'outdoor', {
    calendarImport: verified(hipcampCalendar), calendarExport: verified(hipcampCalendar),
  }),
  getmyboat: listing('GetMyBoat', 'vehicles'),
  outdoorsy: listing('Outdoorsy', 'vehicles', {
    calendarImport: verified(outdoorsyCalendar), calendarExport: verified(outdoorsyCalendar),
  }),
  rvshare: listing('RVshare', 'vehicles'),
  evmatch: listing('EVmatch', 'ev_charging'),
  furnished_finder: listing('Furnished Finder', 'long_term', {
    calendarImport: capability('unsupported', furnishedCalendar, 'Furnished Finder supports account links for Airbnb and Vrbo instead of generic iCal URLs.'),
    other: [{ name: 'Airbnb and Vrbo account links', ...verified(furnishedCalendar) }],
  }),
  spareroom: listing('SpareRoom', 'long_term'),
  zillow: listing('Zillow Rentals', 'long_term'),
  craigslist: listing('Craigslist', 'long_term'),
  facebook: listing('Facebook Marketplace', 'long_term'),
};

// Existing user-defined channels stay available outside the 22-platform catalog.
export const MANUAL_CHANNELS = { direct: 'Direct booking', other: 'Other site', everyspace: 'Everyspace' };
export const PLATFORM_NAMES = { ...Object.fromEntries(Object.entries(INTEGRATIONS).map(([id, entry]) => [id, entry.name])), ...MANUAL_CHANNELS };
export const CHANNEL_GROUPS = Object.entries(CATEGORY_NAMES).map(([category, title]) => [
  title, Object.keys(INTEGRATIONS).filter((id) => INTEGRATIONS[id].category === category),
]);

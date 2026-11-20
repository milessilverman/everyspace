// Scheduled and interactive calendar reads share an operator-controlled HTTPS allowlist.
// Extend it with exact feed hosts verified during provider setup.
const DEFAULT_HOSTS = [
  'www.airbnb.com', 'www.vrbo.com', 'www.homeaway.com', 'ical.booking.com',
  'www.booking.com', 'calendar.google.com', 'swimply.com', 'www.swimply.com',
  'www.peerspace.com', 'www.hipcamp.com', 'hipcamp.com', 'giggster.com', 'outdoorsy.com', 'www.outdoorsy.com',
];
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 3;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

export class CalendarFetchError extends Error {}

function allowedHosts(additional: string) {
  const hosts = additional.split(',').map((part) => part.trim().toLowerCase())
    .filter((host) => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host));
  return new Set([...DEFAULT_HOSTS, ...hosts]);
}

function approvedUrl(value: string, hosts: Set<string>): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CalendarFetchError('Enter a valid HTTPS calendar link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.has(url.hostname)) {
    throw new CalendarFetchError('This calendar host needs verification before Everyspace can fetch its link.');
  }
  return url;
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new CalendarFetchError('The provider returned an empty calendar response.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return result + decoder.decode();
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new CalendarFetchError('The provider calendar is over the 3 MB limit.');
    }
    result += decoder.decode(value, { stream: true });
  }
}

export function createCalendarFetcher(additionalHosts = '', fetcher: typeof fetch = fetch) {
  const hosts = allowedHosts(additionalHosts);
  return async (input: string): Promise<string> => {
    let url = approvedUrl(input, hosts);
    const signal = AbortSignal.timeout(12_000);
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetcher(url, {
          signal, redirect: 'manual', cache: 'no-store',
          headers: { 'user-agent': 'Everyspace-CalendarSync/1.0', accept: 'text/calendar, */*' },
        });
        if (REDIRECT.has(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || hop === MAX_REDIRECTS) throw new CalendarFetchError('The calendar redirect could not be verified.');
          url = approvedUrl(new URL(location, url).href, hosts);
          continue;
        }
        if (!response.ok || response.status !== 200) {
          await response.body?.cancel();
          throw new CalendarFetchError(response.status === 404
            ? 'The provider could not find this calendar. Copy a fresh link from the listing.'
            : 'The provider did not return a complete calendar.');
        }
        return await readLimited(response);
      }
    } catch (error) {
      if (error instanceof CalendarFetchError) throw error;
      throw new CalendarFetchError('The provider calendar could not be read. Everyspace kept the previous bookings.');
    }
    throw new CalendarFetchError('The calendar redirect could not be verified.');
  };
}

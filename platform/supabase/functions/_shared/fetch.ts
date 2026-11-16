// Reads a calendar link from another site with a timeout and a size cap.
const MAX_BYTES = 3_000_000;

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { reader.cancel(); throw new Error('That calendar is too large to read (over 3 MB).'); }
    chunks.push(value);
  }
  const all = new Uint8Array(size); let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

export async function fetchCalendar(url: string): Promise<string> {
  if (!/^https:\/\//i.test(url)) throw new Error('Calendar links must start with https://');
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000), redirect: 'follow', cache: 'no-store',
    headers: { 'user-agent': 'Everyspace-CalendarSync/1.0 (+https://everyspace.app)', accept: 'text/calendar, */*' },
  });
  if (!res.ok) throw new Error(res.status === 404 ? 'The site says this calendar link no longer exists. Copy a fresh link from the site.' : `The site answered with an error (${res.status}). We'll retry.`);
  return readLimited(res);
}

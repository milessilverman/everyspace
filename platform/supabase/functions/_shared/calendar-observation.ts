import type { CalendarEvent } from './ical.ts';

export class IncompleteCalendarObservation extends Error {}

type Page = { events: readonly CalendarEvent[]; nextPage: string | null };
type Limits = { pages: number; events: number };

function sameObservation(a: CalendarEvent, b: CalendarEvent): boolean {
  return a.start === b.start && a.end === b.end && a.allDay === b.allDay && a.kind === b.kind
    && a.cancelled === b.cancelled && a.sequence === b.sequence;
}

// Publish one complete observation. Notifications may wake a read, but never stand in for a complete page sequence.
export async function collectCalendarObservation(
  readPage: (cursor: string | null) => Promise<Page>,
  { pages, events }: Limits = { pages: 30, events: 3000 },
): Promise<CalendarEvent[]> {
  const found = new Map<string, CalendarEvent>();
  const visited = new Set<string>();
  let cursor: string | null = null;
  let total = 0;
  for (let page = 0; page < pages; page++) {
    let result: Page;
    try { result = await readPage(cursor); }
    catch (error) {
      if (cursor === null || error instanceof IncompleteCalendarObservation) throw error;
      throw new IncompleteCalendarObservation('The calendar download stopped before the final page.');
    }
    total += result.events.length;
    if (total > events) throw new IncompleteCalendarObservation('The calendar exceeds the supported event limit.');
    for (const entry of result.events) {
      const previous = found.get(entry.uid);
      if (previous && !sameObservation(previous, entry)) {
        throw new IncompleteCalendarObservation('A booking changed while the calendar was being read. Try again.');
      }
      found.set(entry.uid, entry);
    }
    cursor = result.nextPage;
    if (cursor === null) return [...found.values()];
    if (!cursor || visited.has(cursor)) break;
    visited.add(cursor);
  }
  throw new IncompleteCalendarObservation('The calendar could not be read to the end. Try again.');
}

// The one place that lists which providers exist. To add a provider: write providers/<name>.ts exporting a
// ProviderAdapter and add ONE `registerAdapter(...)` line below. To remove one: delete its line. Core sync code
// (sync.ts, calendar-sync, booking-guard, ...) only ever goes through the registry.
import { registerAdapter } from './registry.ts';
import { icalAdapters } from './ical.ts';
import { manualAdapter } from './manual.ts';

for (const a of icalAdapters()) registerAdapter(a);
registerAdapter(manualAdapter);

export * from './adapter.ts';
export * from './registry.ts';

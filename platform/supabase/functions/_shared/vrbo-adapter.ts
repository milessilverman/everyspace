import { unavailableAdapter, type Channel } from './channel-adapters.ts';

// Vrbo supply connectivity is onboarded through Integration Central.
export const vrboAdapter = unavailableAdapter<Channel>('vrbo');

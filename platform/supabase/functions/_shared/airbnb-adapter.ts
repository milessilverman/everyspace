import { unavailableAdapter, type Channel } from './channel-adapters.ts';

// Replace this transport after Airbnb grants the scopes and provides the partner contract.
export const airbnbAdapter = unavailableAdapter<Channel>('airbnb');

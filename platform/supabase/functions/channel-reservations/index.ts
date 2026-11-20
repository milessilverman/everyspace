import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { airbnbAdapter } from '../_shared/airbnb-adapter.ts';
import { vrboAdapter } from '../_shared/vrbo-adapter.ts';
import { COMPETITION_WINDOW_MS, drainReservations, reservationStore } from '../_shared/channel-reservation-engine.ts';
import { reservationHandler } from '../_shared/channel-reservation-http.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const adapters = { airbnb: airbnbAdapter, vrbo: vrboAdapter };
const store = reservationStore((name, args) => admin.rpc(name, args));
const process = () => drainReservations(store, adapters);

Deno.serve(reservationHandler({
  adapters,
  store,
  workerSecret: Deno.env.get('CHANNEL_RESERVATION_WORKER_SECRET'),
  process,
  wake: () => EdgeRuntime.waitUntil((async () => {
    await process();
    await new Promise((resolve) => setTimeout(resolve, COMPETITION_WINDOW_MS));
    await process();
  })().catch(() => console.error('Channel reservation work remains queued for recovery'))),
}));

-- New Supabase projects do not grant table privileges to API roles automatically.
-- Expose the existing host workflow through its row policies and keep system writes in
-- the established service clients and scoped database functions.
grant select, insert, update, delete on table
  public.profiles, public.properties, public.spaces, public.channel_connections, public.channel_listings
  to authenticated;

grant select on table
  public.app_settings, public.calendar_feeds, public.reservations, public.conflicts, public.earnings_ledger,
  public.booking_holds, public.booking_alerts
  to authenticated;
grant delete on table public.calendar_imports, public.calendar_feeds to authenticated;
-- The earlier calendar, provider and email migrations grant any additional column privileges.

-- These tables are queried by the booking, calendar and operational-readiness functions.
grant select on table
  public.properties, public.spaces, public.channel_listings, public.calendar_imports,
  public.calendar_feeds, public.reservations, public.booking_holds
  to service_role;
grant insert, update on table public.reservations to service_role;
grant update on table public.calendar_imports, public.calendar_feeds to service_role;

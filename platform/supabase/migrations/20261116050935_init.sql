-- Everyspace: core schema for managing every rental, on every site, from one place.
-- Launch market: Los Angeles. Business model: a share of the extra revenue Everyspace brings in (no monthly fee).
--
-- Security: row-level security is on for every table. Hosts can only see their own rows. Edge functions that run
-- on a schedule (calendar sync) use the service role and bypass RLS.

-- ---------------------------------------------------------------- settings
create table public.app_settings (
  id boolean primary key default true check (id), -- single row
  launch_market text not null default 'los_angeles',
  revenue_share_pct numeric(5, 2) not null default 10.00 check (revenue_share_pct between 0 and 50),
  updated_at timestamptz not null default now()
);
insert into public.app_settings default values;
comment on column public.app_settings.revenue_share_pct is
  'Share of attributed (extra) revenue Everyspace charges. Placeholder until the founder sets the final rate.';

-- ---------------------------------------------------------------- hosts
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  notify_by text not null default 'sms' check (notify_by in ('sms', 'email', 'both')),
  market text not null default 'los_angeles',
  created_at timestamptz not null default now()
);

-- Create a profile automatically when someone signs up.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name) values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- properties & spaces
create table public.properties (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (length(title) between 1 and 120),
  address text,
  city text,
  state text default 'CA',
  postal_code text,
  market text not null default 'los_angeles',
  timezone text not null default 'America/Los_Angeles',
  created_at timestamptz not null default now()
);
create index on public.properties (host_id);

-- A space is anything rentable at a property: the whole house, an ADU, the pool, a parking spot, a kayak.
create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  parent_space_id uuid references public.spaces (id) on delete set null, -- booking the parent also blocks this one
  category text not null, -- matches the app catalog: entire_home, adu, pool, parking_spot, kayak …
  title text not null check (length(title) between 1 and 120),
  quantity int not null default 1 check (quantity between 1 and 500),
  -- Revenue share applies to what Everyspace brought in: spaces it listed for the first time…
  added_by_everyspace boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.spaces (property_id);

-- ---------------------------------------------------------------- channels
-- Where hosts list. 'api' = official partner connection, 'ical' = calendar link, 'email' = parsed confirmation
-- emails, 'assisted' = listing written by Everyspace and posted by the host (or the browser extension).
create type public.channel as enum (
  'everyspace', 'airbnb', 'vrbo', 'booking_com', 'expedia', 'furnished_finder', 'swimply', 'peerspace', 'neighbor',
  'spothero', 'sniffspot', 'hipcamp', 'getmyboat', 'outdoorsy', 'rvshare', 'craigslist', 'facebook', 'direct', 'other'
);

create table public.channel_connections (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  channel public.channel not null,
  method text not null check (method in ('api', 'ical', 'email', 'assisted')),
  status text not null default 'pending' check (status in ('pending', 'active', 'error', 'disconnected')),
  external_account_ref text, -- the site's account/host id; never a password. API tokens go in Supabase Vault.
  created_at timestamptz not null default now(),
  unique (host_id, channel)
);

create table public.channel_listings (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  channel public.channel not null,
  external_id text,
  url text,
  status text not null default 'pending' check (status in ('pending', 'live', 'paused', 'removed')),
  -- …and sites it published the space to for the first time.
  listed_by_everyspace boolean not null default false,
  created_at timestamptz not null default now(),
  unique (space_id, channel)
);

-- ---------------------------------------------------------------- calendars
-- Calendar links we read from other sites (one per space per site). The URL contains a secret token.
create table public.calendar_imports (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  channel public.channel not null,
  url text not null check (url ~* '^https?://'),
  last_synced_at timestamptz,
  last_status text check (last_status in ('ok', 'error')),
  last_error text,
  event_count int,
  created_at timestamptz not null default now(),
  unique (space_id, channel)
);

-- Feeds we publish for other sites to read. One per space per site, so a site never imports its own bookings back.
create table public.calendar_feeds (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  for_channel public.channel not null,
  token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), -- 244 random bits
  last_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (space_id, for_channel)
);

-- Everything that occupies a space, from every source.
create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  channel public.channel not null,
  external_uid text not null,
  kind text not null default 'booking' check (kind in ('booking', 'block', 'owner_block')),
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  source text not null check (source in ('ical', 'email', 'api', 'manual', 'everyspace')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  guest_name text,
  summary text,
  payout_cents bigint check (payout_cents >= 0),
  currency text not null default 'USD',
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (space_id, channel, external_uid)
);
create index on public.reservations (space_id, starts_at);

-- Two live reservations for the same space whose dates overlap.
create table public.conflicts (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  a_reservation_id uuid not null references public.reservations (id) on delete cascade,
  b_reservation_id uuid not null references public.reservations (id) on delete cascade,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (a_reservation_id, b_reservation_id)
);

-- Records any new overlaps for a space (within its quantity) and resolves ones that no longer overlap.
create function public.detect_conflicts(p_space uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare
  qty int;
  added int;
begin
  select quantity into qty from public.spaces where id = p_space;
  if qty is null then return 0; end if;
  -- Clear overlaps that went away (cancelled or moved).
  update public.conflicts c set resolved_at = now()
  where c.space_id = p_space and c.resolved_at is null and not exists (
    select 1 from public.reservations a, public.reservations b
    where a.id = c.a_reservation_id and b.id = c.b_reservation_id and a.status = 'confirmed' and b.status = 'confirmed'
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at));
  if qty > 1 then return 0; end if; -- multi-unit spaces are checked against capacity in the app
  with pairs as (
    select a.id as a_id, b.id as b_id
    from public.reservations a join public.reservations b
      on a.space_id = b.space_id and a.id < b.id and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
    where a.space_id = p_space and a.status = 'confirmed' and b.status = 'confirmed'
      and not (a.kind <> 'booking' and b.kind <> 'booking') -- two blocks overlapping is fine
      and a.ends_at > now() - interval '1 day'
  ), ins as (
    insert into public.conflicts (space_id, a_reservation_id, b_reservation_id)
    select p_space, a_id, b_id from pairs
    on conflict (a_reservation_id, b_reservation_id) do update set resolved_at = null
    returning 1
  ) select count(*) into added from ins;
  return added;
end $$;

-- ---------------------------------------------------------------- revenue share
-- One row per completed booking. Only attributed revenue (a space or site Everyspace added) is charged.
create table public.earnings_ledger (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  reservation_id uuid not null unique references public.reservations (id) on delete cascade,
  period date not null, -- first day of the month the stay ends in
  gross_cents bigint not null check (gross_cents >= 0),
  attributed boolean not null,
  share_pct numeric(5, 2) not null,
  fee_cents bigint not null check (fee_cents >= 0),
  created_at timestamptz not null default now()
);
create index on public.earnings_ledger (host_id, period);

-- Is this reservation revenue Everyspace brought in? True when the space or the site listing was added by Everyspace,
-- or the booking came through the Everyspace marketplace.
create function public.is_attributed(p_reservation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select r.channel = 'everyspace'
      or s.added_by_everyspace
      or coalesce((select l.listed_by_everyspace from public.channel_listings l where l.space_id = r.space_id and l.channel = r.channel), false)
  from public.reservations r join public.spaces s on s.id = r.space_id
  where r.id = p_reservation
$$;

-- Adds finished, paid bookings to the ledger with the current share. Safe to run repeatedly.
create function public.accrue_earnings() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.earnings_ledger (host_id, reservation_id, period, gross_cents, attributed, share_pct, fee_cents)
  select p.host_id, r.id, date_trunc('month', r.ends_at)::date, r.payout_cents, public.is_attributed(r.id),
         st.revenue_share_pct,
         case when public.is_attributed(r.id) then round(r.payout_cents * st.revenue_share_pct / 100) else 0 end
  from public.reservations r
  join public.spaces s on s.id = r.space_id
  join public.properties p on p.id = s.property_id
  cross join public.app_settings st
  where r.kind = 'booking' and r.status = 'confirmed' and r.payout_cents is not null and r.ends_at <= now()
  on conflict (reservation_id) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- row-level security
alter table public.app_settings enable row level security;
alter table public.profiles enable row level security;
alter table public.properties enable row level security;
alter table public.spaces enable row level security;
alter table public.channel_connections enable row level security;
alter table public.channel_listings enable row level security;
alter table public.calendar_imports enable row level security;
alter table public.calendar_feeds enable row level security;
alter table public.reservations enable row level security;
alter table public.conflicts enable row level security;
alter table public.earnings_ledger enable row level security;

create function public.owns_space(p_space uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.spaces s join public.properties p on p.id = s.property_id where s.id = p_space and p.host_id = (select auth.uid()))
$$;

create policy "Anyone signed in can read settings" on public.app_settings for select to authenticated using (true);
create policy "Hosts manage their profile" on public.profiles for all to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "Hosts manage their properties" on public.properties for all to authenticated using (host_id = (select auth.uid())) with check (host_id = (select auth.uid()));
create policy "Hosts manage their spaces" on public.spaces for all to authenticated
  using (exists (select 1 from public.properties p where p.id = property_id and p.host_id = (select auth.uid())))
  with check (exists (select 1 from public.properties p where p.id = property_id and p.host_id = (select auth.uid())));
create policy "Hosts manage their connections" on public.channel_connections for all to authenticated using (host_id = (select auth.uid())) with check (host_id = (select auth.uid()));
create policy "Hosts manage their listings" on public.channel_listings for all to authenticated using (public.owns_space(space_id)) with check (public.owns_space(space_id));
create policy "Hosts manage their calendar imports" on public.calendar_imports for all to authenticated using (public.owns_space(space_id)) with check (public.owns_space(space_id));
create policy "Hosts manage their calendar feeds" on public.calendar_feeds for all to authenticated using (public.owns_space(space_id)) with check (public.owns_space(space_id));
create policy "Hosts manage their reservations" on public.reservations for all to authenticated using (public.owns_space(space_id)) with check (public.owns_space(space_id));
create policy "Hosts see their conflicts" on public.conflicts for select to authenticated using (public.owns_space(space_id));
create policy "Hosts see their earnings" on public.earnings_ledger for select to authenticated using (host_id = (select auth.uid()));
-- Revenue-share settings and the ledger are written only by the service role (no insert/update policies for users).

revoke execute on function public.accrue_earnings() from public, anon, authenticated;
revoke execute on function public.detect_conflicts(uuid) from public, anon, authenticated;

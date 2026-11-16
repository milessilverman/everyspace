-- No double bookings, ever.
--
-- Calendar links between sites lag by hours, so syncing alone cannot prevent double bookings. These rules can:
--   1. One open door. For any physical space (and everything it sits inside or contains), at most one live listing
--      may take Instant Book. Every other site is set to request-to-book.
--   2. Hold, close, verify, accept. A request on another site first places a hold here, under a lock, so no other
--      request or booking can take those dates. The dates are then closed on the instant site, Everyspace reads that
--      site's calendar live to prove it (booking-guard function), and only then marks the hold safe to accept.
--   3. Guard. Every sync re-checks that the instant site still shows every other booking as closed, links holds to
--      the bookings they became, and flags any request accepted without the check.
-- Everything that decides "is this time free?" takes the same per-property lock, so two requests can never both win.

-- ---------------------------------------------------------------- space families
-- A space's ancestors (what it sits inside) and descendants (what sits inside it), including itself.
create function public.space_ancestors(p_space uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  with recursive up(id, parent, depth) as (
    select id, parent_space_id, 0 from public.spaces where id = p_space
    union all
    select s.id, s.parent_space_id, up.depth + 1 from public.spaces s join up on s.id = up.parent where up.depth < 20
  ) select id from up
$$;

create function public.related_spaces(p_space uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  with recursive down(id, depth) as (
    select p_space, 0
    union all
    select s.id, down.depth + 1 from public.spaces s join down on s.parent_space_id = down.id where down.depth < 20
  )
  select * from public.space_ancestors(p_space) union select id from down
$$;

-- A space can only sit inside a space at the same property, and never inside itself.
create function public.check_space_parent() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.parent_space_id is null then return new; end if;
  if new.parent_space_id = new.id or new.id in (select public.space_ancestors(new.parent_space_id)) then
    raise exception 'A space cannot sit inside itself.';
  end if;
  if not exists (select 1 from public.spaces where id = new.parent_space_id and property_id = new.property_id) then
    raise exception 'A space can only sit inside another space at the same property.';
  end if;
  return new;
end $$;
create trigger spaces_parent_check before insert or update of parent_space_id, property_id on public.spaces
  for each row execute function public.check_space_parent();

create function public.lock_property(p_space uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare prop uuid;
begin
  select property_id into prop from public.spaces where id = p_space;
  if prop is not null then perform pg_advisory_xact_lock(hashtextextended(prop::text, 0)); end if;
end $$;

-- ---------------------------------------------------------------- rule 1: one open door
-- How each listing takes bookings on its site. This must match the site's real setting; Everyspace asks during setup.
alter table public.channel_listings
  add column booking_mode text not null default 'request' check (booking_mode in ('instant', 'request', 'closed')),
  add column mode_since timestamptz not null default now();
comment on column public.channel_listings.booking_mode is
  'instant = the site confirms bookings by itself (Instant Book). Only one live listing per space family may be instant.';

create function public.enforce_one_door() returns trigger
language plpgsql security definer set search_path = '' as $$
declare other record;
begin
  if tg_op = 'INSERT' or new.booking_mode is distinct from old.booking_mode then new.mode_since := now(); end if;
  if new.booking_mode <> 'instant' or new.status not in ('pending', 'live') then return new; end if;
  perform public.lock_property(new.space_id);
  select l.channel, s.title into other
  from public.channel_listings l join public.spaces s on s.id = l.space_id
  where l.id <> new.id and l.booking_mode = 'instant' and l.status in ('pending', 'live')
    and l.space_id in (select public.related_spaces(new.space_id))
  limit 1;
  if found then
    raise exception 'Only one site can take instant bookings for the same space. % already does for "%". Switch one of them to request-to-book.', other.channel, other.title
      using errcode = 'P0001', hint = 'ONE_DOOR';
  end if;
  return new;
end $$;
create trigger channel_listings_one_door before insert or update on public.channel_listings
  for each row execute function public.enforce_one_door();

-- The instant listings a request for this space has to be closed on.
create function public.door_listings(p_space uuid) returns table (space_id uuid, channel public.channel)
language sql stable security definer set search_path = '' as $$
  select l.space_id, l.channel from public.channel_listings l
  where l.booking_mode = 'instant' and l.status in ('pending', 'live') and l.space_id in (select public.related_spaces(p_space))
$$;

-- ---------------------------------------------------------------- rule 2: holds
create table public.booking_holds (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  channel public.channel not null, -- the site the request came from
  external_ref text, -- the request's id on that site, if known
  guest_name text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default true,
  -- holding: dates reserved here, waiting to be closed on the instant site. safe: verified, OK to accept.
  -- confirmed: the booking came through. released: declined, taken by another booking, or expired.
  status text not null default 'holding' check (status in ('holding', 'safe', 'confirmed', 'released')),
  expires_at timestamptz not null default now() + interval '24 hours',
  verified_at timestamptz,
  released_reason text,
  reservation_id uuid references public.reservations (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on public.booking_holds (space_id, starts_at);

-- How many bookings, closed dates and live holds overlap a stretch of time across a space family.
create function public.busy_count(p_space uuid, p_start timestamptz, p_end timestamptz, p_skip_hold uuid, p_bookings_only boolean)
returns int language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.reservations r
          where r.space_id in (select public.related_spaces(p_space)) and r.status = 'confirmed'
            and (not p_bookings_only or r.kind = 'booking')
            and tstzrange(r.starts_at, r.ends_at) && tstzrange(p_start, p_end))::int
       + (select count(*) from public.booking_holds h
          where h.space_id in (select public.related_spaces(p_space)) and h.status in ('holding', 'safe') and h.expires_at > now()
            and h.id is distinct from p_skip_hold
            and tstzrange(h.starts_at, h.ends_at) && tstzrange(p_start, p_end))::int
$$;

-- Step 1 of a request: reserve the dates here. Fails if anything already occupies them.
create function public.place_hold(p_space uuid, p_channel public.channel, p_start timestamptz, p_end timestamptz,
  p_all_day boolean default true, p_ref text default null, p_guest text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare qty int; hid uuid;
begin
  if (select auth.uid()) is not null and not public.owns_space(p_space) then raise exception 'Space not found.'; end if;
  if p_end <= p_start then raise exception 'The end has to be after the start.'; end if;
  select quantity into qty from public.spaces where id = p_space;
  if qty is null then raise exception 'Space not found.'; end if;
  perform public.lock_property(p_space);
  if public.busy_count(p_space, p_start, p_end, null, false) >= qty then
    raise exception 'Those dates are already taken. Decline this request.' using errcode = 'P0001', hint = 'DATES_TAKEN';
  end if;
  insert into public.booking_holds (space_id, channel, starts_at, ends_at, all_day, external_ref, guest_name)
  values (p_space, p_channel, p_start, p_end, p_all_day, p_ref, p_guest) returning id into hid;
  return hid;
end $$;

-- Step 3, after the booking-guard function proved the dates are closed on every instant site: re-check under the
-- lock that no booking slipped in meanwhile, then mark the hold safe. Returns false (and releases it) if one did.
create function public.mark_hold_safe(p_hold uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare h public.booking_holds; qty int;
begin
  select * into h from public.booking_holds where id = p_hold;
  if h.id is null then return false; end if;
  perform public.lock_property(h.space_id);
  select * into h from public.booking_holds where id = p_hold for update;
  if h.status = 'safe' then return true; end if;
  if h.status <> 'holding' or h.expires_at <= now() then return false; end if;
  select quantity into qty from public.spaces where id = h.space_id;
  -- Dates the host closed are expected here (that is the point); only guest bookings and other holds count.
  if public.busy_count(h.space_id, h.starts_at, h.ends_at, h.id, true) >= qty then
    update public.booking_holds set status = 'released', released_reason = 'taken' where id = p_hold;
    return false;
  end if;
  -- Safe holds last long enough for the site's 24-hour accept window plus calendar lag.
  update public.booking_holds set status = 'safe', verified_at = now(), expires_at = greatest(expires_at, now() + interval '3 days')
  where id = p_hold;
  return true;
end $$;

create function public.release_hold(p_hold uuid, p_reason text default 'declined') returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_holds set status = 'released', released_reason = left(p_reason, 200)
  where id = p_hold and status in ('holding', 'safe')
    and ((select auth.uid()) is null or public.owns_space(space_id));
end $$;

-- ---------------------------------------------------------------- rule 3: guard
create table public.booking_alerts (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  -- door_open: a booking from another site isn't closed on the instant site. unchecked_accept: a request was accepted
  -- without Everyspace's OK.
  kind text not null check (kind in ('door_open', 'unchecked_accept')),
  channel public.channel, -- for door_open: the instant site that needs the dates closed
  reservation_id uuid references public.reservations (id) on delete cascade,
  hold_id uuid references public.booking_holds (id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique nulls not distinct (kind, channel, reservation_id, hold_id)
);
create index on public.booking_alerts (space_id) where resolved_at is null;

-- What the instant listing (p_space on p_channel) must show as busy: upcoming bookings from other sites across the
-- space family, and holds that were marked safe.
create function public.door_requirements(p_space uuid, p_channel public.channel)
returns table (kind text, id uuid, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'reservation', r.id, r.starts_at, r.ends_at from public.reservations r
  where r.space_id in (select public.related_spaces(p_space)) and not (r.channel = p_channel and r.space_id = p_space)
    and r.status = 'confirmed' and r.kind = 'booking' and r.ends_at > now()
  union all
  select 'hold', h.id, h.starts_at, h.ends_at from public.booking_holds h
  where h.space_id in (select public.related_spaces(p_space)) and h.status = 'safe' and h.expires_at > now()
$$;

create function public.site_name(p_channel text) returns text
language sql immutable set search_path = '' as $$
  select case p_channel when 'airbnb' then 'Airbnb' when 'vrbo' then 'Vrbo' when 'booking_com' then 'Booking.com'
    when 'everyspace' then 'Everyspace' when 'spothero' then 'SpotHero' when 'getmyboat' then 'GetMyBoat' when 'rvshare' then 'RVshare'
    when 'furnished_finder' then 'Furnished Finder' else initcap(p_channel) end
$$;

-- Records what the guard found for one instant listing: opens alerts for gaps, resolves ones that are now closed.
create function public.record_door_gaps(p_space uuid, p_channel public.channel, p_reservations uuid[], p_holds uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare added int; tz text; site text := public.site_name(p_channel::text);
begin
  select p.timezone into tz from public.spaces s join public.properties p on p.id = s.property_id where s.id = p_space;
  update public.booking_alerts a set resolved_at = now()
  where a.kind = 'door_open' and a.channel = p_channel and a.resolved_at is null
    and a.space_id in (select public.related_spaces(p_space))
    and not (coalesce(a.reservation_id = any(p_reservations), false) or coalesce(a.hold_id = any(p_holds), false));
  with gaps as (
    select r.space_id, r.id as rid, null::uuid as hid, r.starts_at, r.ends_at, r.channel::text as src
    from public.reservations r where r.id = any(p_reservations)
    union all
    select h.space_id, null, h.id, h.starts_at, h.ends_at, h.channel::text from public.booking_holds h where h.id = any(p_holds)
  ), ins as (
    insert into public.booking_alerts (space_id, kind, channel, reservation_id, hold_id, message)
    select g.space_id, 'door_open', p_channel, g.rid, g.hid,
      format('Close %s – %s on %s now. They are booked on %s, but still open there.',
        to_char(g.starts_at at time zone tz, 'Mon DD'), to_char(g.ends_at at time zone tz, 'Mon DD'), site, public.site_name(g.src))
    from gaps g
    on conflict (kind, channel, reservation_id, hold_id) do update set resolved_at = null
    returning 1
  ) select count(*) into added from ins;
  return added;
end $$;

-- After a sync: link holds to the bookings they became, expire stale holds, and flag requests accepted without the check.
create function public.settle_holds(p_space uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare added int;
begin
  perform public.lock_property(p_space);
  update public.booking_holds h set status = 'confirmed', reservation_id = r.id
  from public.reservations r
  where h.space_id = p_space and h.status in ('holding', 'safe')
    and r.space_id = h.space_id and r.channel = h.channel and r.status = 'confirmed' and r.kind = 'booking'
    and tstzrange(r.starts_at, r.ends_at) && tstzrange(h.starts_at, h.ends_at)
    and not exists (select 1 from public.booking_holds x where x.reservation_id = r.id);
  update public.booking_holds set status = 'released', released_reason = 'expired'
  where space_id = p_space and status in ('holding', 'safe') and expires_at <= now();
  -- A booking on a request-to-book site that never got Everyspace's OK (accepted straight on the site).
  insert into public.booking_alerts (space_id, kind, channel, reservation_id, message)
  select r.space_id, 'unchecked_accept', r.channel, r.id,
    'A request was accepted before Everyspace confirmed the dates were closed everywhere. Check the calendar now.'
  from public.reservations r
  join public.channel_listings l on l.space_id = r.space_id and l.channel = r.channel and l.booking_mode = 'request'
  where r.space_id = p_space and r.status = 'confirmed' and r.kind = 'booking' and r.ends_at > now()
    and r.created_at > l.mode_since
    and not exists (select 1 from public.booking_holds h where h.reservation_id = r.id and h.verified_at is not null)
  on conflict (kind, channel, reservation_id, hold_id) do nothing;
  get diagnostics added = row_count;
  return added;
end $$;

-- ---------------------------------------------------------------- double-booking check across the whole family
-- Replaces the first version: a stay on the whole house now also conflicts with a booking of a room inside it, and
-- dates closed on a site (kind 'block') no longer count as a conflict with the booking they were closed for.
create or replace function public.detect_conflicts(p_space uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare qty int; added int;
begin
  select quantity into qty from public.spaces where id = p_space;
  if qty is null then return 0; end if;
  update public.conflicts c set resolved_at = now()
  where c.space_id = p_space and c.resolved_at is null and not exists (
    select 1 from public.reservations a, public.reservations b
    where a.id = c.a_reservation_id and b.id = c.b_reservation_id and a.status = 'confirmed' and b.status = 'confirmed'
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at));
  if qty > 1 then return 0; end if;
  with pairs as (
    select least(a.id, b.id) as a_id, greatest(a.id, b.id) as b_id
    from public.reservations a join public.reservations b
      on a.id <> b.id and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)
    where a.space_id = p_space and b.space_id in (select public.related_spaces(p_space))
      and a.status = 'confirmed' and b.status = 'confirmed'
      -- Two guests, or a guest on top of the host's own stay. A date the host closed on one site so another site's
      -- guest could have it is the system working, not a conflict.
      and (a.kind = 'booking' or b.kind = 'booking') and a.kind <> 'block' and b.kind <> 'block'
      and a.ends_at > now() - interval '1 day'
  ), ins as (
    insert into public.conflicts (space_id, a_reservation_id, b_reservation_id)
    select distinct p_space, a_id, b_id from pairs
    on conflict (a_reservation_id, b_reservation_id) do update set resolved_at = null
    returning 1
  ) select count(*) into added from ins;
  return added;
end $$;

-- ---------------------------------------------------------------- security
alter table public.booking_holds enable row level security;
alter table public.booking_alerts enable row level security;
create policy "Hosts see their holds" on public.booking_holds for select to authenticated using (public.owns_space(space_id));
create policy "Hosts see their alerts" on public.booking_alerts for select to authenticated using (public.owns_space(space_id));
-- Holds are only created and changed through the functions above, which take the lock.

revoke execute on function public.space_ancestors(uuid), public.related_spaces(uuid), public.lock_property(uuid),
  public.door_listings(uuid), public.busy_count(uuid, timestamptz, timestamptz, uuid, boolean), public.mark_hold_safe(uuid),
  public.door_requirements(uuid, public.channel), public.record_door_gaps(uuid, public.channel, uuid[], uuid[]),
  public.settle_holds(uuid), public.place_hold(uuid, public.channel, timestamptz, timestamptz, boolean, text, text),
  public.release_hold(uuid, text)
  from public, anon, authenticated;
grant execute on function public.place_hold(uuid, public.channel, timestamptz, timestamptz, boolean, text, text),
  public.release_hold(uuid, text) to authenticated;
grant execute on function public.place_hold(uuid, public.channel, timestamptz, timestamptz, boolean, text, text),
  public.release_hold(uuid, text), public.mark_hold_safe(uuid), public.door_listings(uuid),
  public.door_requirements(uuid, public.channel), public.record_door_gaps(uuid, public.channel, uuid[], uuid[]),
  public.settle_holds(uuid), public.detect_conflicts(uuid), public.accrue_earnings() to service_role;

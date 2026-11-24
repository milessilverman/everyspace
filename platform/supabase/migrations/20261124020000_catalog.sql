-- M2: platforms, space categories and amenities become lookup tables (ADR 5). Adding a platform or a category is a
-- plain INSERT, not a migration. The `channel` enum is converted to text + FK to channels(key); keys are unchanged,
-- so clients that pass channel values as plain strings (the Host Console) keep working.

-- ---------------------------------------------------------------- channels
-- Capability levels per area (calendar, booking, listing, pricing, messaging):
--   L0 none · L1 read-only/one-way (e.g. iCal export) · L2 two-way manual/assisted · L3 official API, partial · L4 official API, full.
-- Only cap_calendar = 'L1' for Airbnb, Vrbo and Booking.com is seeded: the existing calendar-sync code reads their iCal
-- links. Everything else is L0 until checked. capabilities_verified_at is NULL = not yet verified against the
-- platform's official terms/docs.
create table public.channels (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  kind text not null default 'marketplace' check (kind in ('everyspace', 'marketplace', 'classifieds', 'direct', 'other')),
  cap_calendar text not null default 'L0' check (cap_calendar in ('L0', 'L1', 'L2', 'L3', 'L4')),
  cap_booking text not null default 'L0' check (cap_booking in ('L0', 'L1', 'L2', 'L3', 'L4')),
  cap_listing text not null default 'L0' check (cap_listing in ('L0', 'L1', 'L2', 'L3', 'L4')),
  cap_pricing text not null default 'L0' check (cap_pricing in ('L0', 'L1', 'L2', 'L3', 'L4')),
  cap_messaging text not null default 'L0' check (cap_messaging in ('L0', 'L1', 'L2', 'L3', 'L4')),
  capabilities_verified_at date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.channels (key, name, kind) values
  ('everyspace', 'Everyspace', 'everyspace'), ('airbnb', 'Airbnb', 'marketplace'), ('vrbo', 'Vrbo', 'marketplace'),
  ('booking_com', 'Booking.com', 'marketplace'), ('expedia', 'Expedia', 'marketplace'),
  ('furnished_finder', 'Furnished Finder', 'marketplace'), ('swimply', 'Swimply', 'marketplace'),
  ('peerspace', 'Peerspace', 'marketplace'), ('neighbor', 'Neighbor', 'marketplace'), ('spothero', 'SpotHero', 'marketplace'),
  ('sniffspot', 'Sniffspot', 'marketplace'), ('hipcamp', 'Hipcamp', 'marketplace'), ('getmyboat', 'GetMyBoat', 'marketplace'),
  ('outdoorsy', 'Outdoorsy', 'marketplace'), ('rvshare', 'RVshare', 'marketplace'), ('craigslist', 'Craigslist', 'classifieds'),
  ('facebook', 'Facebook', 'classifieds'), ('direct', 'Direct', 'direct'), ('other', 'Other', 'other');
update public.channels set cap_calendar = 'L1' where key in ('airbnb', 'vrbo', 'booking_com');

-- ---------------------------------------------------------------- space categories
-- Seeded from the keys of `const CATEGORIES` in index.html (group = its first argument), plus the four Host Console
-- SPACE_TYPES keys that are not in that catalog (garage, storage, studio, other) so existing Host Console inserts keep
-- passing the FK. Label = humanised key. units is left empty where not known.
create table public.space_categories (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  label text not null,
  group_key text,
  units text[] not null default '{}' check (units <@ array['hour', 'day', 'night', 'week', 'month']),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.space_categories (key, label, group_key)
select k, upper(left(replace(k, '_', ' '), 1)) || substr(replace(k, '_', ' '), 2), g
from (values
  ('entire_home', 'living'), ('apartment_unit', 'living'), ('adu', 'living'), ('private_room', 'living'),
  ('backyard', 'outdoor'), ('yard_campsite', 'outdoor'), ('pool', 'outdoor'), ('workspace', 'outdoor'),
  ('film_location', 'outdoor'), ('kitchen', 'outdoor'), ('sport_court', 'outdoor'), ('meeting_room', 'outdoor'),
  ('parking_spot', 'parking'), ('rv_parking', 'parking'), ('ev_charging', 'parking'), ('dock_slip', 'parking'),
  ('lot_parking', 'parking'), ('garage_storage', 'storage'), ('attic_storage', 'storage'), ('basement_storage', 'storage'),
  ('warehouse_storage', 'storage'), ('garden_plot', 'land'), ('beehive_site', 'land'), ('pasture', 'land'),
  ('rooftop_solar', 'energy'), ('battery_site', 'energy'), ('charger_site', 'energy'), ('telecom_site', 'energy'),
  ('fleet_parking', 'commercial'), ('signage', 'commercial'), ('parcel_locker', 'commercial'),
  ('atv', 'gear'), ('snowmobile', 'gear'), ('kayak', 'gear'), ('boat', 'gear'), ('jet_ski', 'gear'), ('ebike', 'gear'),
  ('camper', 'gear'), ('building', 'container'),
  -- Host Console SPACE_TYPES keys not in the app catalog
  ('garage', 'storage'), ('storage', 'storage'), ('studio', null), ('other', null)
) v (k, g);
-- Any category already in use (free text before this migration) is kept as a row rather than rejected.
insert into public.space_categories (key, label)
select distinct s.category, s.category from public.spaces s
where not exists (select 1 from public.space_categories c where c.key = s.category);
alter table public.spaces add constraint spaces_category_fkey foreign key (category) references public.space_categories (key) on update cascade;

-- ---------------------------------------------------------------- amenities
create table public.amenities (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.amenities (key, label) values
  ('wifi', 'Wi-Fi'), ('parking', 'Parking'), ('kitchen', 'Kitchen'), ('washer', 'Washer'), ('dryer', 'Dryer'),
  ('air_conditioning', 'Air conditioning'), ('heating', 'Heating'), ('restroom', 'Restroom'),
  ('wheelchair_accessible', 'Step-free access'), ('ev_charger', 'EV charger'), ('pets_allowed', 'Pets allowed');

create table public.space_amenities (
  space_id uuid not null references public.spaces (id) on delete cascade,
  amenity_key text not null references public.amenities (key) on update cascade,
  provenance_tag text not null default 'owner_confirmed' check (provenance_tag in ('measured', 'estimated', 'owner_confirmed', 'unavailable')),
  created_at timestamptz not null default now(),
  primary key (space_id, amenity_key)
);
create index on public.space_amenities (amenity_key);

-- ---------------------------------------------------------------- enum -> text + FK
-- Functions whose signatures use the enum are dropped first, recreated with text below (bodies unchanged).
drop function public.door_listings(uuid);
drop function public.door_requirements(uuid, public.channel);
drop function public.record_door_gaps(uuid, public.channel, uuid[], uuid[]);
drop function public.place_hold(uuid, public.channel, timestamptz, timestamptz, boolean, text, text);

alter table public.channel_connections alter column channel type text using channel::text;
alter table public.channel_listings alter column channel type text using channel::text;
alter table public.calendar_imports alter column channel type text using channel::text;
alter table public.calendar_feeds alter column for_channel type text using for_channel::text;
alter table public.reservations alter column channel type text using channel::text;
alter table public.booking_holds alter column channel type text using channel::text;
alter table public.booking_alerts alter column channel type text using channel::text;

alter table public.channel_connections add constraint channel_connections_channel_fkey foreign key (channel) references public.channels (key) on update cascade;
alter table public.channel_listings add constraint channel_listings_channel_fkey foreign key (channel) references public.channels (key) on update cascade;
alter table public.calendar_imports add constraint calendar_imports_channel_fkey foreign key (channel) references public.channels (key) on update cascade;
alter table public.calendar_feeds add constraint calendar_feeds_for_channel_fkey foreign key (for_channel) references public.channels (key) on update cascade;
alter table public.reservations add constraint reservations_channel_fkey foreign key (channel) references public.channels (key) on update cascade;
alter table public.booking_holds add constraint booking_holds_channel_fkey foreign key (channel) references public.channels (key) on update cascade;
alter table public.booking_alerts add constraint booking_alerts_channel_fkey foreign key (channel) references public.channels (key) on update cascade;
create index on public.channel_listings (channel);
create index on public.calendar_imports (channel);
create index on public.calendar_feeds (for_channel);
create index on public.reservations (channel);
create index on public.booking_holds (channel);
create index on public.booking_alerts (channel);

drop type public.channel;

-- Site names come from channels now; unknown keys still read nicely.
create or replace function public.site_name(p_channel text) returns text
language sql stable set search_path = '' as $$
  select coalesce((select c.name from public.channels c where c.key = p_channel), initcap(p_channel))
$$;

create function public.door_listings(p_space uuid) returns table (space_id uuid, channel text)
language sql stable security definer set search_path = '' as $$
  select l.space_id, l.channel from public.channel_listings l
  where l.booking_mode = 'instant' and l.status in ('pending', 'live') and l.space_id in (select public.related_spaces(p_space))
$$;

create function public.door_requirements(p_space uuid, p_channel text)
returns table (kind text, id uuid, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'reservation', r.id, r.starts_at, r.ends_at from public.reservations r
  where r.space_id in (select public.related_spaces(p_space)) and not (r.channel = p_channel and r.space_id = p_space)
    and r.status = 'confirmed' and r.kind = 'booking' and r.ends_at > now()
  union all
  select 'hold', h.id, h.starts_at, h.ends_at from public.booking_holds h
  where h.space_id in (select public.related_spaces(p_space)) and h.status = 'safe' and h.expires_at > now()
$$;

create function public.place_hold(p_space uuid, p_channel text, p_start timestamptz, p_end timestamptz,
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

-- Same body as 20261116110046_alerts_polish.
create function public.record_door_gaps(p_space uuid, p_channel text, p_reservations uuid[], p_holds uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare added int; tz text; site text := public.site_name(p_channel);
begin
  select p.timezone into tz from public.spaces s join public.properties p on p.id = s.property_id where s.id = p_space;
  update public.booking_alerts a set resolved_at = now()
  where a.kind = 'door_open' and a.channel = p_channel and a.resolved_at is null
    and a.space_id in (select public.related_spaces(p_space))
    and not (coalesce(a.reservation_id = any(p_reservations), false) or coalesce(a.hold_id = any(p_holds), false));
  with gaps as (
    select r.space_id, r.id as rid, null::uuid as hid, r.starts_at, r.ends_at, r.all_day, r.channel as src
    from public.reservations r where r.id = any(p_reservations)
    union all
    select h.space_id, null, h.id, h.starts_at, h.ends_at, h.all_day, h.channel from public.booking_holds h where h.id = any(p_holds)
  ), worded as (
    select g.*,
      to_char(g.starts_at at time zone tz, 'Mon FMDD') as first_night,
      to_char(case when g.all_day then g.ends_at - interval '12 hours' else g.ends_at end at time zone tz, 'Mon FMDD') as last_night
    from gaps g
  ), ins as (
    insert into public.booking_alerts (space_id, kind, channel, reservation_id, hold_id, message)
    select w.space_id, 'door_open', p_channel, w.rid, w.hid,
      case when not w.all_day then format('Close %s on %s now. It''s booked on %s, but still open there.', w.first_night, site, public.site_name(w.src))
           when w.first_night = w.last_night then format('Close the night of %s on %s now. It''s booked on %s, but still open there.', w.first_night, site, public.site_name(w.src))
           else format('Close the nights of %s – %s on %s now. They''re booked on %s, but still open there.', w.first_night, w.last_night, site, public.site_name(w.src)) end
    from worded w
    on conflict (kind, channel, reservation_id, hold_id) do update set resolved_at = null, message = excluded.message
    returning 1
  ) select count(*) into added from ins;
  return added;
end $$;

revoke execute on function public.door_listings(uuid), public.door_requirements(uuid, text),
  public.record_door_gaps(uuid, text, uuid[], uuid[]), public.place_hold(uuid, text, timestamptz, timestamptz, boolean, text, text)
  from public, anon, authenticated;
grant execute on function public.place_hold(uuid, text, timestamptz, timestamptz, boolean, text, text) to authenticated;
grant execute on function public.door_listings(uuid), public.door_requirements(uuid, text),
  public.record_door_gaps(uuid, text, uuid[], uuid[]), public.place_hold(uuid, text, timestamptz, timestamptz, boolean, text, text)
  to service_role;

-- ---------------------------------------------------------------- row-level security
alter table public.channels enable row level security;
alter table public.space_categories enable row level security;
alter table public.amenities enable row level security;
alter table public.space_amenities enable row level security;
-- Lookups are public reference data; only the service role writes them.
create policy "Anyone reads channels" on public.channels for select to anon, authenticated using (true);
create policy "Anyone reads space categories" on public.space_categories for select to anon, authenticated using (true);
create policy "Anyone reads amenities" on public.amenities for select to anon, authenticated using (true);
create policy "Members read space amenities" on public.space_amenities for select to authenticated using (public.can_view_space(space_id));
create policy "Managers add space amenities" on public.space_amenities for insert to authenticated with check (public.can_manage_space(space_id));
create policy "Managers edit space amenities" on public.space_amenities for update to authenticated using (public.can_manage_space(space_id)) with check (public.can_manage_space(space_id));
create policy "Managers delete space amenities" on public.space_amenities for delete to authenticated using (public.can_manage_space(space_id));
revoke insert, update, delete, truncate on public.channels, public.space_categories, public.amenities from anon, authenticated;

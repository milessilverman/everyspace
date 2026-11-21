alter table public.spaces add column turnover_minutes integer not null default 0 check (turnover_minutes between 0 and 1440);
alter table public.reservations add column units integer not null default 1 check (units between 1 and 500);
alter table public.booking_holds add column units integer not null default 1 check (units between 1 and 500);

create or replace function public.space_ancestors(p_space uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  with recursive ancestors(id, parent_space_id, property_id) as (
    select id, parent_space_id, property_id from public.spaces where id = p_space
    union
    select s.id, s.parent_space_id, s.property_id
    from public.spaces s join ancestors a on s.id = a.parent_space_id and s.property_id = a.property_id
  )
  select id from ancestors
$$;

create or replace function public.related_spaces(p_space uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  with recursive descendants(id, property_id) as (
    select id, property_id from public.spaces where id = p_space
    union
    select s.id, s.property_id
    from public.spaces s join descendants d on s.parent_space_id = d.id and s.property_id = d.property_id
  )
  select * from public.space_ancestors(p_space)
  union
  select id from descendants
$$;

create function public.buffered_reservation_end(p_end timestamptz, p_minutes integer) returns timestamptz
language sql stable strict set search_path = '' as $$
  select p_end + make_interval(mins => p_minutes)
$$;

-- Bookings and holds consume units over half-open buffered intervals. Parent/child
-- occupancy or an explicit block consumes the full target capacity.
create or replace function public.busy_count(
  p_space uuid, p_start timestamptz, p_end timestamptz, p_skip_hold uuid, p_bookings_only boolean
) returns int language sql stable security definer set search_path = '' as $$
  with target as (
    select quantity, p_start as starts_at, public.buffered_reservation_end(p_end, turnover_minutes) as ends_at
    from public.spaces where id = p_space
  ), family as (
    select s.id, s.turnover_minutes
    from public.spaces s where s.id in (select public.related_spaces(p_space))
  ), busy as (
    select r.starts_at, public.buffered_reservation_end(r.ends_at, case when r.kind = 'booking' then f.turnover_minutes else 0 end) as ends_at,
      case when r.space_id = p_space and r.kind = 'booking' then r.units else t.quantity end as units
    from public.reservations r join family f on f.id = r.space_id cross join target t
    where r.status = 'confirmed' and (not p_bookings_only or r.kind <> 'block')
    union all
    select h.starts_at, public.buffered_reservation_end(h.ends_at, f.turnover_minutes),
      case when h.space_id = p_space then h.units else t.quantity end
    from public.booking_holds h join family f on f.id = h.space_id cross join target t
    where h.status in ('holding', 'safe') and h.expires_at > now() and h.id is distinct from p_skip_hold
    union all
    select r.starts_at, public.buffered_reservation_end(r.ends_at, f.turnover_minutes), t.quantity
    from public.channel_reservation_requests r
    join public.channel_api_listings a on a.id = r.listing_id
    join family f on f.id = a.space_id cross join target t
    where r.status in ('approving', 'uncertain')
  ), events as (
    select e.at, sum(e.delta) as delta
    from busy b cross join target t
    cross join lateral (values (greatest(b.starts_at, t.starts_at), b.units), (least(b.ends_at, t.ends_at), -b.units)) e(at, delta)
    where b.starts_at < t.ends_at and b.ends_at > t.starts_at
    group by e.at
  ), usage as (
    select sum(delta) over (order by at) as units from events
  )
  select coalesce(max(units), 0)::int from usage
$$;

-- The previous signature is retained for existing RPC callers and defaults to one unit.
create function public.place_inventory_hold(
  p_space uuid, p_channel public.channel, p_start timestamptz, p_end timestamptz,
  p_all_day boolean, p_ref text, p_guest text, p_units integer
) returns uuid language plpgsql security definer set search_path = '' as $$
declare qty int; hid uuid;
begin
  if (select auth.uid()) is not null and not public.owns_space(p_space) then raise exception 'Space not found.'; end if;
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_end <= p_start then
    raise exception 'The end has to be after the start.';
  end if;
  perform public.lock_property(p_space);
  select quantity into qty from public.spaces where id = p_space;
  if qty is null then raise exception 'Space not found.'; end if;
  if p_units is null or p_units < 1 or p_units > qty then
    raise exception 'Requested units must be within the space capacity.';
  end if;
  if public.busy_count(p_space, p_start, p_end, null, false) + p_units > qty then
    raise exception 'Those dates are already taken or above capacity.' using errcode = 'P0001', hint = 'DATES_TAKEN';
  end if;
  insert into public.booking_holds(space_id, channel, starts_at, ends_at, all_day, external_ref, guest_name, units)
  values (p_space, p_channel, p_start, p_end, p_all_day, p_ref, p_guest, p_units) returning id into hid;
  return hid;
end $$;

create or replace function public.place_hold(
  p_space uuid, p_channel public.channel, p_start timestamptz, p_end timestamptz,
  p_all_day boolean default true, p_ref text default null, p_guest text default null
) returns uuid language sql security definer set search_path = '' as $$
  select public.place_inventory_hold(p_space, p_channel, p_start, p_end, p_all_day, p_ref, p_guest, 1)
$$;

create or replace function public.mark_hold_safe(p_hold uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare h public.booking_holds; qty int;
begin
  select * into h from public.booking_holds where id = p_hold;
  if h.id is null then return false; end if;
  perform public.lock_property(h.space_id);
  select * into h from public.booking_holds where id = p_hold for update;
  if h.id is null or h.status not in ('holding', 'safe') or h.expires_at <= clock_timestamp() then return false; end if;
  select quantity into qty from public.spaces where id = h.space_id;
  if public.busy_count(h.space_id, h.starts_at, h.ends_at, h.id, true) + h.units > qty then
    update public.booking_holds set status = 'released', released_reason = 'taken' where id = p_hold;
    return false;
  end if;
  if h.status = 'safe' then return true; end if;
  update public.booking_holds set status = 'safe', verified_at = now(), expires_at = greatest(expires_at, now() + interval '3 days')
  where id = p_hold;
  return true;
end $$;

create or replace function public.detect_conflicts(p_space uuid) returns int
language sql security definer set search_path = '' as $$
  with occupancy as (
    select r.id, r.space_id, r.kind, r.starts_at, e.ends_at, s.quantity,
      case when r.kind = 'owner_block' then s.quantity else r.units end as units
    from public.reservations r join public.spaces s on s.id = r.space_id
    cross join lateral (select public.buffered_reservation_end(r.ends_at, case when r.kind = 'booking' then s.turnover_minutes else 0 end) as ends_at) e
    where r.space_id in (select public.related_spaces(p_space)) and r.status = 'confirmed'
      and r.kind in ('booking', 'owner_block') and e.ends_at > now() - interval '1 day'
  ), events as (
    select o.space_id, o.quantity, e.at, sum(e.delta) as delta
    from occupancy o cross join lateral (values (o.starts_at, o.units), (o.ends_at, -o.units)) e(at, delta)
    group by o.space_id, o.quantity, e.at
  ), usage as (
    select space_id, quantity, at, lead(at) over timeline as until, sum(delta) over timeline as units
    from events window timeline as (partition by space_id order by at)
  ), pairs as (
    select distinct least(a.id, b.id) as a_id, greatest(a.id, b.id) as b_id
    from occupancy a join occupancy b on a.id <> b.id and a.starts_at < b.ends_at and b.starts_at < a.ends_at
    where a.space_id = p_space and (a.kind = 'booking' or b.kind = 'booking')
      and (a.space_id <> b.space_id or exists (
        select 1 from usage u where u.space_id = a.space_id and u.units > u.quantity
          and u.at < least(a.ends_at, b.ends_at) and u.until > greatest(a.starts_at, b.starts_at)
      ))
  ), cleared as (
    update public.conflicts c set resolved_at = now()
    where c.resolved_at is null and (c.space_id = p_space or exists (
      select 1 from public.reservations r where r.id in (c.a_reservation_id, c.b_reservation_id) and r.space_id = p_space
    ))
    and not exists (select 1 from pairs p where p.a_id = c.a_reservation_id and p.b_id = c.b_reservation_id)
  ), recorded as (
    insert into public.conflicts(space_id, a_reservation_id, b_reservation_id)
    select p_space, a_id, b_id from pairs
    on conflict (a_reservation_id, b_reservation_id) do update set resolved_at = null
    returning 1
  )
  select count(*)::int from recorded
$$;

create or replace function public.door_requirements(p_space uuid, p_channel public.channel)
returns table(kind text, id uuid, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with family as (
    select id, turnover_minutes from public.spaces where id in (select public.related_spaces(p_space))
  )
  select 'reservation', r.id, r.starts_at, public.buffered_reservation_end(r.ends_at, f.turnover_minutes)
  from public.reservations r join family f on f.id = r.space_id
  where not (r.channel = p_channel and r.space_id = p_space)
    and r.status = 'confirmed' and r.kind = 'booking'
    and public.buffered_reservation_end(r.ends_at, f.turnover_minutes) > now()
  union all
  select 'hold', h.id, h.starts_at, public.buffered_reservation_end(h.ends_at, f.turnover_minutes)
  from public.booking_holds h join family f on f.id = h.space_id
  where h.status = 'safe' and h.expires_at > now()
$$;

create function public.calendar_feed_reservations(p_space uuid)
returns table(id uuid, space_id uuid, channel public.channel, status text, starts_at timestamptz, ends_at timestamptz, all_day boolean)
language sql stable set search_path = '' as $$
  select r.id, r.space_id, r.channel, r.status, r.starts_at, e.ends_at, r.all_day
  from public.reservations r join public.spaces s on s.id = r.space_id
  cross join lateral (select public.buffered_reservation_end(r.ends_at, case when r.kind = 'booking' then s.turnover_minutes else 0 end) as ends_at) e
  where r.space_id in (select public.related_spaces(p_space)) and r.status = 'confirmed' and e.ends_at >= now() - interval '1 day'
$$;

-- Email is a host-provided observation. Only the host can move it into the guarded request or calendar workflow.
create table public.booking_email_reviews (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null,
  channel public.channel not null,
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  reference text check (length(reference) between 1 and 120),
  reported_status text not null check (reported_status in ('request', 'confirmed', 'cancelled', 'unknown')),
  starts_at timestamptz,
  ends_at timestamptz,
  all_day boolean,
  units integer check (units between 1 and 500),
  issues text[] not null default '{}',
  status text not null default 'needs_review' check (status in ('needs_review', 'dismissed', 'held', 'recorded')),
  hold_id uuid references public.booking_holds(id) on delete set null,
  reservation_id uuid references public.reservations(id) on delete set null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  foreign key (space_id, channel) references public.channel_listings(space_id, channel) on delete cascade,
  unique (space_id, channel, fingerprint),
  check (ends_at > starts_at)
);
create index booking_email_reviews_hold_idx on public.booking_email_reviews(hold_id);
create index booking_email_reviews_reservation_idx on public.booking_email_reviews(reservation_id);
create index booking_email_reviews_status_idx on public.booking_email_reviews(status, created_at desc);

alter table public.booking_email_reviews enable row level security;
create policy "Hosts see email reviews in their spaces" on public.booking_email_reviews
  for select to authenticated using (public.owns_space(space_id));
revoke all on public.booking_email_reviews from public, anon, authenticated;
grant select (id, space_id, channel, reference, reported_status, starts_at, ends_at, all_day, units, issues,
  status, created_at, reviewed_at) on public.booking_email_reviews to authenticated;
grant select, insert on public.booking_email_reviews to service_role;

-- The host records a confirmation observed on an external channel. This never writes to the provider.
create function public.record_external_booking(
  p_space uuid, p_channel public.channel, p_start timestamptz, p_end timestamptz,
  p_all_day boolean, p_units integer, p_reference text, p_source text default 'manual', p_hold uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  ref text := nullif(btrim(p_reference), '');
  booking public.reservations;
  hold public.booking_holds;
  result uuid;
begin
  if (select auth.uid()) is null or not public.owns_space(p_space) then raise exception 'Space not found.'; end if;
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_end <= p_start
     or p_all_day is null or p_units is null or p_units not between 1 and 500 then
    raise exception 'Verify the dates and unit count first.';
  end if;
  if ref is null or length(ref) > 120 then raise exception 'Enter a provider confirmation reference of up to 120 characters.'; end if;
  if p_source not in ('manual', 'email') then raise exception 'Invalid recording source.'; end if;
  perform public.lock_property(p_space);
  if p_units > (select quantity from public.spaces where id = p_space) then
    raise exception 'Requested units must be within the space capacity.';
  end if;
  if p_hold is not null then
    select * into hold from public.booking_holds h where h.id = p_hold and h.space_id = p_space for update;
    if hold.id is null or (hold.channel, hold.starts_at, hold.ends_at, hold.all_day, hold.units)
      is distinct from (p_channel, p_start, p_end, p_all_day, p_units) then
      raise exception 'The confirmed booking differs from the hold. Review the existing request first.';
    end if;
    if hold.reservation_id is not null then
      if exists (select 1 from public.reservations r where r.id = hold.reservation_id and r.status = 'confirmed') then
        return hold.reservation_id;
      end if;
      raise exception 'The linked reservation is no longer confirmed. Check the booking on the provider.';
    end if;
  end if;

  -- An outside confirmation is recorded even if another booking occupies these dates.
  insert into public.reservations(space_id, channel, external_uid, source, starts_at, ends_at, all_day, units, guest_name)
  values (p_space, p_channel, 'external:' || ref, p_source, p_start, p_end, p_all_day, p_units, hold.guest_name)
  on conflict (space_id, channel, external_uid) do nothing returning id into result;
  if result is null then
    select * into booking from public.reservations r where r.space_id = p_space and r.channel = p_channel
      and r.external_uid = 'external:' || ref and r.source in ('manual', 'email') and r.kind = 'booking' and r.status = 'confirmed';
    if booking.id is null or (booking.starts_at, booking.ends_at, booking.all_day, booking.units)
      is distinct from (p_start, p_end, p_all_day, p_units) then
      raise exception 'This reference already exists with other details. Review the existing calendar entry.';
    end if;
    result := booking.id;
  end if;
  if p_hold is not null then
    if exists (select 1 from public.booking_holds h where h.reservation_id = result and h.id <> p_hold) then
      raise exception 'This confirmation is already linked to a different hold.';
    end if;
    update public.booking_holds set status = 'confirmed', reservation_id = result where id = p_hold;
  end if;
  perform public.detect_conflicts(p_space);
  perform public.settle_holds(p_space);
  return result;
end $$;

revoke execute on function public.record_external_booking(uuid, public.channel, timestamptz, timestamptz, boolean, integer, text, text, uuid)
from public, anon, authenticated;
grant execute on function public.record_external_booking(uuid, public.channel, timestamptz, timestamptz, boolean, integer, text, text, uuid)
to authenticated;

create function public.review_booking_email(
  p_review uuid, p_action text, p_start timestamptz default null, p_end timestamptz default null,
  p_all_day boolean default null, p_units integer default null, p_reference text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  item public.booking_email_reviews;
  action_status text;
  ref text := nullif(btrim(p_reference), '');
  result uuid;
begin
  select * into item from public.booking_email_reviews e where e.id = p_review and public.owns_space(e.space_id);
  if (select auth.uid()) is null or item.id is null then raise exception 'Email review not found.'; end if;
  action_status := case p_action when 'hold' then 'held' when 'record' then 'recorded' when 'dismiss' then 'dismissed' end;
  if action_status is null then raise exception 'Invalid review action.'; end if;
  perform public.lock_property(item.space_id);
  select * into item from public.booking_email_reviews e where e.id = p_review and public.owns_space(e.space_id) for update;
  if item.id is null then raise exception 'Email review not found.'; end if;
  if item.status = action_status then return coalesce(item.hold_id, item.reservation_id, item.id); end if;
  if item.status <> 'needs_review' then raise exception 'This email has already been reviewed.'; end if;
  if p_action = 'dismiss' then
    update public.booking_email_reviews set status = 'dismissed', reviewed_at = now() where id = item.id;
    return item.id;
  end if;
  if item.reported_status = 'cancelled' then
    raise exception 'Review this cancellation on the provider before updating your calendar.';
  end if;
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_end <= p_start
      or p_all_day is null or p_units is null or p_units not between 1 and 500 then
    raise exception 'Verify the dates and unit count first.';
  end if;
  if p_units > (select quantity from public.spaces where id = item.space_id) then
    raise exception 'Requested units must be within the space capacity.';
  end if;
  if length(ref) > 120 then raise exception 'The booking reference is too long.'; end if;
  if p_action = 'hold' then
    if ref is not null and exists (select 1 from public.booking_holds h
      where h.space_id = item.space_id and h.channel = item.channel and h.external_ref = ref
        and (h.status = 'confirmed' or (h.status in ('holding', 'safe') and h.expires_at > now()))) then
      raise exception 'A request with this reference already exists. Check Requests before continuing.';
    end if;
    result := public.place_inventory_hold(item.space_id, item.channel, p_start, p_end, p_all_day, ref, null, p_units);
  else
    result := public.record_external_booking(item.space_id, item.channel, p_start, p_end, p_all_day, p_units, ref, 'email');
  end if;
  update public.booking_email_reviews set status = action_status, reviewed_at = now(),
    reference = ref, starts_at = p_start, ends_at = p_end, all_day = p_all_day, units = p_units,
    hold_id = case when p_action = 'hold' then result end,
    reservation_id = case when p_action = 'record' then result end
  where id = item.id;
  return result;
end $$;

revoke execute on function public.place_inventory_hold(uuid, public.channel, timestamptz, timestamptz, boolean, text, text, integer),
  public.calendar_feed_reservations(uuid), public.review_booking_email(uuid, text, timestamptz, timestamptz, boolean, integer, text)
from public, anon, authenticated;
grant execute on function public.place_inventory_hold(uuid, public.channel, timestamptz, timestamptz, boolean, text, text, integer)
to authenticated, service_role;
grant execute on function public.calendar_feed_reservations(uuid) to service_role;
grant execute on function public.review_booking_email(uuid, text, timestamptz, timestamptz, boolean, integer, text) to authenticated;

-- Serialize buffer edits with the same property lock used by both reservation workflows.
create or replace function public.guard_channel_inventory_edits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  property_ids uuid[];
  space uuid;
begin
  if tg_table_name = 'spaces' then
    if (old.property_id, old.parent_space_id, old.quantity, old.turnover_minutes) is not distinct from
       (new.property_id, new.parent_space_id, new.quantity, new.turnover_minutes) then return new; end if;
    property_ids := array[old.property_id, new.property_id];
  else
    if old.timezone = new.timezone then return new; end if;
    property_ids := array[old.id];
  end if;
  for space in select distinct on (s.property_id) s.id from public.spaces s
    where s.property_id = any(property_ids) order by s.property_id, s.id
  loop
    perform public.lock_property(space);
  end loop;
  if exists (
    select 1
    from public.channel_reservation_requests r join public.channel_api_listings a on a.id = r.listing_id
    join public.spaces s on s.id = a.space_id
    where s.property_id = any(property_ids) and r.status in ('approving', 'uncertain')
  ) then
    raise exception 'Inventory cannot change while a provider confirmation is unresolved.';
  end if;
  if tg_table_name = 'spaces' then
    if new.property_id <> old.property_id and exists (select 1 from public.spaces where parent_space_id = old.id) then
      raise exception 'Move related spaces together within the same property.';
    end if;
    if (old.quantity, old.turnover_minutes) is distinct from (new.quantity, new.turnover_minutes) then
      update public.booking_holds set status = 'holding', verified_at = null
      where status = 'safe' and expires_at > now() and space_id in (select public.related_spaces(old.id));
    end if;
  end if;
  return new;
end $$;
drop trigger spaces_channel_inventory_guard on public.spaces;
create trigger spaces_channel_inventory_guard before update of property_id, parent_space_id, quantity, turnover_minutes on public.spaces
  for each row execute function public.guard_channel_inventory_edits();

-- The existing dormant provider adapter proves availability for unbuffered stays only.
create or replace function public.channel_approval_scope(p_request uuid, p_token uuid) returns jsonb
language sql stable set search_path = '' as $$
  with related as (
    select public.related_spaces(origin.space_id) as id
    from public.channel_reservation_requests r join public.channel_api_listings origin on origin.id = r.listing_id
    where r.id = p_request and r.lease_token = p_token
  ),
  listings as (
    select l.space_id, l.channel from public.channel_listings l
    where l.space_id in (select id from related) and l.channel <> 'everyspace' and l.status in ('pending', 'live')
    union
    select a.space_id, a.channel from public.channel_api_listings a where a.space_id in (select id from related)
  )
  select coalesce(jsonb_agg(jsonb_build_object('channel', l.channel, 'listing',
    case when a.authorized then jsonb_build_object('id', a.id, 'channel', a.channel, 'accountRef', a.account_ref, 'listingRef', a.listing_ref) end)), '[]'::jsonb)
  from listings l left join public.channel_api_listings a on a.space_id = l.space_id and a.channel = l.channel
  where not exists (select 1 from public.spaces s where s.id in (select id from related) and s.turnover_minutes > 0);
$$;


-- Never consume several unit holds based on one calendar reservation of uncertain identity.
create or replace function public.settle_holds(p_space uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare added int;
begin
  perform public.lock_property(p_space);
  with possible as (
    select h.id as hold_id, r.id as reservation_id,
      count(*) over (partition by h.id) as reservations_per_hold,
      count(*) over (partition by r.id) as holds_per_reservation
    from public.booking_holds h
    join public.reservations r on r.space_id = h.space_id and r.channel = h.channel
      and (r.starts_at, r.ends_at, r.units) = (h.starts_at, h.ends_at, h.units)
    join public.spaces s on s.id = h.space_id
    where h.space_id = p_space and h.status in ('holding', 'safe')
      and r.status = 'confirmed' and r.kind = 'booking'
      and not exists (select 1 from public.booking_holds x where x.reservation_id = r.id)
      and case r.source
        when 'api' then exists (
          select 1 from public.channel_reservation_requests q
          where q.reservation_id = r.id and h.external_ref in (q.external_request_ref, q.provider_reservation_ref)
        )
        when 'email' then r.external_uid = 'external:' || h.external_ref
        else r.external_uid in (h.external_ref, 'external:' || h.external_ref)
          or (h.external_ref is null and s.quantity = 1)
      end
  )
  update public.booking_holds h set status = 'confirmed', reservation_id = p.reservation_id
  from possible p where h.id = p.hold_id and p.reservations_per_hold = 1 and p.holds_per_reservation = 1;
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
    and not exists (select 1 from public.channel_reservation_requests q
      where q.reservation_id = r.id and q.approval_started_at is not null)
  on conflict (kind, channel, reservation_id, hold_id) do nothing;
  get diagnostics added = row_count;
  return added;
end $$;

-- Commit the manual check only if the observed instant listings and cleanup window still match.
create function public.mark_hold_safe_snapshot(p_hold uuid, p_doors jsonb, p_turnover integer)
returns boolean language plpgsql set search_path = '' as $$
declare
  scope_id uuid;
  turnover integer;
  doors jsonb;
begin
  select h.space_id into scope_id from public.booking_holds h where h.id = p_hold;
  if scope_id is null then return false; end if;
  perform public.lock_property(scope_id);
  select s.turnover_minutes into turnover from public.spaces s where s.id = scope_id;
  select coalesce(jsonb_agg(to_jsonb(d) order by d.space_id, d.channel), '[]'::jsonb)
  into doors from public.door_listings(scope_id) d;
  if doors is distinct from p_doors or turnover is distinct from p_turnover then return null; end if;
  return public.mark_hold_safe(p_hold);
end $$;

revoke execute on function public.mark_hold_safe_snapshot(uuid, jsonb, integer) from public, anon, authenticated;
grant execute on function public.mark_hold_safe_snapshot(uuid, jsonb, integer) to service_role;

create or replace function public.lock_reservation_inventory() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  old_space uuid := case when tg_op <> 'INSERT' then old.space_id end;
  new_space uuid := case when tg_op <> 'DELETE' then new.space_id end;
  space uuid;
begin
  for space in select s.id from public.spaces s where s.id in (old_space, new_space) order by s.property_id loop
    perform public.lock_property(space);
  end loop;
  if tg_table_name = 'reservations' and tg_op = 'UPDATE' then
    if new.source = 'ical' and (old.source in ('api', 'email')
        or (old.source = 'manual' and old.external_uid like 'external:%')) then return null; end if;
  elsif tg_table_name = 'channel_api_listings' and tg_op = 'UPDATE' then
    if (old.space_id, old.channel, old.account_ref, old.listing_ref) is distinct from
       (new.space_id, new.channel, new.account_ref, new.listing_ref) then
      raise exception 'A verified API listing cannot be reassigned.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function public.site_name(p_channel text) returns text
language sql immutable set search_path = '' as $$
  select case p_channel when 'airbnb' then 'Airbnb' when 'vrbo' then 'Vrbo' when 'booking_com' then 'Booking.com'
    when 'everyspace' then 'Everyspace' when 'spothero' then 'SpotHero' when 'getmyboat' then 'GetMyBoat' when 'rvshare' then 'RVshare'
    when 'furnished_finder' then 'Furnished Finder' when 'kitchen_door' then 'The Kitchen Door' when 'giggster' then 'Giggster'
    when 'evmatch' then 'EVmatch' when 'liquidspace' then 'LiquidSpace' when 'spareroom' then 'SpareRoom'
    when 'zillow' then 'Zillow Rentals' else initcap(p_channel) end
$$;


-- Reflect an external cancellation only for a booking the host recorded in Everyspace.
create function public.cancel_recorded_external_booking(p_booking uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare space uuid;
begin
  if (select auth.uid()) is null then return false; end if;
  select r.space_id into space from public.reservations r
  where r.id = p_booking and r.source in ('manual', 'email') and r.external_uid like 'external:%' and public.owns_space(r.space_id);
  if space is null then return false; end if;
  perform public.lock_property(space);
  update public.reservations r set status = 'cancelled', updated_at = now()
  where r.id = p_booking and r.space_id = space and r.source in ('manual', 'email')
    and r.external_uid like 'external:%' and public.owns_space(r.space_id);
  if not found then return false; end if;
  update public.booking_holds set status = 'released', released_reason = 'cancelled'
    where reservation_id = p_booking and status = 'confirmed';
  update public.booking_alerts set resolved_at = now() where reservation_id = p_booking and resolved_at is null;
  perform public.detect_conflicts(space);
  return true;
end $$;

revoke execute on function public.cancel_recorded_external_booking(uuid) from public, anon, authenticated;
grant execute on function public.cancel_recorded_external_booking(uuid) to authenticated;

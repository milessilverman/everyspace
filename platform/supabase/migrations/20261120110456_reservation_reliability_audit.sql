alter table public.calendar_imports
  add column last_attempt_at timestamptz,
  add column sync_lease uuid,
  add column sync_lease_until timestamptz;

update public.calendar_imports set last_attempt_at = last_synced_at;
-- Previous code set the success timestamp on a failed read.
update public.calendar_imports set last_synced_at = null where last_status = 'error';

alter table public.reservations
  add column calendar_missing_since timestamptz,
  add column calendar_sequence integer check (calendar_sequence >= 0);
create index calendar_imports_attempt_idx on public.calendar_imports (last_attempt_at nulls first, id);
create index reservations_calendar_snapshot_idx on public.reservations(space_id, channel, ends_at)
  where source = 'ical' and status = 'confirmed';

-- Hosts configure links. Only the sync service can attest to a read or modify health metadata.
revoke select, insert, update on public.calendar_imports from public, anon, authenticated;
grant select (id, space_id, channel, url, last_synced_at, last_attempt_at, last_status, last_error, event_count, created_at)
  on public.calendar_imports to authenticated;
grant insert (space_id, channel, url), update (space_id, channel, url) on public.calendar_imports to authenticated;
revoke insert, update on public.calendar_feeds from public, anon, authenticated;
grant insert (space_id, for_channel) on public.calendar_feeds to authenticated;

create function public.reset_changed_calendar_link() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.url, new.space_id, new.channel) is distinct from (old.url, old.space_id, old.channel) then
    new.sync_lease := null;
    new.sync_lease_until := null;
    new.last_attempt_at := null;
    new.last_synced_at := null;
    new.last_status := null;
    new.last_error := null;
    new.event_count := null;
  end if;
  return new;
end $$;

create trigger calendar_imports_reset_link before update of url, space_id, channel on public.calendar_imports
for each row execute function public.reset_changed_calendar_link();

create function public.claim_calendar_sync(p_import uuid, p_url text, p_minimum_age_seconds integer)
returns uuid language sql set search_path = '' as $$
  update public.calendar_imports i set
    sync_lease = gen_random_uuid(), sync_lease_until = clock_timestamp() + interval '45 seconds',
    last_attempt_at = clock_timestamp()
  where i.id = p_import and i.url = p_url
    and (i.sync_lease_until is null or i.sync_lease_until <= clock_timestamp())
    and (i.last_attempt_at is null or i.last_attempt_at <= clock_timestamp() - make_interval(secs => p_minimum_age_seconds))
  returning i.sync_lease
$$;

create function public.apply_calendar_sync(
  p_import uuid, p_lease uuid, p_time_zone text, p_events jsonb, p_error text default null
) returns jsonb language plpgsql set search_path = '' as $$
declare
  scope uuid;
  calendar public.calendar_imports;
  saved integer := 0;
  missing_count integer := 0;
  conflicts_count integer := 0;
  older_count integer := 0;
  unchecked integer := 0;
  success_at timestamptz;
begin
  select i.space_id into scope from public.calendar_imports i where i.id = p_import;
  if scope is null then return jsonb_build_object('status', 'superseded'); end if;
  perform public.lock_property(scope);
  select * into calendar from public.calendar_imports i
    where i.id = p_import and i.space_id = scope and i.sync_lease = p_lease and i.sync_lease_until > clock_timestamp()
    for update;
  if calendar.id is null then return jsonb_build_object('status', 'superseded'); end if;
  if p_error is not null or p_time_zone is distinct from (
    select p.timezone from public.spaces s join public.properties p on p.id = s.property_id where s.id = scope
  ) then
    update public.calendar_imports i set sync_lease = null, sync_lease_until = null, last_status = 'error',
      last_error = left(coalesce(p_error, 'The property time zone changed during the read. Sync again.'), 180)
      where i.id = p_import;
    return jsonb_build_object('status', 'error');
  end if;

  if p_events is null or jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 3000 then
    raise exception 'Invalid calendar event batch.';
  end if;

  select count(*) into older_count from public.reservations r
  join jsonb_to_recordset(p_events) as e(external_uid text, calendar_sequence integer) on e.external_uid = r.external_uid
  where r.space_id = scope and r.channel = calendar.channel and r.source = 'ical'
    and r.calendar_sequence is not null and (e.calendar_sequence is null or e.calendar_sequence < r.calendar_sequence);

  insert into public.reservations as r
    (space_id, channel, external_uid, kind, source, status, starts_at, ends_at, all_day, summary, calendar_sequence)
  select scope, calendar.channel, e.external_uid, e.kind, 'ical', e.status, e.starts_at, e.ends_at, e.all_day,
    case when e.kind = 'booking' then 'Reserved' else 'Unavailable' end, e.calendar_sequence
  from jsonb_to_recordset(p_events) as e(external_uid text, kind text, status text, starts_at timestamptz, ends_at timestamptz, all_day boolean, calendar_sequence integer)
  on conflict (space_id, channel, external_uid) do update
    set kind = excluded.kind, status = excluded.status, starts_at = excluded.starts_at,
        ends_at = excluded.ends_at, all_day = excluded.all_day, summary = excluded.summary,
        calendar_missing_since = null, calendar_sequence = excluded.calendar_sequence, updated_at = now()
    where r.source = 'ical' and (r.calendar_sequence is null or excluded.calendar_sequence >= r.calendar_sequence)
      and (r.calendar_missing_since is not null or
        (r.kind, r.status, r.starts_at, r.ends_at, r.all_day, r.summary, r.calendar_sequence)
        is distinct from (excluded.kind, excluded.status, excluded.starts_at, excluded.ends_at, excluded.all_day, excluded.summary, excluded.calendar_sequence));
  get diagnostics saved = row_count;

  -- Absence can mean a truncated snapshot, a moving provider horizon, or an external cancellation.
  update public.reservations r set calendar_missing_since = now()
  where r.space_id = scope and r.channel = calendar.channel and r.source = 'ical'
    and r.status = 'confirmed' and r.ends_at > now() and r.calendar_missing_since is null
    and not exists (select 1 from jsonb_to_recordset(p_events) as e(external_uid text) where e.external_uid = r.external_uid);

  select count(*) into missing_count from public.reservations r
  where r.space_id = scope and r.channel = calendar.channel and r.source = 'ical'
    and r.status = 'confirmed' and r.ends_at > now() and r.calendar_missing_since is not null;

  conflicts_count := public.detect_conflicts(scope);
  unchecked := public.settle_holds(scope);
  success_at := clock_timestamp();
  update public.calendar_imports i set
    sync_lease = null, sync_lease_until = null, last_synced_at = success_at, event_count = jsonb_array_length(p_events),
    last_status = case when missing_count + older_count > 0 then 'error' else 'ok' end,
    last_error = case when missing_count > 0 then 'A previously recorded event is missing. Verify it on the provider. Its time remains occupied.'
      when older_count > 0 then 'The provider returned an older event revision. Everyspace kept the newer booking.' end
  where i.id = p_import;

  return jsonb_build_object('status', case when missing_count + older_count > 0 then 'needs_review' else 'ok' end,
    'seen_at', success_at, 'upserts', saved, 'missing', missing_count, 'older', older_count, 'newConflicts', conflicts_count, 'uncheckedAccepts', unchecked);
end $$;

-- One JSON value avoids silent truncation by the database API's per-response row limit.
create function public.calendar_feed_snapshot(p_space uuid, p_channel public.channel) returns jsonb
language plpgsql stable set search_path = '' as $$
declare events jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(r) order by r.starts_at, r.id), '[]'::jsonb) into events from (
    select e.* from public.calendar_feed_reservations(p_space) e join public.reservations r on r.id = e.id
    where (e.space_id, e.channel) is distinct from (p_space, p_channel)
      and (r.source <> 'ical' or r.kind <> 'block') limit 3001
  ) r;
  if jsonb_array_length(events) > 3000 then raise exception 'Calendar exceeds supported event count.'; end if;
  return events;
end $$;

revoke execute on function public.claim_calendar_sync(uuid, text, integer),
  public.apply_calendar_sync(uuid, uuid, text, jsonb, text), public.calendar_feed_snapshot(uuid, public.channel),
  public.reset_changed_calendar_link() from public, anon, authenticated;
grant execute on function public.claim_calendar_sync(uuid, text, integer),
  public.apply_calendar_sync(uuid, uuid, text, jsonb, text), public.calendar_feed_snapshot(uuid, public.channel)
to service_role;

-- Host mutations go through scoped RPCs. Externally observed facts and managed allocations have distinct write paths.
revoke insert, update, delete on public.reservations from public, anon, authenticated;
drop policy "Hosts manage their reservations" on public.reservations;
create policy "Hosts read their reservations" on public.reservations
  for select to authenticated using (public.owns_space(space_id));

create function public.occupied_units(
  p_space uuid, p_start timestamptz, p_end timestamptz, p_skip_hold uuid, p_bookings_only boolean, p_skip_reservation uuid
) returns int language sql stable security definer set search_path = '' as $$
  with target as (
    select quantity, p_start as starts_at, public.buffered_reservation_end(p_end, turnover_minutes) as ends_at
    from public.spaces where id = p_space
  ), family as (
    select s.id, s.turnover_minutes
    from public.spaces s where s.id in (select public.related_spaces(p_space))
  ), busy as (
    select r.starts_at, public.buffered_reservation_end(r.ends_at, case when r.kind = 'booking' then f.turnover_minutes else 0 end) as ends_at,
      case when r.space_id = p_space and r.kind = 'booking' and r.source <> 'ical' then r.units else t.quantity end as units
    from public.reservations r join family f on f.id = r.space_id cross join target t
    where r.status = 'confirmed' and r.id is distinct from p_skip_reservation and (not p_bookings_only or r.kind <> 'block')
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

create or replace function public.record_external_booking(
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
  if p_source is null or p_source not in ('manual', 'email') then raise exception 'Invalid recording source.'; end if;
  perform public.lock_property(p_space);
  if p_channel = 'everyspace' or (p_channel not in ('direct', 'other') and not exists (
    select 1 from public.channel_listings l where l.space_id = p_space and l.channel = p_channel
  )) then
    raise exception 'Choose a tracked external listing for this booking.';
  end if;
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

create or replace function public.cancel_recorded_external_booking(p_booking uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare space uuid;
begin
  if (select auth.uid()) is null then return false; end if;
  select r.space_id into space from public.reservations r
  where r.id = p_booking and ((r.source in ('manual', 'email') and r.external_uid like 'external:%')
    or (r.source = 'ical' and r.calendar_missing_since is not null)) and public.owns_space(r.space_id);
  if space is null then return false; end if;
  perform public.lock_property(space);
  update public.reservations r set status = 'cancelled', updated_at = now()
  where r.id = p_booking and r.space_id = space and public.owns_space(r.space_id) and (
      (r.source in ('manual', 'email') and r.external_uid like 'external:%')
      or (r.source = 'ical' and r.calendar_missing_since is not null)
    );
  if not found then return false; end if;
  update public.booking_holds set status = 'released', released_reason = 'cancelled'
    where reservation_id = p_booking and status = 'confirmed';
  update public.booking_alerts set resolved_at = now() where reservation_id = p_booking and resolved_at is null;
  perform public.detect_conflicts(space);
  return true;
end $$;


create or replace function public.busy_count(
  p_space uuid, p_start timestamptz, p_end timestamptz, p_skip_hold uuid, p_bookings_only boolean
) returns int language sql stable security definer set search_path = '' as $$
  select public.occupied_units(p_space, p_start, p_end, p_skip_hold, p_bookings_only, null)
$$;

-- Match the allocation check when a calendar does not report the booked unit count.
create or replace function public.detect_conflicts(p_space uuid) returns int
language sql security definer set search_path = '' as $$
  with occupancy as (
    select r.id, r.space_id, r.kind, r.starts_at, e.ends_at, s.quantity,
      case when r.kind = 'owner_block' or r.source = 'ical' then s.quantity else r.units end as units
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

-- A managed confirmation cannot bypass occupancy checks. The existing alphabetically earlier
-- reservations_inventory_lock trigger takes the same per-property lock for all sources.
create function public.enforce_managed_confirmation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare capacity integer;
begin
  if new.status <> 'confirmed' or (new.channel <> 'everyspace' and new.source <> 'everyspace') then return new; end if;
  if new.channel <> 'everyspace' or new.source <> 'everyspace' or new.kind <> 'booking' then
    raise exception 'Invalid Everyspace booking provenance.';
  end if;
  if tg_op = 'UPDATE' then
    if (old.space_id, old.starts_at, old.ends_at, old.units, old.status, old.channel, old.source)
      is not distinct from (new.space_id, new.starts_at, new.ends_at, new.units, new.status, new.channel, new.source) then
      return new;
    end if;
  end if;
  perform public.lock_property(new.space_id);
  select s.quantity into capacity from public.spaces s where s.id = new.space_id;
  if public.occupied_units(new.space_id, new.starts_at, new.ends_at, null, false, new.id) + new.units > capacity then
    raise exception 'These dates would exceed confirmed capacity.' using errcode = 'P0001', hint = 'DATES_TAKEN';
  end if;
  return new;
end $$;

create trigger reservations_managed_confirmation before insert or update on public.reservations
for each row execute function public.enforce_managed_confirmation();

create function public.validate_property_time_zone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names t where t.name = new.timezone) then
    raise exception 'Choose a valid property time zone.';
  end if;
  return new;
end $$;

create trigger properties_validate_time_zone before insert or update of timezone on public.properties
for each row execute function public.validate_property_time_zone();

create function public.reconcile_space_configuration() returns trigger
language plpgsql security definer set search_path = '' as $$
declare candidate uuid;
begin
  if (old.property_id, old.parent_space_id, old.quantity, old.turnover_minutes) is not distinct from
    (new.property_id, new.parent_space_id, new.quantity, new.turnover_minutes) then return new; end if;
  if (old.property_id, old.parent_space_id) is distinct from (new.property_id, new.parent_space_id)
      and exists (
        select 1 from public.channel_listings a join public.channel_listings b on a.id < b.id
        join public.spaces x on x.id = a.space_id
        where x.property_id = new.property_id and a.booking_mode = 'instant' and b.booking_mode = 'instant'
          and a.status in ('pending', 'live') and b.status in ('pending', 'live')
          and b.space_id in (select public.related_spaces(a.space_id))
      ) then
    raise exception 'This change would create overlapping instant-book listings. Change the booking modes first.';
  end if;
  for candidate in select * from public.related_spaces(new.id)
    union select * from public.related_spaces(old.parent_space_id)
  loop
    if exists (
      select 1 from public.reservations r join public.spaces s on s.id = r.space_id
      where r.space_id = candidate and r.source = 'everyspace' and r.status = 'confirmed'
        and public.buffered_reservation_end(r.ends_at, s.turnover_minutes) > now()
        and public.occupied_units(r.space_id, r.starts_at, r.ends_at, null, false, r.id) + r.units > s.quantity
    ) then
      raise exception 'This change would conflict with a managed booking. Review upcoming bookings first.';
    end if;
    perform public.detect_conflicts(candidate);
  end loop;
  return new;
end $$;

create trigger spaces_reconcile_configuration after update of property_id, parent_space_id, quantity, turnover_minutes on public.spaces
for each row execute function public.reconcile_space_configuration();

create function public.record_external_booking_change(
  p_booking uuid, p_observed_updated_at timestamptz, p_start timestamptz, p_end timestamptz,
  p_all_day boolean, p_units integer
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  scope uuid;
  booking public.reservations;
begin
  if (select auth.uid()) is null then return false; end if;
  select r.space_id into scope from public.reservations r where r.id = p_booking and public.owns_space(r.space_id)
    and r.source in ('manual', 'email') and r.external_uid like 'external:%';
  if scope is null then return false; end if;
  perform public.lock_property(scope);
  select * into booking from public.reservations r where r.id = p_booking and r.space_id = scope
    and public.owns_space(r.space_id) and r.source in ('manual', 'email') and r.external_uid like 'external:%' for update;
  if booking.id is null or booking.status <> 'confirmed' then return false; end if;
  if p_start is null or p_end is null or not isfinite(p_start) or not isfinite(p_end) or p_end <= p_start
      or p_all_day is null or p_units is null or p_units not between 1 and (select s.quantity from public.spaces s where s.id = scope) then
    raise exception 'Verify the dates and unit count first.';
  end if;
  if (booking.starts_at, booking.ends_at, booking.all_day, booking.units)
      is not distinct from (p_start, p_end, p_all_day, p_units) then return true; end if;
  if booking.updated_at is distinct from p_observed_updated_at then
    raise exception 'The booking changed since you opened it. Refresh and verify the latest details.';
  end if;
  update public.reservations r set starts_at = p_start, ends_at = p_end, all_day = p_all_day, units = p_units,
    updated_at = clock_timestamp() where r.id = p_booking;
  perform public.detect_conflicts(scope);
  return true;
end $$;

revoke execute on function public.occupied_units(uuid, timestamptz, timestamptz, uuid, boolean, uuid),
  public.enforce_managed_confirmation(), public.reconcile_space_configuration(), public.validate_property_time_zone(),
  public.record_external_booking_change(uuid, timestamptz, timestamptz, timestamptz, boolean, integer) from public, anon, authenticated;
grant execute on function public.record_external_booking_change(uuid, timestamptz, timestamptz, timestamptz, boolean, integer)
to authenticated;

create function public.record_calendar_door_gaps(
  p_import uuid, p_seen_at timestamptz, p_reservations uuid[], p_holds uuid[]
) returns integer language plpgsql set search_path = '' as $$
declare calendar public.calendar_imports;
begin
  select * into calendar from public.calendar_imports where id = p_import;
  if calendar.id is null then return 0; end if;
  perform public.lock_property(calendar.space_id);
  select * into calendar from public.calendar_imports
    where id = p_import and space_id = calendar.space_id and last_synced_at = p_seen_at for update;
  if calendar.id is null or not exists (
    select 1 from public.channel_listings l
    where l.space_id = calendar.space_id and l.channel = calendar.channel
      and l.booking_mode = 'instant' and l.status in ('pending', 'live')
  ) then return 0; end if;
  return public.record_door_gaps(calendar.space_id, calendar.channel, p_reservations, p_holds);
end $$;

revoke execute on function public.record_calendar_door_gaps(uuid, timestamptz, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.record_calendar_door_gaps(uuid, timestamptz, uuid[], uuid[]) to service_role;

-- Private snapshot used to fetch the exact feed that the final hold check will validate.
create function public.manual_guard_snapshot(p_space uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('time_zone', p.timezone, 'turnover', s.turnover_minutes, 'doors', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'space_id', d.space_id, 'channel', d.channel, 'mode_since', l.mode_since, 'import_id', i.id, 'url', i.url
    ) order by d.space_id, d.channel), '[]'::jsonb)
    from public.door_listings(p_space) d
    join public.channel_listings l on l.space_id = d.space_id and l.channel = d.channel
    left join public.calendar_imports i on i.space_id = d.space_id and i.channel = d.channel
  ))
  from public.spaces s join public.properties p on p.id = s.property_id where s.id = p_space
$$;

create function public.mark_hold_checked_snapshot(p_hold uuid, p_snapshot jsonb) returns boolean
language plpgsql set search_path = '' as $$
declare scope_id uuid;
begin
  select h.space_id into scope_id from public.booking_holds h where h.id = p_hold;
  if scope_id is null then return false; end if;
  perform public.lock_property(scope_id);
  perform 1 from public.calendar_imports i join public.door_listings(scope_id) d
    on d.space_id = i.space_id and d.channel = i.channel for share of i;
  if p_snapshot is null or public.manual_guard_snapshot(scope_id) is distinct from p_snapshot then return null; end if;
  return public.mark_hold_safe(p_hold);
end $$;

revoke execute on function public.manual_guard_snapshot(uuid), public.mark_hold_checked_snapshot(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.manual_guard_snapshot(uuid), public.mark_hold_checked_snapshot(uuid, jsonb)
to service_role;

create function public.remove_tracked_listing(p_listing uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare listing public.channel_listings;
begin
  if (select auth.uid()) is null then return false; end if;
  select * into listing from public.channel_listings l where l.id = p_listing and public.owns_space(l.space_id);
  if listing.id is null then return false; end if;
  perform public.lock_property(listing.space_id);
  delete from public.channel_listings l where l.id = p_listing and l.space_id = listing.space_id
    and l.channel = listing.channel and public.owns_space(l.space_id);
  if not found then return false; end if;
  if exists (select 1 from public.channel_api_listings a where a.space_id = listing.space_id
      and a.channel = listing.channel and a.authorized) then
    raise exception 'Disconnect the authorized provider integration before removing this listing.';
  end if;
  delete from public.calendar_imports i where i.space_id = listing.space_id and i.channel = listing.channel;
  delete from public.calendar_feeds f where f.space_id = listing.space_id and f.for_channel = listing.channel;
  return true;
end $$;

revoke execute on function public.remove_tracked_listing(uuid) from public, anon, authenticated;
grant execute on function public.remove_tracked_listing(uuid) to authenticated;

alter table public.booking_holds add column command_id uuid;
create unique index booking_holds_command_idx on public.booking_holds(space_id, command_id) where command_id is not null;

create function public.place_inventory_hold_once(
  p_space uuid, p_channel public.channel, p_start timestamptz, p_end timestamptz, p_all_day boolean,
  p_ref text, p_guest text, p_units integer, p_command_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  existing public.booking_holds;
  result uuid;
begin
  if (select auth.uid()) is null or not public.owns_space(p_space) then raise exception 'Space not found.'; end if;
  if p_command_id is null then raise exception 'A request key is required.'; end if;
  perform public.lock_property(p_space);
  select * into existing from public.booking_holds h where h.space_id = p_space and h.command_id = p_command_id;
  if existing.id is not null then
    if (existing.channel, existing.starts_at, existing.ends_at, existing.all_day, existing.external_ref, existing.guest_name, existing.units)
        is distinct from (p_channel, p_start, p_end, p_all_day, p_ref, p_guest, p_units) then
      raise exception 'This submission already created a hold with other details. Check Requests.';
    end if;
    return existing.id;
  end if;
  result := public.place_inventory_hold(p_space, p_channel, p_start, p_end, p_all_day, p_ref, p_guest, p_units);
  update public.booking_holds set command_id = p_command_id where id = result;
  return result;
end $$;

revoke execute on function public.place_inventory_hold_once(uuid, public.channel, timestamptz, timestamptz, boolean, text, text, integer, uuid)
from public, anon, authenticated;
grant execute on function public.place_inventory_hold_once(uuid, public.channel, timestamptz, timestamptz, boolean, text, text, integer, uuid)
to authenticated;

alter table public.booking_email_reviews drop constraint booking_email_reviews_reported_status_check;
alter table public.booking_email_reviews add constraint booking_email_reviews_reported_status_check
  check (reported_status in ('request', 'confirmed', 'cancelled', 'modified', 'refund', 'unknown'));

create or replace function public.review_booking_email(
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
  if item.reported_status in ('cancelled', 'modified', 'refund') then
    raise exception 'Verify the provider update and reconcile the original calendar entry.';
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

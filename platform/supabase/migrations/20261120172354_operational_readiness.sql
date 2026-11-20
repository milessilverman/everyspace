alter table public.calendar_imports add column last_issue text
  check (last_issue in ('fetch_failed', 'incomplete_import', 'write_failed', 'configuration_changed'));
grant select (last_issue) on public.calendar_imports to authenticated;

create or replace function public.reset_changed_calendar_link() returns trigger
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
    new.last_issue := null;
  end if;
  return new;
end $$;

-- Classify the same committed observation that updated occupancy. A superseded read cannot write health.
create function public.apply_calendar_observation(
  p_import uuid, p_lease uuid, p_time_zone text, p_events jsonb, p_error text, p_issue text
) returns jsonb language plpgsql set search_path = '' as $$
declare result jsonb;
begin
  if p_issue is not null and p_issue not in ('fetch_failed', 'incomplete_import', 'write_failed') then
    raise exception 'Invalid calendar result.';
  end if;
  result := public.apply_calendar_sync(p_import, p_lease, p_time_zone, p_events, p_error);
  if result->>'status' <> 'superseded' then
    update public.calendar_imports set last_issue = case result->>'status'
      when 'needs_review' then 'incomplete_import'
      when 'error' then coalesce(p_issue, 'configuration_changed') end
    where id = p_import;
  end if;
  return result;
end $$;

revoke execute on function public.apply_calendar_observation(uuid, uuid, text, jsonb, text, text)
from public, anon, authenticated;
grant execute on function public.apply_calendar_observation(uuid, uuid, text, jsonb, text, text) to service_role;

-- One scoped query supplies host warnings and the operator aggregate. Both use the caller's existing grants and RLS.
create schema everyspace_ops;
revoke all on schema everyspace_ops from public, anon;
grant usage on schema everyspace_ops to authenticated, service_role;

create index reservations_active_review_idx on public.reservations(space_id, ends_at)
  where status = 'confirmed' and kind = 'booking';

create function everyspace_ops.warnings(p_host uuid, p_checked_at timestamptz)
returns table (kind text, space_id uuid, channel public.channel, affected bigint)
language sql stable security invoker set search_path = '' as $$
  with scoped_spaces as (
    select s.id from public.spaces s join public.properties p on p.id = s.property_id
    where p_host is null or p.host_id = p_host
  ), active_reservations as (
    select r.space_id, r.channel, r.source, r.starts_at, r.ends_at, r.all_day, r.calendar_missing_since
    from public.reservations r join scoped_spaces s on s.id = r.space_id
    where r.status = 'confirmed' and r.kind = 'booking' and r.ends_at > p_checked_at
  ), missing as (
    select r.space_id, r.channel, count(*) as affected
    from active_reservations r where r.calendar_missing_since is not null
    group by r.space_id, r.channel
  ), imports as (
    select i.space_id, i.channel, i.created_at, i.last_attempt_at, i.last_synced_at, i.last_issue, i.last_status
    from public.calendar_imports i join scoped_spaces s on s.id = i.space_id
  ), duplicate_windows as (
    select r.space_id, r.channel
    from active_reservations r
    group by r.space_id, r.channel, r.starts_at, r.ends_at, r.all_day
    having bool_or(r.source = 'ical') and bool_or(r.source in ('manual', 'email', 'api'))
  )
  select 'stale_calendar', i.space_id, i.channel, 1::bigint from imports i
    where coalesce(i.last_synced_at, i.created_at) <= p_checked_at - interval '30 minutes'
  union all
  select 'failed_sync', i.space_id, i.channel, 1::bigint from imports i
    where i.last_status = 'error' and i.last_issue is distinct from 'incomplete_import'
      and (i.last_attempt_at is null or i.last_synced_at is null or i.last_synced_at < i.last_attempt_at)
  union all
  select 'incomplete_import', coalesce(i.space_id, m.space_id), coalesce(i.channel, m.channel),
    coalesce(m.affected, 1::bigint)
    from imports i full join missing m using (space_id, channel)
    where m.affected > 0 or (i.last_status = 'error' and (i.last_issue = 'incomplete_import'
      or i.last_synced_at >= i.last_attempt_at))
  union all
  select 'possible_duplicate', d.space_id, d.channel, count(*) from duplicate_windows d
    group by d.space_id, d.channel
  union all
  select 'unresolved_hold', h.space_id, h.channel, count(*)
    from public.booking_holds h join scoped_spaces s on s.id = h.space_id
    where h.status in ('holding', 'safe') and h.expires_at > p_checked_at
      and ((h.status = 'holding' and h.created_at <= p_checked_at - interval '2 hours')
        or h.expires_at <= p_checked_at + interval '1 hour')
    group by h.space_id, h.channel
  union all
  select 'pending_reconciliation', l.space_id, l.channel, count(*)
    from public.channel_reservation_requests r
    join public.channel_api_listings l on l.id = r.listing_id join scoped_spaces s on s.id = l.space_id
    where r.status = 'uncertain' or (r.status = 'approving' and r.updated_at <= p_checked_at - interval '15 minutes')
    group by l.space_id, l.channel
  union all
  select 'email_update_review', e.space_id, e.channel, count(*)
    from public.booking_email_reviews e join scoped_spaces s on s.id = e.space_id
    where e.status = 'needs_review' and e.reported_status in ('cancelled', 'modified', 'refund')
    group by e.space_id, e.channel
$$;

create function public.host_operational_warnings() returns jsonb
language sql stable security invoker set search_path = '' as $$
  with host as (select auth.uid() as id), items as (
    select w.* from host h cross join lateral everyspace_ops.warnings(h.id, statement_timestamp()) w
      where h.id is not null
  ), first_page as (
    select * from items order by case kind
      when 'pending_reconciliation' then 1 when 'incomplete_import' then 2 when 'failed_sync' then 3
      when 'unresolved_hold' then 4 when 'possible_duplicate' then 5 when 'email_update_review' then 6
      else 7 end, space_id, channel limit 60
  )
  select jsonb_build_object('checked_at', statement_timestamp(), 'total', (select count(*) from items),
    'warnings', coalesce((select jsonb_agg(to_jsonb(w)) from first_page w), '[]'::jsonb))
$$;

create function public.operational_readiness() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('checked_at', statement_timestamp(),
    'warnings', coalesce((select jsonb_object_agg(c.kind, c.affected) from (
      select w.kind, sum(w.affected) as affected from everyspace_ops.warnings(null, statement_timestamp()) w group by w.kind
    ) c), '{}'::jsonb),
    'calendar_connections', (select count(*) from public.calendar_imports),
    'latest_calendar_attempt', (select max(last_attempt_at) from public.calendar_imports))
$$;

revoke execute on function everyspace_ops.warnings(uuid, timestamptz),
  public.host_operational_warnings(), public.operational_readiness() from public, anon, authenticated;
grant execute on function everyspace_ops.warnings(uuid, timestamptz) to authenticated, service_role;
grant execute on function public.host_operational_warnings() to authenticated;
grant execute on function public.operational_readiness() to service_role;

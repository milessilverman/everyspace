-- A changed time or status at the same explicit iCal sequence is ambiguous.
-- Keep the recorded booking and surface the observation for review.
create or replace function public.apply_calendar_sync(
  p_import uuid, p_lease uuid, p_time_zone text, p_events jsonb, p_error text default null
) returns jsonb language plpgsql set search_path = '' as $$
declare
  scope uuid;
  calendar public.calendar_imports;
  saved integer := 0;
  missing_count integer := 0;
  conflicts_count integer := 0;
  older_count integer := 0;
  revision_conflicts integer := 0;
  unchecked integer := 0;
  success_at timestamptz;
  needs_review boolean;
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

  select count(*) filter (where e.calendar_sequence is null or e.calendar_sequence < r.calendar_sequence),
         count(*) filter (where e.calendar_sequence = r.calendar_sequence
           and (r.kind, r.status, r.starts_at, r.ends_at, r.all_day)
               is distinct from (e.kind, e.status, e.starts_at, e.ends_at, e.all_day))
    into older_count, revision_conflicts
  from public.reservations r
  join jsonb_to_recordset(p_events) as e(external_uid text, calendar_sequence integer, kind text,
    status text, starts_at timestamptz, ends_at timestamptz, all_day boolean) on e.external_uid = r.external_uid
  where r.space_id = scope and r.channel = calendar.channel and r.source = 'ical' and r.calendar_sequence is not null;

  insert into public.reservations as r
    (space_id, channel, external_uid, kind, source, status, starts_at, ends_at, all_day, summary, calendar_sequence)
  select scope, calendar.channel, e.external_uid, e.kind, 'ical', e.status, e.starts_at, e.ends_at, e.all_day,
    case when e.kind = 'booking' then 'Reserved' else 'Unavailable' end, e.calendar_sequence
  from jsonb_to_recordset(p_events) as e(external_uid text, kind text, status text, starts_at timestamptz,
    ends_at timestamptz, all_day boolean, calendar_sequence integer)
  on conflict (space_id, channel, external_uid) do update
    set kind = excluded.kind, status = excluded.status, starts_at = excluded.starts_at,
        ends_at = excluded.ends_at, all_day = excluded.all_day, summary = excluded.summary,
        calendar_missing_since = null, calendar_sequence = excluded.calendar_sequence, updated_at = now()
    where r.source = 'ical'
      and (r.calendar_sequence is null or excluded.calendar_sequence > r.calendar_sequence
        or (excluded.calendar_sequence = r.calendar_sequence and
          (r.kind, r.status, r.starts_at, r.ends_at, r.all_day)
          is not distinct from (excluded.kind, excluded.status, excluded.starts_at, excluded.ends_at, excluded.all_day)))
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
  needs_review := missing_count + older_count + revision_conflicts > 0;
  update public.calendar_imports i set
    sync_lease = null, sync_lease_until = null, last_synced_at = success_at, event_count = jsonb_array_length(p_events),
    last_status = case when needs_review then 'error' else 'ok' end,
    last_error = case when missing_count > 0 then 'A previously recorded event is missing. Verify it on the provider. Its time remains occupied.'
      when revision_conflicts > 0 then 'The provider returned different details for the same event revision. Verify the change on the provider.'
      when older_count > 0 then 'The provider returned an older event revision. Everyspace kept the newer booking.' end
  where i.id = p_import;

  return jsonb_build_object('status', case when needs_review then 'needs_review' else 'ok' end,
    'seen_at', success_at, 'upserts', saved, 'missing', missing_count, 'older', older_count, 'revision_conflicts', revision_conflicts,
    'newConflicts', conflicts_count, 'uncheckedAccepts', unchecked);
end $$;

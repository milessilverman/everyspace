-- Provider authorization and listing identity are provisioned by the service role after partner onboarding.
create table public.channel_api_listings (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete restrict,
  channel public.channel not null check (channel in ('airbnb', 'vrbo')),
  account_ref text not null check (length(account_ref) between 1 and 240),
  listing_ref text not null check (length(listing_ref) between 1 and 240),
  authorized boolean not null default false,
  approval_supported boolean not null default false,
  auto_approve boolean not null default false check (not auto_approve or (authorized and approval_supported)),
  unique (space_id, channel),
  unique (channel, account_ref, listing_ref)
);

create table public.channel_reservation_requests (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.channel_api_listings(id) on delete restrict,
  external_request_ref text not null check (length(external_request_ref) between 1 and 240),
  check_in date,
  check_out date,
  starts_at timestamptz,
  ends_at timestamptz check (ends_at > starts_at),
  expected_net_minor bigint check (expected_net_minor between 0 and 9007199254740991),
  currency text check (currency ~ '^[A-Z]{3}$'),
  expires_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'approving', 'uncertain', 'confirmed', 'declined', 'expired', 'cancelled')),
  reason text not null default 'received',
  decision jsonb not null default '{}'::jsonb,
  provider_reservation_ref text,
  reservation_id uuid unique references public.reservations(id) on delete restrict,
  approval_started_at timestamptz,
  observed_at timestamptz,
  eligible_at timestamptz,
  next_attempt_at timestamptz default clock_timestamp(),
  retry_count int not null default 0 check (retry_count >= 0),
  event_version bigint not null default 1,
  lease_version bigint,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (listing_id, external_request_ref),
  unique (listing_id, provider_reservation_ref),
  check ((expected_net_minor is null) = (currency is null)),
  check ((status not in ('approving', 'uncertain')) or
    (approval_started_at is not null and starts_at is not null and ends_at is not null))
);
create index channel_reservation_due_idx on public.channel_reservation_requests(next_attempt_at, id)
  where next_attempt_at is not null;
create index channel_reservation_active_idx on public.channel_reservation_requests(listing_id, starts_at, ends_at)
  where status in ('pending', 'approving', 'uncertain');

create table public.channel_reservation_events (
  listing_id uuid not null references public.channel_api_listings(id) on delete restrict,
  delivery_ref text not null check (length(delivery_ref) between 1 and 240),
  request_id uuid not null references public.channel_reservation_requests(id) on delete restrict,
  received_at timestamptz not null default clock_timestamp(),
  primary key (listing_id, delivery_ref)
);
create index on public.channel_reservation_events(request_id);

create table public.channel_reservation_audit (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.channel_reservation_requests(id) on delete restrict,
  previous_status text,
  status text not null,
  reason text not null,
  decision jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index on public.channel_reservation_audit(request_id, created_at);

alter table public.channel_api_listings enable row level security;
alter table public.channel_reservation_requests enable row level security;
alter table public.channel_reservation_audit enable row level security;
alter table public.channel_reservation_events enable row level security;

create policy "Hosts see API listings in their spaces" on public.channel_api_listings
  for select to authenticated using (public.owns_space(space_id));
create policy "Hosts see API requests in their spaces" on public.channel_reservation_requests
  for select to authenticated using (listing_id in (select l.id from public.channel_api_listings l));
create policy "Hosts see API decisions in their spaces" on public.channel_reservation_audit
  for select to authenticated using (request_id in (select r.id from public.channel_reservation_requests r));

revoke all on public.channel_api_listings, public.channel_reservation_requests,
  public.channel_reservation_events, public.channel_reservation_audit from public, anon, authenticated;
grant select (id, space_id, channel, authorized, approval_supported, auto_approve)
  on public.channel_api_listings to authenticated;
grant select (id, listing_id, starts_at, ends_at, status, reason, updated_at, created_at)
  on public.channel_reservation_requests to authenticated;
grant select on public.channel_reservation_audit to authenticated;
grant select, insert, update on public.channel_api_listings, public.channel_reservation_requests to service_role;
grant select, insert on public.channel_reservation_events, public.channel_reservation_audit to service_role;

-- The calendar importer cannot overwrite an authoritative confirmation. Hosts can still manage other sources.
create policy "Hosts cannot create API reservations" on public.reservations as restrictive
  for insert to authenticated with check (source <> 'api');
create policy "Hosts cannot change API reservations" on public.reservations as restrictive
  for update to authenticated using (source <> 'api') with check (source <> 'api');
create policy "Hosts cannot delete API reservations" on public.reservations as restrictive
  for delete to authenticated using (source <> 'api');

create function public.lock_reservation_inventory() returns trigger
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
    if old.source = 'api' and new.source = 'ical' then return null; end if;
  elsif tg_table_name = 'channel_api_listings' and tg_op = 'UPDATE' then
    if (old.space_id, old.channel, old.account_ref, old.listing_ref) is distinct from
       (new.space_id, new.channel, new.account_ref, new.listing_ref) then
      raise exception 'A verified API listing cannot be reassigned.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger reservations_inventory_lock before insert or update or delete on public.reservations
  for each row execute function public.lock_reservation_inventory();
create trigger channel_listings_inventory_lock before insert or update or delete on public.channel_listings
  for each row execute function public.lock_reservation_inventory();
create trigger channel_api_listings_inventory_lock before insert or update on public.channel_api_listings
  for each row execute function public.lock_reservation_inventory();

-- Moving spaces or changing capacity or timezone during a provider write could invalidate its hold.
create function public.guard_channel_inventory_edits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  property_ids uuid[];
  space uuid;
begin
  if tg_table_name = 'spaces' then
    if (old.property_id, old.parent_space_id, old.quantity) is not distinct from
       (new.property_id, new.parent_space_id, new.quantity) then return new; end if;
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
  return new;
end $$;
create trigger spaces_channel_inventory_guard before update of property_id, parent_space_id, quantity on public.spaces
  for each row execute function public.guard_channel_inventory_edits();
create trigger properties_channel_inventory_guard before update of timezone on public.properties
  for each row execute function public.guard_channel_inventory_edits();

create function public.audit_channel_reservation() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' or (old.status, old.reason, old.decision) is distinct from (new.status, new.reason, new.decision) then
    insert into public.channel_reservation_audit(request_id, previous_status, status, reason, decision)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, new.reason, new.decision);
  end if;
  return new;
end $$;
create trigger channel_reservation_audit after insert or update on public.channel_reservation_requests
  for each row execute function public.audit_channel_reservation();

-- Manual holds and guard checks use the same inventory as automatic approvals. Ambiguous provider writes
-- reserve the dates until the provider verifies a terminal result, including after the worker lease expires.
create or replace function public.busy_count(p_space uuid, p_start timestamptz, p_end timestamptz, p_skip_hold uuid, p_bookings_only boolean)
returns int language sql stable security definer set search_path = '' as $$
  with related as (select public.related_spaces(p_space) as id)
  select case when exists (
    select 1 from public.channel_reservation_requests r join public.channel_api_listings l on l.id = r.listing_id
    where l.space_id in (select id from related) and r.status in ('approving', 'uncertain')
      and tstzrange(r.starts_at, r.ends_at) && tstzrange(p_start, p_end)
  ) then (select quantity from public.spaces where id = p_space) else
    (select count(*) from public.reservations r
      where r.space_id in (select id from related) and r.status = 'confirmed'
        and (not p_bookings_only or r.kind = 'booking')
        and tstzrange(r.starts_at, r.ends_at) && tstzrange(p_start, p_end))::int
    + (select count(*) from public.booking_holds h
      where h.space_id in (select id from related) and h.status in ('holding', 'safe') and h.expires_at > now()
        and h.id is distinct from p_skip_hold
        and tstzrange(h.starts_at, h.ends_at) && tstzrange(p_start, p_end))::int
  end;
$$;

-- Rechecks of previously safe manual holds also consult current shared inventory.
create or replace function public.mark_hold_safe(p_hold uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare h public.booking_holds; qty int;
begin
  select * into h from public.booking_holds where id = p_hold;
  if h.id is null then return false; end if;
  perform public.lock_property(h.space_id);
  select * into h from public.booking_holds where id = p_hold for update;
  if h.status not in ('holding', 'safe') or h.expires_at <= clock_timestamp() then return false; end if;
  select quantity into qty from public.spaces where id = h.space_id;
  -- Dates the host closed are expected here (that is the point); only guest bookings and other holds count.
  if public.busy_count(h.space_id, h.starts_at, h.ends_at, h.id, true) >= qty then
    update public.booking_holds set status = 'released', released_reason = 'taken' where id = p_hold;
    return false;
  end if;
  if h.status = 'safe' then return true; end if;
  -- Safe holds last long enough for the site's 24-hour accept window plus calendar lag.
  update public.booking_holds set status = 'safe', verified_at = now(), expires_at = greatest(expires_at, now() + interval '3 days')
  where id = p_hold;
  return true;
end $$;

-- The calendar fallback may settle only the matching manual hold for an API record.
create or replace function public.settle_holds(p_space uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare added int;
begin
  perform public.lock_property(p_space);
  update public.booking_holds h set status = 'confirmed', reservation_id = r.id
  from public.reservations r
  where h.space_id = p_space and h.status in ('holding', 'safe')
    and r.space_id = h.space_id and r.channel = h.channel and r.status = 'confirmed' and r.kind = 'booking'
    and tstzrange(r.starts_at, r.ends_at) && tstzrange(h.starts_at, h.ends_at)
    and (r.source <> 'api' or exists (
      select 1 from public.channel_reservation_requests q
      where q.reservation_id = r.id and h.external_ref in (q.external_request_ref, q.provider_reservation_ref)
    ))
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
    and not exists (select 1 from public.channel_reservation_requests q
      where q.reservation_id = r.id and q.approval_started_at is not null)
  on conflict (kind, channel, reservation_id, hold_id) do nothing;
  get diagnostics added = row_count;
  return added;
end $$;

create function public.enqueue_channel_reservation_event(
  p_channel public.channel, p_account text, p_listing text, p_delivery text, p_ref text
) returns text language plpgsql set search_path = '' as $$
declare
  integration public.channel_api_listings;
  existing_ref text;
  request_id uuid;
begin
  select * into integration from public.channel_api_listings l
    where l.channel = p_channel and l.account_ref = p_account and l.listing_ref = p_listing and l.authorized;
  if integration.id is null then return 'unknown_listing'; end if;
  perform public.lock_property(integration.space_id);
  if not exists (select 1 from public.channel_api_listings l where l.id = integration.id and l.authorized
      and l.account_ref = p_account and l.listing_ref = p_listing and l.channel = p_channel) then
    return 'unknown_listing';
  end if;
  select r.external_request_ref into existing_ref
    from public.channel_reservation_events e join public.channel_reservation_requests r on r.id = e.request_id
    where e.listing_id = integration.id and e.delivery_ref = p_delivery;
  if found then
    return case when existing_ref = p_ref then 'duplicate' else 'mismatch' end;
  end if;

  insert into public.channel_reservation_requests as r(listing_id, external_request_ref)
    values (integration.id, p_ref)
    on conflict (listing_id, external_request_ref) do update
      set event_version = r.event_version + 1, next_attempt_at = clock_timestamp(), retry_count = 0
    returning id into request_id;
  insert into public.channel_reservation_events(listing_id, delivery_ref, request_id)
    values (integration.id, p_delivery, request_id);
  return 'queued';
end $$;

create function public.claim_channel_reservation_work() returns jsonb
language plpgsql set search_path = '' as $$
declare work jsonb;
begin
  with candidate as (
    select r.id from public.channel_reservation_requests r
    join public.channel_api_listings l on l.id = r.listing_id
    where l.authorized and r.next_attempt_at <= clock_timestamp()
      and (r.lease_until is null or r.lease_until <= clock_timestamp())
    order by r.next_attempt_at, r.id
    for update of r skip locked limit 1
  ), leased as (
    update public.channel_reservation_requests r set lease_token = gen_random_uuid(),
      lease_until = clock_timestamp() + interval '90 seconds', lease_version = r.event_version
    from candidate where r.id = candidate.id returning r.*
  )
  select jsonb_build_object('id', r.id, 'token', r.lease_token, 'listingId', l.id, 'request',
    jsonb_build_object('channel', l.channel, 'accountRef', l.account_ref, 'listingRef', l.listing_ref,
      'externalRequestId', r.external_request_ref))
  into work from leased r join public.channel_api_listings l on l.id = r.listing_id;
  return work;
end $$;

-- All state transitions take the property lock before the request row lock.
create function public.lock_channel_reservation_request(p_request uuid, p_token uuid)
returns public.channel_reservation_requests language plpgsql set search_path = '' as $$
declare
  request public.channel_reservation_requests;
  space uuid;
begin
  select l.space_id into space
    from public.channel_reservation_requests r join public.channel_api_listings l on l.id = r.listing_id
    where r.id = p_request;
  if space is null then return null; end if;
  perform public.lock_property(space);
  select * into request from public.channel_reservation_requests r
    where r.id = p_request and r.lease_token = p_token and r.lease_until > clock_timestamp() for update;
  if request.lease_version <> request.event_version then
    update public.channel_reservation_requests set lease_token = null, lease_until = null where id = p_request;
    return null;
  end if;
  return request;
end $$;

create function public.record_channel_reservation_result(p_request uuid, p_token uuid, p_state text, p_details jsonb)
returns text language plpgsql set search_path = '' as $$
declare
  request public.channel_reservation_requests := public.lock_channel_reservation_request(p_request, p_token);
  integration public.channel_api_listings;
  tz text;
  provider_check_in date;
  provider_check_out date;
  arrival timestamptz;
  departure timestamptz;
  ref text := nullif(p_details->>'reservationRef', '');
  calendar_uid text := nullif(p_details->>'calendarUid', '');
  reservation uuid;
  due timestamptz;
  result_reason text;
  status_after text;
  conflict_space uuid;
begin
  if request.id is null then return 'lease_lost'; end if;
  select * into integration from public.channel_api_listings where id = request.listing_id;

  if p_state = 'pending' and request.status in ('approving', 'uncertain') then
    p_state := 'retry';
    p_details := jsonb_build_object('reason', 'confirmation_unverified');
  end if;
  if request.status = 'confirmed' and p_state in ('pending', 'declined', 'expired')
      or request.status = 'cancelled' and p_state in ('pending', 'confirmed') then
    p_state := 'retry';
    p_details := jsonb_build_object('reason', 'provider_state_conflict');
  end if;
  if p_state = 'confirmed' and (ref is null or length(ref) > 240 or length(calendar_uid) > 512
      or (request.provider_reservation_ref is not null and request.provider_reservation_ref <> ref)
      or p_details->>'checkIn' is null or p_details->>'checkOut' is null) then
    p_state := 'retry';
    p_details := jsonb_build_object('reason', 'confirmation_unverified');
  end if;
  if p_state = 'cancelled' and (ref is null or length(ref) > 240
      or (request.provider_reservation_ref is not null and request.provider_reservation_ref <> ref)) then
    p_state := 'retry';
    p_details := jsonb_build_object('reason', 'confirmation_unverified');
  end if;

  if p_state in ('pending', 'confirmed') then
    provider_check_in := (p_details->>'checkIn')::date;
    provider_check_out := (p_details->>'checkOut')::date;
    if provider_check_in is null or provider_check_out is null or provider_check_in >= provider_check_out then
      p_state := 'retry';
      p_details := jsonb_build_object('reason', 'provider_dates_invalid');
    else
      select p.timezone into tz from public.spaces s join public.properties p on p.id = s.property_id where s.id = integration.space_id;
      arrival := provider_check_in::timestamp at time zone tz;
      departure := provider_check_out::timestamp at time zone tz;
    end if;
  end if;

  if p_state = 'retry' then
    status_after := case when request.status = 'approving' then 'uncertain' else request.status end;
    result_reason := case when status_after = 'uncertain' then 'confirmation_unverified'
      else coalesce(p_details->>'reason', 'provider_read_failed') end;
    -- Back off read-only checks for 15 seconds through eight minutes. Fresh events restart the budget.
    due := case when request.retry_count < 7 then
      clock_timestamp() + make_interval(secs => least(480, 15 * power(2, request.retry_count))) end;
    update public.channel_reservation_requests set status = status_after, reason = result_reason,
      retry_count = retry_count + 1, next_attempt_at = due, lease_token = null, lease_until = null,
      updated_at = clock_timestamp()
    where id = p_request;
    return status_after;
  end if;

  if p_state = 'pending' then
    if request.status <> 'pending' then
      update public.channel_reservation_requests set next_attempt_at = null, lease_token = null, lease_until = null where id = p_request;
      return request.status;
    end if;
    due := coalesce(request.eligible_at, clock_timestamp() + interval '3 seconds');
    result_reason := case
      when not (integration.authorized and integration.approval_supported and integration.auto_approve) then 'automation_off'
      when (p_details->>'expiresAt')::timestamptz <= clock_timestamp() then 'provider_deadline_passed'
      when departure <= clock_timestamp() then 'provider_deadline_passed'
      when due > clock_timestamp() then 'waiting_for_requests'
      else 'ready' end;
    update public.channel_reservation_requests set
      check_in = provider_check_in, check_out = provider_check_out,
      starts_at = arrival, ends_at = departure,
      expected_net_minor = (p_details#>>'{quote,netMinor}')::bigint, currency = p_details#>>'{quote,currency}',
      expires_at = (p_details->>'expiresAt')::timestamptz, eligible_at = due, observed_at = clock_timestamp(),
      next_attempt_at = case when result_reason = 'ready' then clock_timestamp()
        when result_reason = 'waiting_for_requests' then due
        when result_reason = 'provider_deadline_passed' then clock_timestamp() + interval '5 minutes' end,
      lease_token = case when result_reason = 'ready' then lease_token end,
      lease_until = case when result_reason = 'ready' then lease_until end,
      reason = case when result_reason = 'ready' then reason else result_reason end,
      updated_at = clock_timestamp()
    where id = p_request;
    return result_reason;
  end if;

  reservation := request.reservation_id;
  if p_state = 'confirmed' then
    if reservation is null then
      insert into public.reservations as r(space_id, channel, external_uid, kind, status, source, starts_at, ends_at, all_day)
        values (integration.space_id, integration.channel, coalesce(calendar_uid, 'provider:' || ref),
          'booking', 'confirmed', 'api', arrival, departure, true)
      on conflict (space_id, channel, external_uid) do update set kind = 'booking', status = 'confirmed', source = 'api',
        starts_at = excluded.starts_at, ends_at = excluded.ends_at, all_day = true, updated_at = clock_timestamp()
        where r.source = 'ical' and calendar_uid is not null
      returning id into reservation;
      if reservation is null then
        update public.channel_reservation_requests set
          status = case when status = 'approving' then 'uncertain' else status end,
          reason = 'provider_identity_conflict', next_attempt_at = null, lease_token = null, lease_until = null,
          updated_at = clock_timestamp() where id = p_request;
        return 'provider_identity_conflict';
      end if;
    else
      update public.reservations set starts_at = arrival, ends_at = departure, updated_at = clock_timestamp() where id = reservation;
    end if;
    result_reason := case
      when request.approval_started_at is null then 'provider_confirmed_independently'
      when (request.starts_at, request.ends_at) is distinct from (arrival, departure) then 'provider_dates_changed'
      else 'provider_confirmed' end;
  elsif p_state = 'cancelled' then
    update public.reservations set status = 'cancelled', updated_at = clock_timestamp() where id = reservation;
    result_reason := 'provider_cancelled';
  elsif p_state in ('declined', 'expired') then
    result_reason := 'provider_' || p_state;
  else
    raise exception 'Invalid provider state';
  end if;
  update public.channel_reservation_requests set status = p_state, reason = result_reason,
    provider_reservation_ref = coalesce(ref, provider_reservation_ref), reservation_id = reservation,
    check_in = coalesce(provider_check_in, channel_reservation_requests.check_in),
    check_out = coalesce(provider_check_out, channel_reservation_requests.check_out),
    starts_at = coalesce(arrival, starts_at), ends_at = coalesce(departure, ends_at),
    observed_at = clock_timestamp(), updated_at = clock_timestamp(),
    next_attempt_at = null, lease_token = null, lease_until = null, retry_count = 0
  where id = p_request;
  if reservation is not null then
    for conflict_space in select public.related_spaces(integration.space_id) loop
      perform public.detect_conflicts(conflict_space);
    end loop;
  end if;
  return p_state;
end $$;

-- Require fresh direct coverage for every active external listing that can occupy the same inventory.
create function public.channel_approval_scope(p_request uuid, p_token uuid) returns jsonb
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
  from listings l left join public.channel_api_listings a on a.space_id = l.space_id and a.channel = l.channel;
$$;

create function public.prepare_channel_reservation_approval(p_request uuid, p_token uuid, p_proof jsonb)
returns text language plpgsql set search_path = '' as $$
declare
  request public.channel_reservation_requests := public.lock_channel_reservation_request(p_request, p_token);
  integration public.channel_api_listings;
  scope jsonb;
  evaluated_at timestamptz := clock_timestamp();
  winner uuid;
  incomparable boolean;
  result_reason text;
  context jsonb;
  retry_delay interval := interval '30 seconds';
begin
  if request.id is null or request.status <> 'pending' or request.approval_started_at is not null then return 'lease_lost'; end if;
  select * into integration from public.channel_api_listings where id = request.listing_id;
  scope := public.channel_approval_scope(p_request, p_token);
  context := jsonb_build_object('expected_net_minor', request.expected_net_minor, 'currency', request.currency);
  if not (integration.authorized and integration.approval_supported and integration.auto_approve) then
    result_reason := 'automation_off';
    retry_delay := null;
  elsif not exists (select 1 from public.channel_listings l where l.space_id = integration.space_id
      and l.channel = integration.channel and l.status = 'live' and l.booking_mode = 'request') then
    result_reason := 'request_mode_required';
  elsif exists (select 1 from public.door_listings(integration.space_id) where channel <> 'everyspace') then
    result_reason := 'independent_instant_booking';
  elsif exists (select 1 from public.spaces s where s.id in (select public.related_spaces(integration.space_id)) and s.quantity <> 1) then
    result_reason := 'capacity_requires_review';
  elsif request.eligible_at is null or request.eligible_at > evaluated_at or request.starts_at is null or request.ends_at <= evaluated_at
      or request.expires_at <= evaluated_at or request.observed_at is null or request.observed_at <= evaluated_at - interval '20 seconds' then
    result_reason := 'request_unverified';
  elsif public.busy_count(integration.space_id, request.starts_at, request.ends_at, null, false) > 0 then
    result_reason := 'dates_taken';
    retry_delay := interval '5 minutes';
  elsif not exists (select 1 from jsonb_array_elements(scope) s where s#>>'{listing,id}' = integration.id::text) or exists (
    select 1 from jsonb_array_elements(scope) s
    where not exists (
      select 1 from jsonb_array_elements(p_proof) proof
      where proof->>'listingId' = s#>>'{listing,id}' and proof->>'state' = 'clear'
        and (proof->>'bookingMode' = 'request' or (proof->>'bookingMode' = 'closed' and proof->>'listingId' <> integration.id::text))
        and (proof->>'observedAt')::timestamptz between evaluated_at - interval '20 seconds' and evaluated_at
    )
  ) then
    result_reason := 'availability_unverified';
  elsif exists (
    select 1 from public.channel_reservation_requests peer join public.channel_api_listings a on a.id = peer.listing_id
    where peer.id <> p_request and a.auto_approve and peer.status = 'pending' and peer.starts_at is null
      and a.space_id in (select public.related_spaces(integration.space_id))
  ) then
    result_reason := 'competing_request_unverified';
    retry_delay := interval '3 seconds';
  else
    with candidates as (
      select peer.id, peer.expected_net_minor, peer.currency, peer.created_at
      from public.channel_reservation_requests peer join public.channel_api_listings a on a.id = peer.listing_id
      join public.channel_listings l on l.space_id = a.space_id and l.channel = a.channel
      where a.auto_approve and peer.status = 'pending' and l.status = 'live' and l.booking_mode = 'request'
        and a.space_id in (select public.related_spaces(integration.space_id))
        and (peer.expires_at is null or peer.expires_at > evaluated_at)
        and tstzrange(peer.starts_at, peer.ends_at) && tstzrange(request.starts_at, request.ends_at)
        and public.busy_count(a.space_id, peer.starts_at, peer.ends_at, null, false) = 0
    )
    select (select id from candidates order by expected_net_minor desc nulls last, created_at, id limit 1),
      exists (select 1 from candidates where id <> p_request
        and (expected_net_minor is null or request.expected_net_minor is null or currency <> request.currency))
    into winner, incomparable;
    if incomparable then
      result_reason := 'competing_quotes_unverified';
    elsif winner is distinct from p_request then
      result_reason := 'competing_request_preferred';
      context := context || jsonb_build_object('preferred_request_id', winner);
      retry_delay := interval '3 seconds';
    else
      update public.channel_reservation_requests set status = 'approving', reason = 'approval_started',
        approval_started_at = evaluated_at, updated_at = evaluated_at, retry_count = 0,
        decision = context || jsonb_build_object('operation_id', p_request, 'availability', p_proof)
      where id = p_request;
      return 'approving';
    end if;
  end if;
  update public.channel_reservation_requests set reason = result_reason, decision = context,
    lease_token = null, lease_until = null, next_attempt_at = evaluated_at + retry_delay, updated_at = evaluated_at
  where id = p_request;
  return result_reason;
end $$;

revoke execute on function public.lock_reservation_inventory(), public.guard_channel_inventory_edits(),
  public.audit_channel_reservation(),
  public.enqueue_channel_reservation_event(public.channel, text, text, text, text), public.claim_channel_reservation_work(),
  public.lock_channel_reservation_request(uuid, uuid), public.record_channel_reservation_result(uuid, uuid, text, jsonb),
  public.channel_approval_scope(uuid, uuid), public.prepare_channel_reservation_approval(uuid, uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.enqueue_channel_reservation_event(public.channel, text, text, text, text),
  public.claim_channel_reservation_work(), public.lock_channel_reservation_request(uuid, uuid),
  public.record_channel_reservation_result(uuid, uuid, text, jsonb), public.channel_approval_scope(uuid, uuid),
  public.prepare_channel_reservation_approval(uuid, uuid, jsonb), public.lock_property(uuid), public.related_spaces(uuid),
  public.busy_count(uuid, timestamptz, timestamptz, uuid, boolean)
to service_role;

-- M5: resource-based availability and conflict engine (docs/schema-proposal.md, "Availability rules (M5)").
--
-- One definition of "is this time free?", availability_conflicts(), used by every path that books or flags:
--   create_booking       Everyspace-originated bookings and host blocks: rejected on any conflict.
--   import_reservations  what a marketplace reports: always recorded, then flagged; never rejected.
--   place_hold           holds for requests from other sites (same name and signature as before).
--   detect_conflicts     records conflicting pairs in public.conflicts (same name and signature as before).
-- Every writer takes lock_property() first, so two writers for the same property run one after the other.
-- core/availability.js mirrors these rules; platform/tests/availability_parity.test.mjs keeps the two equal.
--
-- Rules: half-open ranges; a reservation or hold occupies its own space for [start - setup, end + cleanup) (buffers do
-- not extend onto related spaces or resources); a space is blocked by itself, its ancestors, its descendants and any
-- space with a relation that blocks it; quantity n allows n overlapping bookings; a shared resource's units in use at
-- any one moment (peak, not total) must stay <= its capacity; live holds count; cancelled reservations never count;
-- kinds 'block' and 'owner_block' occupy like bookings.

-- ---------------------------------------------------------------- columns
alter table public.spaces
  add column setup_minutes int not null default 0 check (setup_minutes >= 0),
  add column cleanup_minutes int not null default 0 check (cleanup_minutes >= 0);
comment on column public.spaces.setup_minutes is 'Time blocked before each booking of this space (setup). Not applied to related spaces.';
comment on column public.spaces.cleanup_minutes is 'Time blocked after each booking of this space (cleaning). Not applied to related spaces.';

alter table public.reservations add column exclusive boolean not null default false;
comment on column public.reservations.exclusive is
  'Set only by create_booking on quantity-1 spaces. Exclusive confirmed rows of one space can never overlap (exclusion constraint). Imported rows are never exclusive: they record what a marketplace reports.';

alter table public.calendar_imports
  add column consecutive_failures int not null default 0 check (consecutive_failures >= 0),
  add column last_ok_at timestamptz;
update public.calendar_imports set last_ok_at = last_synced_at where last_status = 'ok';

-- Keeps the two columns right for writers that only set last_status (today's calendar-sync function). A writer that
-- sets consecutive_failures itself is left alone.
create function public.track_import_health() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.consecutive_failures is distinct from old.consecutive_failures then return new; end if;
  if new.last_status = 'ok' and (new.last_synced_at is distinct from old.last_synced_at or old.last_status is distinct from 'ok') then
    new.consecutive_failures := 0;
    if new.last_ok_at is not distinct from old.last_ok_at then new.last_ok_at := coalesce(new.last_synced_at, now()); end if;
  elsif new.last_status = 'error' and (new.last_synced_at is distinct from old.last_synced_at or old.last_status is distinct from 'error') then
    new.consecutive_failures := old.consecutive_failures + 1;
  end if;
  return new;
end $$;
create trigger calendar_imports_health before update of last_status, last_synced_at on public.calendar_imports
  for each row execute function public.track_import_health();

-- ---------------------------------------------------------------- relations and shared resources
-- A booking on space_id blocks blocks_space_id (an event on the lawn blocks the pool). symmetric = both ways
-- (a studio and a hot tub that overlook each other). No row = independent (an ADU does not block the driveway).
-- Not transitive, and not inherited by children or parents.
create table public.space_relations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  blocks_space_id uuid not null references public.spaces (id) on delete cascade,
  "symmetric" boolean not null default false,
  note text check (length(note) <= 300),
  created_at timestamptz not null default now(),
  check (space_id <> blocks_space_id),
  unique (space_id, blocks_space_id)
);
create index on public.space_relations (blocks_space_id);

-- Something several spaces draw on: one bathroom for two rooms, four parking places for the house, the ADU and the RV pad.
create table public.resources (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  capacity int not null check (capacity between 1 and 10000),
  created_at timestamptz not null default now()
);
create index on public.resources (property_id);

create table public.space_resources (
  space_id uuid not null references public.spaces (id) on delete cascade,
  resource_id uuid not null references public.resources (id) on delete cascade,
  units int not null default 1 check (units between 1 and 10000),
  created_at timestamptz not null default now(),
  primary key (space_id, resource_id)
);
create index on public.space_resources (resource_id);

-- Relations and resource links stay within one property.
create function public.check_same_property() returns trigger
language plpgsql security definer set search_path = '' as $$
declare a uuid; b uuid;
begin
  select property_id into a from public.spaces where id = new.space_id;
  if tg_table_name = 'space_relations' then
    select property_id into b from public.spaces where id = new.blocks_space_id;
  else
    select property_id into b from public.resources where id = new.resource_id;
  end if;
  if a is null or b is null or a <> b then
    raise exception 'That record does not belong to this property or organization.' using errcode = '23503';
  end if;
  return new;
end $$;
create trigger space_relations_same_property before insert or update on public.space_relations
  for each row execute function public.check_same_property();
create trigger space_resources_same_property before insert or update on public.space_resources
  for each row execute function public.check_same_property();
-- A resource cannot move to another property while spaces elsewhere use it.
create function public.check_resource_move() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.property_id <> old.property_id and exists (select 1 from public.space_resources where resource_id = new.id) then
    raise exception 'That record does not belong to this property or organization.' using errcode = '23503';
  end if;
  return new;
end $$;
create trigger resources_property_move before update of property_id on public.resources
  for each row execute function public.check_resource_move();
-- A space cannot move to another property while it has relations or resource links.
create function public.check_space_move() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.property_id <> old.property_id and (
       exists (select 1 from public.space_relations where new.id in (space_id, blocks_space_id))
       or exists (select 1 from public.space_resources where space_id = new.id)) then
    raise exception 'Remove this space''s relations and shared resources before moving it to another property.' using errcode = '23503';
  end if;
  return new;
end $$;
create trigger spaces_property_move before update of property_id on public.spaces
  for each row execute function public.check_space_move();

alter table public.space_relations enable row level security;
alter table public.resources enable row level security;
alter table public.space_resources enable row level security;
create policy "Members read space relations" on public.space_relations for select to authenticated using (public.can_view_space(space_id));
create policy "Managers write space relations" on public.space_relations for all to authenticated
  using (public.can_manage_space(space_id) and public.can_manage_space(blocks_space_id))
  with check (public.can_manage_space(space_id) and public.can_manage_space(blocks_space_id));
create policy "Members read resources" on public.resources for select to authenticated using (public.has_property_permission(property_id, 'property.read'));
create policy "Managers write resources" on public.resources for all to authenticated
  using (public.has_property_permission(property_id, 'space.write')) with check (public.has_property_permission(property_id, 'space.write'));
create policy "Members read space resources" on public.space_resources for select to authenticated using (public.can_view_space(space_id));
create policy "Managers write space resources" on public.space_resources for all to authenticated
  using (public.can_manage_space(space_id)) with check (public.can_manage_space(space_id));

-- ---------------------------------------------------------------- who may book
-- Service role explicitly (edge functions), a signed-in member with booking.write, or a superuser session with no
-- role set (migrations, local maintenance). Decided by the session's role, never by auth.uid() being null (audit
-- finding 5). Inside SECURITY DEFINER functions current_user is the owner, but the 'role' setting is still the
-- caller's (PostgREST runs `set local role authenticated|service_role`), and an API role cannot switch it.
create function public.can_book(p_space uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case current_setting('role', true)
    when 'service_role' then true
    when 'authenticated' then public.has_space_permission(p_space, 'booking.write')
    when 'anon' then false
    else coalesce((select r.rolsuper from pg_catalog.pg_roles r where r.rolname = session_user), false)
  end
$$;

-- Same idea for reading availability: a signed-in caller must be able to see the space.
create function public.can_read_bookings(p_space uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case current_setting('role', true)
    when 'authenticated' then public.can_view_space(p_space)
    when 'anon' then false
    else true
  end
$$;

-- ---------------------------------------------------------------- the rules
-- Spaces whose bookings block p_space: itself, ancestors, descendants, and spaces related to it.
create function public.blocking_spaces(p_space uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select f.id from public.related_spaces(p_space) as f(id)
  union
  select r.space_id from public.space_relations r where r.blocks_space_id = p_space
  union
  select r.blocks_space_id from public.space_relations r where r.space_id = p_space and r."symmetric"
$$;

-- Everything that stops [p_starts, p_ends) from being booked on p_space. p_ignore skips one reservation or hold
-- (the one being edited or re-checked). Rows are sorted by kind, space_id, reservation_id, hold_id, resource_id.
create function public.availability_conflicts(p_space uuid, p_starts timestamptz, p_ends timestamptz, p_ignore uuid default null)
returns table (kind text, space_id uuid, reservation_id uuid, hold_id uuid, resource_id uuid, detail text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare qty int; v_setup int; v_clean int;
begin
  if p_starts is null or p_ends is null or p_ends <= p_starts then
    raise exception 'The end has to be after the start.' using errcode = '22023';
  end if;
  select s.quantity, s.setup_minutes, s.cleanup_minutes into qty, v_setup, v_clean from public.spaces s where s.id = p_space;
  if qty is null or not public.can_read_bookings(p_space) then raise exception 'Space not found.' using errcode = 'P0002'; end if;
  return query
  with cand as (
    select tstzrange(p_starts, p_ends) as raw,
           tstzrange(p_starts - v_setup * interval '1 minute', p_ends + v_clean * interval '1 minute') as buf
  ), blockers as (
    select b as sid from public.blocking_spaces(p_space) b
  ), mine as ( -- resources the candidate's space uses
    select sr.resource_id as rid, sr.units, r.capacity from public.space_resources sr
    join public.resources r on r.id = sr.resource_id where sr.space_id = p_space
  ), users as ( -- every space drawing on one of those resources
    select sr.resource_id as rid, sr.space_id as sid, sr.units from public.space_resources sr where sr.resource_id in (select rid from mine)
  ), occ as ( -- live occupancy on any space that matters here
    select r.id as res_id, null::uuid as hld_id, r.space_id as sid, tstzrange(r.starts_at, r.ends_at) as raw,
           tstzrange(r.starts_at - s.setup_minutes * interval '1 minute', r.ends_at + s.cleanup_minutes * interval '1 minute') as buf
    from public.reservations r join public.spaces s on s.id = r.space_id
    where r.status = 'confirmed' and r.id is distinct from p_ignore
      and (r.space_id in (select sid from blockers) or r.space_id in (select sid from users))
    union all
    select null, h.id, h.space_id, tstzrange(h.starts_at, h.ends_at),
           tstzrange(h.starts_at - s.setup_minutes * interval '1 minute', h.ends_at + s.cleanup_minutes * interval '1 minute')
    from public.booking_holds h join public.spaces s on s.id = h.space_id
    where h.status in ('holding', 'safe') and h.expires_at > now() and h.id is distinct from p_ignore
      and (h.space_id in (select sid from blockers) or h.space_id in (select sid from users))
  ), same as ( -- the space itself, buffered on both sides
    select o.* from occ o, cand c where o.sid = p_space and o.buf && c.buf
  ), same_peak as (
    select coalesce(max(run), 0) as peak from (
      select sum(d) over (order by t, d) as run from (
        select greatest(lower(o.buf), lower(c.buf)) as t, 1 as d from same o, cand c
        union all
        select least(upper(o.buf), upper(c.buf)), -1 from same o, cand c) ev) x
  ), res_use as ( -- raw occupancy of each shared resource during the candidate
    select u.rid, u.units, o.* from users u join occ o on o.sid = u.sid, cand c where o.raw && c.raw
  ), res_peak as (
    select rid, max(run) as peak from (
      select rid, sum(d) over (partition by rid order by t, d) as run from (
        select ru.rid, greatest(lower(ru.raw), lower(c.raw)) as t, ru.units as d from res_use ru, cand c
        union all
        select ru.rid, least(upper(ru.raw), upper(c.raw)), -ru.units from res_use ru, cand c) ev) x
    group by rid
  ), found as (
    -- 1. the space itself
    select case when o.hld_id is not null then 'hold' when o.raw && c.raw then 'overlap' else 'buffer' end as k,
           o.sid, o.res_id, o.hld_id, null::uuid as rsc,
           case when o.hld_id is not null then 'held for a pending request' when o.raw && c.raw then 'already booked'
                else 'inside setup or cleaning time' end as why
    from same o, cand c where qty <= 1
    union all
    select 'capacity', o.sid, o.res_id, o.hld_id, null, format('all %s units in use', qty)
    from same o, same_peak p where qty > 1 and p.peak + 1 > qty
    union all
    -- 2. related spaces, raw ranges only
    select case when o.hld_id is not null then 'hold' else 'overlap' end, o.sid, o.res_id, o.hld_id, null,
           case when o.hld_id is not null then 'related space held for a pending request' else 'related space booked' end
    from occ o, cand c where o.sid <> p_space and o.sid in (select sid from blockers) and o.raw && c.raw
    union all
    -- 3. shared resources, peak concurrent units
    select 'resource', ru.sid, ru.res_id, ru.hld_id, ru.rid, format('shared resource capacity %s reached', m.capacity)
    from res_use ru join res_peak p on p.rid = ru.rid join mine m on m.rid = ru.rid
    where p.peak + m.units > m.capacity
  )
  select f.k, f.sid, f.res_id, f.hld_id, f.rsc, f.why from found f
  order by f.k, f.sid, f.res_id nulls last, f.hld_id nulls last, f.rsc nulls last;
end $$;

-- ---------------------------------------------------------------- bookings Everyspace makes: rejected on any conflict
create function public.create_booking(p_space uuid, p_starts timestamptz, p_ends timestamptz,
  p_kind text default 'booking', p_channel text default 'everyspace', p_guest_name text default null,
  p_guest_count int default null, p_payout_cents bigint default null, p_all_day boolean default false,
  p_summary text default null, p_external_uid text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare qty int; found_conflicts jsonb; v_id uuid;
begin
  if not public.can_book(p_space) then raise exception 'Space not found.' using errcode = '42501'; end if;
  select quantity into qty from public.spaces where id = p_space;
  if qty is null then raise exception 'Space not found.' using errcode = 'P0002'; end if;
  if p_kind is null or p_kind not in ('booking', 'block', 'owner_block') then
    raise exception 'Kind must be booking, block or owner_block.' using errcode = '22023';
  end if;
  if p_starts is null or p_ends is null or p_ends <= p_starts then
    raise exception 'The end has to be after the start.' using errcode = '22023';
  end if;
  perform public.lock_property(p_space);
  select coalesce(jsonb_agg(to_jsonb(a) order by a.kind, a.space_id, a.reservation_id, a.hold_id, a.resource_id), '[]'::jsonb)
    into found_conflicts from public.availability_conflicts(p_space, p_starts, p_ends) a;
  if jsonb_array_length(found_conflicts) > 0 then
    raise exception 'Those times are not available (% conflict(s)).', jsonb_array_length(found_conflicts)
      using errcode = '23P01', detail = found_conflicts::text, hint = 'BOOKING_CONFLICT';
  end if;
  insert into public.reservations (space_id, channel, external_uid, kind, status, source, starts_at, ends_at, all_day,
    guest_name, guest_count, payout_cents, summary, exclusive)
  values (p_space, p_channel, coalesce(p_external_uid, 'es-' || gen_random_uuid()::text), p_kind, 'confirmed', 'everyspace',
    p_starts, p_ends, coalesce(p_all_day, false), p_guest_name, p_guest_count, p_payout_cents, p_summary, qty = 1)
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- what marketplaces report: recorded, then flagged
-- p_rows: [{external_uid, starts_at, ends_at, kind?, status?, all_day?, guest_count?, payout_cents?, guest_name?, summary?}]
-- Upserts on (space_id, channel, external_uid). Every row is validated before anything is written. Re-sending the
-- same rows changes nothing. Returns {inserted, updated, cancelled, conflicts:[...]}; conflicts lists, for each
-- confirmed row in the batch, what it collides with (closed-dates blocks excluded, like detect_conflicts), and the
-- pairs are also recorded in public.conflicts.
create function public.import_reservations(p_space uuid, p_channel text, p_rows jsonb, p_source text default 'manual') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v jsonb; i int := 0; n_ins int := 0; n_upd int := 0; n_can int := 0;
  v_uid text; v_s timestamptz; v_e timestamptz; v_kind text; v_status text; v_all_day boolean; v_gc int; v_pay bigint;
  old public.reservations; v_id uuid; v_ids uuid[] := '{}'; seen text[] := '{}'; v_batch uuid := gen_random_uuid();
  v_conf jsonb;
begin
  if not public.can_book(p_space) then raise exception 'Space not found.' using errcode = '42501'; end if;
  if not exists (select 1 from public.spaces where id = p_space) then raise exception 'Space not found.' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.channels where key = p_channel) then
    raise exception 'Unknown site "%".', p_channel using errcode = '22023';
  end if;
  if p_source is null or p_source not in ('ical', 'email', 'api', 'manual', 'everyspace', 'csv') then
    raise exception 'Source must be one of ical, email, api, manual, everyspace, csv.' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'Rows must be a JSON array.' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'At most 5000 rows per import.' using errcode = '22023'; end if;

  -- Validate everything first: a malformed batch writes nothing.
  for v in select value from jsonb_array_elements(p_rows) loop
    i := i + 1;
    if jsonb_typeof(v) <> 'object' then raise exception 'Row %: must be an object.', i using errcode = '22023'; end if;
    if coalesce(jsonb_typeof(v -> 'external_uid'), '') <> 'string' or btrim(v ->> 'external_uid') = '' or length(v ->> 'external_uid') > 500 then
      raise exception 'Row %: external_uid must be a non-empty string.', i using errcode = '22023';
    end if;
    if (v ->> 'external_uid') = any (seen) then
      raise exception 'Row %: external_uid "%" appears twice in this import.', i, v ->> 'external_uid' using errcode = '22023';
    end if;
    seen := seen || (v ->> 'external_uid');
    if coalesce(v ->> 'starts_at', '') !~ '^\d{4}-\d{2}-\d{2}' or coalesce(v ->> 'ends_at', '') !~ '^\d{4}-\d{2}-\d{2}' then
      raise exception 'Row %: starts_at and ends_at must be ISO-8601 timestamps.', i using errcode = '22023';
    end if;
    begin
      v_s := (v ->> 'starts_at')::timestamptz; v_e := (v ->> 'ends_at')::timestamptz;
    exception when others then
      raise exception 'Row %: starts_at and ends_at must be ISO-8601 timestamps.', i using errcode = '22023';
    end;
    if v_s is null or v_e is null or v_e <= v_s then raise exception 'Row %: the end has to be after the start.', i using errcode = '22023'; end if;
    if v ? 'kind' and (v ->> 'kind') not in ('booking', 'block', 'owner_block') then
      raise exception 'Row %: kind must be booking, block or owner_block.', i using errcode = '22023';
    end if;
    if v ? 'status' and (v ->> 'status') not in ('confirmed', 'cancelled') then
      raise exception 'Row %: status must be confirmed or cancelled.', i using errcode = '22023';
    end if;
    if v ? 'all_day' and jsonb_typeof(v -> 'all_day') not in ('boolean', 'null') then
      raise exception 'Row %: all_day must be true or false.', i using errcode = '22023';
    end if;
    if v ? 'guest_count' and jsonb_typeof(v -> 'guest_count') <> 'null' and (jsonb_typeof(v -> 'guest_count') <> 'number'
       or (v ->> 'guest_count')::numeric <> trunc((v ->> 'guest_count')::numeric) or (v ->> 'guest_count')::numeric not between 1 and 10000) then
      raise exception 'Row %: guest_count must be a whole number from 1 to 10000.', i using errcode = '22023';
    end if;
    if v ? 'payout_cents' and jsonb_typeof(v -> 'payout_cents') <> 'null' and (jsonb_typeof(v -> 'payout_cents') <> 'number'
       or (v ->> 'payout_cents')::numeric <> trunc((v ->> 'payout_cents')::numeric) or (v ->> 'payout_cents')::numeric < 0
       or (v ->> 'payout_cents')::numeric > 9e15) then
      raise exception 'Row %: payout_cents must be a whole number of cents, 0 or more.', i using errcode = '22023';
    end if;
  end loop;

  perform public.lock_property(p_space);
  for v in select value from jsonb_array_elements(p_rows) loop
    v_uid := v ->> 'external_uid';
    v_s := (v ->> 'starts_at')::timestamptz; v_e := (v ->> 'ends_at')::timestamptz;
    v_kind := coalesce(v ->> 'kind', 'booking');
    v_status := coalesce(v ->> 'status', 'confirmed');
    v_all_day := coalesce((v ->> 'all_day')::boolean, false);
    v_gc := (v ->> 'guest_count')::int;
    v_pay := (v ->> 'payout_cents')::bigint;
    select * into old from public.reservations r where r.space_id = p_space and r.channel = p_channel and r.external_uid = v_uid for update;
    if old.id is null then
      insert into public.reservations (space_id, channel, external_uid, kind, status, source, starts_at, ends_at, all_day,
        guest_count, payout_cents, guest_name, summary, exclusive, import_batch_id)
      values (p_space, p_channel, v_uid, v_kind, v_status, p_source, v_s, v_e, v_all_day, v_gc, v_pay,
        left(v ->> 'guest_name', 200), left(v ->> 'summary', 500), false, v_batch)
      returning id into v_id;
      n_ins := n_ins + 1;
    else
      v_id := old.id;
      if (old.kind, old.status, old.starts_at, old.ends_at, old.all_day, old.exclusive) is distinct from (v_kind, v_status, v_s, v_e, v_all_day, false)
         or (v ? 'guest_count' and old.guest_count is distinct from v_gc)
         or (v ? 'payout_cents' and old.payout_cents is distinct from v_pay)
         or (v ? 'guest_name' and old.guest_name is distinct from left(v ->> 'guest_name', 200))
         or (v ? 'summary' and old.summary is distinct from left(v ->> 'summary', 500)) then
        update public.reservations r set kind = v_kind, status = v_status, starts_at = v_s, ends_at = v_e, all_day = v_all_day,
          guest_count = case when v ? 'guest_count' then v_gc else r.guest_count end,
          payout_cents = case when v ? 'payout_cents' then v_pay else r.payout_cents end,
          guest_name = case when v ? 'guest_name' then left(v ->> 'guest_name', 200) else r.guest_name end,
          summary = case when v ? 'summary' then left(v ->> 'summary', 500) else r.summary end,
          exclusive = false, import_batch_id = v_batch, updated_at = now()
        where r.id = old.id;
        if old.status = 'confirmed' and v_status = 'cancelled' then n_can := n_can + 1; else n_upd := n_upd + 1; end if;
      end if;
    end if;
    if v_status = 'confirmed' then v_ids := v_ids || v_id; end if;
    old := null;
  end loop;

  -- Flag, never reject: what each confirmed row of the batch collides with.
  select coalesce(jsonb_agg(jsonb_build_object('reservation_id', x.id, 'external_uid', x.external_uid, 'kind', c.kind,
           'space_id', c.space_id, 'conflicting_reservation_id', c.reservation_id, 'hold_id', c.hold_id,
           'resource_id', c.resource_id, 'detail', c.detail)
           order by x.starts_at, x.id, c.kind, c.space_id, c.reservation_id, c.hold_id, c.resource_id), '[]'::jsonb)
    into v_conf
  from public.reservations x
  cross join lateral public.availability_conflicts(x.space_id, x.starts_at, x.ends_at, x.id) c
  left join public.reservations o on o.id = c.reservation_id
  left join public.booking_holds h on h.id = c.hold_id
  where x.id = any (v_ids)
    and x.kind <> 'block' and coalesce(o.kind, '') <> 'block'
    and (c.hold_id is null or h.channel <> x.channel); -- a hold on the same site is this booking arriving (settle_holds)
  perform public.detect_conflicts(p_space);
  return jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'cancelled', n_can, 'conflicts', v_conf);
end $$;

-- ---------------------------------------------------------------- holds use the same rules (same signature)
create or replace function public.place_hold(p_space uuid, p_channel text, p_start timestamptz, p_end timestamptz,
  p_all_day boolean default true, p_ref text default null, p_guest text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare hid uuid;
begin
  if not public.can_book(p_space) then raise exception 'Space not found.'; end if;
  if p_end <= p_start then raise exception 'The end has to be after the start.'; end if;
  if not exists (select 1 from public.spaces where id = p_space) then raise exception 'Space not found.'; end if;
  perform public.lock_property(p_space);
  if exists (select 1 from public.availability_conflicts(p_space, p_start, p_end)) then
    raise exception 'Those dates are already taken. Decline this request.' using errcode = 'P0001', hint = 'DATES_TAKEN';
  end if;
  insert into public.booking_holds (space_id, channel, starts_at, ends_at, all_day, external_ref, guest_name)
  values (p_space, p_channel, p_start, p_end, p_all_day, p_ref, p_guest) returning id into hid;
  return hid;
end $$;

-- ---------------------------------------------------------------- detect_conflicts on the same rules (same signature)
-- Conflicting pairs of confirmed reservations that involve p_space, found by availability_conflicts. As before, a date
-- closed on one site for another site's guest (kind 'block') is the system working, not a conflict, and two host
-- blocks never conflict with each other.
create function public.conflict_pairs(p_space uuid) returns table (a_id uuid, b_id uuid)
language sql stable security definer set search_path = '' as $$
  with xs as (
    select r.id, r.space_id, r.starts_at, r.ends_at, r.kind from public.reservations r
    where r.status = 'confirmed' and r.ends_at > now() - interval '1 day'
      and (r.space_id = p_space
           -- spaces p_space blocks (their check sees p_space; family is symmetric and covered by p_space's own rows)
           or r.space_id in (select x.blocks_space_id from public.space_relations x where x.space_id = p_space)
           or r.space_id in (select x.space_id from public.space_relations x where x.blocks_space_id = p_space and x."symmetric"))
  )
  select distinct least(x.id, c.reservation_id), greatest(x.id, c.reservation_id)
  from xs x
  cross join lateral public.availability_conflicts(x.space_id, x.starts_at, x.ends_at, x.id) c
  join public.reservations b on b.id = c.reservation_id
  where (x.space_id = p_space or b.space_id = p_space)
    and (x.kind = 'booking' or b.kind = 'booking') and x.kind <> 'block' and b.kind <> 'block'
$$;

create or replace function public.detect_conflicts(p_space uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare added int;
begin
  if not exists (select 1 from public.spaces where id = p_space) then return 0; end if;
  update public.conflicts c set resolved_at = now()
  where c.space_id = p_space and c.resolved_at is null
    and not exists (select 1 from public.conflict_pairs(p_space) p where p.a_id = c.a_reservation_id and p.b_id = c.b_reservation_id)
    -- leave conflicts that ended long ago as they were (conflict_pairs only looks at recent and future stays),
    -- unless one side was cancelled
    and exists (select 1 from public.reservations a, public.reservations b
                where a.id = c.a_reservation_id and b.id = c.b_reservation_id
                  and (a.status <> 'confirmed' or b.status <> 'confirmed' or greatest(a.ends_at, b.ends_at) > now() - interval '1 day'));
  with ins as (
    insert into public.conflicts (space_id, a_reservation_id, b_reservation_id)
    select p_space, p.a_id, p.b_id from public.conflict_pairs(p_space) p
    on conflict (a_reservation_id, b_reservation_id) do update set resolved_at = null
    returning 1
  ) select count(*) into added from ins;
  return added;
end $$;

-- ---------------------------------------------------------------- exclusion constraint (backstop for create_booking)
-- Needs btree_gist (uuid equality inside a GiST index). Installed in `extensions` where that schema exists (Supabase),
-- otherwise in the default schema. Where the extension cannot be loaded (plain PGlite), the constraint is skipped and
-- the property lock plus availability_conflicts remain the guarantee; real Postgres always gets it.
do $$
declare sch text := case when exists (select 1 from pg_namespace where nspname = 'extensions') then 'extensions' else 'public' end;
begin
  if not exists (select 1 from pg_extension where extname = 'btree_gist')
     and exists (select 1 from pg_available_extensions where name = 'btree_gist') then
    begin
      execute format('create extension if not exists btree_gist schema %I', sch);
    exception when others then
      raise notice 'btree_gist not enabled here: %', sqlerrm;
    end;
  end if;
  if exists (select 1 from pg_extension where extname = 'btree_gist') then
    execute 'alter table public.reservations add constraint reservations_exclusive_no_overlap
      exclude using gist (space_id with =, tstzrange(starts_at, ends_at) with &&) where (exclusive and status = ''confirmed'')';
  else
    raise notice 'btree_gist unavailable: reservations_exclusive_no_overlap not created';
  end if;
end $$;

-- ---------------------------------------------------------------- sync health
create view public.sync_health with (security_invoker = true) as
select ci.id as import_id, ci.space_id, ci.channel, ci.last_synced_at, ci.last_status, ci.last_ok_at, ci.consecutive_failures,
  (ci.last_ok_at is null or ci.last_ok_at < now() - interval '3 hours' or ci.consecutive_failures >= 3) as stale
from public.calendar_imports ci;
revoke all on public.sync_health from anon;

-- ---------------------------------------------------------------- reservations: RPC-only writes
-- Reads stay under RLS. Signed-in users write through create_booking / import_reservations, which take the lock;
-- the service role (calendar-sync) keeps direct access.
drop policy "Operators add reservations" on public.reservations;
drop policy "Operators edit reservations" on public.reservations;
drop policy "Operators delete reservations" on public.reservations;
revoke insert, update, delete, truncate on public.reservations from anon, authenticated;

-- ---------------------------------------------------------------- function privileges
revoke execute on function public.track_import_health(), public.check_same_property(), public.check_resource_move(),
  public.check_space_move(), public.can_book(uuid), public.can_read_bookings(uuid), public.blocking_spaces(uuid),
  public.availability_conflicts(uuid, timestamptz, timestamptz, uuid),
  public.create_booking(uuid, timestamptz, timestamptz, text, text, text, int, bigint, boolean, text, text),
  public.import_reservations(uuid, text, jsonb, text), public.conflict_pairs(uuid)
  from public, anon, authenticated;
grant execute on function public.availability_conflicts(uuid, timestamptz, timestamptz, uuid),
  public.create_booking(uuid, timestamptz, timestamptz, text, text, text, int, bigint, boolean, text, text),
  public.import_reservations(uuid, text, jsonb, text)
  to authenticated, service_role;
grant execute on function public.blocking_spaces(uuid), public.detect_conflicts(uuid) to service_role;

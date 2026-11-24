-- M3: property intelligence. Everything Everyspace knows about a property, with provenance on every value (ADR 7),
-- regulatory rules as rows, opportunities and immutable projections, and a quarantined store for restricted
-- third-party data (ADR 9). Geometry is GeoJSON in jsonb (no PostGIS).

-- ---------------------------------------------------------------- shared tenant-reference check
-- For any row carrying some of org_id / property_id / space_id / reservation_id / parcel_id / projection_id: every
-- reference must belong to the same property and organization. Fills org_id from the property (or space) when the
-- client leaves it out. One message for "missing" and "someone else's" so ids of other tenants are not confirmed.
create function public.check_tenant_refs() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb := to_jsonb(new);
  v_org uuid := (r ->> 'org_id')::uuid;
  v_prop uuid := (r ->> 'property_id')::uuid;
  v_space uuid := (r ->> 'space_id')::uuid;
  v_res uuid := (r ->> 'reservation_id')::uuid;
  x uuid;
  bad constant text := 'That record does not belong to this property or organization.';
begin
  if v_res is not null then
    select space_id into x from public.reservations where id = v_res;
    if x is null or (v_space is not null and x <> v_space) then raise exception '%', bad using errcode = '23503'; end if;
    v_space := x;
  end if;
  if v_space is not null then
    select property_id into x from public.spaces where id = v_space;
    if x is null or (v_prop is not null and x <> v_prop) then raise exception '%', bad using errcode = '23503'; end if;
    v_prop := x;
  end if;
  if (r ->> 'parcel_id') is not null
     and not exists (select 1 from public.parcels where id = (r ->> 'parcel_id')::uuid and property_id = v_prop) then
    raise exception '%', bad using errcode = '23503';
  end if;
  if (r ->> 'projection_id') is not null
     and not exists (select 1 from public.projections where id = (r ->> 'projection_id')::uuid
                     and (property_id = v_prop or (property_id is null and org_id = (select org_id from public.properties where id = v_prop)))) then
    raise exception '%', bad using errcode = '23503';
  end if;
  if v_prop is not null and r ? 'org_id' then
    select org_id into x from public.properties where id = v_prop;
    if v_org is null then
      new := jsonb_populate_record(new, jsonb_build_object('org_id', x));
    elsif v_org <> x then
      raise exception '%', bad using errcode = '23503';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- parcels, buildings
create table public.parcels (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  apn text,
  jurisdiction jsonb not null default '{}',
  boundary jsonb, -- GeoJSON Polygon/MultiPolygon
  lot_area_sqft numeric check (lot_area_sqft > 0),
  created_at timestamptz not null default now()
);
create index on public.parcels (property_id);

create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  parcel_id uuid references public.parcels (id) on delete set null,
  kind text not null default 'main' check (kind in ('main', 'adu', 'garage', 'shed', 'other')),
  footprint jsonb, -- GeoJSON Polygon
  footprint_sqft numeric check (footprint_sqft > 0),
  stories numeric check (stories > 0),
  year_built int check (year_built between 1600 and 2200),
  created_at timestamptz not null default now()
);
create index on public.buildings (property_id);
create index on public.buildings (parcel_id);
create trigger buildings_tenant_refs before insert or update on public.buildings for each row execute function public.check_tenant_refs();

-- ---------------------------------------------------------------- attributes (append-only, provenance on every row)
create table public.property_attributes (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  subject_type text not null default 'property' check (subject_type in ('property', 'parcel', 'building', 'space')),
  subject_id uuid,
  key text not null check (key ~ '^[a-z][a-z0-9_.]*$'),
  value jsonb,
  unit text,
  provenance_tag text not null check (provenance_tag in ('measured', 'estimated', 'owner_confirmed', 'unavailable')),
  source_name text not null,
  source_url text,
  license text,
  retrieved_at timestamptz,
  confidence numeric check (confidence between 0 and 1),
  method text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  superseded_at timestamptz,
  -- A missing number is unavailable, never 0: unavailable rows carry no value.
  check (provenance_tag <> 'unavailable' or value is null or value = 'null'::jsonb),
  -- A number without a source is a planning default: estimated, confidence <= 0.2.
  check (source_name <> 'Everyspace planning default (uncited)' or (provenance_tag = 'estimated' and coalesce(confidence, 0) <= 0.2))
);
create index on public.property_attributes (property_id, subject_type, subject_id, key);
create index on public.property_attributes (created_by);

create function public.property_attributes_append_only() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ok boolean;
begin
  if tg_op = 'INSERT' then
    new.created_at := clock_timestamp();
    if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
    if new.subject_type = 'property' then
      ok := new.subject_id is null or new.subject_id = new.property_id;
    elsif new.subject_type = 'space' then
      ok := exists (select 1 from public.spaces where id = new.subject_id and property_id = new.property_id);
    elsif new.subject_type = 'building' then
      ok := exists (select 1 from public.buildings where id = new.subject_id and property_id = new.property_id);
    else
      ok := exists (select 1 from public.parcels where id = new.subject_id and property_id = new.property_id);
    end if;
    if not ok then
      raise exception 'That record does not belong to this property or organization.' using errcode = '23503';
    end if;
    if new.subject_type = 'property' then new.subject_id := null; end if;
    return new;
  end if;
  -- UPDATE: only superseded_at may be set, once.
  if (to_jsonb(new) - 'superseded_at') is distinct from (to_jsonb(old) - 'superseded_at')
     or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    raise exception 'Property attributes are append-only: add a new row instead of changing one.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger property_attributes_append_only before insert or update on public.property_attributes
  for each row execute function public.property_attributes_append_only();

-- Current value per (property, subject, key): the newest owner_confirmed row; else the highest confidence, then the
-- newest; an unavailable row wins only when nothing else exists. Superseded rows are ignored.
create view public.property_profile with (security_invoker = true) as
select distinct on (a.property_id, a.subject_type, a.subject_id, a.key)
  a.property_id, a.subject_type, a.subject_id, a.key, a.value, a.unit, a.provenance_tag, a.source_name, a.source_url,
  a.license, a.retrieved_at, a.confidence, a.method, a.created_by, a.created_at, a.id as attribute_id
from public.property_attributes a
where a.superseded_at is null
order by a.property_id, a.subject_type, a.subject_id, a.key,
  (a.provenance_tag = 'owner_confirmed') desc,
  (a.provenance_tag = 'unavailable') asc,
  case when a.provenance_tag = 'owner_confirmed' then a.created_at end desc nulls last,
  a.confidence desc nulls last,
  a.created_at desc,
  a.id desc;

-- The owner (or a manager) confirms or corrects a value. Runs as the caller, so RLS decides who may.
create function public.confirm_attribute(p_property uuid, p_key text, p_value jsonb, p_unit text default null,
  p_subject_type text default 'property', p_subject_id uuid default null, p_note text default null) returns uuid
language sql volatile set search_path = '' as $$
  insert into public.property_attributes (property_id, subject_type, subject_id, key, value, unit, provenance_tag,
    source_name, retrieved_at, confidence, method)
  values (p_property, p_subject_type, p_subject_id, p_key, p_value, p_unit, 'owner_confirmed',
    'Owner', now(), 1, coalesce(p_note, 'owner confirmation'))
  returning id
$$;

-- ---------------------------------------------------------------- photos
create table public.property_photos (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete set null,
  storage_path text not null,
  source text not null default 'owner_upload' check (source in ('owner_upload')),
  license text,
  uploaded_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.property_photos (property_id);
create index on public.property_photos (space_id);
create index on public.property_photos (uploaded_by);
create trigger property_photos_tenant_refs before insert or update on public.property_photos for each row execute function public.check_tenant_refs();

-- ---------------------------------------------------------------- regulatory
-- Global rules per jurisdiction and category. No rows are seeded: a rule exists only with a source.
create table public.regulatory_rules (
  id uuid primary key default gen_random_uuid(),
  jurisdiction_key text not null,
  category_key text references public.space_categories (key) on update cascade,
  rule_type text not null,
  effect text not null check (effect in ('allowed', 'permit_required', 'restricted', 'prohibited', 'unknown')),
  summary text not null,
  params jsonb not null default '{}',
  source_url text,
  verified boolean not null default false,
  verified_at date,
  created_at timestamptz not null default now(),
  check (not verified or (source_url is not null and verified_at is not null))
);
create index on public.regulatory_rules (jurisdiction_key, category_key);
create index on public.regulatory_rules (category_key);

create table public.property_regulatory (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  rule_id uuid not null references public.regulatory_rules (id) on delete cascade,
  status text not null default 'unknown' check (status in ('unknown', 'not_applicable', 'pending', 'compliant', 'non_compliant')),
  permit_number text,
  expires_at date,
  provenance_tag text not null default 'owner_confirmed' check (provenance_tag in ('measured', 'estimated', 'owner_confirmed', 'unavailable')),
  created_at timestamptz not null default now(),
  unique (property_id, rule_id)
);
create index on public.property_regulatory (rule_id);

-- ---------------------------------------------------------------- projections (immutable) and opportunities
create table public.projections (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references public.properties (id) on delete cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  model_version text not null,
  goal text,
  inputs jsonb not null,
  assumptions jsonb not null,
  scenarios jsonb not null,
  confidence numeric check (confidence between 0 and 1),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.projections (property_id);
create index on public.projections (org_id);
create index on public.projections (created_by);
create trigger projections_tenant_refs before insert on public.projections for each row execute function public.check_tenant_refs();

create function public.projections_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Projections are immutable: save a new projection instead.' using errcode = '42501';
end $$;
create trigger projections_no_update before update on public.projections for each row execute function public.projections_immutable();

create table public.opportunities (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  category_key text not null references public.space_categories (key) on update cascade,
  basis text,
  status text not null default 'identified' check (status in ('identified', 'considering', 'planned', 'active', 'dismissed')),
  feasibility jsonb not null default '{}',
  projection_id uuid references public.projections (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.opportunities (property_id);
create index on public.opportunities (category_key);
create index on public.opportunities (projection_id);
create trigger opportunities_tenant_refs before insert or update on public.opportunities for each row execute function public.check_tenant_refs();

-- ---------------------------------------------------------------- provider data (quarantined, ADR 9)
-- Restricted third-party data, scoped to the provider that supplied it. expires_at is required; expired rows are
-- hidden by the read policy at once, and purge_expired_provider_data() deletes them daily (scheduled in
-- supabase/cron/calendar_sync.sql). Nothing references this table: it is never joined into intelligence or estimates.
create table public.provider_data (
  id uuid primary key default gen_random_uuid(),
  channel_key text not null references public.channels (key) on update cascade,
  org_id uuid not null references public.organizations (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  retrieved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (expires_at > retrieved_at)
);
create index on public.provider_data (org_id);
create index on public.provider_data (space_id);
create index on public.provider_data (channel_key);
create index on public.provider_data (expires_at);
create trigger provider_data_tenant_refs before insert or update on public.provider_data for each row execute function public.check_tenant_refs();

create function public.purge_expired_provider_data() returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from public.provider_data where expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- row-level security
alter table public.parcels enable row level security;
alter table public.buildings enable row level security;
alter table public.property_attributes enable row level security;
alter table public.property_photos enable row level security;
alter table public.regulatory_rules enable row level security;
alter table public.property_regulatory enable row level security;
alter table public.projections enable row level security;
alter table public.opportunities enable row level security;
alter table public.provider_data enable row level security;

-- Property-scoped tables: property.read to read, property.write to write.
create policy "Members read parcels" on public.parcels for select to authenticated using (public.has_property_permission(property_id, 'property.read'));
create policy "Managers write parcels" on public.parcels for all to authenticated
  using (public.has_property_permission(property_id, 'property.write')) with check (public.has_property_permission(property_id, 'property.write'));
create policy "Members read buildings" on public.buildings for select to authenticated using (public.has_property_permission(property_id, 'property.read'));
create policy "Managers write buildings" on public.buildings for all to authenticated
  using (public.has_property_permission(property_id, 'property.write')) with check (public.has_property_permission(property_id, 'property.write'));
create policy "Members read photos" on public.property_photos for select to authenticated using (public.has_property_permission(property_id, 'property.read'));
create policy "Managers write photos" on public.property_photos for all to authenticated
  using (public.has_property_permission(property_id, 'property.write')) with check (public.has_property_permission(property_id, 'property.write'));
create policy "Members read regulatory status" on public.property_regulatory for select to authenticated using (public.has_property_permission(property_id, 'property.read'));
create policy "Managers write regulatory status" on public.property_regulatory for all to authenticated
  using (public.has_property_permission(property_id, 'property.write')) with check (public.has_property_permission(property_id, 'property.write'));
create policy "Members read opportunities" on public.opportunities for select to authenticated using (public.has_property_permission(property_id, 'property.read'));
create policy "Managers write opportunities" on public.opportunities for all to authenticated
  using (public.has_property_permission(property_id, 'property.write')) with check (public.has_property_permission(property_id, 'property.write'));

-- Attributes: read, insert, and mark superseded. No delete, no value updates (trigger + privileges).
create policy "Members read attributes" on public.property_attributes for select to authenticated using (public.has_property_permission(property_id, 'property.read'));
create policy "Managers add attributes" on public.property_attributes for insert to authenticated with check (public.has_property_permission(property_id, 'property.write'));
create policy "Managers supersede attributes" on public.property_attributes for update to authenticated
  using (public.has_property_permission(property_id, 'property.write')) with check (public.has_property_permission(property_id, 'property.write'));
revoke update, delete, truncate on public.property_attributes from anon, authenticated;
grant update (superseded_at) on public.property_attributes to authenticated;

create policy "Anyone reads regulatory rules" on public.regulatory_rules for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.regulatory_rules from anon, authenticated;

create policy "Members read projections" on public.projections for select to authenticated using (public.has_org_permission(org_id, 'property.read'));
create policy "Managers save projections" on public.projections for insert to authenticated with check (public.has_org_permission(org_id, 'property.write'));
revoke update, delete, truncate on public.projections from anon, authenticated;

-- Expired rows are invisible at once, whether or not the daily purge has run yet (review finding 8).
create policy "Members read their provider data" on public.provider_data for select to authenticated
  using (expires_at > now() and public.has_org_permission(org_id, 'property.read'));
revoke insert, update, delete, truncate on public.provider_data from anon, authenticated;

-- ---------------------------------------------------------------- function privileges
revoke execute on function public.check_tenant_refs(), public.property_attributes_append_only(), public.projections_immutable(),
  public.purge_expired_provider_data(), public.confirm_attribute(uuid, text, jsonb, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.confirm_attribute(uuid, text, jsonb, text, text, uuid, text) to authenticated;
grant execute on function public.purge_expired_provider_data() to service_role;

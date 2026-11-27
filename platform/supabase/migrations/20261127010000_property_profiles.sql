-- PD-DB: server-side cache for property profiles (the estimator's "type an address" lookup) and a daily budget guard
-- for paid data providers. Written ONLY by the property-profile edge function with the service role.
-- Restricted third-party data is kept only with an expiry (decision 9): every row carries expires_at, set by the
-- function from the shortest retention among the providers it used; expired rows are invisible at once and purged daily.
-- Privacy: a row records which address was looked up, never who looked it up.

-- ---------------------------------------------------------------- profiles
create table public.property_profiles (
  id uuid primary key default gen_random_uuid(),
  address_key text not null check (address_key = lower(address_key) and char_length(address_key) between 5 and 400),
  place_id text check (char_length(place_id) <= 300),
  apn text check (char_length(apn) <= 100),
  county_fips text check (county_fips ~ '^[0-9]{5}$'),
  address text not null check (char_length(address) between 5 and 400),
  lat double precision check (lat between -90 and 90),
  lng double precision check (lng between -180 and 180),
  profile jsonb not null check (jsonb_typeof(profile) = 'object' and pg_column_size(profile) < 262144),
  providers jsonb not null default '[]' check (jsonb_typeof(providers) = 'array'),
  model_version text not null check (char_length(model_version) between 1 and 100),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Set when a signed-in owner claims the profile for one of their properties.
  property_id uuid references public.properties (id) on delete set null,
  check (expires_at > created_at)
);
-- One cached row per normalised address; storing again replaces it (see store_property_profile).
create unique index property_profiles_address_key_uidx on public.property_profiles (address_key);
create index on public.property_profiles (place_id);
create index on public.property_profiles (apn);
create index on public.property_profiles (expires_at);
create index on public.property_profiles (property_id);

-- ---------------------------------------------------------------- provider budget
create table public.provider_usage (
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  day date not null,
  calls int not null default 0 check (calls >= 0),
  primary key (provider, day)
);

-- ---------------------------------------------------------------- access
alter table public.property_profiles enable row level security;
alter table public.provider_usage enable row level security; -- no policies: the service role bypasses RLS, nobody else gets in

-- Members with property read permission see non-expired profiles claimed for their own properties. Expired rows are
-- invisible at once, whether or not the purge has run.
create policy "Members read their claimed profiles" on public.property_profiles for select to authenticated
  using (expires_at > now() and property_id is not null and public.has_property_permission(property_id, 'property.read'));
revoke all on public.property_profiles from anon;
revoke insert, update, delete, truncate on public.property_profiles from authenticated;
revoke all on public.provider_usage from anon, authenticated;

-- ---------------------------------------------------------------- functions (service role only)
-- Caller check (same idea as can_book): the session role decides, so a signed-in or anonymous API caller is refused even
-- if a grant is ever widened by mistake. A superuser / owner session with no role set (migrations, maintenance) passes.
create function public.assert_service_caller() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(current_setting('role', true), '') in ('authenticated', 'anon') then
    raise exception 'permission denied: service role only' using errcode = '42501';
  end if;
end $$;

-- Atomic daily budget: ONE upsert statement, so concurrent callers cannot both take the last unit. The UTC day is the
-- key. Returns true while today's count stays within the cap; a cap of 0 or less (or null) is always false.
create function public.reserve_provider_call(p_provider text, p_daily_cap int) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v_calls int;
begin
  perform public.assert_service_caller();
  if p_daily_cap is null or p_daily_cap <= 0 then return false; end if;
  insert into public.provider_usage as u (provider, day, calls)
  values (p_provider, (now() at time zone 'utc')::date, 1)
  on conflict (provider, day) do update set calls = u.calls + 1 where u.calls < p_daily_cap
  returning u.calls into v_calls;
  return v_calls is not null;
end $$;

-- Upsert by address_key. A re-store replaces the data and restarts created_at, but keeps an existing owner claim.
create function public.store_property_profile(
  p_address_key text, p_place_id text, p_apn text, p_county_fips text, p_address text, p_lat double precision,
  p_lng double precision, p_profile jsonb, p_providers jsonb, p_model_version text, p_expires_at timestamptz) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.assert_service_caller();
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'expires_at must be in the future' using errcode = '22023';
  end if;
  insert into public.property_profiles as t (address_key, place_id, apn, county_fips, address, lat, lng, profile, providers,
    model_version, created_at, expires_at)
  values (p_address_key, p_place_id, p_apn, p_county_fips, p_address, p_lat, p_lng, p_profile, coalesce(p_providers, '[]'::jsonb),
    p_model_version, now(), p_expires_at)
  on conflict (address_key) do update set place_id = excluded.place_id, apn = excluded.apn, county_fips = excluded.county_fips,
    address = excluded.address, lat = excluded.lat, lng = excluded.lng, profile = excluded.profile,
    providers = excluded.providers, model_version = excluded.model_version, created_at = excluded.created_at,
    expires_at = excluded.expires_at
  returning t.id into v_id;
  return v_id;
end $$;

-- The newest non-expired row for this address key (or, when given, the same place_id), else null.
create function public.get_cached_property_profile(p_address_key text, p_place_id text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform public.assert_service_caller();
  select jsonb_build_object('id', t.id, 'profile', t.profile, 'providers', t.providers, 'model_version', t.model_version,
    'created_at', t.created_at, 'expires_at', t.expires_at) into v
  from public.property_profiles t
  where t.expires_at > now()
    and (t.address_key = p_address_key or (p_place_id is not null and t.place_id = p_place_id))
  order by t.created_at desc, t.id desc
  limit 1;
  return v;
end $$;

create function public.purge_expired_property_profiles() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform public.assert_service_caller();
  delete from public.property_profiles where expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.assert_service_caller(), public.reserve_provider_call(text, int),
  public.store_property_profile(text, text, text, text, text, double precision, double precision, jsonb, jsonb, text, timestamptz),
  public.get_cached_property_profile(text, text), public.purge_expired_property_profiles() from public, anon, authenticated;
grant execute on function public.reserve_provider_call(text, int),
  public.store_property_profile(text, text, text, text, text, double precision, double precision, jsonb, jsonb, text, timestamptz),
  public.get_cached_property_profile(text, text), public.purge_expired_property_profiles() to service_role;
-- assert_service_caller is called from inside the SECURITY DEFINER functions above, as their owner: no API role needs it.
revoke execute on function public.assert_service_caller() from service_role;

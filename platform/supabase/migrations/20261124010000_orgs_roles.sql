-- M1: organizations, roles and memberships. The tenant is the organization (ADR 4).
--
-- Every profile gets a personal organization with an owner membership, created with the profile and backfilled for
-- profiles that already exist. properties.org_id defaults to the host's personal organization when a client leaves it
-- out, so the Host Console (which inserts properties with only host_id) keeps working unchanged. host_id stays for
-- backward compatibility and for the revenue-share ledger.
--
-- Row-level security goes through one choke point, has_org_permission(org, permission). Roles are rows, so a new role
-- or a changed permission set is an UPDATE, not a migration.
--
-- Permission matrix (seeded below; rank orders roles so nobody can grant or edit a role above their own):
--   permission       what it allows                                               owner admin manager operator viewer
--   org.manage       rename the org, add/remove members, change roles              x     x
--   property.read    read properties, spaces, bookings, intelligence, tasks, comms x     x     x       x        x
--   property.write   properties, parcels, buildings, attributes, photos,           x     x     x
--                    regulatory status, opportunities, projections
--   space.write      spaces, site listings, calendar links in/out, pricing rules   x     x     x
--   booking.write    reservations, holds (place/release), alert acknowledgement    x     x     x       x
--   finance.read     expenses, revenue entries, earnings ledger                    x     x     x
--   finance.write    expenses, revenue entries                                     x     x
--   task.write       create/edit/assign maintenance tasks                          x     x     x
--   task.update      update the status of a task assigned to you                   x     x     x       x
--   comms.write      log guest communications                                      x     x     x
--   rank                                                                           100   80    60      40       20

-- ---------------------------------------------------------------- tables
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  kind text not null default 'team' check (kind in ('personal', 'team')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index organizations_one_personal_per_user on public.organizations (created_by) where kind = 'personal';

create table public.roles (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  label text not null,
  permissions text[] not null default '{}',
  rank int not null check (rank between 0 and 1000),
  created_at timestamptz not null default now()
);
insert into public.roles (key, label, rank, permissions) values
  ('owner', 'Owner', 100, array['org.manage', 'property.read', 'property.write', 'space.write', 'booking.write',
    'finance.read', 'finance.write', 'task.write', 'task.update', 'comms.write']),
  ('admin', 'Admin', 80, array['org.manage', 'property.read', 'property.write', 'space.write', 'booking.write',
    'finance.read', 'finance.write', 'task.write', 'task.update', 'comms.write']),
  ('manager', 'Manager', 60, array['property.read', 'property.write', 'space.write', 'booking.write', 'finance.read',
    'task.write', 'task.update', 'comms.write']),
  ('operator', 'Operator', 40, array['property.read', 'booking.write', 'task.update']),
  ('viewer', 'Viewer', 20, array['property.read']);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role_key text not null references public.roles (key) on update cascade,
  status text not null default 'active' check (status in ('invited', 'active', 'suspended')),
  invited_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on public.memberships (user_id);
create index on public.memberships (role_key);

alter table public.properties add column org_id uuid references public.organizations (id) on delete cascade;
alter table public.channel_connections add column org_id uuid references public.organizations (id) on delete cascade;

-- ---------------------------------------------------------------- permission checks (the RLS choke point)
create function public.has_org_permission(p_org uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m join public.roles r on r.key = m.role_key
    where m.org_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active' and p_perm = any (r.permissions))
$$;

create function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.org_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active')
$$;

-- The caller's role rank in an org (0 when not an active member). Used by the membership guard.
create function public.org_role_rank(p_org uuid) returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((select r.rank from public.memberships m join public.roles r on r.key = m.role_key
                   where m.org_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active'), 0)
$$;

create function public.has_property_permission(p_property uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.has_org_permission(p.org_id, p_perm) from public.properties p where p.id = p_property), false)
$$;

create function public.has_space_permission(p_space uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select public.has_org_permission(p.org_id, p_perm)
                   from public.spaces s join public.properties p on p.id = s.property_id where s.id = p_space), false)
$$;

create function public.can_view_space(p_space uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select public.has_space_permission(p_space, 'property.read') $$;

create function public.can_manage_space(p_space uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select public.has_space_permission(p_space, 'space.write') $$;

-- Same name and signature as before; now membership-based. Every remaining caller (place_hold, release_hold,
-- dismiss_alert) acts on a space's bookings, so it checks booking.write.
create or replace function public.owns_space(p_space uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select public.has_space_permission(p_space, 'booking.write') $$;

-- ---------------------------------------------------------------- personal org bootstrap
create function public.ensure_personal_org(p_user uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; nm text;
begin
  select id into v_org from public.organizations where created_by = p_user and kind = 'personal';
  if v_org is not null then return v_org; end if;
  select left(coalesce(nullif(btrim(full_name), ''), 'Personal'), 120) into nm from public.profiles where id = p_user;
  if nm is null then raise exception 'Profile not found.'; end if;
  insert into public.organizations (name, kind, created_by) values (nm, 'personal', p_user) returning id into v_org;
  insert into public.memberships (org_id, user_id, role_key) values (v_org, p_user, 'owner');
  return v_org;
end $$;

create function public.on_profile_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform public.ensure_personal_org(new.id);
  return new;
end $$;
create trigger profiles_personal_org after insert on public.profiles for each row execute function public.on_profile_created();

-- A team org, with the caller as its owner (a user cannot insert their own membership directly).
create function public.create_organization(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.'; end if;
  insert into public.organizations (name, kind, created_by) values (btrim(p_name), 'team', (select auth.uid())) returning id into v_org;
  insert into public.memberships (org_id, user_id, role_key) values (v_org, (select auth.uid()), 'owner');
  return v_org;
end $$;

-- Backfill: every existing profile gets its personal org; existing rows join it.
select public.ensure_personal_org(id) from public.profiles;

-- properties / channel_connections inserted without org_id land in the host's personal org.
create function public.default_org_from_host() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.org_id is null then
    new.org_id := (select id from public.organizations where created_by = new.host_id and kind = 'personal');
  end if;
  return new;
end $$;
create trigger properties_default_org before insert on public.properties for each row execute function public.default_org_from_host();
create trigger channel_connections_default_org before insert on public.channel_connections for each row execute function public.default_org_from_host();

update public.properties p set org_id = o.id from public.organizations o where o.created_by = p.host_id and o.kind = 'personal' and p.org_id is null;
update public.channel_connections c set org_id = o.id from public.organizations o where o.created_by = c.host_id and o.kind = 'personal' and c.org_id is null;
alter table public.properties alter column org_id set not null;
alter table public.channel_connections alter column org_id set not null;
create index on public.properties (org_id);
create index on public.channel_connections (org_id);

-- host_id is the legacy owner column (revenue-share ledger is keyed on it); signed-in users cannot reassign it.
create function public.guard_host_id() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') and new.host_id is distinct from old.host_id then
    raise exception 'host_id cannot be changed.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger properties_guard_host before update on public.properties for each row execute function public.guard_host_id();
create trigger channel_connections_guard_host before update on public.channel_connections for each row execute function public.guard_host_id();

-- ---------------------------------------------------------------- membership guard
-- Runs as the caller (invoker) so current_user tells a signed-in user apart from definer functions and the service
-- role. RLS already requires org.manage for any write; this adds: no self-adds, no changing your own role or status,
-- nothing above your own rank, and an org always keeps an active owner.
create function public.guard_membership() returns trigger
language plpgsql set search_path = '' as $$
declare me int; tgt int; oldr int;
begin
  if current_user not in ('authenticated', 'anon') then return coalesce(new, old); end if;
  me := public.org_role_rank(coalesce(new.org_id, old.org_id));
  if tg_op = 'INSERT' then
    if new.user_id = (select auth.uid()) then
      raise exception 'You cannot add yourself to an organization.' using errcode = '42501';
    end if;
    -- No membership without consent (review finding 7): a signed-in user can only invite; the invited person
    -- accepts with accept_invite() (or declines with decline_invite()).
    new.status := 'invited';
    new.invited_by := (select auth.uid());
  else
    if tg_op = 'UPDATE' and new.status = 'active' and old.status is distinct from 'active' then
      raise exception 'Only the invited person can accept an invitation.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.user_id <> old.user_id) then
      raise exception 'A membership cannot be moved.' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and old.user_id = (select auth.uid())
       and (new.role_key <> old.role_key or new.status <> old.status) then
      raise exception 'You cannot change your own role.' using errcode = '42501';
    end if;
    select rank into oldr from public.roles where key = old.role_key;
    if oldr > me then raise exception 'You cannot change a member above your own role.' using errcode = '42501'; end if;
    if old.role_key = 'owner' and old.status = 'active'
       and (tg_op = 'DELETE' or new.role_key <> 'owner' or new.status <> 'active')
       and not exists (select 1 from public.memberships m where m.org_id = old.org_id and m.id <> old.id
                       and m.role_key = 'owner' and m.status = 'active') then
      raise exception 'An organization needs at least one owner.' using errcode = '42501';
    end if;
  end if;
  if tg_op <> 'DELETE' then
    select rank into tgt from public.roles where key = new.role_key;
    if tgt > me then raise exception 'You cannot grant a role above your own.' using errcode = '42501'; end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger memberships_guard before insert or update or delete on public.memberships
  for each row execute function public.guard_membership();

-- ---------------------------------------------------------------- row-level security
alter table public.organizations enable row level security;
alter table public.roles enable row level security;
alter table public.memberships enable row level security;

create policy "Members read their orgs" on public.organizations for select to authenticated using (public.is_org_member(id));
create policy "Org managers rename their org" on public.organizations for update to authenticated
  using (public.has_org_permission(id, 'org.manage')) with check (public.has_org_permission(id, 'org.manage'));
-- Orgs are created by ensure_personal_org / create_organization and deleted by the service role.

create policy "Signed-in users read roles" on public.roles for select to authenticated using (true);

create policy "Members read their org's members" on public.memberships for select to authenticated using (public.is_org_member(org_id));
create policy "Users read their own invitations" on public.memberships for select to authenticated using (user_id = (select auth.uid()));
create policy "Org managers add members" on public.memberships for insert to authenticated with check (public.has_org_permission(org_id, 'org.manage'));
create policy "Org managers change members" on public.memberships for update to authenticated
  using (public.has_org_permission(org_id, 'org.manage')) with check (public.has_org_permission(org_id, 'org.manage'));
create policy "Org managers remove members" on public.memberships for delete to authenticated using (public.has_org_permission(org_id, 'org.manage'));

-- The invited person, and only they, accepts or declines (the membership guard refuses everyone else's 'active').
-- Definer functions run as the owner, so the guard's signed-in checks do not apply to them.
create function public.accept_invite(p_org uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  update public.memberships set status = 'active'
  where org_id = p_org and user_id = (select auth.uid()) and status = 'invited';
  return found;
end $$;

create function public.decline_invite(p_org uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  delete from public.memberships where org_id = p_org and user_id = (select auth.uid()) and status = 'invited';
  return found;
end $$;

-- Profiles: a signed-in user reads only their own row (policy "Hosts manage their profile"). Teammates' names come
-- from org_member_profiles(), and only between ACTIVE members of the same org; a phone number only to members with
-- org.manage (review finding 7: an invite alone shows nothing).
create function public.org_member_profiles(p_org uuid)
returns table (user_id uuid, role_key text, status text, full_name text, phone text)
language sql stable security definer set search_path = '' as $$
  select m.user_id, m.role_key, m.status,
         case when m.status = 'active' then p.full_name end,
         case when m.status = 'active' and public.has_org_permission(p_org, 'org.manage') then p.phone end
  from public.memberships m join public.profiles p on p.id = m.user_id
  where m.org_id = p_org and public.is_org_member(p_org)
  order by m.created_at, m.user_id
$$;

-- Properties and everything under them: read = property.read, write = the matching *.write permission.
drop policy "Hosts manage their properties" on public.properties;
create policy "Members read properties" on public.properties for select to authenticated using (public.has_org_permission(org_id, 'property.read'));
create policy "Managers add properties" on public.properties for insert to authenticated
  with check (public.has_org_permission(org_id, 'property.write') and host_id = (select auth.uid()));
create policy "Managers edit properties" on public.properties for update to authenticated
  using (public.has_org_permission(org_id, 'property.write')) with check (public.has_org_permission(org_id, 'property.write'));
create policy "Org managers delete properties" on public.properties for delete to authenticated using (public.has_org_permission(org_id, 'org.manage'));

drop policy "Hosts manage their spaces" on public.spaces;
create policy "Members read spaces" on public.spaces for select to authenticated using (public.has_property_permission(property_id, 'property.read'));
create policy "Managers add spaces" on public.spaces for insert to authenticated with check (public.has_property_permission(property_id, 'space.write'));
create policy "Managers edit spaces" on public.spaces for update to authenticated
  using (public.has_property_permission(property_id, 'space.write')) with check (public.has_property_permission(property_id, 'space.write'));
create policy "Managers delete spaces" on public.spaces for delete to authenticated using (public.has_property_permission(property_id, 'space.write'));

drop policy "Hosts manage their connections" on public.channel_connections;
create policy "Members read connections" on public.channel_connections for select to authenticated using (public.has_org_permission(org_id, 'property.read'));
create policy "Managers add connections" on public.channel_connections for insert to authenticated
  with check (public.has_org_permission(org_id, 'space.write') and host_id = (select auth.uid()));
create policy "Managers edit connections" on public.channel_connections for update to authenticated
  using (public.has_org_permission(org_id, 'space.write')) with check (public.has_org_permission(org_id, 'space.write'));
create policy "Managers delete connections" on public.channel_connections for delete to authenticated using (public.has_org_permission(org_id, 'space.write'));

drop policy "Hosts manage their listings" on public.channel_listings;
create policy "Members read listings" on public.channel_listings for select to authenticated using (public.can_view_space(space_id));
create policy "Managers add listings" on public.channel_listings for insert to authenticated with check (public.can_manage_space(space_id));
create policy "Managers edit listings" on public.channel_listings for update to authenticated using (public.can_manage_space(space_id)) with check (public.can_manage_space(space_id));
create policy "Managers delete listings" on public.channel_listings for delete to authenticated using (public.can_manage_space(space_id));

-- Calendar links carry secret tokens (audit finding 2): only people who can manage the space can read them.
drop policy "Hosts manage their calendar imports" on public.calendar_imports;
create policy "Managers manage calendar imports" on public.calendar_imports for all to authenticated
  using (public.can_manage_space(space_id)) with check (public.can_manage_space(space_id));
drop policy "Hosts manage their calendar feeds" on public.calendar_feeds;
create policy "Managers manage calendar feeds" on public.calendar_feeds for all to authenticated
  using (public.can_manage_space(space_id)) with check (public.can_manage_space(space_id));

drop policy "Hosts manage their reservations" on public.reservations;
create policy "Members read reservations" on public.reservations for select to authenticated using (public.can_view_space(space_id));
create policy "Operators add reservations" on public.reservations for insert to authenticated with check (public.has_space_permission(space_id, 'booking.write'));
create policy "Operators edit reservations" on public.reservations for update to authenticated
  using (public.has_space_permission(space_id, 'booking.write')) with check (public.has_space_permission(space_id, 'booking.write'));
create policy "Operators delete reservations" on public.reservations for delete to authenticated using (public.has_space_permission(space_id, 'booking.write'));

drop policy "Hosts see their conflicts" on public.conflicts;
create policy "Members see conflicts" on public.conflicts for select to authenticated using (public.can_view_space(space_id));
drop policy "Hosts see their holds" on public.booking_holds;
create policy "Members see holds" on public.booking_holds for select to authenticated using (public.can_view_space(space_id));
drop policy "Hosts see their alerts" on public.booking_alerts;
create policy "Members see alerts" on public.booking_alerts for select to authenticated using (public.can_view_space(space_id));

drop policy "Hosts see their earnings" on public.earnings_ledger;
-- Visibility follows current membership (review finding 12): finance readers of the property's org, or the ledger's
-- host while still an active member of that org. A host removed from a team org no longer reads its earnings.
create policy "Hosts and finance readers see earnings" on public.earnings_ledger for select to authenticated using (exists (
    select 1 from public.reservations r join public.spaces s on s.id = r.space_id join public.properties p on p.id = s.property_id
    where r.id = earnings_ledger.reservation_id
      and (public.has_org_permission(p.org_id, 'finance.read')
           or (earnings_ledger.host_id = (select auth.uid()) and public.is_org_member(p.org_id)))));

-- ---------------------------------------------------------------- function privileges
revoke execute on function public.has_org_permission(uuid, text), public.is_org_member(uuid), public.org_role_rank(uuid),
  public.has_property_permission(uuid, text), public.has_space_permission(uuid, text), public.can_view_space(uuid),
  public.can_manage_space(uuid), public.owns_space(uuid), public.create_organization(text),
  public.ensure_personal_org(uuid), public.on_profile_created(), public.default_org_from_host(), public.guard_host_id(),
  public.guard_membership(), public.accept_invite(uuid), public.decline_invite(uuid), public.org_member_profiles(uuid)
  from public, anon, authenticated;
grant execute on function public.has_org_permission(uuid, text), public.is_org_member(uuid), public.org_role_rank(uuid),
  public.has_property_permission(uuid, text), public.has_space_permission(uuid, text), public.can_view_space(uuid),
  public.can_manage_space(uuid), public.owns_space(uuid), public.create_organization(text),
  public.accept_invite(uuid), public.decline_invite(uuid), public.org_member_profiles(uuid)
  to authenticated;
grant execute on function public.ensure_personal_org(uuid) to service_role;

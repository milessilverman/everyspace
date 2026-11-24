-- M4: operations. Pricing rules, expenses, revenue entries, maintenance tasks, a guest-communication log, and three
-- additive reservation columns. Org-scoped tables get org_id filled from their property/space when it is omitted.

-- ---------------------------------------------------------------- reservations (additive)
-- source: 'csv' added for owner-uploaded booking exports (existing values unchanged).
alter table public.reservations drop constraint reservations_source_check;
alter table public.reservations add constraint reservations_source_check
  check (source in ('ical', 'email', 'api', 'manual', 'everyspace', 'csv'));
alter table public.reservations
  add column guest_count int check (guest_count between 1 and 10000),
  add column import_batch_id uuid;
create index on public.reservations (import_batch_id) where import_batch_id is not null;

-- ---------------------------------------------------------------- pricing rules
create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  channel_key text references public.channels (key) on update cascade, -- null = every site
  rule_type text not null check (rule_type in ('base', 'seasonal', 'weekday', 'length_of_stay', 'discount', 'fee', 'minimum')),
  unit text not null check (unit in ('hour', 'day', 'night', 'week', 'month')),
  amount_cents bigint not null,
  starts_on date,
  ends_on date,
  dow int[] check (dow <@ array[0, 1, 2, 3, 4, 5, 6]), -- 0 = Sunday
  min_units int check (min_units >= 1),
  priority int not null default 0,
  created_at timestamptz not null default now(),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  check (rule_type = 'discount' or amount_cents >= 0)
);
create index on public.pricing_rules (space_id);
create index on public.pricing_rules (channel_key);

-- ---------------------------------------------------------------- expenses, revenue
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  property_id uuid references public.properties (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete cascade,
  category text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  incurred_on date not null,
  recurring text not null default 'none' check (recurring in ('none', 'weekly', 'monthly', 'quarterly', 'yearly')),
  note text,
  created_at timestamptz not null default now()
);
create index on public.expenses (org_id, incurred_on);
create index on public.expenses (property_id);
create index on public.expenses (space_id);
create trigger expenses_tenant_refs before insert or update on public.expenses for each row execute function public.check_tenant_refs();

-- net = gross - platform fee - cleaning - tax. gross is everything the guest paid for the booking; cleaning and tax
-- are the parts passed through to the cleaner and the tax authority.
create table public.revenue_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  property_id uuid references public.properties (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete cascade,
  reservation_id uuid references public.reservations (id) on delete set null,
  channel_key text references public.channels (key) on update cascade,
  gross_cents bigint not null check (gross_cents >= 0),
  platform_fee_cents bigint not null default 0 check (platform_fee_cents >= 0),
  cleaning_cents bigint not null default 0 check (cleaning_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  net_cents bigint generated always as (gross_cents - platform_fee_cents - cleaning_cents - tax_cents) stored,
  currency text not null default 'USD',
  earned_on date not null,
  source text not null default 'manual' check (source in ('manual', 'csv', 'ical', 'email', 'api', 'everyspace')),
  created_at timestamptz not null default now()
);
create index on public.revenue_entries (org_id, earned_on);
create index on public.revenue_entries (property_id);
create index on public.revenue_entries (space_id);
create index on public.revenue_entries (reservation_id);
create index on public.revenue_entries (channel_key);
create trigger revenue_entries_tenant_refs before insert or update on public.revenue_entries for each row execute function public.check_tenant_refs();

-- ---------------------------------------------------------------- maintenance
create table public.maintenance_tasks (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete cascade,
  reservation_id uuid references public.reservations (id) on delete set null,
  kind text not null check (kind in ('turnover', 'cleaning', 'repair', 'inspection', 'restock', 'other')),
  title text,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  assigned_to uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.maintenance_tasks (property_id, due_at);
create index on public.maintenance_tasks (space_id);
create index on public.maintenance_tasks (reservation_id);
create index on public.maintenance_tasks (assigned_to);
create trigger maintenance_tasks_tenant_refs before insert or update on public.maintenance_tasks for each row execute function public.check_tenant_refs();

-- The assignee must be an active member of the property's org (checked for everyone).
create function public.check_task_assignee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_to is not null and not exists (
    select 1 from public.memberships m join public.properties p on p.org_id = m.org_id
    where p.id = new.property_id and m.user_id = new.assigned_to and m.status = 'active') then
    raise exception 'Tasks can only be assigned to a member of this organization.' using errcode = '23503';
  end if;
  return new;
end $$;
create trigger maintenance_tasks_assignee before insert or update of assigned_to, property_id on public.maintenance_tasks
  for each row execute function public.check_task_assignee();

-- An assignee without task.write may change only the status (runs as the caller).
create function public.guard_task_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if current_user in ('authenticated', 'anon') and not public.has_property_permission(old.property_id, 'task.write')
     and (to_jsonb(new) - 'status' - 'updated_at') is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
    raise exception 'You can only update the status of a task assigned to you.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger maintenance_tasks_guard before update on public.maintenance_tasks for each row execute function public.guard_task_update();

-- ---------------------------------------------------------------- communications
create table public.communications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  space_id uuid references public.spaces (id) on delete cascade,
  reservation_id uuid references public.reservations (id) on delete set null,
  channel_key text references public.channels (key) on update cascade,
  direction text not null check (direction in ('inbound', 'outbound', 'note')),
  body text not null check (length(body) <= 20000),
  sent_at timestamptz not null default now(),
  source text not null default 'manual' check (source in ('manual', 'email', 'api', 'csv')),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.communications (org_id, sent_at);
create index on public.communications (space_id);
create index on public.communications (reservation_id);
create index on public.communications (channel_key);
create index on public.communications (created_by);
create trigger communications_tenant_refs before insert or update on public.communications for each row execute function public.check_tenant_refs();

-- ---------------------------------------------------------------- row-level security
alter table public.pricing_rules enable row level security;
alter table public.expenses enable row level security;
alter table public.revenue_entries enable row level security;
alter table public.maintenance_tasks enable row level security;
alter table public.communications enable row level security;

create policy "Members read pricing rules" on public.pricing_rules for select to authenticated using (public.can_view_space(space_id));
create policy "Managers write pricing rules" on public.pricing_rules for all to authenticated
  using (public.can_manage_space(space_id)) with check (public.can_manage_space(space_id));

create policy "Finance readers see expenses" on public.expenses for select to authenticated using (public.has_org_permission(org_id, 'finance.read'));
create policy "Finance writers add expenses" on public.expenses for insert to authenticated with check (public.has_org_permission(org_id, 'finance.write'));
create policy "Finance writers edit expenses" on public.expenses for update to authenticated
  using (public.has_org_permission(org_id, 'finance.write')) with check (public.has_org_permission(org_id, 'finance.write'));
create policy "Finance writers delete expenses" on public.expenses for delete to authenticated using (public.has_org_permission(org_id, 'finance.write'));

create policy "Finance readers see revenue" on public.revenue_entries for select to authenticated using (public.has_org_permission(org_id, 'finance.read'));
create policy "Finance writers add revenue" on public.revenue_entries for insert to authenticated with check (public.has_org_permission(org_id, 'finance.write'));
create policy "Finance writers edit revenue" on public.revenue_entries for update to authenticated
  using (public.has_org_permission(org_id, 'finance.write')) with check (public.has_org_permission(org_id, 'finance.write'));
create policy "Finance writers delete revenue" on public.revenue_entries for delete to authenticated using (public.has_org_permission(org_id, 'finance.write'));

create policy "Members read tasks" on public.maintenance_tasks for select to authenticated using (public.has_property_permission(property_id, 'property.read'));
create policy "Managers add tasks" on public.maintenance_tasks for insert to authenticated with check (public.has_property_permission(property_id, 'task.write'));
create policy "Managers and assignees update tasks" on public.maintenance_tasks for update to authenticated
  using (public.has_property_permission(property_id, 'task.write')
         or (assigned_to = (select auth.uid()) and public.has_property_permission(property_id, 'task.update')))
  with check (public.has_property_permission(property_id, 'task.write')
         or (assigned_to = (select auth.uid()) and public.has_property_permission(property_id, 'task.update')));
create policy "Managers delete tasks" on public.maintenance_tasks for delete to authenticated using (public.has_property_permission(property_id, 'task.write'));

create policy "Members read communications" on public.communications for select to authenticated using (public.has_org_permission(org_id, 'property.read'));
create policy "Managers log communications" on public.communications for insert to authenticated with check (public.has_org_permission(org_id, 'comms.write'));
create policy "Managers edit communications" on public.communications for update to authenticated
  using (public.has_org_permission(org_id, 'comms.write')) with check (public.has_org_permission(org_id, 'comms.write'));
create policy "Managers delete communications" on public.communications for delete to authenticated using (public.has_org_permission(org_id, 'comms.write'));

revoke execute on function public.check_task_assignee(), public.guard_task_update() from public, anon, authenticated;

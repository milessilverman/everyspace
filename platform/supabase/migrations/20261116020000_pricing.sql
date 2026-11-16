-- Pricing: a share of the extra revenue Everyspace brings in, no monthly fee.
-- Each host, each month: 10% until Everyspace's fee reaches $30, then 3% on the rest of that month.
-- Example: $1,000 of extra bookings in a month → $30 + 3% of $700 ($21) = $51 (5.1%). Bigger months trend to 3%.
-- Only attributed revenue is ever charged (see public.is_attributed). All three numbers live in app_settings.

alter table public.app_settings
  add column intro_share_pct numeric(5, 2) not null default 10.00 check (intro_share_pct between 0 and 50),
  add column intro_fee_cap_cents bigint not null default 3000 check (intro_fee_cap_cents >= 0),
  add column standard_share_pct numeric(5, 2) not null default 3.00 check (standard_share_pct between 0 and 50);
comment on column public.app_settings.intro_share_pct is 'Share charged each month until the fee reaches intro_fee_cap_cents.';
comment on column public.app_settings.intro_fee_cap_cents is 'Monthly fee per host charged at the intro share ($30 = 3000).';
comment on column public.app_settings.standard_share_pct is 'Share charged on the rest of the month once the intro cap is reached.';

-- Adds finished, paid bookings to the ledger in the order they ended. Safe to run repeatedly.
-- share_pct on each ledger row is the effective rate for that booking.
create or replace function public.accrue_earnings() returns int
language plpgsql security definer set search_path = '' as $$
declare
  st public.app_settings;
  r record;
  so_far bigint; room bigint; intro_gross bigint; fee bigint; attr boolean;
  n int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('accrue_earnings', 0));
  select * into st from public.app_settings;
  for r in
    select p.host_id, res.id, date_trunc('month', res.ends_at at time zone p.timezone)::date as period, res.payout_cents as gross
    from public.reservations res
    join public.spaces s on s.id = res.space_id
    join public.properties p on p.id = s.property_id
    where res.kind = 'booking' and res.status = 'confirmed' and res.payout_cents is not null and res.ends_at <= now()
      and not exists (select 1 from public.earnings_ledger l where l.reservation_id = res.id)
    order by res.ends_at, res.id
  loop
    attr := public.is_attributed(r.id);
    fee := 0;
    if attr then
      select coalesce(sum(l.fee_cents), 0) into so_far from public.earnings_ledger l where l.host_id = r.host_id and l.period = r.period;
      room := greatest(st.intro_fee_cap_cents - so_far, 0);
      intro_gross := case when st.intro_share_pct > 0 then least(r.gross, floor(room * 100 / st.intro_share_pct)::bigint) else 0 end;
      fee := round(intro_gross * st.intro_share_pct / 100) + round((r.gross - intro_gross) * st.standard_share_pct / 100);
    end if;
    insert into public.earnings_ledger (host_id, reservation_id, period, gross_cents, attributed, share_pct, fee_cents)
    values (r.host_id, r.id, r.period, r.gross, attr,
            case when r.gross > 0 then round(fee * 100.0 / r.gross, 2) else 0 end, fee)
    on conflict (reservation_id) do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

alter table public.app_settings drop column revenue_share_pct;

-- Internal helpers aren't callable from outside (signed-in hosts still need owns_space for row-level security).
revoke execute on function public.is_attributed(uuid), public.handle_new_user(), public.check_space_parent(),
  public.enforce_one_door() from public, anon, authenticated;
revoke execute on function public.owns_space(uuid) from public, anon;
grant execute on function public.owns_space(uuid) to authenticated;

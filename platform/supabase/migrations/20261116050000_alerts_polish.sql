-- Clearer guard alerts, and a way for hosts to acknowledge "accepted without the check" alerts.

-- Name the nights to close ("Dec 8 – Dec 9"), not the check-out day, so hosts don't close a night they could rent.
create or replace function public.record_door_gaps(p_space uuid, p_channel public.channel, p_reservations uuid[], p_holds uuid[]) returns int
language plpgsql security definer set search_path = '' as $$
declare added int; tz text; site text := public.site_name(p_channel::text);
begin
  select p.timezone into tz from public.spaces s join public.properties p on p.id = s.property_id where s.id = p_space;
  update public.booking_alerts a set resolved_at = now()
  where a.kind = 'door_open' and a.channel = p_channel and a.resolved_at is null
    and a.space_id in (select public.related_spaces(p_space))
    and not (coalesce(a.reservation_id = any(p_reservations), false) or coalesce(a.hold_id = any(p_holds), false));
  with gaps as (
    select r.space_id, r.id as rid, null::uuid as hid, r.starts_at, r.ends_at, r.all_day, r.channel::text as src
    from public.reservations r where r.id = any(p_reservations)
    union all
    select h.space_id, null, h.id, h.starts_at, h.ends_at, h.all_day, h.channel::text from public.booking_holds h where h.id = any(p_holds)
  ), worded as (
    select g.*,
      to_char(g.starts_at at time zone tz, 'Mon FMDD') as first_night,
      to_char(case when g.all_day then g.ends_at - interval '12 hours' else g.ends_at end at time zone tz, 'Mon FMDD') as last_night
    from gaps g
  ), ins as (
    insert into public.booking_alerts (space_id, kind, channel, reservation_id, hold_id, message)
    select w.space_id, 'door_open', p_channel, w.rid, w.hid,
      case when not w.all_day then format('Close %s on %s now. It''s booked on %s, but still open there.', w.first_night, site, public.site_name(w.src))
           when w.first_night = w.last_night then format('Close the night of %s on %s now. It''s booked on %s, but still open there.', w.first_night, site, public.site_name(w.src))
           else format('Close the nights of %s – %s on %s now. They''re booked on %s, but still open there.', w.first_night, w.last_night, site, public.site_name(w.src)) end
    from worded w
    on conflict (kind, channel, reservation_id, hold_id) do update set resolved_at = null, message = excluded.message
    returning 1
  ) select count(*) into added from ins;
  return added;
end $$;

-- A host has looked into a booking that was accepted without Everyspace's check. (Dates-still-open alerts can't be
-- dismissed: they clear by themselves once the dates are closed.)
create function public.dismiss_alert(p_alert uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_alerts set resolved_at = now()
  where id = p_alert and kind = 'unchecked_accept' and resolved_at is null and public.owns_space(space_id);
  return found;
end $$;
revoke execute on function public.dismiss_alert(uuid) from public, anon;
grant execute on function public.dismiss_alert(uuid) to authenticated;

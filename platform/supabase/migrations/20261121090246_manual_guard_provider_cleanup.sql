-- Bind cleanup on every related instant listing to the final hold check.
create or replace function public.manual_guard_snapshot(p_space uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('time_zone', p.timezone, 'turnover', s.turnover_minutes, 'doors', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'space_id', d.space_id, 'channel', d.channel, 'mode_since', l.mode_since,
      'import_id', i.id, 'url', i.url, 'turnover_minutes', listing_space.turnover_minutes
    ) order by d.space_id, d.channel), '[]'::jsonb)
    from public.door_listings(p_space) d
    join public.spaces listing_space on listing_space.id = d.space_id
    join public.channel_listings l on l.space_id = d.space_id and l.channel = d.channel
    left join public.calendar_imports i on i.space_id = d.space_id and i.channel = d.channel
  ))
  from public.spaces s join public.properties p on p.id = s.property_id where s.id = p_space
$$;

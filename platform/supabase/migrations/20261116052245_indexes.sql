-- Indexes for the foreign keys the Supabase performance advisor flagged (used by the family lookups and the guard).
create index if not exists spaces_parent_space_id_idx on public.spaces (parent_space_id);
create index if not exists booking_holds_reservation_id_idx on public.booking_holds (reservation_id);
create index if not exists booking_alerts_reservation_id_idx on public.booking_alerts (reservation_id);
create index if not exists booking_alerts_hold_id_idx on public.booking_alerts (hold_id);
create index if not exists conflicts_space_id_idx on public.conflicts (space_id);
create index if not exists conflicts_b_reservation_id_idx on public.conflicts (b_reservation_id);

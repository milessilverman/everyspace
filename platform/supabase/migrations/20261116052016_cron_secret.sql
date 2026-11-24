-- The 15-minute schedule proves itself to calendar-sync with a random secret kept in Supabase Vault
-- ('calendar_sync_cron_secret', created in supabase/cron/calendar_sync.sql). Only the service role can check it.
create function public.check_cron_secret(p_secret text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  return p_secret is not null and length(p_secret) >= 32 and exists (
    select 1 from vault.decrypted_secrets where name = 'calendar_sync_cron_secret' and decrypted_secret = p_secret);
end $$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

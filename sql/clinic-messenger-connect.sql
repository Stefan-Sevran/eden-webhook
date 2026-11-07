-- Apply after clinic-messenger-pilot.sql.
begin;

create table public.clinic_messenger_credentials (
  connection_id uuid primary key references public.clinic_channel_connections(id) on delete cascade,
  token_ciphertext text not null
);
alter table public.clinic_messenger_credentials enable row level security;
revoke all on public.clinic_messenger_credentials from public, anon, authenticated;
grant select, insert, update on public.clinic_messenger_credentials to service_role;

create function public.save_clinic_messenger_credential(
  target_account uuid, target_location uuid, target_page text, encrypted_token text
) returns text language plpgsql security invoker set search_path = '' as $$
declare
  connection uuid;
  connection_status text;
begin
  insert into public.clinic_channel_connections as existing
    (account_id, location_id, channel, status, external_id)
  values
    (target_account, target_location, 'facebook_messenger', 'verifying', target_page)
  on conflict (location_id, channel) do update
    set external_id = excluded.external_id,
        status = case when existing.status = 'connected' then 'connected' else 'verifying' end,
        updated_at = now()
  where existing.account_id = excluded.account_id
    and (existing.external_id is null or existing.external_id = excluded.external_id)
  returning id, status into connection, connection_status;

  if connection is null then return null; end if;

  insert into public.clinic_messenger_credentials(connection_id, token_ciphertext)
  values (connection, encrypted_token)
  on conflict (connection_id) do update
    set token_ciphertext = excluded.token_ciphertext;
  return connection_status;
exception when unique_violation then
  return null;
end;
$$;

revoke execute on function public.save_clinic_messenger_credential(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_clinic_messenger_credential(uuid, uuid, text, text) to service_role;

commit;

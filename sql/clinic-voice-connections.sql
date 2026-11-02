-- Apply after clinic-tenancy.sql. The called number belongs to an ElevenLabs
-- agent, not the clinic's existing phone number that forwards to it.
alter table public.clinic_channel_connections
  add column if not exists forwarding_number text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clinic_voice_number_format'
    and conrelid = 'public.clinic_channel_connections'::regclass) then
    alter table public.clinic_channel_connections
      add constraint clinic_voice_number_format
      check (forwarding_number is null or
        (channel = 'ai_phone' and forwarding_number ~ '^\+[1-9][0-9]{7,14}$'));
  end if;
end;
$$;

-- An active/verifying agent and destination may never be assigned to two clinics.
create unique index if not exists clinic_voice_agent_unique
  on public.clinic_channel_connections(external_id)
  where channel = 'ai_phone' and status in ('verifying', 'connected');
create unique index if not exists clinic_voice_number_unique
  on public.clinic_channel_connections(forwarding_number)
  where channel = 'ai_phone' and status in ('verifying', 'connected');

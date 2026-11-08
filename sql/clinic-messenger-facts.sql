-- Apply after clinic-tenancy.sql and before deploying the guided setup API.
-- Writes go through the authenticated, pilot-scoped clinic API.
alter table public.clinic_locations
  add column if not exists messenger_facts jsonb;

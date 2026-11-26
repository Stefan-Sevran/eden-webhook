begin;

create table public.pearlsmile_calendar_claims (
  location_id uuid not null references public.clinic_locations(id),
  slot_at timestamptz not null,
  request_id uuid not null,
  attempt_until timestamptz not null default (now() + interval '90 seconds'),
  primary key (location_id, slot_at),
  unique (location_id, request_id)
);

alter table public.pearlsmile_calendar_claims enable row level security;
revoke all on public.pearlsmile_calendar_claims from public, anon, authenticated;
grant select, insert, update on public.pearlsmile_calendar_claims to service_role;

commit;

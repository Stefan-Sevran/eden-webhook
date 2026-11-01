-- Apply after clinic-outcomes.sql. Legacy Eden/demo events remain internal until
-- explicitly assigned to an account and location. No patient data is migrated.
create table if not exists public.clinic_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 120),
  created_at timestamptz not null default now()
);

create table if not exists public.clinic_memberships (
  account_id uuid not null references public.clinic_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'staff')),
  primary key (account_id, user_id)
);
create index if not exists clinic_memberships_user_idx
  on public.clinic_memberships(user_id, account_id);

create table if not exists public.clinic_locations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.clinic_accounts(id) on delete cascade,
  name text not null check (length(name) between 2 and 120),
  timezone text not null default 'Asia/Manila',
  alert_email text,
  created_at timestamptz not null default now(),
  unique (id, account_id)
);
create index if not exists clinic_locations_account_idx
  on public.clinic_locations(account_id);

create table if not exists public.clinic_channel_connections (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  location_id uuid not null,
  channel text not null check (channel in ('website_chat', 'facebook_messenger', 'ai_phone')),
  status text not null default 'requested'
    check (status in ('requested', 'verifying', 'connected', 'action_required', 'disconnected')),
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (location_id, account_id)
    references public.clinic_locations(id, account_id) on delete cascade,
  unique (location_id, channel)
);
create index if not exists clinic_channels_account_idx
  on public.clinic_channel_connections(account_id);

alter table public.clinic_outcomes
  add column if not exists account_id uuid references public.clinic_accounts(id),
  add column if not exists location_id uuid;
alter table public.clinic_outcomes
  drop constraint if exists clinic_outcomes_location_account_fk;
alter table public.clinic_outcomes
  add constraint clinic_outcomes_location_account_fk
  foreign key (location_id, account_id)
  references public.clinic_locations(id, account_id);
create index if not exists clinic_outcomes_account_recent_idx
  on public.clinic_outcomes(account_id, occurred_at desc);

alter table public.clinic_accounts enable row level security;
alter table public.clinic_memberships enable row level security;
alter table public.clinic_locations enable row level security;
alter table public.clinic_channel_connections enable row level security;

-- Membership reads its own user_id; other policies may safely consult it.
create policy clinic_memberships_own_read on public.clinic_memberships
  for select to authenticated using (user_id = (select auth.uid()));
create policy clinic_accounts_member_read on public.clinic_accounts
  for select to authenticated using (exists (
    select 1 from public.clinic_memberships m
    where m.account_id = id and m.user_id = (select auth.uid())
  ));
create policy clinic_locations_member_read on public.clinic_locations
  for select to authenticated using (exists (
    select 1 from public.clinic_memberships m
    where m.account_id = clinic_locations.account_id
      and m.user_id = (select auth.uid())
  ));
create policy clinic_locations_admin_insert on public.clinic_locations
  for insert to authenticated with check (exists (
    select 1 from public.clinic_memberships m
    where m.account_id = clinic_locations.account_id
      and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
  ));
create policy clinic_channels_member_read on public.clinic_channel_connections
  for select to authenticated using (exists (
    select 1 from public.clinic_memberships m
    where m.account_id = clinic_channel_connections.account_id
      and m.user_id = (select auth.uid())
  ));
create policy clinic_channels_admin_request on public.clinic_channel_connections
  for insert to authenticated with check (
    status = 'requested' and external_id is null and exists (
      select 1 from public.clinic_memberships m
      where m.account_id = clinic_channel_connections.account_id
        and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
    )
  );
create policy clinic_outcomes_member_read on public.clinic_outcomes
  for select to authenticated using (
    account_id is not null and exists (
      select 1 from public.clinic_memberships m
      where m.account_id = clinic_outcomes.account_id
        and m.user_id = (select auth.uid())
    )
  );

revoke all on public.clinic_accounts, public.clinic_memberships,
  public.clinic_locations, public.clinic_channel_connections from anon, authenticated;
grant select on public.clinic_accounts, public.clinic_memberships,
  public.clinic_locations, public.clinic_channel_connections to authenticated;
grant insert on public.clinic_locations, public.clinic_channel_connections to authenticated;
grant select, insert, update on public.clinic_accounts, public.clinic_memberships,
  public.clinic_locations, public.clinic_channel_connections to service_role;
grant select on public.clinic_outcomes to authenticated;

-- A single transaction creates the account, first location, and owner membership.
create or replace function public.create_clinic_account(account_name text, location_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare new_id uuid;
begin
  if auth.uid() is null or length(trim(account_name)) not between 2 and 120
    or length(trim(location_name)) not between 2 and 120 then
    raise exception 'Invalid clinic account request';
  end if;
  insert into public.clinic_accounts(name) values (trim(account_name)) returning id into new_id;
  insert into public.clinic_memberships(account_id, user_id, role)
    values (new_id, auth.uid(), 'owner');
  insert into public.clinic_locations(account_id, name)
    values (new_id, trim(location_name));
  return new_id;
end;
$$;
revoke all on function public.create_clinic_account(text, text) from public, anon;
grant execute on function public.create_clinic_account(text, text) to authenticated;

-- Recreate the view to partition booking cases by tenant and location.
drop view if exists public.clinic_booking_cases;
create view public.clinic_booking_cases with (security_invoker = true) as
select distinct on (account_id, location_id, details->>'bookingId')
  event_key, clinic_id, channel, kind, status, summary, details,
  occurred_at, notification_state, account_id, location_id
from public.clinic_outcomes
where kind in ('booking.requested', 'booking.updated', 'booking.cancelled')
  and nullif(details->>'bookingId', '') is not null
order by account_id, location_id, details->>'bookingId', occurred_at desc, event_key desc;
revoke all on public.clinic_booking_cases from anon, authenticated;
grant select on public.clinic_booking_cases to authenticated, service_role;

-- Append-only staff actions for booking requests and calls requiring follow-up.
-- Apply after clinic-tenancy.sql. Existing outcomes remain open by default.
create table if not exists public.clinic_followup_actions (
  id bigint generated always as identity primary key,
  event_key text not null references public.clinic_outcomes(event_key) on delete cascade,
  account_id uuid not null references public.clinic_accounts(id) on delete cascade,
  location_id uuid not null,
  actor_user_id uuid not null references auth.users(id),
  action text not null check (action in ('handled', 'reopened')),
  created_at timestamptz not null default now(),
  foreign key (location_id, account_id)
    references public.clinic_locations(id, account_id)
);
create index if not exists clinic_followup_account_recent_idx
  on public.clinic_followup_actions(account_id, location_id, created_at desc, id desc);

alter table public.clinic_followup_actions enable row level security;
create policy clinic_followup_member_read on public.clinic_followup_actions
  for select to authenticated using (exists (
    select 1 from public.clinic_memberships m
    where m.account_id = clinic_followup_actions.account_id
      and m.user_id = (select auth.uid())
  ));
create policy clinic_followup_member_append on public.clinic_followup_actions
  for insert to authenticated with check (
    actor_user_id = (select auth.uid())
    and exists (
      select 1 from public.clinic_memberships m
      where m.account_id = clinic_followup_actions.account_id
        and m.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.clinic_outcomes e
      where e.event_key = clinic_followup_actions.event_key
        and e.account_id = clinic_followup_actions.account_id
        and e.location_id = clinic_followup_actions.location_id
        and e.kind in ('call.followup_needed', 'booking.requested')
    )
  );
revoke all on public.clinic_followup_actions from anon, authenticated;
grant select, insert on public.clinic_followup_actions to authenticated;
grant select on public.clinic_followup_actions to service_role;

create or replace view public.clinic_followup_states
with (security_invoker = true) as
select distinct on (event_key)
  event_key, account_id, location_id, action, actor_user_id, created_at
from public.clinic_followup_actions
order by event_key, created_at desc, id desc;
revoke all on public.clinic_followup_states from anon, authenticated;
grant select on public.clinic_followup_states to authenticated, service_role;

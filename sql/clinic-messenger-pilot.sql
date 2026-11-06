-- Apply after clinic-confirmed-appointments.sql.
begin;

create unique index clinic_messenger_active_page_idx
  on public.clinic_channel_connections(external_id)
  where channel = 'facebook_messenger' and status in ('verifying', 'connected');

create table public.clinic_messenger_turns (
  event_key text primary key,
  conversation_key text not null,
  received_at timestamptz not null,
  draft jsonb not null,
  case_key text,
  state text not null default 'prepared' check (state in ('prepared', 'sending', 'sent', 'needs_review')),
  updated_at timestamptz not null default now()
);
create index clinic_messenger_recent_turn_idx
  on public.clinic_messenger_turns(conversation_key, received_at desc, updated_at desc, event_key);
alter table public.clinic_messenger_turns enable row level security;
revoke all on public.clinic_messenger_turns from public, anon, authenticated;
grant select, insert, update on public.clinic_messenger_turns to service_role;

alter policy clinic_followup_member_append on public.clinic_followup_actions
  with check (
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
        and e.kind in ('call.followup_needed', 'booking.requested', 'inquiry.followup_needed')
    )
  );

commit;

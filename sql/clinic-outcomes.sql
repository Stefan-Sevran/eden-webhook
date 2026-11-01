-- Run once in the Supabase SQL editor. Only the backend secret key may access this table.
create table if not exists public.clinic_outcomes (
  event_key text primary key,
  clinic_id text not null,
  channel text not null,
  kind text not null,
  status text not null,
  summary text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  notify_to text,
  notification_state text not null default 'not_configured'
    check (notification_state in ('not_configured', 'pending', 'sending', 'retry', 'sent')),
  notification_attempts integer not null default 0,
  notification_claimed_at timestamptz,
  notification_error text,
  notified_at timestamptz
);

create index if not exists clinic_outcomes_recent_idx
  on public.clinic_outcomes (clinic_id, occurred_at desc);
create index if not exists clinic_outcomes_pending_idx
  on public.clinic_outcomes (notification_state, occurred_at)
  where notification_state in ('pending', 'retry', 'sending');

alter table public.clinic_outcomes enable row level security;
revoke all on public.clinic_outcomes from anon, authenticated;
grant select, insert, update on public.clinic_outcomes to service_role;

create or replace function public.claim_clinic_notifications(batch_size integer default 10)
returns setof public.clinic_outcomes
language sql
security invoker
set search_path = public
as $$
  update public.clinic_outcomes as outcome
  set notification_state = 'sending',
      notification_claimed_at = now(),
      notification_attempts = outcome.notification_attempts + 1
  where outcome.event_key in (
    select candidate.event_key
    from public.clinic_outcomes candidate
    where candidate.notify_to is not null
      and candidate.notification_attempts < 10
      and (
        candidate.notification_state in ('pending', 'retry')
        or (candidate.notification_state = 'sending'
            and candidate.notification_claimed_at < now() - interval '5 minutes')
      )
    order by candidate.occurred_at
    limit least(greatest(batch_size, 1), 20)
    for update skip locked
  )
  returning outcome.*;
$$;
revoke all on function public.claim_clinic_notifications(integer) from public, anon, authenticated;
grant execute on function public.claim_clinic_notifications(integer) to service_role;

-- A current booking queue derived from automatic channel events.
-- This is read-only; no clinic is asked to maintain a separate Sheet.
create or replace view public.clinic_booking_cases
with (security_invoker = true)
as
select distinct on (clinic_id, details->>'bookingId')
  event_key, clinic_id, channel, kind, status, summary, details,
  occurred_at, notification_state
from public.clinic_outcomes
where kind in ('booking.requested', 'booking.updated', 'booking.cancelled')
  and nullif(details->>'bookingId', '') is not null
order by clinic_id, details->>'bookingId', occurred_at desc, event_key desc;

revoke all on public.clinic_booking_cases from anon, authenticated;
grant select on public.clinic_booking_cases to service_role;

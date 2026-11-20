-- Apply after clinic_booking_changes. Restore cancelled bookings as a new staff action.
alter table public.clinic_followup_actions
  drop constraint clinic_followup_prior_action_check,
  drop constraint clinic_followup_actions_action_check,
  drop constraint clinic_followup_appointment_check,
  add constraint clinic_followup_actions_action_check
    check (action in ('handled', 'reopened', 'claimed', 'booked', 'rescheduled', 'cancelled', 'restored')),
  add constraint clinic_followup_appointment_check
    check (
      (appointment_at is null and action not in ('rescheduled', 'restored'))
      or (appointment_at is not null and isfinite(appointment_at) and action in ('booked', 'rescheduled', 'restored'))
    ),
  add constraint clinic_followup_prior_action_check
    check ((action in ('rescheduled', 'cancelled', 'restored')) = (prior_action_at is not null));

-- Older clients and Messenger still use action as the current workflow state.
create or replace view public.clinic_followup_states with (security_invoker = true) as
select latest.event_key, latest.account_id, latest.location_id,
  case latest.action
    when 'rescheduled' then 'booked'
    when 'restored' then 'booked'
    when 'cancelled' then 'handled'
    else latest.action
  end as action,
  latest.actor_user_id, latest.created_at, latest.appointment_at, latest.action as recorded_action,
  case when latest.action = 'cancelled' then (
    select prior.appointment_at from public.clinic_followup_actions prior
    where prior.event_key = latest.event_key and prior.account_id = latest.account_id
      and prior.location_id = latest.location_id and prior.created_at = latest.prior_action_at
    order by prior.id desc limit 1
  ) end as previous_appointment_at
from (
  select distinct on (event_key) event_key, account_id, location_id, action,
    actor_user_id, created_at, appointment_at, prior_action_at
  from public.clinic_followup_actions
  order by event_key, created_at desc, id desc
) latest;

create or replace function public.guard_clinic_followup_transition()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare previous public.clinic_followup_actions%rowtype;
begin
  -- Serialize actions on this inquiry without giving staff write access to outcomes.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.event_key, 0));
  select * into previous from public.clinic_followup_actions
  where event_key = new.event_key and account_id = new.account_id and location_id = new.location_id
  order by created_at desc, id desc limit 1;

  if new.action in ('rescheduled', 'cancelled', 'restored') then
    if previous.action = new.action
        and previous.actor_user_id = new.actor_user_id
        and previous.prior_action_at = new.prior_action_at
        and previous.appointment_at is not distinct from new.appointment_at then
      return null; -- A retry of a completed change.
    end if;

    if previous.created_at is distinct from new.prior_action_at
        or (new.action = 'restored' and previous.action is distinct from 'cancelled')
        or (new.action <> 'restored' and coalesce(previous.action, '') not in ('booked', 'rescheduled', 'restored')) then
      raise exception using errcode = '23505', message = 'Clinic booking changed';
    end if;

    if new.action = 'rescheduled' and previous.appointment_at = new.appointment_at then
      return null;
    end if;

    new.created_at := greatest(pg_catalog.clock_timestamp(), previous.created_at + interval '1 microsecond');
    return new;
  end if;

  if new.action in ('claimed', 'booked') and previous.action = new.action
      and previous.actor_user_id = new.actor_user_id
      and previous.appointment_at is not distinct from new.appointment_at then
    return null; -- A retry of a completed write.
  end if;

  if previous.action in ('booked', 'rescheduled', 'cancelled', 'restored')
      or (new.action = 'claimed' and previous.action in ('claimed', 'handled'))
      or (new.action = 'booked' and previous.action is distinct from 'claimed' and (
        (previous.action is not null and previous.action <> 'reopened')
        or new.appointment_at is null
        or not exists (
          select 1 from public.clinic_outcomes e
          where e.event_key = new.event_key and e.account_id = new.account_id
            and e.location_id = new.location_id and e.kind = 'booking.requested'
            and not (coalesce(e.details->>'demo', '') = 'true'
                     and coalesce(e.details->>'messengerSetupTestId', '') <> '')
        )
      ))
      or (previous.action = 'claimed' and previous.actor_user_id <> new.actor_user_id) then
    raise exception using errcode = '23505', message = 'Clinic follow-up state changed';
  end if;

  new.created_at := greatest(pg_catalog.clock_timestamp(), previous.created_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.guard_clinic_followup_transition() from public, anon, authenticated;

-- Convert the selected clock time using the location's zone and write as the
-- signed-in staff member. The same row policies and transition guard still apply.
create or replace function public.save_clinic_appointment(
  p_account_id uuid,
  p_location_id uuid,
  p_event_key text,
  p_action text,
  p_prior_action_at timestamptz,
  p_local_time timestamp without time zone
) returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  clinic_zone text;
  appointment timestamptz;
  normal_time timestamptz;
  valid_times integer;
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'Sign in to change the appointment';
  end if;
  if p_action is null or p_action not in ('booked', 'rescheduled', 'cancelled', 'restored')
      or (p_action = 'booked') <> (p_prior_action_at is null)
      or (p_action = 'cancelled') <> (p_local_time is null)
      or (p_local_time is not null and not pg_catalog.isfinite(p_local_time)) then
    raise exception using errcode = '22023', message = 'Invalid appointment change';
  end if;

  select l.timezone into clinic_zone from public.clinic_locations l
  where l.id = p_location_id and l.account_id = p_account_id;

  if clinic_zone is null then
    raise exception using errcode = '42501', message = 'Clinic location unavailable';
  end if;

  if p_local_time is not null then
    normal_time := p_local_time at time zone clinic_zone;
    -- Consider the offsets on each side of a daylight-saving transition.
    with candidate_times as (
      select p_local_time at time zone (
        pg_catalog.timezone(clinic_zone, probe) - pg_catalog.timezone('UTC', probe)
      ) as time
      from pg_catalog.unnest(array[normal_time - interval '24 hours', normal_time, normal_time + interval '24 hours']) as probe
    )
    select count(distinct time), min(time) into valid_times, appointment
    from candidate_times
    where pg_catalog.timezone(clinic_zone, time) = p_local_time;

    if valid_times <> 1 then
      raise exception using errcode = '22023', message = 'Choose a time outside the clinic’s clock change';
    end if;
  end if;

  insert into public.clinic_followup_actions (
    account_id, location_id, event_key, actor_user_id, action, appointment_at, prior_action_at
  ) values (p_account_id, p_location_id, p_event_key, actor, p_action, appointment, p_prior_action_at);
end;
$$;
revoke all on function public.save_clinic_appointment(uuid, uuid, text, text, timestamptz, timestamp)
  from public, anon, authenticated;
grant execute on function public.save_clinic_appointment(uuid, uuid, text, text, timestamptz, timestamp)
  to authenticated;

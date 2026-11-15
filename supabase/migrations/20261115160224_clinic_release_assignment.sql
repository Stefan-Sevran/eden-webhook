-- A manager clears the exact assignment they reviewed. The original assignee's
-- release path and clinic membership policies still apply to ordinary actions.
alter table public.clinic_followup_actions
  drop constraint clinic_followup_prior_action_check,
  add constraint clinic_followup_prior_action_check check (
    case
      when action in ('rescheduled', 'cancelled', 'restored') then prior_action_at is not null
      when assigned_user_id is not null or action = 'reopened' then true
      else prior_action_at is null
    end
  );

create or replace function public.guard_clinic_followup_transition()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
declare
  previous public.clinic_followup_actions%rowtype;
  previous_assignee uuid;

begin
  -- Serialize actions on this inquiry without giving staff write access to outcomes.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.event_key, 0));
  select * into previous from public.clinic_followup_actions
  where event_key = new.event_key and account_id = new.account_id and location_id = new.location_id
  order by created_at desc, id desc limit 1;

  previous_assignee := coalesce(previous.assigned_user_id, previous.actor_user_id);

  if new.assigned_user_id is not null then
    if not exists (
      select 1 from public.clinic_memberships m
      where m.account_id = new.account_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    ) or not exists (
      select 1 from clinic_team_private.members(new.account_id) m
      where m.user_id = new.assigned_user_id
    ) then
      raise exception using errcode = '42501', message = 'Clinic assignment requires an owner or admin and an active teammate';
    end if;

    if previous.action = 'claimed'
        and previous.actor_user_id = new.actor_user_id
        and previous.assigned_user_id = new.assigned_user_id
        and previous.prior_action_at is not distinct from new.prior_action_at then
      return null;
    end if;
    if coalesce(previous.action, 'reopened') not in ('reopened', 'claimed')
        or previous.created_at is distinct from new.prior_action_at then
      raise exception using errcode = '23505', message = 'Clinic assignment changed';
    end if;

    new.created_at := greatest(pg_catalog.clock_timestamp(), previous.created_at + interval '1 microsecond');
    return new;
  end if;

  if new.action = 'reopened' and new.prior_action_at is not null then
    if not exists (
      select 1 from public.clinic_memberships m
      where m.account_id = new.account_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    ) then
      raise exception using errcode = '42501', message = 'Only an owner or admin can clear an assignment';
    end if;

    if previous.action = 'reopened' and previous.actor_user_id = new.actor_user_id
        and previous.prior_action_at = new.prior_action_at then
      return null;
    end if;
    if previous.action is distinct from 'claimed'
        or previous.created_at is distinct from new.prior_action_at then
      raise exception using errcode = '23505', message = 'Clinic assignment changed';
    end if;

    new.created_at := greatest(pg_catalog.clock_timestamp(), previous.created_at + interval '1 microsecond');
    return new;
  end if;

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
      and (case when new.action = 'claimed' then previous_assignee else previous.actor_user_id end) = new.actor_user_id
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
      or (previous.action = 'claimed' and previous_assignee <> new.actor_user_id) then
    raise exception using errcode = '23505', message = 'Clinic follow-up state changed';
  end if;

  new.created_at := greatest(pg_catalog.clock_timestamp(), previous.created_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.guard_clinic_followup_transition() from public, anon, authenticated;


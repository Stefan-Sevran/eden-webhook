-- Directory labels are visible only to members of the matching clinic account.
create schema clinic_team_private;
revoke all on schema clinic_team_private from public, anon, authenticated;
grant usage on schema clinic_team_private to authenticated;

create function clinic_team_private.members(p_account_id uuid)
returns table(user_id uuid, display_name text)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, left(coalesce(
    nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
    nullif(btrim(u.raw_user_meta_data->>'name'), ''),
    nullif(initcap(regexp_replace(split_part(u.email, '@', 1), '[._-]+', ' ', 'g')), ''),
    'Team member'
  ), 80) as display_name
  from public.clinic_memberships m
  join auth.users u on u.id = m.user_id
  where m.account_id = p_account_id and exists (
    select 1 from public.clinic_memberships viewer
    where viewer.account_id = p_account_id and viewer.user_id = auth.uid()
  )
  order by display_name, m.user_id;
$$;
revoke all on function clinic_team_private.members(uuid) from public, anon, authenticated;
grant execute on function clinic_team_private.members(uuid) to authenticated;

create function public.list_clinic_team(p_account_id uuid)
returns table(user_id uuid, display_name text)
language sql stable security invoker set search_path = ''
as $$ select * from clinic_team_private.members(p_account_id) $$;
revoke all on function public.list_clinic_team(uuid) from public, anon, authenticated;
grant execute on function public.list_clinic_team(uuid) to authenticated;

-- Record who assigned the inquiry and who handles it independently.
alter table public.clinic_followup_actions
  add column assigned_user_id uuid references auth.users(id),
  drop constraint clinic_followup_prior_action_check,
  add constraint clinic_followup_assignee_check check (assigned_user_id is null or action = 'claimed'),
  add constraint clinic_followup_prior_action_check check (
    case
      when action in ('rescheduled', 'cancelled', 'restored') then prior_action_at is not null
      when assigned_user_id is not null then true
      else prior_action_at is null
    end
  );

create or replace view public.clinic_followup_states with (security_invoker = true) as
select latest.event_key, latest.account_id, latest.location_id,
  case latest.action
    when 'rescheduled' then 'booked'
    when 'restored' then 'booked'
    when 'cancelled' then 'handled'
    else latest.action
  end as action,
  coalesce(latest.assigned_user_id, latest.actor_user_id) as actor_user_id, latest.created_at, latest.appointment_at, latest.action as recorded_action,
  case when latest.action = 'cancelled' then (
    select prior.appointment_at from public.clinic_followup_actions prior
    where prior.event_key = latest.event_key and prior.account_id = latest.account_id
      and prior.location_id = latest.location_id and prior.created_at = latest.prior_action_at
    order by prior.id desc limit 1
  ) end as previous_appointment_at
from (
  select distinct on (event_key) event_key, account_id, location_id, action,
    actor_user_id, created_at, appointment_at, prior_action_at, assigned_user_id
  from public.clinic_followup_actions
  order by event_key, created_at desc, id desc
) latest;

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


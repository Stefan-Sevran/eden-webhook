-- Apply after clinic-confirmed-appointments.sql.
-- A staff member may confirm an unassigned booking request with an appointment time.

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

  if new.action in ('claimed', 'booked') and previous.action = new.action
      and previous.actor_user_id = new.actor_user_id
      and previous.appointment_at is not distinct from new.appointment_at then
    return null; -- A retry of a completed write.
  end if;

  if previous.action = 'booked'
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

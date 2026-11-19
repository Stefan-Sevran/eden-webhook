-- The completed walk-in RPC writes its outcome and initial appointment together.
-- All ordinary bookings and reschedules still need a future time.
create or replace function public.guard_clinic_future_appointment()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.appointment_at is null or new.appointment_at > pg_catalog.clock_timestamp() then
    return new;
  end if;

  if new.action = 'booked' and exists (
    select 1
    from public.clinic_outcomes e
    join public.clinic_locations l on l.id = e.location_id and l.account_id = e.account_id
    where e.event_key = new.event_key and e.location_id = new.location_id and e.account_id = new.account_id
      and e.channel = 'staff_booking' and e.kind = 'booking.requested' and e.summary = 'Staff walk-in'
      and e.details->>'bookingId' = e.event_key
      and (e.details->>'staffLocalTime')::timestamp at time zone l.timezone = new.appointment_at
      and not exists (select 1 from public.clinic_followup_actions a where a.event_key = e.event_key)
  ) then
    return new;
  end if;

  raise exception using errcode = '22023', message = 'Choose an appointment time in the future.';
end;
$$;

create or replace trigger clinic_followup_validate_future
before insert on public.clinic_followup_actions
for each row execute function public.guard_clinic_future_appointment();

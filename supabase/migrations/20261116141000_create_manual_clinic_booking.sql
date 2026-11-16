create function public.create_manual_clinic_booking(
  p_account_id uuid, p_location_id uuid, p_submission_id uuid,
  p_patient_name text, p_service text, p_local_time timestamp without time zone
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  booking_key text;
  payload jsonb;
begin
  if actor is null or not exists (
    select 1 from public.clinic_memberships as member
    join public.clinic_locations as location on location.account_id = member.account_id
    where member.account_id = p_account_id and member.user_id = actor and location.id = p_location_id
  ) then
    raise exception using errcode = '42501', message = 'Clinic location unavailable';
  end if;

  if p_submission_id is null or p_local_time is null or not pg_catalog.isfinite(p_local_time)
    or coalesce(length(btrim(p_patient_name)), 0) not between 1 and 120
    or coalesce(length(btrim(p_service)), 0) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Enter a patient name, service, and appointment time';
  end if;

  booking_key := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.concat_ws(':', 'clinic_manual_booking', p_account_id, p_location_id, actor, p_submission_id), 'UTF8'
  )), 'hex');
  payload := pg_catalog.jsonb_build_object('bookingId', booking_key, 'patientName', btrim(p_patient_name),
    'service', btrim(p_service), 'staffLocalTime', p_local_time);

  insert into public.clinic_outcomes (
    event_key, clinic_id, account_id, location_id, channel, kind, status, summary, details, notification_state
  ) values (
    booking_key, p_location_id, p_account_id, p_location_id, 'staff_booking',
    'booking.requested', 'AWAITING_CLINIC', 'Staff booking', payload, 'not_configured'
  )
  on conflict (event_key) do nothing;
  if found then
    perform public.save_clinic_appointment(p_account_id, p_location_id, booking_key, 'booked', null, p_local_time);
  elsif not exists (
    select 1 from public.clinic_outcomes where event_key = booking_key and details = payload
  ) then
    raise exception using errcode = '22023',
      message = 'A booking was already saved for this submission. Close this form and review Booked.';
  end if;
  return booking_key;
end;
$$;

revoke all on function public.create_manual_clinic_booking(uuid, uuid, uuid, text, text, timestamp without time zone)
  from public, anon, authenticated;
grant execute on function public.create_manual_clinic_booking(uuid, uuid, uuid, text, text, timestamp without time zone)
  to authenticated;

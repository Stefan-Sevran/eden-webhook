-- Validate time after the transition guard, which skips retries of a saved action.
create or replace function public.guard_clinic_future_appointment()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if new.appointment_at is not null and new.appointment_at <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '22023', message = 'Choose an appointment time in the future.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_clinic_future_appointment() from public, anon, authenticated;

create trigger clinic_followup_validate_future
before insert on public.clinic_followup_actions
for each row execute function public.guard_clinic_future_appointment();

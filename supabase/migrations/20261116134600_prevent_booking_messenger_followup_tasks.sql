create function public.guard_messenger_followup_task_booking()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.action = 'booked' and exists (
    select 1 from public.clinic_outcomes
    where event_key = new.event_key and account_id = new.account_id and location_id = new.location_id
      and channel = 'facebook_messenger' and details ? 'messengerRequestAction'
  ) then
    raise exception using errcode = '23514', message = 'Review the original appointment for this Messenger follow-up';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_messenger_followup_task_booking() from public, anon, authenticated;

create trigger clinic_followup_prevent_messenger_task_booking
before insert on public.clinic_followup_actions
for each row execute function public.guard_messenger_followup_task_booking();

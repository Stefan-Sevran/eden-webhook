-- Apply after clinic-followup-actions.sql.
begin;

alter table public.clinic_followup_actions
  drop constraint if exists clinic_followup_actions_action_check,
  add constraint clinic_followup_actions_action_check
    check (action in ('handled', 'reopened', 'claimed', 'booked'));

create index if not exists clinic_followup_event_latest_idx
  on public.clinic_followup_actions(event_key, created_at desc, id desc);

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
      and previous.actor_user_id = new.actor_user_id then
    return null; -- A retry of a completed write.
  end if;

  if previous.action = 'booked'
      or (new.action = 'claimed' and previous.action in ('claimed', 'handled'))
      or (new.action = 'booked' and (previous.action is distinct from 'claimed'
           or previous.actor_user_id is distinct from new.actor_user_id))
      or (previous.action = 'claimed' and previous.actor_user_id <> new.actor_user_id) then
    raise exception using errcode = '23505', message = 'Clinic follow-up state changed';
  end if;

  new.created_at := greatest(pg_catalog.clock_timestamp(), previous.created_at + interval '1 microsecond');
  return new;
end;
$$;
revoke all on function public.guard_clinic_followup_transition() from public, anon, authenticated;

drop trigger if exists clinic_followup_transition on public.clinic_followup_actions;
create trigger clinic_followup_transition before insert on public.clinic_followup_actions
for each row execute function public.guard_clinic_followup_transition();

commit;

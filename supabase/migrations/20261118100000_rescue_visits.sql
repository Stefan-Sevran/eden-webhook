create schema if not exists clinic_rescue_private;
revoke all on schema clinic_rescue_private from public, anon, authenticated;

create table public.clinic_visit_completions (
  event_key text primary key references public.clinic_outcomes(event_key),
  account_id uuid not null, location_id uuid not null,
  eden_event_key text unique references public.clinic_outcomes(event_key),
  appointment_at timestamptz not null, completed_at timestamptz not null default now(),
  amount_minor bigint check (amount_minor between 0 and 99999999999),
  currency text not null check (currency in ('PHP','THB','USD')),
  receipt_ref text check(length(receipt_ref) between 1 and 80), revision integer not null, recorded_by uuid not null,
  foreign key(location_id,account_id) references public.clinic_locations(id,account_id)
);
create index clinic_visit_location on public.clinic_visit_completions(location_id,appointment_at);
alter table public.clinic_visit_completions enable row level security;
revoke all on public.clinic_visit_completions from public,anon,authenticated;
grant select on public.clinic_visit_completions to authenticated;
create policy visit_member on public.clinic_visit_completions for select to authenticated using (exists
  (select 1 from public.clinic_memberships m where m.account_id=clinic_visit_completions.account_id and m.user_id=(select auth.uid())));

create table clinic_rescue_private.visit_entries (
  event_key text references public.clinic_visit_completions, revision integer,
  location_id uuid not null, eden_event_key text, amount_minor bigint, delta_minor bigint not null,
  currency text not null, receipt_ref text, recorded_by uuid not null, posted_at timestamptz not null default clock_timestamp(),
  primary key(event_key,revision)
);
create index rescue_entries_period on clinic_rescue_private.visit_entries(location_id,posted_at);
create function clinic_rescue_private.eligible(e public.clinic_outcomes) returns boolean
language sql immutable set search_path='' as $$
 select e.channel in ('website_chat','facebook_messenger','ai_phone')
 and e.kind in ('booking.requested','inquiry.followup_needed','call.followup_needed')
 and coalesce(e.details->>'demo','false') <> 'true'
 and not (e.details ?| array['messengerSetupTestId','messengerRequestAction','relatedRequestKey'])
$$;

create function public.record_clinic_visit(p_location uuid,p_event text,p_appointment timestamptz,
  p_revision integer,p_amount_minor bigint,p_currency text,p_source text default null,p_receipt text default null) returns void
language plpgsql security definer set search_path='' as $$
declare
 e public.clinic_outcomes; src public.clinic_outcomes; prev public.clinic_visit_completions;
 st public.clinic_followup_states; origin text; new_rev integer; delta bigint;
begin
 if not exists (select 1 from public.clinic_locations l join public.clinic_memberships m using(account_id)
   where l.id=p_location and m.user_id=auth.uid()) then raise exception 'Location unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_event,0));
 select * into e from public.clinic_outcomes where event_key=p_event and location_id=p_location;
 if e.event_key is null or (e.channel <> 'staff_booking' and not clinic_rescue_private.eligible(e))
   or coalesce(e.details->>'demo','false')='true' then raise exception 'Choose a live booking'; end if;
 select * into st from public.clinic_followup_states where event_key=p_event and location_id=p_location;
 if st.action is distinct from 'booked' or st.appointment_at is null or st.appointment_at > now()
   or st.appointment_at is distinct from p_appointment then raise exception 'Review the confirmed appointment time'; end if;
 origin := case when e.channel='staff_booking' then p_source else p_event end;
 if origin is not null then
  select * into src from public.clinic_outcomes where event_key=origin and location_id=p_location and account_id=e.account_id;
  if src.event_key is null or not clinic_rescue_private.eligible(src) or src.occurred_at>now() then raise exception 'Choose an Eden request from this location'; end if;
 end if;
 select * into prev from public.clinic_visit_completions where event_key=p_event;
 p_receipt:=nullif(trim(p_receipt),'');
 if prev.event_key is not null and prev.receipt_ref is not distinct from p_receipt and prev.amount_minor is not distinct from p_amount_minor
   and prev.currency=p_currency and prev.eden_event_key is not distinct from origin then return; end if;
 if coalesce(prev.revision,0) is distinct from p_revision then raise exception 'Visit changed. Refresh before saving'; end if;
 if (prev.eden_event_key is not null and prev.eden_event_key is distinct from origin)
 or (prev.amount_minor is not null and (p_amount_minor is null or p_currency <> prev.currency))
 then raise exception 'Keep the recorded source and currency. Enter zero for a fully refunded visit'; end if;
 new_rev := coalesce(prev.revision,0)+1;
 delta := coalesce(p_amount_minor,0) - case when prev.eden_event_key is not distinct from origin then coalesce(prev.amount_minor,0) else 0 end;
 insert into public.clinic_visit_completions(event_key,account_id,location_id,eden_event_key,appointment_at,amount_minor,currency,receipt_ref,revision,recorded_by)
 values(p_event,e.account_id,p_location,origin,p_appointment,p_amount_minor,p_currency,p_receipt,new_rev,auth.uid())
 on conflict(event_key) do update set amount_minor=excluded.amount_minor,currency=excluded.currency,receipt_ref=excluded.receipt_ref,eden_event_key=excluded.eden_event_key,revision=excluded.revision,recorded_by=excluded.recorded_by;
 insert into clinic_rescue_private.visit_entries(event_key,revision,location_id,eden_event_key,amount_minor,delta_minor,currency,receipt_ref,recorded_by)
 values(p_event,new_rev,p_location,origin,p_amount_minor,delta,p_currency,p_receipt,auth.uid());
exception when unique_violation then raise exception 'This Eden request already has a completed visit';
end $$;
revoke all on function public.record_clinic_visit(uuid,text,timestamptz,integer,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.record_clinic_visit(uuid,text,timestamptz,integer,bigint,text,text,text) to authenticated;

create function clinic_rescue_private.guard_completed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended(new.event_key,0));
 if exists(select 1 from public.clinic_visit_completions where event_key=new.event_key) then
   raise exception 'This visit is already completed';
 end if;
 return new;
end $$;
create trigger prevent_completed_visit_changes before insert on public.clinic_followup_actions
 for each row execute function clinic_rescue_private.guard_completed();

-- Walk-ins can be entered at arrival or retrospectively without scheduling a future appointment.
create function public.record_clinic_walkin(p_location uuid,p_submission uuid,p_name text,p_service text,
 p_local_time timestamp,p_currency text) returns text language plpgsql security definer set search_path='' as $$
declare l public.clinic_locations; visit_time timestamptz; k text; payload jsonb;
begin
 select loc.* into l from public.clinic_locations loc join public.clinic_memberships m using(account_id)
 where m.user_id=auth.uid() and loc.id=p_location;
 if l.id is null then raise exception 'Location unavailable'; end if;
 visit_time:=p_local_time at time zone l.timezone;
 if p_submission is null or coalesce(length(trim(p_name)),0) not between 1 and 120
 or coalesce(length(trim(p_service)),0) not between 1 and 100 or visit_time is null or not isfinite(visit_time)
 or visit_time>now() then raise exception 'Enter a name, service and a visit time up to now'; end if;
 k:=encode(sha256(convert_to(concat_ws(':','clinic_walkin',l.id,auth.uid(),p_submission),'UTF8')),'hex');
 payload:=jsonb_build_object('bookingId',k,'patientName',trim(p_name),'service',trim(p_service),'staffLocalTime',p_local_time);
 insert into public.clinic_outcomes(event_key,account_id,location_id,clinic_id,channel,kind,status,summary,details)
 values(k,l.account_id,l.id,l.id::text,'staff_booking','booking.requested','AWAITING_CLINIC','Staff walk-in',payload)
 on conflict(event_key) do nothing;
 if found then
 insert into public.clinic_followup_actions(account_id,location_id,event_key,actor_user_id,action,appointment_at)
 values(l.account_id,l.id,k,auth.uid(),'booked',visit_time);
 perform public.record_clinic_visit(l.id,k,visit_time,0,null,p_currency,null);
 elsif not exists(select 1 from public.clinic_outcomes where event_key=k and details=payload) then
 raise exception 'This walk-in has already been recorded. Review the saved visit.';
 end if;
 return k;
end $$;
revoke all on function public.record_clinic_walkin(uuid,uuid,text,text,timestamp,text) from public,anon,authenticated;
grant execute on function public.record_clinic_walkin(uuid,uuid,text,text,timestamp,text) to authenticated;

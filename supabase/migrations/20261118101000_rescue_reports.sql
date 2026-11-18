create table public.clinic_rescue_settings (
 location_id uuid primary key, account_id uuid not null, pilot_start date not null,
 cadence text not null check(cadence in ('weekly','fortnightly','monthly')),
 currency text not null check(currency in ('PHP','THB','USD')),
 rate_bps integer not null check(rate_bps between 0 and 10000), recipient text, configured_by uuid not null,
 timezone text not null,
 foreign key(location_id,account_id) references public.clinic_locations(id,account_id)
);
create table public.clinic_rescue_reports (
 id uuid primary key default gen_random_uuid(), account_id uuid not null, location_id uuid not null references public.clinic_rescue_settings,
 kind text not null check(kind in ('results','settlement')), period_start date not null, period_end date not null,
 snapshot jsonb not null, approved_at timestamptz, approved_by uuid,
 checkout_url text check(length(checkout_url)<=512 and checkout_url ~ '^https://[a-zA-Z0-9.-]+/[^[:space:]]+$'),
 unique(location_id,kind,period_start), check(period_end>period_start),
 check(checkout_url is null or (kind='settlement' and approved_at is not null and (snapshot->>'share_minor')::bigint>0))
);
alter table public.clinic_rescue_reports enable row level security;
alter table public.clinic_rescue_settings enable row level security;
revoke all on public.clinic_rescue_settings,public.clinic_rescue_reports from public,anon,authenticated,service_role;
grant select on public.clinic_rescue_settings,public.clinic_rescue_reports to authenticated,service_role;
-- A provider integration or Eden operator attaches an amount-specific checkout after approval.
grant update(checkout_url) on public.clinic_rescue_reports to service_role;
create policy rescue_settings_manager on public.clinic_rescue_settings for select to authenticated using (exists
(select 1 from public.clinic_memberships m where m.user_id=(select auth.uid()) and m.account_id=clinic_rescue_settings.account_id and m.role in ('owner','admin')));
create policy rescue_reports_manager on public.clinic_rescue_reports for select to authenticated using (exists
(select 1 from public.clinic_memberships m where m.user_id=(select auth.uid()) and m.account_id=clinic_rescue_reports.account_id and m.role in ('owner','admin')));

create function public.configure_rescue_reports(p_location uuid,p_start date,p_cadence text,p_currency text,p_rate_bps integer,p_email_me boolean)
returns void language plpgsql security definer set search_path='' as $$
declare l public.clinic_locations; old public.clinic_rescue_settings; email text;
begin
 select loc.* into l from public.clinic_locations loc join public.clinic_memberships m using(account_id)
 where loc.id=p_location and m.user_id=auth.uid() and m.role in ('owner','admin') for update of loc;
 if l.id is null then raise exception 'Owner or admin access required'; end if;
 select * into old from public.clinic_rescue_settings where location_id=p_location;
 if old.location_id is not null and (p_start,p_cadence,p_currency,p_rate_bps) is distinct from
 (old.pilot_start,old.cadence,old.currency,old.rate_bps) then raise exception 'Reporting terms already set for this pilot'; end if;
 if p_start < (now() at time zone l.timezone)::date-366 and old.location_id is null then raise exception 'Select a pilot start within the past year'; end if;
 if p_email_me then
  select u.email into email from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null;
  if email is null then raise exception 'Verify your workspace email first'; end if;
 end if;
 insert into public.clinic_rescue_settings values(l.id,l.account_id,p_start,p_cadence,p_currency,p_rate_bps,email,auth.uid(),l.timezone)
 on conflict(location_id) do update set recipient=excluded.recipient;
end $$;

-- All period ends are exclusive and evaluated in the clinic's time zone.
create function clinic_rescue_private.summary(s public.clinic_rescue_settings,k text,a date,b date)
returns jsonb language sql stable set search_path='' as $$
 with bounds as (select a::timestamp at time zone s.timezone lo,b::timestamp at time zone s.timezone hi,
 (s.pilot_start+7)::timestamp at time zone s.timezone paid_start),
 requests as (
 select e.*,f.action,exists(select 1 from clinic_rescue_private.visit_entries j where j.eden_event_key=e.event_key and j.posted_at<hi) as attended from public.clinic_outcomes e cross join bounds
 left join lateral(select x.action from public.clinic_followup_actions x where x.event_key=e.event_key and x.created_at<hi
 order by x.created_at desc,x.id desc limit 1) f on true
 where e.location_id=s.location_id and e.occurred_at<hi and clinic_rescue_private.eligible(e)
 ),
 receipts as (
 select j.*,v.appointment_at,src.occurred_at as request_at
 from clinic_rescue_private.visit_entries j join public.clinic_visit_completions v using(event_key)
 join public.clinic_outcomes src on src.event_key=j.eden_event_key cross join bounds
 where j.location_id=s.location_id and j.posted_at<hi and j.currency=s.currency
 ),
 totals as (
 select coalesce(sum(delta_minor) filter(where posted_at>=lo),0) collected,
 coalesce(sum(delta_minor) filter(where posted_at>=lo and appointment_at>=paid_start and request_at>=paid_start),0) eligible,
 coalesce(sum(delta_minor) filter(where appointment_at>=paid_start and request_at>=paid_start),0) lifetime
 from receipts cross join bounds
 ),
 prior_months as (
 select date_trunc('month',posted_at at time zone s.timezone) mon,sum(delta_minor) total
 from receipts,bounds where posted_at<lo and appointment_at>=paid_start and request_at>=paid_start group by 1
 ),
 prior_balances as (select sum(total) over(order by mon) balance from prior_months),
 fee as (
 select round(lifetime*s.rate_bps/10000) - greatest(0,coalesce((select round(max(balance)*s.rate_bps/10000) from prior_balances),0)) balance from totals
 ),
 visits as (
 select v.event_key,j.amount_minor,j.currency,j.eden_event_key from public.clinic_visit_completions v cross join bounds
 join lateral(select e.* from clinic_rescue_private.visit_entries e where e.event_key=v.event_key and e.posted_at<hi
 order by e.revision desc limit 1) j on true
 where v.location_id=s.location_id and v.completed_at>=lo and v.completed_at<hi
 )
 select jsonb_build_object(
 'currency',s.currency,'rate_bps',s.rate_bps,'free_through',s.pilot_start+6,
 'channels',coalesce((select jsonb_object_agg(channel,n) from
 (select channel,count(*) n from requests,bounds where occurred_at>=lo group by channel) c),'{}'::jsonb),
 'confirmed',(select count(*) from requests,bounds where occurred_at>=lo and (attended or action in ('booked','rescheduled','restored'))),
 'outstanding',(select count(*) from requests where not attended and (action is null or action in ('reopened','claimed'))),
 'completed',(select count(*) from visits),'attributed',(select count(*) from visits where eden_event_key is not null),
 'amount_pending',(select count(*) from visits where amount_minor is null),
 'other_currency',(select count(*) from visits where amount_minor is not null and currency<>s.currency),
 'collected_minor',collected,'eligible_minor',eligible,
 'share_minor',case when k='settlement' then greatest(0,balance) else 0 end,
 'credit_minor',case when k='settlement' then greatest(0,-balance) else 0 end,
 'entries',coalesce((select jsonb_agg(jsonb_build_object('ref',coalesce(j.receipt_ref,left(encode(sha256(convert_to(j.event_key,'UTF8')),'hex'),10)),'channel',e.channel,
 'posted',j.posted_at,'delta_minor',j.delta_minor,'free',j.appointment_at<paid_start or j.request_at<paid_start)
 order by j.posted_at,j.event_key,j.revision) from receipts j join public.clinic_outcomes e on e.event_key=j.eden_event_key
 cross join bounds where j.posted_at>=lo and j.amount_minor is not null),'[]'::jsonb)
 ) from totals,fee
$$;

create function clinic_rescue_private.generate(p_location uuid) returns void
language plpgsql security definer set search_path='' as $$
declare s public.clinic_rescue_settings; today date; k text; a date; b date;
begin
 select * into s from public.clinic_rescue_settings where location_id=p_location for update;
 if not found then return; end if;
 today:=(now() at time zone s.timezone)::date;
 foreach k in array array['results','settlement'] loop
 select coalesce(max(period_end),s.pilot_start) into a from public.clinic_rescue_reports where location_id=p_location and kind=k;
 loop
 b:=case when k='results' and a=s.pilot_start then a+7
 when k='results' and s.cadence='weekly' then a+7
 when k='results' and s.cadence='fortnightly' then a+14
 else (date_trunc('month',a::timestamp)+interval '1 month')::date end;
 exit when b>today;
 insert into public.clinic_rescue_reports(account_id,location_id,kind,period_start,period_end,snapshot)
 values(s.account_id,p_location,k,a,b,clinic_rescue_private.summary(s,k,a,b));
 a:=b;
 end loop;
 end loop;
end $$;

create function public.refresh_rescue_reports(p_location uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.clinic_locations l join public.clinic_memberships m using(account_id)
 where l.id=p_location and m.user_id=auth.uid() and m.role in ('owner','admin')) then raise exception 'Owner or admin access required'; end if;
 perform clinic_rescue_private.generate(p_location);
end $$;
create function public.approve_rescue_report(p_report uuid,p_expected jsonb) returns void language plpgsql security definer set search_path='' as $$
declare r public.clinic_rescue_reports; s public.clinic_rescue_settings; current_summary jsonb;
begin
 select t.* into s from public.clinic_rescue_settings t join public.clinic_rescue_reports x using(location_id)
 join public.clinic_memberships m on m.account_id=t.account_id and m.user_id=auth.uid() and m.role in ('owner','admin')
 where x.id=p_report for update of t;
 if not found then raise exception 'Owner or admin access required'; end if;
 select * into r from public.clinic_rescue_reports where id=p_report for update;
 if r.approved_at is not null then return; end if;
 if r.kind='settlement' and exists(select 1 from public.clinic_rescue_reports x where x.location_id=r.location_id
 and x.kind='settlement' and x.period_start<r.period_start and x.approved_at is null) then raise exception 'Review the earlier monthly settlement first'; end if;
 current_summary:=clinic_rescue_private.summary(s,r.kind,r.period_start,r.period_end);
 if current_summary is distinct from p_expected then
 update public.clinic_rescue_reports set snapshot=current_summary where id=p_report;
 return;
 end if;
 update public.clinic_rescue_reports set approved_at=now(),approved_by=auth.uid(),snapshot=current_summary where id=p_report;
end $$;
create function public.generate_due_rescue_reports() returns void language plpgsql security definer set search_path='' as $$
declare loc uuid;
begin
 for loc in select location_id from public.clinic_rescue_settings order by location_id loop perform clinic_rescue_private.generate(loc); end loop;
end $$;
revoke all on function public.generate_due_rescue_reports() from public,anon,authenticated;
grant execute on function public.generate_due_rescue_reports() to service_role;
revoke all on function public.configure_rescue_reports(uuid,date,text,text,integer,boolean), public.refresh_rescue_reports(uuid),
 public.approve_rescue_report(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.configure_rescue_reports(uuid,date,text,text,integer,boolean), public.refresh_rescue_reports(uuid),
 public.approve_rescue_report(uuid,jsonb) to authenticated;

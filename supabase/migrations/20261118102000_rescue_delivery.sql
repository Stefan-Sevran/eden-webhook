create table clinic_rescue_private.report_mail (
 report_id uuid primary key references public.clinic_rescue_reports,
 recipient text not null, attempts integer not null default 0, first_attempt timestamptz,
 next_attempt timestamptz not null default now(), sent_at timestamptz, delivery_token uuid
);
create function clinic_rescue_private.queue_report() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into clinic_rescue_private.report_mail(report_id,recipient)
 select new.id,s.recipient from public.clinic_rescue_settings s where s.location_id=new.location_id and s.recipient is not null;
 return new;
end $$;
create trigger approved_rescue_mail after update of approved_at on public.clinic_rescue_reports
 for each row when (old.approved_at is null and new.approved_at is not null) execute function clinic_rescue_private.queue_report();

create function public.claim_rescue_mail() returns table(report_id uuid,recipient text,token uuid,account_id uuid,location_id uuid)
language sql security definer set search_path='' as $$
 with candidates as (
 select m.report_id from clinic_rescue_private.report_mail m join public.clinic_rescue_reports r on r.id=m.report_id
 join public.clinic_rescue_settings s using(location_id)
 where m.sent_at is null and m.next_attempt<=now() and m.attempts<10 and m.recipient=s.recipient
 and (m.first_attempt is null or m.first_attempt > now()-interval '23 hours')
 order by m.next_attempt,m.report_id limit 8 for update of m skip locked
 ), claimed as (
 update clinic_rescue_private.report_mail m set delivery_token=gen_random_uuid(),attempts=m.attempts+1,
 first_attempt=coalesce(m.first_attempt,now()),next_attempt=now()+interval '10 minutes'
 from candidates c where m.report_id=c.report_id returning m.*)
 select c.report_id,c.recipient,c.delivery_token,r.account_id,r.location_id from claimed c join public.clinic_rescue_reports r on r.id=c.report_id
$$;
create function public.ack_rescue_mail(p_report uuid,p_token uuid) returns void language sql security definer set search_path='' as $$
 update clinic_rescue_private.report_mail set sent_at=now() where report_id=p_report and delivery_token=p_token and sent_at is null
$$;
revoke all on function public.claim_rescue_mail(),public.ack_rescue_mail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_rescue_mail(),public.ack_rescue_mail(uuid,uuid) to service_role;

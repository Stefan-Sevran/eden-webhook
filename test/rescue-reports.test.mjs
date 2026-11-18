import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
const dir=new URL('../',import.meta.url).pathname;
const file=n=>fs.readFileSync(dir+'/'+n,'utf8');
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.uid',true),'')::uuid$$;
grant usage on schema auth to authenticated;
`);
for(const name of ['clinic-outcomes','clinic-tenancy','clinic-followup-actions','clinic-booking-outcomes','clinic-confirmed-appointments']) await db.exec(file('sql/'+name+'.sql'));
await db.exec(`create or replace view clinic_followup_states with (security_invoker=true) as select distinct on(event_key)
event_key, account_id,location_id,case when action in ('rescheduled','restored') then 'booked' else action end action,actor_user_id,created_at,appointment_at,action as recorded_action,null::timestamptz previous_appointment_at from clinic_followup_actions order by event_key,created_at desc,id desc;`);
for(const name of fs.readdirSync(dir+'/supabase/migrations').filter(x=>x.includes('rescue')).sort()) await db.exec(file('supabase/migrations/'+name));
const AC='10000000-0000-4000-a000-000000000001',LOC='20000000-0000-4000-a000-000000000001',OWNER='30000000-0000-4000-a000-000000000001', STAFF='30000000-0000-4000-a000-000000000002';
await db.exec(`insert into auth.users values ('${OWNER}','owner@example.test',now()),('${STAFF}','staff@example.test',now());insert into clinic_accounts(id,name) values ('${AC}','Test Clinic');
insert into clinic_locations(id,account_id,name) values ('${LOC}','${AC}','Demo');
insert into clinic_memberships values('${AC}','${OWNER}','owner'),('${AC}','${STAFF}','staff');
set app.uid='${OWNER}';
select configure_rescue_reports('${LOC}',current_date-80,'weekly','PHP',1500,true);
alter table clinic_followup_actions disable trigger user;`);
async function fixture(k,channel,days,demo=false) {
 await db.query(`insert into clinic_outcomes(event_key,clinic_id,location_id,account_id,channel,kind,status,summary,details,occurred_at)
 values($1,$2::uuid::text,$2::uuid,$3,$4,'booking.requested','AWAITING_CLINIC','Test',$5::jsonb,current_date-$6::int)`,[k,LOC,AC,channel,JSON.stringify({demo}),days]);
 await db.query(`insert into clinic_followup_actions(event_key,location_id,account_id,action,actor_user_id,appointment_at,created_at) values($1,$2,$3,'booked',$4,current_date-$5::int,current_date-$5::int)`,[k,LOC,AC,OWNER,days]);
}
for (const [k,c,d,t] of [['trial','website_chat',79],['post','facebook_messenger',53],['manual','staff_booking',52],['web','website_chat',55],['setup','website_chat',52,true]]) await fixture(k,c,d,t);
async function save(k,days,rev,amt,source=null){await db.query('select record_clinic_visit($1,$2,current_date-$3::int,$4,$5,$6,$7)',[LOC,k,days,rev,amt,'PHP',source]);}
await db.exec("set role authenticated");
await save('post',53,0,null);await save('post',53,0,null);
assert.equal((await db.query("select amount_minor from clinic_visit_completions where event_key='post'")).rows[0].amount_minor,null);
await save('post',53,1,0);assert.equal((await db.query("select amount_minor from clinic_visit_completions where event_key='post'")).rows[0].amount_minor,0);
await save('post',53,2,100000);await assert.rejects(save('post',53,1,80));
await save('trial',79,0,500000);await save('manual',52,0,50000);await save('manual',52,1,50000,'web');
await assert.rejects(save('web',55,0,50000));await assert.rejects(save('setup',52,0,20));
await db.exec('reset role');
await save('web',55,0,50000).then(()=>assert.fail('duplicate source'),()=>{});
await db.query("select record_clinic_walkin($1,$2,'Clinic walk-in','Visit',current_date-1,'PHP')",[LOC,'50000000-0000-4000-a000-000000000001']);
await db.query("select record_clinic_walkin($1,$2,'Clinic walk-in','Visit',current_date-1,'PHP')",[LOC,'50000000-0000-4000-a000-000000000001']);
assert.equal((await db.query("select count(*)::int n from clinic_outcomes where summary='Staff walk-in'")).rows[0].n,1);
await db.exec(`update clinic_rescue_private.visit_entries set posted_at=current_date-44;update clinic_visit_completions set completed_at=current_date-44;`);
await db.exec('select generate_due_rescue_reports();select generate_due_rescue_reports()');
const reports=(await db.query("select * from clinic_rescue_reports where kind='settlement' order by period_start")).rows;
assert.ok(reports.length>=2);
for(const r of reports) {
 await db.query('select approve_rescue_report($1,$2)',[r.id,JSON.stringify(r.snapshot)]);
 const again=(await db.query('select * from clinic_rescue_reports where id=$1',[r.id])).rows[0];
 if(!again.approved_at)await db.query('select approve_rescue_report($1,$2)',[again.id,JSON.stringify(again.snapshot)]);
}
const fees=(await db.query("select sum((snapshot->>'share_minor')::integer)::integer fee from clinic_rescue_reports where approved_at is not null")).rows[0].fee;
assert.equal(fees,22500);
const claims=(await db.query('select * from claim_rescue_mail()')).rows;assert.equal(claims.length,reports.length);
assert.equal((await db.query('select * from claim_rescue_mail()')).rows.length,0);
await db.query('select ack_rescue_mail($1,$2)',[claims[0].report_id,claims[0].token]);
await save('post',53,3,80000);await db.exec("update clinic_rescue_private.visit_entries set posted_at=now() where event_key='post' and revision=4");
const later=(await db.query(`select clinic_rescue_private.summary(s,'settlement',current_date,current_date+1) s from clinic_rescue_settings s`)).rows[0].s;
assert.equal(later.eligible_minor,-20000);assert.equal(later.share_minor,0);
await db.exec(`set app.uid='${STAFF}';set role authenticated;`);
assert.equal((await db.query('select * from clinic_rescue_reports')).rows.length,0);
await assert.rejects(db.query('select refresh_rescue_reports($1)',[LOC]));
await db.exec("set app.uid='40000000-0000-4000-a000-000000000003'");
assert.equal((await db.query('select * from clinic_visit_completions')).rows.length,0);
await assert.rejects(save('post',53,3,123));
console.log('PASS visits, zero/missing values, trial exclusion, linked walk-in, duplicate prevention, late edit, refund, review, delivery lease and tenant isolation');
await db.close();

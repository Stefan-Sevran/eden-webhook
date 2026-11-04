-- Apply after clinic-tenancy.sql.
-- A signed-in clinic owner or admin may change only the alert destination.
alter table public.clinic_locations
  add constraint clinic_locations_alert_email_format
  check (
    alert_email is null or (
      length(alert_email) <= 254
      and alert_email ~ $email$^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$email$
    )
  ) not valid;

create policy clinic_locations_admin_update_alert_email on public.clinic_locations
  for update to authenticated
  using (exists (
    select 1 from public.clinic_memberships m
    where m.account_id = clinic_locations.account_id
      and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
  ))
  with check (exists (
    select 1 from public.clinic_memberships m
    where m.account_id = clinic_locations.account_id
      and m.user_id = (select auth.uid()) and m.role in ('owner', 'admin')
  ));

grant update (alert_email) on public.clinic_locations to authenticated;

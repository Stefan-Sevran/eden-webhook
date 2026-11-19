-- Read-only preview for the open results period. Closed reports and monthly approvals use their existing paths.
create function public.current_rescue_period(p_location uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  settings public.clinic_rescue_settings;
  today date;
  paid_start date;
  period_start date;
  days_per_period integer;
  totals jsonb;
  eligible bigint;
begin
  select s.* into settings from public.clinic_rescue_settings s
  join public.clinic_memberships m on m.account_id = s.account_id
  where s.location_id = p_location and m.user_id = auth.uid() and m.role in ('owner','admin');
  if not found then return null; end if;

  today := (now() at time zone settings.timezone)::date;
  if today < settings.pilot_start then return null; end if;
  paid_start := settings.pilot_start + 7;
  if today < paid_start then
    period_start := settings.pilot_start;
  elsif settings.cadence = 'monthly' then
    period_start := greatest(paid_start, date_trunc('month', today::timestamp)::date);
  else
    days_per_period := case when settings.cadence = 'fortnightly' then 14 else 7 end;
    period_start := today - ((today - paid_start) % days_per_period);
  end if;

  totals := clinic_rescue_private.summary(settings,'results',period_start,today+1);
  eligible := (totals->>'eligible_minor')::bigint;
  return jsonb_build_object('period_start',period_start,'through',today,'currency',settings.currency,
    'rate_bps',settings.rate_bps,'collected_minor',totals->'collected_minor','eligible_minor',eligible,
    'estimated_share_minor',round(eligible::numeric * settings.rate_bps / 10000));
end;
$$;
revoke all on function public.current_rescue_period(uuid) from public,anon,authenticated;
grant execute on function public.current_rescue_period(uuid) to authenticated;

create function public.amend_untouched_messenger_request(
  target_account uuid, target_location uuid, target_page text, target_sender text,
  target_event text, change_event text, change_kind text, new_service text, new_time text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  outcome public.clinic_outcomes%rowtype;
  amendments jsonb;
begin
  if change_kind is null
      or change_kind not in ('change_time', 'change_service')
      or target_event is null or change_event is null
      or target_event !~ '^[a-f0-9]{64}$' or change_event !~ '^[a-f0-9]{64}$'
      or (change_kind = 'change_time' and coalesce(length(btrim(new_time)), 0) not between 1 and 160)
      or (change_kind = 'change_service' and coalesce(length(btrim(new_service)), 0) not between 1 and 100) then
    return false;
  end if;

  -- Use the same transaction lock as the staff follow-up transition trigger.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_event, 0));

  select * into outcome from public.clinic_outcomes
  where event_key = target_event and account_id = target_account and location_id = target_location
    and channel = 'facebook_messenger' and kind in ('booking.requested', 'inquiry.followup_needed')
    and details->>'pageId' = target_page and details->>'senderId' = target_sender
    and coalesce(details->>'demo', 'false') <> 'true'
    and not (details ? 'messengerRequestAction')
    and (kind = 'booking.requested' or nullif(details->>'requestedTime', '') is not null)
  for update;
  if not found then
    return false;
  end if;

  amendments := coalesce(outcome.details->'messengerAmendments', '[]'::jsonb);
  if amendments @> jsonb_build_array(jsonb_build_object('eventKey', change_event)) then
    return true;
  end if;

  if exists (
    select 1 from public.clinic_followup_actions
    where event_key = target_event and account_id = target_account and location_id = target_location
  ) then
    return false;
  end if;

  update public.clinic_outcomes
  set details = outcome.details ||
    case change_kind when 'change_time' then jsonb_build_object('requestedTime', btrim(new_time))
      else jsonb_build_object('service', btrim(new_service)) end ||
    jsonb_build_object('messengerAmendments', amendments || jsonb_build_array(
      jsonb_build_object('eventKey', change_event, 'action', change_kind,
        'priorService', outcome.details->>'service', 'priorRequestedTime', outcome.details->>'requestedTime',
        'at', pg_catalog.clock_timestamp())
    ))
  where event_key = target_event and account_id = target_account and location_id = target_location;

  return true;
end;
$$;

revoke all on function public.amend_untouched_messenger_request(uuid, uuid, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.amend_untouched_messenger_request(uuid, uuid, text, text, text, text, text, text, text)
  to service_role;

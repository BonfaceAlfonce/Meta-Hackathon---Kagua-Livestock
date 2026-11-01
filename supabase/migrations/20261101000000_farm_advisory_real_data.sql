-- Kagua Livestock: Farm Advisory real-data publishing.
-- Run AFTER 20261029000001_das_farm_advisory.sql. No existing rows are modified.
--
-- The advisory now pairs a zone-linked telemetry record with the farm's own
-- camera photo (image_id 'snapshot:<uuid>') or, when no photo is linked,
-- with the reading alone (image_id 'reading:<uuid>'). This replaces the
-- publish function so it accepts those real image references and stops
-- stamping published alerts as demo data.

begin;

create or replace function public.publish_farm_advisory(p_analysis_id uuid, p_advisory jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  analysis public.farm_image_analyses%rowtype;
  telemetry public.telemetry_events%rowtype;
  advisory_alert uuid;
begin
  select * into analysis from public.farm_image_analyses where id = p_analysis_id for update;
  if not found or analysis.advisory_key is null
    or (analysis.image_id not like 'snapshot:%' and analysis.image_id not like 'reading:%') then
    raise exception 'Invalid advisory analysis';
  end if;
  if analysis.status = 'complete' then return to_jsonb(analysis); end if;
  if analysis.status <> 'pending' then raise exception 'Analysis is not pending'; end if;
  select * into telemetry from public.telemetry_events
    where id = (p_advisory->>'telemetry_event_id')::uuid and farm_id = analysis.farm_id;
  if not found or telemetry.zone_id is null or telemetry.zone_id <> (p_advisory->>'zone_id')::uuid
    or analysis.farm_id <> (p_advisory->>'farm_id')::uuid then
    raise exception 'Telemetry belongs to another farm or zone';
  end if;
  insert into public.farm_alerts(farm_id, zone_id, device_id, telemetry_event_id, severity, alert_type, title, message, details)
  values (analysis.farm_id, telemetry.zone_id, telemetry.device_id, telemetry.id,
    (p_advisory->'evidence'->>'severity')::public.alert_severity, 'farm_advisory',
    p_advisory->>'title', p_advisory->>'message',
    jsonb_build_object('source','farm-advisory','advisory_key',analysis.advisory_key,'analysis_id',analysis.id,'mode',analysis.mode,'advisory',p_advisory))
  on conflict (farm_id, (details->>'advisory_key')) where alert_type = 'farm_advisory'
    do update set message = excluded.message, details = excluded.details
  returning id into advisory_alert;
  update public.farm_image_analyses set result = p_advisory->'result', advisory = p_advisory,
    alert_id = advisory_alert, status = 'complete', completed_at = now()
    where id = analysis.id returning * into analysis;
  return to_jsonb(analysis);
end;
$$;

revoke all on function public.publish_farm_advisory(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.publish_farm_advisory(uuid,jsonb) to service_role;

commit;

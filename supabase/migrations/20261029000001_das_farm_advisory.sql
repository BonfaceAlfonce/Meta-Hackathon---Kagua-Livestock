-- Additive advisory support. Run AFTER 20261028000001_farm_image_analyses.sql.
begin;
alter table public.farm_image_analyses add column if not exists advisory_key text;
alter table public.farm_image_analyses add column if not exists advisory jsonb;
alter table public.farm_image_analyses add column if not exists alert_id uuid references public.farm_alerts(id) on delete set null;
create unique index if not exists farm_image_analyses_advisory_key on public.farm_image_analyses(farm_id, advisory_key) where advisory_key is not null;
create unique index if not exists farm_alerts_advisory_key on public.farm_alerts(farm_id, (details->>'advisory_key')) where alert_type = 'farm_advisory';

-- Analysis and existing dashboard alert are published together, never partially.
-- Only the authenticated server function (service_role) may execute this operation.
create or replace function public.publish_farm_advisory(p_analysis_id uuid, p_advisory jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  analysis public.farm_image_analyses%rowtype;
  telemetry public.telemetry_events%rowtype;
  advisory_alert uuid;
begin
  select * into analysis from public.farm_image_analyses where id = p_analysis_id for update;
  if not found or analysis.image_id <> 'das-advisory-pair-v1' or analysis.advisory_key is null then
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
    jsonb_build_object('demo',true,'advisory_key',analysis.advisory_key,'analysis_id',analysis.id,'mode',analysis.mode,'advisory',p_advisory))
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

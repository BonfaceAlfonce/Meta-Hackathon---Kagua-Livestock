-- Kagua Livestock: remove demo/seed rows so the app shows real farm data only.
-- Run in Supabase SQL Editor as project owner AFTER you no longer need the
-- demo farms. Safe to re-run: each delete only touches rows flagged as demo.
--
-- Deletes, in dependency order:
--   1. demo camera snapshots (metadata.demo) and old sample advisory history
--   2. demo alerts (details.demo, DEMO titles, old sample advisories)
--   3. demo telemetry (raw_payload.demo / measurements.demo)
--   4. demo devices (metadata.demo)
--   5. demo zones (DEMO description) left with no readings or photos
-- Farms, memberships, alert rules and real Fill-out-data / ESP32 rows are kept.
-- Demo seeds never uploaded Storage files, so no bucket cleanup is needed.

begin;

delete from public.farm_image_analyses
where mode = 'sample' or image_id = 'das-advisory-pair-v1';

delete from public.camera_snapshots
where metadata ->> 'demo' = 'true';

delete from public.farm_alerts
where details ->> 'demo' = 'true'
   or title like 'DEMO%';

delete from public.telemetry_events
where raw_payload ->> 'demo' = 'true'
   or measurements ->> 'demo' = 'true';

delete from public.sensor_devices
where metadata ->> 'demo' = 'true';

delete from public.farm_zones
where description like 'DEMO%'
  and not exists (select 1 from public.telemetry_events e where e.zone_id = farm_zones.id)
  and not exists (select 1 from public.camera_snapshots s where s.zone_id = farm_zones.id);

commit;

-- Verify: every count below should be 0 when cleanup is complete.
select 'demo snapshots' as kind, count(*) from public.camera_snapshots where metadata ->> 'demo' = 'true'
union all select 'demo telemetry', count(*) from public.telemetry_events where raw_payload ->> 'demo' = 'true' or measurements ->> 'demo' = 'true'
union all select 'demo alerts', count(*) from public.farm_alerts where details ->> 'demo' = 'true' or title like 'DEMO%'
union all select 'demo devices', count(*) from public.sensor_devices where metadata ->> 'demo' = 'true'
union all select 'demo zones', count(*) from public.farm_zones where description like 'DEMO%'
union all select 'sample analyses', count(*) from public.farm_image_analyses where mode = 'sample' or image_id = 'das-advisory-pair-v1';

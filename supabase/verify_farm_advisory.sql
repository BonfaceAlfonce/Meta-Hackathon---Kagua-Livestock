-- Kagua Livestock: one-click Farm Advisory verification (temporary test data).
--
-- WHAT THIS DOES
--   1. Checks the advisory migrations are applied (clear error if not).
--   2. Creates 3 real zones (Brooder house, Feeder house, Free-roam run).
--   3. Adds 1 zone-linked test reading so Farm Advisory has something to run on.
--   4. Shows you the created rows and what to click in the app.
--
-- HOW TO USE
--   Paste this ENTIRE file into Supabase SQL Editor and press Run. No edits
--   needed when your project has exactly one farm. With several farms, the
--   script tells you which id to paste into v_farm_override below.
--   Afterwards: open the app > Farm Advisory > Run advisory. Expect a
--   readings-only result (no photo yet). Then submit a real photo from
--   Fill out data and run the advisory again to see the Meta vision analysis.
--   When finished verifying, run the CLEANUP block at the bottom to remove
--   everything this script created.

-- Optional: only needed when your project has more than one farm (see v_farm_override inside the script).

do $$
declare
  v_farm_override uuid := null; -- SQL Editor: paste your farm id between the quotes if asked.
  v_farm_id uuid;
  v_farm_count int;
  v_zone_id uuid;
begin
  -- 0. Prerequisite checks with plain-language errors.
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'farm_image_analyses') then
    raise exception 'STOP: advisory tables are missing. Run migrations 20261028000001, 20261029000001 and 20261101000000 first (see supabase/SQL_EDITOR_ORDER.md).';
  end if;
  if (select count(*) from pg_proc where proname = 'publish_farm_advisory') = 0
     or pg_get_functiondef((select oid from pg_proc where proname = 'publish_farm_advisory')) not like '%snapshot:%' then
    raise exception 'STOP: publish_farm_advisory is old or missing. Run migration 20261101000000_farm_advisory_real_data.sql first.';
  end if;

  -- 1. Pick the farm automatically.
  if v_farm_override is not null then
    v_farm_id := v_farm_override;
  else
    select count(*), min(id) into v_farm_count, v_farm_id from public.farms;
    if v_farm_count = 0 then
      raise exception 'STOP: no farms exist yet. Create your farm first.';
    elsif v_farm_count > 1 then
      raise notice 'Your farms: %', (select string_agg(name || ' = ' || id::text, ' | ') from public.farms);
      raise exception 'STOP: you have several farms. Paste one id into v_farm_override near the top of this script and rerun.';
    end if;
  end if;
  raise notice 'Using farm %', v_farm_id;

  -- 2. Create the 3 zones (skips names that already exist).
  insert into public.farm_zones (farm_id, name, zone_type, description, is_night_monitored)
  select v_farm_id, name, zone_type, description, is_night
  from (values
    ('Brooder house', 'coop', 'Chicks under heat; early-life monitoring.', true),
    ('Feeder house', 'barn', 'Main poultry house with feeders and drinkers.', true),
    ('Free-roam run', 'free_roam', 'Outdoor free-roam feeding area.', false)
  ) as z(name, zone_type, description, is_night)
  where not exists (select 1 from public.farm_zones fz where fz.farm_id = v_farm_id and fz.name = z.name);

  select id into v_zone_id from public.farm_zones
  where farm_id = v_farm_id and name = 'Brooder house' order by created_at limit 1;

  -- 3. Add one zone-linked test reading (skips itself on rerun).
  insert into public.telemetry_events
    (farm_id, zone_id, source_event_id, captured_at, received_at,
     temperature_c, humidity_pct, ammonia_ppm, measurements,
     animal_observation, is_night, raw_payload)
  select v_farm_id, v_zone_id, 'VERIFY-ADVISORY-01', now(), now(),
    31.8, 66.0, 14.0, jsonb_build_object('co2_ppm', 950),
    'Temporary verification reading for the Farm Advisory check.',
    false, jsonb_build_object('source', 'advisory-verify', 'verify', true)
  where not exists (select 1 from public.telemetry_events e
                    where e.farm_id = v_farm_id and e.source_event_id = 'VERIFY-ADVISORY-01');
  raise notice 'Verification data ready for farm %', v_farm_id;
end $$;

-- 4. What was created: open the app > Farm Advisory and run the advisory on the reading below.
select z.name as zone, z.id as zone_id, e.captured_at as reading_time,
       e.temperature_c as temp_c, e.humidity_pct as humidity, e.ammonia_ppm as ammonia,
       e.measurements ->> 'co2_ppm' as co2_ppm
from public.telemetry_events e
join public.farm_zones z on z.id = e.zone_id
where e.source_event_id = 'VERIFY-ADVISORY-01'
order by e.captured_at desc;

-- ─── CLEANUP (run only after you finished verifying) ───
-- delete from public.telemetry_events where source_event_id = 'VERIFY-ADVISORY-01';
-- The 3 zones are real farm structure: keep them for your actual Fill-out-data
-- submissions, or delete them only if the farm has no other data yet:
-- delete from public.farm_zones where name in ('Brooder house', 'Feeder house', 'Free-roam run');

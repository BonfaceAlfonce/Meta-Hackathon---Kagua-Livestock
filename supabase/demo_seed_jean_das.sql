-- Jean + Das demo farms, alerts, telemetry, and camera-image examples.
-- Run in Supabase SQL Editor as project owner. Safe to rerun; no rows are deleted.
-- All sensor values and image references below are DEMO illustrations, not ESP32 captures.

begin;

do $$
declare
  v_jean uuid := '863f9e96-571b-4b01-a6bd-559af8f0687c';
  v_das uuid := '6f43ca55-ce1b-46b1-be32-f55c117bc3be';
  v_jean_farm uuid;
  v_das_farm uuid;
  v_jean_group uuid;
  v_das_group uuid;
  v_jean_zone uuid;
  v_das_zone uuid;
  v_jean_device uuid;
  v_das_device uuid;
begin
  if not exists (select 1 from auth.users where id = v_jean) then
    raise exception 'Jean auth user % was not found.', v_jean;
  end if;
  if not exists (select 1 from auth.users where id = v_das) then
    raise exception 'Das auth user % was not found.', v_das;
  end if;

  select id into v_jean_farm from public.farms where name = 'Jean Farm' order by created_at limit 1;
  if v_jean_farm is null then
    insert into public.farms (name, timezone, country_code, settings)
    values ('Jean Farm', 'Africa/Nairobi', 'KE', jsonb_build_object('demo', true))
    returning id into v_jean_farm;
  end if;
  select id into v_das_farm from public.farms where name = 'Das Farm' order by created_at limit 1;
  if v_das_farm is null then
    insert into public.farms (name, timezone, country_code, settings)
    values ('Das Farm', 'Africa/Nairobi', 'KE', jsonb_build_object('demo', true))
    returning id into v_das_farm;
  end if;

  insert into public.profiles (user_id, display_name) values (v_jean, 'Jean')
  on conflict (user_id) do update set display_name = coalesce(profiles.display_name, excluded.display_name);
  insert into public.profiles (user_id, display_name) values (v_das, 'Das')
  on conflict (user_id) do update set display_name = coalesce(profiles.display_name, excluded.display_name);

  insert into public.farm_members (farm_id, user_id, role) values (v_jean_farm, v_jean, 'owner')
  on conflict (farm_id, user_id) do update set role = 'owner';
  insert into public.farm_members (farm_id, user_id, role) values (v_das_farm, v_das, 'owner')
  on conflict (farm_id, user_id) do update set role = 'owner';

  select id into v_jean_group from public.animal_groups where farm_id = v_jean_farm and name = 'Jean demo poultry flock' order by created_at limit 1;
  if v_jean_group is null then
    insert into public.animal_groups (farm_id, name, species, species_label, animal_count, notes)
    values (v_jean_farm, 'Jean demo poultry flock', 'poultry', 'Poultry', 120,
      'DEMO group only; replace with Jean Farm inventory.') returning id into v_jean_group;
  end if;
  select id into v_das_group from public.animal_groups where farm_id = v_das_farm and name = 'Das demo poultry flock' order by created_at limit 1;
  if v_das_group is null then
    insert into public.animal_groups (farm_id, name, species, species_label, animal_count, notes)
    values (v_das_farm, 'Das demo poultry flock', 'poultry', 'Poultry', 85,
      'DEMO group only; replace with Das Farm inventory.') returning id into v_das_group;
  end if;

  select id into v_jean_zone from public.farm_zones where farm_id = v_jean_farm and name = 'Heat-stress demo coop' order by created_at limit 1;
  if v_jean_zone is null then
    insert into public.farm_zones (farm_id, animal_group_id, name, zone_type, description, is_night_monitored)
    values (v_jean_farm, v_jean_group, 'Heat-stress demo coop', 'coop',
      'DEMO zone for illustrating elevated heat and humidity review.', true) returning id into v_jean_zone;
  end if;
  select id into v_das_zone from public.farm_zones where farm_id = v_das_farm and name = 'Wet-ground demo run' order by created_at limit 1;
  if v_das_zone is null then
    insert into public.farm_zones (farm_id, animal_group_id, name, zone_type, description, is_night_monitored)
    values (v_das_farm, v_das_group, 'Wet-ground demo run', 'free_roam',
      'DEMO zone for illustrating wet bedding/ground and ammonia review.', true) returning id into v_das_zone;
  end if;

  insert into public.sensor_devices (farm_id, zone_id, device_code, name, kind, manufacturer, model, capabilities, status, last_seen_at, metadata)
  values (v_jean_farm, v_jean_zone, 'JEAN-DEMO-ESP32-01', 'Jean demo ESP32 sensor', 'camera_sensor', 'Kagua Livestock', 'ESP32 demo',
    array['temperature','humidity','ammonia','camera'], 'active', now(), jsonb_build_object('demo', true))
  on conflict (farm_id, device_code) do update set zone_id=excluded.zone_id, name=excluded.name, kind=excluded.kind, capabilities=excluded.capabilities, status=excluded.status, last_seen_at=excluded.last_seen_at, metadata=excluded.metadata
  returning id into v_jean_device;
  insert into public.sensor_devices (farm_id, zone_id, device_code, name, kind, manufacturer, model, capabilities, status, last_seen_at, metadata)
  values (v_das_farm, v_das_zone, 'DAS-DEMO-ESP32-01', 'Das demo ESP32 sensor', 'camera_sensor', 'Kagua Livestock', 'ESP32 demo',
    array['temperature','humidity','ammonia','ground_moisture','camera'], 'active', now(), jsonb_build_object('demo', true))
  on conflict (farm_id, device_code) do update set zone_id=excluded.zone_id, name=excluded.name, kind=excluded.kind, capabilities=excluded.capabilities, status=excluded.status, last_seen_at=excluded.last_seen_at, metadata=excluded.metadata
  returning id into v_das_device;

  insert into public.telemetry_events
    (farm_id, zone_id, device_id, source_event_id, captured_at, received_at, temperature_c, humidity_pct, ammonia_ppm,
     measurements, animal_observation, activity_level, battery_voltage, signal_strength_dbm, is_night, raw_payload)
  select v_jean_farm, v_jean_zone, v_jean_device, 'JEAN-DEMO-'||lpad(n::text,2,'0'), now()-((4-n)*interval '10 minutes'), now(),
    t, h, a, jsonb_build_object('demo',true,'ground_moisture_pct',26+n,'heat_stress_demo',true),
    'DEMO ONLY: illustrative heat-stress scenario; no physical ESP32 captured this observation.', 0.20, 3.88, -54,
    extract(hour from ((now()-((4-n)*interval '10 minutes')) at time zone 'Africa/Nairobi')) < 6 or extract(hour from ((now()-((4-n)*interval '10 minutes')) at time zone 'Africa/Nairobi')) >= 18,
    jsonb_build_object('demo',true,'seed','demo_seed_jean_das.sql')
  from (values (1,35.6,70.0,9.0),(2,36.7,74.0,11.0),(3,37.8,78.0,14.0)) as d(n,t,h,a)
  on conflict (device_id, source_event_id) do update set farm_id=excluded.farm_id, zone_id=excluded.zone_id, captured_at=excluded.captured_at, received_at=excluded.received_at, temperature_c=excluded.temperature_c, humidity_pct=excluded.humidity_pct, ammonia_ppm=excluded.ammonia_ppm, measurements=excluded.measurements, animal_observation=excluded.animal_observation, activity_level=excluded.activity_level, battery_voltage=excluded.battery_voltage, signal_strength_dbm=excluded.signal_strength_dbm, is_night=excluded.is_night, raw_payload=excluded.raw_payload;

  insert into public.telemetry_events
    (farm_id, zone_id, device_id, source_event_id, captured_at, received_at, temperature_c, humidity_pct, ammonia_ppm,
     measurements, animal_observation, activity_level, battery_voltage, signal_strength_dbm, is_night, raw_payload)
  select v_das_farm, v_das_zone, v_das_device, 'DAS-DEMO-'||lpad(n::text,2,'0'), now()-((4-n)*interval '10 minutes'), now(),
    t, h, a, jsonb_build_object('demo',true,'ground_moisture_pct',m,'wet_ground_demo',true),
    'DEMO ONLY: illustrative wet-ground/ammonia scenario; no physical ESP32 captured this observation.', 0.16, 3.81, -62,
    extract(hour from ((now()-((4-n)*interval '10 minutes')) at time zone 'Africa/Nairobi')) < 6 or extract(hour from ((now()-((4-n)*interval '10 minutes')) at time zone 'Africa/Nairobi')) >= 18,
    jsonb_build_object('demo',true,'seed','demo_seed_jean_das.sql')
  from (values (1,27.8,82.0,21.0,78),(2,28.2,88.0,29.0,89),(3,28.5,92.0,38.0,96)) as d(n,t,h,a,m)
  on conflict (device_id, source_event_id) do update set farm_id=excluded.farm_id, zone_id=excluded.zone_id, captured_at=excluded.captured_at, received_at=excluded.received_at, temperature_c=excluded.temperature_c, humidity_pct=excluded.humidity_pct, ammonia_ppm=excluded.ammonia_ppm, measurements=excluded.measurements, animal_observation=excluded.animal_observation, activity_level=excluded.activity_level, battery_voltage=excluded.battery_voltage, signal_strength_dbm=excluded.signal_strength_dbm, is_night=excluded.is_night, raw_payload=excluded.raw_payload;

  insert into public.camera_snapshots (farm_id, zone_id, device_id, telemetry_event_id, captured_at, storage_bucket, storage_path, content_type, is_night, ai_summary, ai_labels, metadata)
  select v_jean_farm, v_jean_zone, v_jean_device, e.id, e.captured_at, 'farm-media',
    'demo/'||v_jean_farm::text||'/jean-heat-stress.jpg', 'image/jpeg', e.is_night,
    'DEMO IMAGE: reference photo depicts panting poultry. It is not a Jean Farm or ESP32 camera capture.',
    jsonb_build_array('demo','poultry','panting reference'),
    jsonb_build_object('demo',true,'demo_image_url','https://www.pluimveeloket.be/sites/default/files/inline-images/hijgende%20kippen_1.jpg','demo_image_source_url','https://www.pluimveeloket.be/Stalklimaat/Temperatuur/Coolchicks-Artikel-Tips-en-tricks','demo_image_source_credit','Pluimveeloket / ILVO Coolchicks article')
  from public.telemetry_events e where e.device_id=v_jean_device and e.source_event_id='JEAN-DEMO-03'
  on conflict (storage_bucket, storage_path) do update set farm_id=excluded.farm_id, zone_id=excluded.zone_id, device_id=excluded.device_id, telemetry_event_id=excluded.telemetry_event_id, captured_at=excluded.captured_at, ai_summary=excluded.ai_summary, ai_labels=excluded.ai_labels, metadata=excluded.metadata;

  insert into public.camera_snapshots (farm_id, zone_id, device_id, telemetry_event_id, captured_at, storage_bucket, storage_path, content_type, is_night, ai_summary, ai_labels, metadata)
  select v_das_farm, v_das_zone, v_das_device, e.id, e.captured_at, 'farm-media',
    'demo/'||v_das_farm::text||'/das-wet-ground.jpg', 'image/jpeg', e.is_night,
    'DEMO IMAGE: reference photo depicts poultry on wet ground. It is not a Das Farm or ESP32 camera capture.',
    jsonb_build_array('demo','poultry','wet-ground reference'),
    jsonb_build_object('demo',true,'demo_image_url','https://images.unsplash.com/photo-1716797701752-e9214beb5f9e?auto=format&fit=crop&fm=jpg&q=80&w=1200','demo_image_source_url','https://unsplash.com/photos/un-gallo-parado-en-un-suelo-mojado-junto-a-un-trozo-de-comida-6sKsu4AjDPU','demo_image_source_credit','Mr Wang / Unsplash')
  from public.telemetry_events e where e.device_id=v_das_device and e.source_event_id='DAS-DEMO-03'
  on conflict (storage_bucket, storage_path) do update set farm_id=excluded.farm_id, zone_id=excluded.zone_id, device_id=excluded.device_id, telemetry_event_id=excluded.telemetry_event_id, captured_at=excluded.captured_at, ai_summary=excluded.ai_summary, ai_labels=excluded.ai_labels, metadata=excluded.metadata;

  insert into public.farm_alerts (farm_id, zone_id, device_id, telemetry_event_id, severity, alert_type, title, message, details, occurred_at)
  select v_jean_farm, v_jean_zone, v_jean_device, e.id, 'critical', 'demo_heat_stress',
    'DEMO · Heat-stress conditions', 'Illustrative readings show rising temperature and humidity. Check ventilation and cool water access.',
    jsonb_build_object('demo',true,'demo_key','jean-heat-stress-v1','evidence','Synthetic telemetry values and reference image; not a real animal-health assessment.'), now()
  from public.telemetry_events e where e.device_id=v_jean_device and e.source_event_id='JEAN-DEMO-03'
    and not exists (select 1 from public.farm_alerts a where a.farm_id=v_jean_farm and a.details->>'demo_key'='jean-heat-stress-v1');

  insert into public.farm_alerts (farm_id, zone_id, device_id, telemetry_event_id, severity, alert_type, title, message, details, occurred_at)
  select v_das_farm, v_das_zone, v_das_device, e.id, 'warning', 'demo_high_ammonia',
    'DEMO · Ammonia and wet-ground review', 'Illustrative ammonia, humidity, and ground-moisture values are elevated. Inspect bedding and ventilation.',
    jsonb_build_object('demo',true,'demo_key','das-wet-ground-ammonia-v1','evidence','Synthetic telemetry values and reference image; not a real animal-health assessment.'), now()
  from public.telemetry_events e where e.device_id=v_das_device and e.source_event_id='DAS-DEMO-03'
    and not exists (select 1 from public.farm_alerts a where a.farm_id=v_das_farm and a.details->>'demo_key'='das-wet-ground-ammonia-v1');
end $$;

commit;

-- Verify the two memberships, farm names, recent telemetry, alert counts, and demo image links.
select f.name as farm_name, m.user_id, m.role
from public.farm_members m join public.farms f on f.id=m.farm_id
where m.user_id in ('863f9e96-571b-4b01-a6bd-559af8f0687c','6f43ca55-ce1b-46b1-be32-f55c117bc3be')
order by f.name;

select f.name as farm_name, count(*) as demo_readings
from public.telemetry_events e join public.farms f on f.id=e.farm_id
where e.raw_payload->>'demo'='true'
  and exists (select 1 from public.sensor_devices d where d.id=e.device_id and d.device_code in ('JEAN-DEMO-ESP32-01','DAS-DEMO-ESP32-01'))
group by f.name order by f.name;

select f.name as farm_name, s.ai_summary, s.metadata->>'demo_image_url' as demo_image_url
from public.camera_snapshots s join public.farms f on f.id=s.farm_id
where s.metadata->>'demo'='true' and f.name in ('Jean Farm','Das Farm')
order by f.name;

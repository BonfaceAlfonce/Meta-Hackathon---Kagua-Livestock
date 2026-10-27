-- Demo data for the first Kagua user. Run in Supabase SQL Editor as project owner.
-- Safe to rerun: it uses stable device and event IDs and upserts those rows.
-- All generated readings are explicitly marked as DEMO, not physical sensor data.

begin;

do $$
declare
  v_user_id uuid := '362a443a-649e-4009-99b9-48884af73e25';
  v_farm_id uuid;
  v_membership_count integer;
  v_farm_count integer;
  v_zone_id uuid;
  v_device_id uuid;
begin
  if not exists (select 1 from auth.users where id = v_user_id) then
    raise exception 'Auth user % was not found. Check the UUID in Authentication > Users.', v_user_id;
  end if;

  select count(*), (array_agg(farm_id))[1]
    into v_membership_count, v_farm_id
    from public.farm_members
   where user_id = v_user_id;

  if v_membership_count = 0 then
    select count(*) into v_farm_count from public.farms;
    if v_farm_count <> 1 then
      raise exception 'User has no farm membership and found % farms. This script only auto-selects when exactly one farm exists. Add the intended farm UUID to the script before rerunning.', v_farm_count;
    end if;
    select id into v_farm_id from public.farms limit 1;
  elsif v_membership_count > 1 then
    raise exception 'User already belongs to % farms. Choose the intended farm UUID and seed that farm explicitly.', v_membership_count;
  end if;

  insert into public.profiles (user_id, display_name)
  values (v_user_id, 'Kagua Farm User')
  on conflict (user_id) do nothing;

  insert into public.farm_members (farm_id, user_id, role)
  values (v_farm_id, v_user_id, 'owner')
  on conflict (farm_id, user_id) do nothing;

  select id into v_zone_id
    from public.farm_zones
   where farm_id = v_farm_id and name = 'Demo monitoring zone'
   order by created_at
   limit 1;

  if v_zone_id is null then
    insert into public.farm_zones
      (farm_id, name, zone_type, description, is_night_monitored)
    values
      (v_farm_id, 'Demo monitoring zone', 'free_roam',
       'DEMO zone for illustrating livestock telemetry; connect a real sensor before relying on readings.', true)
    returning id into v_zone_id;
  end if;

  insert into public.sensor_devices
    (farm_id, zone_id, device_code, name, kind, manufacturer, model,
     capabilities, status, last_seen_at, metadata)
  values
    (v_farm_id, v_zone_id, 'KAGUA-DEMO-ESP32-01', 'Demo ESP32 sensor', 'sensor',
     'Kagua Livestock', 'ESP32 demo', array['temperature','humidity','ammonia'],
     'active', now(), jsonb_build_object('demo', true, 'source', 'seed SQL'))
  on conflict (farm_id, device_code) do update
    set zone_id = excluded.zone_id,
        name = excluded.name,
        kind = excluded.kind,
        capabilities = excluded.capabilities,
        status = excluded.status,
        last_seen_at = excluded.last_seen_at,
        metadata = excluded.metadata
  returning id into v_device_id;

  insert into public.telemetry_events
    (farm_id, zone_id, device_id, source_event_id, captured_at, received_at,
     temperature_c, humidity_pct, ammonia_ppm, measurements,
     animal_observation, activity_level, battery_voltage, signal_strength_dbm,
     is_night, raw_payload)
  select
    v_farm_id,
    v_zone_id,
    v_device_id,
    'KAGUA-DEMO-' || lpad(n::text, 3, '0'),
    now() - (n * interval '10 minutes'),
    now(),
    (24.2 + n * 0.17)::numeric(7,3),
    (58.0 + n * 0.8)::numeric(7,3),
    (8.0 + n * 0.35)::numeric(10,3),
    jsonb_build_object('demo', true, 'animal_species', 'mixed', 'activity', 'illustrative'),
    'DEMO DATA ONLY — illustrative values; not measured from an animal or physical sensor.',
    (0.35 + n * 0.04)::numeric(7,3),
    (3.90 - n * 0.01)::numeric(7,3),
    -55 - n,
    extract(hour from ((now() - (n * interval '10 minutes')) at time zone 'Africa/Nairobi')) < 6
      or extract(hour from ((now() - (n * interval '10 minutes')) at time zone 'Africa/Nairobi')) >= 18,
    jsonb_build_object('demo', true, 'seed', 'demo_seed_for_first_user.sql')
  from generate_series(1, 6) as series(n)
  on conflict (device_id, source_event_id) do update
    set farm_id = excluded.farm_id,
        zone_id = excluded.zone_id,
        captured_at = excluded.captured_at,
        received_at = excluded.received_at,
        temperature_c = excluded.temperature_c,
        humidity_pct = excluded.humidity_pct,
        ammonia_ppm = excluded.ammonia_ppm,
        measurements = excluded.measurements,
        animal_observation = excluded.animal_observation,
        activity_level = excluded.activity_level,
        battery_voltage = excluded.battery_voltage,
        signal_strength_dbm = excluded.signal_strength_dbm,
        is_night = excluded.is_night,
        raw_payload = excluded.raw_payload;
end $$;

commit;

-- Confirm membership and seeded rows for this user/farm.
select f.id as farm_id, f.name as farm_name, m.user_id, m.role
from public.farm_members m
join public.farms f on f.id = m.farm_id
where m.user_id = '362a443a-649e-4009-99b9-48884af73e25';

select count(*) as demo_readings
from public.telemetry_events
where raw_payload ->> 'demo' = 'true'
  and farm_id in (
    select farm_id from public.farm_members
    where user_id = '362a443a-649e-4009-99b9-48884af73e25'
  );

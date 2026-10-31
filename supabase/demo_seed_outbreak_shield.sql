-- Outbreak Shield demo data. FOR SANDBOX / DEMO PROJECTS ONLY.
--
-- Creates "Kagua Demo Farm" (you become its owner) plus five neighbouring demo
-- farms, with seven normal days followed by an outbreak pattern:
--   Kagua Demo Farm  Brooder 2: losses start yesterday; Brooder 1: losses today
--                    (spreading); Grower House: no log today, so you can log it live.
--   Kiambu neighbours: two high-risk farms, one elevated, one normal
--                    -> triggers the Kiambu regional warning (3+ farms).
--   Nakuru farm: high risk but alone -> no regional warning (privacy threshold).
--
-- Dates are relative to today in Africa/Nairobi, and every row uses fixed IDs,
-- so re-running this script (e.g. on demo day) refreshes the scenario.
-- All logs are marked source = 'demo'. Neighbour farms have no members, so
-- Row Level Security keeps their details hidden from you; only county
-- aggregates are visible.
--
-- Usage (Supabase SQL Editor, as project owner):
--   1. Create your user in Authentication > Users.
--   2. Put that email below and run this whole file.
--   3. Run the outbreak-shield function for yesterday and today (see README).

begin;

do $$
declare
  v_email text := 'REPLACE_WITH_YOUR_LOGIN_EMAIL';
  v_user uuid;
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
begin
  select id into v_user from auth.users where lower(email) = lower(trim(v_email));
  if v_user is null then
    raise exception 'No auth user with email %. Create it in Authentication > Users first, then set v_email.', v_email;
  end if;

  -- Farms (fixed IDs make the script re-runnable).
  insert into public.farms (id, name, timezone, country_code, county, locality, settings) values
    ('d0000000-0000-4000-8000-000000000001', 'Kagua Demo Farm', 'Africa/Nairobi', 'KE', 'Kiambu', 'Limuru', '{"demo": true}'),
    ('d0000000-0000-4000-8000-000000000002', 'Neighbour Farm B', 'Africa/Nairobi', 'KE', 'Kiambu', 'Ruiru', '{"demo": true}'),
    ('d0000000-0000-4000-8000-000000000003', 'Neighbour Farm C', 'Africa/Nairobi', 'KE', 'Kiambu', 'Thika', '{"demo": true}'),
    ('d0000000-0000-4000-8000-000000000004', 'Neighbour Farm D', 'Africa/Nairobi', 'KE', 'Kiambu', 'Juja', '{"demo": true}'),
    ('d0000000-0000-4000-8000-000000000005', 'Valley Farm', 'Africa/Nairobi', 'KE', 'Nakuru', 'Naivasha', '{"demo": true}')
  on conflict (id) do update set name = excluded.name, county = excluded.county, locality = excluded.locality;

  insert into public.profiles (user_id, display_name) values (v_user, 'Demo Farmer') on conflict (user_id) do nothing;
  insert into public.farm_members (farm_id, user_id, role)
  values ('d0000000-0000-4000-8000-000000000001', v_user, 'owner')
  on conflict (farm_id, user_id) do update set role = 'owner';

  insert into public.farm_zones (id, farm_id, name, zone_type) values
    ('d1000000-0000-4000-8000-0000000000a1', 'd0000000-0000-4000-8000-000000000001', 'Brooder 1', 'coop'),
    ('d1000000-0000-4000-8000-0000000000a2', 'd0000000-0000-4000-8000-000000000001', 'Brooder 2', 'coop'),
    ('d1000000-0000-4000-8000-0000000000a3', 'd0000000-0000-4000-8000-000000000001', 'Grower House', 'barn'),
    ('d1000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-000000000002', 'Layer House', 'barn'),
    ('d1000000-0000-4000-8000-0000000000c1', 'd0000000-0000-4000-8000-000000000003', 'Coop', 'coop'),
    ('d1000000-0000-4000-8000-0000000000d1', 'd0000000-0000-4000-8000-000000000004', 'Coop', 'coop'),
    ('d1000000-0000-4000-8000-0000000000e1', 'd0000000-0000-4000-8000-000000000005', 'Coop', 'coop')
  on conflict (id) do update set name = excluded.name, status = 'active';

  -- Start each run from a clean slate for the demo farms.
  delete from public.outbreak_assessments where farm_id::text like 'd0000000-0000-4000-8000-%';
  delete from public.flock_health_logs where farm_id::text like 'd0000000-0000-4000-8000-%';
  delete from public.telemetry_events where farm_id::text like 'd0000000-0000-4000-8000-%' and raw_payload ->> 'demo' = 'outbreak-shield';
  -- Regional rows hold aggregates only; remove recent ones for the demo counties so they are recomputed.
  delete from public.regional_signals where country_code = 'KE' and county in ('Kiambu', 'Nakuru') and window_end >= v_today - 7;

  -- Seven normal days (2..8 days ago) for every zone: 500 birds, 1 death/day, normal intake.
  insert into public.flock_health_logs (farm_id, zone_id, log_date, flock_size, deaths, feed_intake_pct, water_intake_pct, source)
  select z.farm_id, z.id, v_today - g, 500, 1, 100, 100, 'demo'
  from public.farm_zones z
  cross join generate_series(2, 8) g
  where z.farm_id::text like 'd0000000-0000-4000-8000-%';

  -- Yesterday: Brooder 2 shows losses and low water intake; everything else normal.
  insert into public.flock_health_logs (farm_id, zone_id, log_date, flock_size, deaths, feed_intake_pct, water_intake_pct, source)
  select z.farm_id, z.id, v_today - 1, 500,
         case when z.id = 'd1000000-0000-4000-8000-0000000000a2' then 12 else 1 end,
         100,
         case when z.id = 'd1000000-0000-4000-8000-0000000000a2' then 65 else 100 end,
         'demo'
  from public.farm_zones z
  where z.farm_id::text like 'd0000000-0000-4000-8000-%';

  -- Today. Grower House is intentionally left without a log for the live demo.
  insert into public.flock_health_logs (farm_id, zone_id, log_date, flock_size, deaths, sick_count, feed_intake_pct, water_intake_pct, respiratory_signs, notes, source) values
    ('d0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000a1', v_today, 500, 14, 6, 100, 60, true,  'Birds quiet, some gasping', 'demo'),
    ('d0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000a2', v_today, 500, 10, 4, 100, 70, false, null, 'demo'),
    ('d0000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-0000000000b1', v_today, 500, 9,  0, 70, 100, false, null, 'demo'),
    ('d0000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-0000000000c1', v_today, 500, 5,  0, 100, 100, false, null, 'demo'),
    ('d0000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-0000000000d1', v_today, 500, 1,  0, 100, 100, false, null, 'demo'),
    ('d0000000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-0000000000e1', v_today, 500, 11, 0, 100, 60, false, null, 'demo');

  -- Activity telemetry for Brooder 1: steady for a week, then half as active today (noon local time).
  insert into public.telemetry_events (farm_id, zone_id, captured_at, activity_level, raw_payload)
  select 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-0000000000a1',
         ((v_today - g)::timestamp + time '12:00') at time zone 'Africa/Nairobi',
         case when g = 0 then 25 else 50 end,
         '{"demo": "outbreak-shield"}'
  from generate_series(0, 7) g;

  raise notice 'Demo data ready for % (today in Nairobi: %). Now run the outbreak-shield function for % and then %.', v_email, v_today, v_today - 1, v_today;
end $$;

commit;

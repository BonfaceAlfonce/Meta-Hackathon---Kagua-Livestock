-- Kagua Livestock: multi-farm, multi-species monitoring schema
-- Run once in Supabase SQL Editor (or with `supabase db push`).
-- Client apps use only the Supabase URL + publishable/anon key and RLS.
-- Never put service_role keys, device secrets, WhatsApp tokens, or VAPID private keys in VITE_ variables.

begin;

create schema if not exists private;

do $$ begin
  create type public.farm_member_role as enum ('owner', 'admin', 'operator', 'viewer');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.animal_species as enum ('cattle', 'horse', 'poultry', 'sheep', 'goat', 'pig', 'other');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.device_kind as enum ('sensor', 'camera', 'camera_sensor', 'gateway', 'other');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.alert_severity as enum ('info', 'warning', 'critical');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.record_status as enum ('active', 'paused', 'retired');
exception when duplicate_object then null; end $$;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  phone_e164 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_phone_format check (phone_e164 is null or phone_e164 ~ '^[+][1-9][0-9]{7,14}$')
);

create table if not exists public.farms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Africa/Nairobi',
  country_code char(2) not null default 'KE',
  county text,
  locality text,
  latitude double precision,
  longitude double precision,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (latitude is null or latitude between -90 and 90),
  check (longitude is null or longitude between -180 and 180)
);

create table if not exists public.farm_members (
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.farm_member_role not null default 'viewer',
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (farm_id, user_id)
);
create index if not exists farm_members_user_id_idx on public.farm_members(user_id);

create or replace function private.has_farm_role(p_farm_id uuid, p_roles public.farm_member_role[] default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.farm_members m
    where m.farm_id = p_farm_id
      and m.user_id = (select auth.uid())
      and (p_roles is null or m.role = any(p_roles))
  );
$$;
revoke all on function private.has_farm_role(uuid, public.farm_member_role[]) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.has_farm_role(uuid, public.farm_member_role[]) to authenticated;

create table if not exists public.animal_groups (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  name text not null,
  species public.animal_species not null,
  species_label text,
  animal_count integer check (animal_count is null or animal_count >= 0),
  breed text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, id)
);
create index if not exists animal_groups_farm_idx on public.animal_groups(farm_id, species);

-- Individual animals support GPS collars/tags; groups support flock/herd-level monitoring.
create table if not exists public.farm_animals (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  animal_group_id uuid,
  name text,
  tag_code text,
  species public.animal_species not null,
  species_label text,
  breed text,
  sex text check (sex is null or sex in ('female','male','unknown')),
  date_of_birth date,
  status public.record_status not null default 'active',
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, id),
  unique (farm_id, tag_code),
  foreign key (farm_id, animal_group_id) references public.animal_groups(farm_id, id)
);
create index if not exists farm_animals_farm_idx on public.farm_animals(farm_id, species, status);

create table if not exists public.farm_zones (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  animal_group_id uuid,
  name text not null,
  zone_type text not null default 'other' check (zone_type in ('barn','coop','stable','pasture','range','free_roam','yard','other')),
  description text,
  latitude double precision,
  longitude double precision,
  boundary_geojson jsonb,
  is_night_monitored boolean not null default false,
  status public.record_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, id),
  foreign key (farm_id, animal_group_id) references public.animal_groups(farm_id, id),
  check (latitude is null or latitude between -90 and 90),
  check (longitude is null or longitude between -180 and 180),
  check (boundary_geojson is null or jsonb_typeof(boundary_geojson) = 'object')
);
create index if not exists farm_zones_farm_idx on public.farm_zones(farm_id, status);

create table if not exists public.sensor_devices (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  zone_id uuid,
  device_code text not null,
  name text not null,
  kind public.device_kind not null default 'camera_sensor',
  manufacturer text,
  model text,
  firmware_version text,
  capabilities text[] not null default '{}',
  status public.record_status not null default 'active',
  last_seen_at timestamptz,
  last_ip inet,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, id),
  unique (farm_id, device_code),
  foreign key (farm_id, zone_id) references public.farm_zones(farm_id, id)
);
create index if not exists sensor_devices_zone_idx on public.sensor_devices(farm_id, zone_id, status);

-- Event-level telemetry: known readings have typed columns, while `measurements`
-- carries additional/future sensors without needing a schema change.
create table if not exists public.telemetry_events (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  zone_id uuid,
  device_id uuid,
  animal_id uuid,
  source_event_id text,
  captured_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  temperature_c numeric(7,3),
  humidity_pct numeric(7,3) check (humidity_pct is null or humidity_pct between 0 and 100),
  ammonia_ppm numeric(10,3) check (ammonia_ppm is null or ammonia_ppm >= 0),
  measurements jsonb not null default '{}'::jsonb check (jsonb_typeof(measurements) = 'object'),
  animal_observation text,
  activity_level numeric(7,3),
  battery_voltage numeric(7,3),
  signal_strength_dbm integer,
  is_night boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(raw_payload) = 'object'),
  created_at timestamptz not null default now(),
  unique (farm_id, id),
  foreign key (farm_id, zone_id) references public.farm_zones(farm_id, id),
  foreign key (farm_id, device_id) references public.sensor_devices(farm_id, id),
  foreign key (farm_id, animal_id) references public.farm_animals(farm_id, id),
  unique (device_id, source_event_id)
);
create index if not exists telemetry_farm_captured_idx on public.telemetry_events(farm_id, captured_at desc);
create index if not exists telemetry_zone_captured_idx on public.telemetry_events(zone_id, captured_at desc);
create index if not exists telemetry_device_captured_idx on public.telemetry_events(device_id, captured_at desc);
create index if not exists telemetry_night_idx on public.telemetry_events(farm_id, captured_at desc) where is_night;

create table if not exists public.animal_tracking_points (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  animal_id uuid not null,
  device_id uuid,
  telemetry_event_id uuid,
  captured_at timestamptz not null default now(),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m numeric(8,2) check (accuracy_m is null or accuracy_m >= 0),
  speed_mps numeric(8,3) check (speed_mps is null or speed_mps >= 0),
  heading_degrees numeric(6,2) check (heading_degrees is null or heading_degrees between 0 and 360),
  is_night boolean not null default false,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (farm_id, animal_id) references public.farm_animals(farm_id, id),
  foreign key (farm_id, device_id) references public.sensor_devices(farm_id, id),
  foreign key (farm_id, telemetry_event_id) references public.telemetry_events(farm_id, id)
);
create index if not exists animal_tracking_time_idx on public.animal_tracking_points(farm_id, animal_id, captured_at desc);
create index if not exists animal_tracking_night_idx on public.animal_tracking_points(farm_id, captured_at desc) where is_night;

create table if not exists public.camera_snapshots (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  zone_id uuid,
  device_id uuid,
  animal_id uuid,
  telemetry_event_id uuid,
  captured_at timestamptz not null default now(),
  storage_bucket text not null default 'farm-media',
  storage_path text not null,
  content_type text not null default 'image/jpeg',
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),
  is_night boolean not null default false,
  ai_summary text,
  ai_labels jsonb not null default '[]'::jsonb check (jsonb_typeof(ai_labels) = 'array'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (farm_id, id),
  unique (storage_bucket, storage_path),
  foreign key (farm_id, zone_id) references public.farm_zones(farm_id, id),
  foreign key (farm_id, device_id) references public.sensor_devices(farm_id, id),
  foreign key (farm_id, animal_id) references public.farm_animals(farm_id, id),
  foreign key (farm_id, telemetry_event_id) references public.telemetry_events(farm_id, id)
);
create index if not exists camera_snapshots_zone_time_idx on public.camera_snapshots(zone_id, captured_at desc);
create index if not exists camera_snapshots_farm_time_idx on public.camera_snapshots(farm_id, captured_at desc);

create table if not exists public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  zone_id uuid,
  metric_key text not null,
  operator text not null check (operator in ('gt','gte','lt','lte','eq','neq')),
  threshold numeric not null,
  severity public.alert_severity not null default 'warning',
  enabled boolean not null default true,
  quiet_hours jsonb not null default '{}'::jsonb check (jsonb_typeof(quiet_hours) = 'object'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, id),
  foreign key (farm_id, zone_id) references public.farm_zones(farm_id, id) on delete cascade
);

create table if not exists public.farm_alerts (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  zone_id uuid,
  device_id uuid,
  animal_id uuid,
  telemetry_event_id uuid,
  rule_id uuid,
  severity public.alert_severity not null default 'info',
  alert_type text not null,
  title text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  occurred_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (farm_id, id),
  foreign key (farm_id, zone_id) references public.farm_zones(farm_id, id),
  foreign key (farm_id, device_id) references public.sensor_devices(farm_id, id),
  foreign key (farm_id, animal_id) references public.farm_animals(farm_id, id),
  foreign key (farm_id, telemetry_event_id) references public.telemetry_events(farm_id, id),
  foreign key (farm_id, rule_id) references public.alert_rules(farm_id, id)
);
create index if not exists farm_alerts_farm_time_idx on public.farm_alerts(farm_id, occurred_at desc);
create index if not exists farm_alerts_unacked_idx on public.farm_alerts(farm_id, occurred_at desc) where acknowledged_at is null;

create table if not exists public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('in_app','web_push','whatsapp','email')),
  enabled boolean not null default false,
  phone_e164 text,
  push_endpoint text,
  push_p256dh text,
  push_auth text,
  consented_at timestamptz,
  consent_text_version text,
  consent_source text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (farm_id, user_id, channel, push_endpoint),
  check (channel <> 'whatsapp' or not enabled or (phone_e164 is not null and consented_at is not null and consent_text_version is not null)),
  check (phone_e164 is null or phone_e164 ~ '^[+][1-9][0-9]{7,14}$'),
  check (channel <> 'web_push' or not enabled or (push_endpoint is not null and push_p256dh is not null and push_auth is not null))
);
create index if not exists notification_preferences_user_idx on public.notification_preferences(user_id, farm_id);

create table if not exists public.farm_reports (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  report_type text not null check (report_type in ('daily','weekly','monthly','custom','incident')),
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'pending' check (status in ('pending','running','complete','failed')),
  storage_bucket text,
  storage_path text,
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);
create index if not exists farm_reports_period_idx on public.farm_reports(farm_id, period_start desc);

create table if not exists public.farm_subscriptions (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  package_name text not null,
  camera_limit integer not null check (camera_limit > 0),
  monthly_price_kes numeric(12,2) check (monthly_price_kes is null or monthly_price_kes >= 0),
  billing_status text not null default 'quotation' check (billing_status in ('quotation','trial','active','past_due','cancelled','expired')),
  installation_status text not null default 'not_scheduled' check (installation_status in ('not_scheduled','requested','scheduled','installed')),
  report_frequency text not null default 'monthly' check (report_frequency in ('daily','weekly','monthly','custom')),
  starts_at timestamptz,
  ends_at timestamptz,
  external_billing_ref text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Installation enquiries are written through a rate-limited Edge Function,
-- not directly from the anonymous browser role.
create table if not exists public.installation_requests (
  id uuid primary key default gen_random_uuid(),
  contact_name text not null,
  email text not null,
  phone_e164 text,
  farm_name text,
  location_text text,
  animal_species public.animal_species[] not null default '{}',
  camera_count integer check (camera_count is null or camera_count > 0),
  package_interest text,
  message text,
  preferred_contact text not null default 'phone' check (preferred_contact in ('phone','email','whatsapp')),
  status text not null default 'new' check (status in ('new','contacted','quoted','closed','spam')),
  created_at timestamptz not null default now()
);

-- Device credentials are hashes only and live in a non-exposed schema.
-- Put device-token verification and inserts in an Edge Function; never embed
-- a service key or raw device token in ESP32 firmware shared with the client.
create table if not exists private.device_credentials (
  device_id uuid primary key references public.sensor_devices(id) on delete cascade,
  token_hash text not null,
  rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
revoke all on table private.device_credentials from public, anon, authenticated;

-- Updated-at maintenance.
do $$ declare t text; begin
  foreach t in array array['profiles','farms','animal_groups','farm_animals','farm_zones','sensor_devices','alert_rules','notification_preferences','farm_subscriptions'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- Enable RLS everywhere in the exposed public schema; explicit grants are
-- paired with policies because policies alone do not remove existing grants.
alter table public.profiles enable row level security;
alter table public.farms enable row level security;
alter table public.farm_members enable row level security;
alter table public.animal_groups enable row level security;
alter table public.farm_animals enable row level security;
alter table public.farm_zones enable row level security;
alter table public.sensor_devices enable row level security;
alter table public.telemetry_events enable row level security;
alter table public.animal_tracking_points enable row level security;
alter table public.camera_snapshots enable row level security;
alter table public.alert_rules enable row level security;
alter table public.farm_alerts enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.farm_reports enable row level security;
alter table public.farm_subscriptions enable row level security;
alter table public.installation_requests enable row level security;

revoke all on public.profiles, public.farms, public.farm_members, public.animal_groups, public.farm_animals,
  public.farm_zones, public.sensor_devices, public.telemetry_events, public.animal_tracking_points, public.camera_snapshots,
  public.alert_rules, public.farm_alerts, public.notification_preferences, public.farm_reports,
  public.farm_subscriptions, public.installation_requests from anon, authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select on public.farms, public.farm_members, public.sensor_devices,
  public.telemetry_events, public.animal_tracking_points, public.camera_snapshots, public.farm_reports,
  public.farm_subscriptions to authenticated;
grant select, insert, update, delete on public.animal_groups, public.farm_animals, public.farm_zones,
  public.alert_rules to authenticated;
grant select, update (acknowledged_at, acknowledged_by) on public.farm_alerts to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;

-- Policies are replaced by name so the migration is safe to re-apply.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists farms_member_select on public.farms;
create policy farms_member_select on public.farms for select to authenticated using ((select private.has_farm_role(id)));
drop policy if exists farms_admin_update on public.farms;
create policy farms_admin_update on public.farms for update to authenticated using ((select private.has_farm_role(id, array['owner','admin']::public.farm_member_role[]))) with check ((select private.has_farm_role(id, array['owner','admin']::public.farm_member_role[])));

drop policy if exists farm_members_select_same_farm on public.farm_members;
create policy farm_members_select_same_farm on public.farm_members for select to authenticated using ((select private.has_farm_role(farm_id)));

drop policy if exists animal_groups_member_read on public.animal_groups;
create policy animal_groups_member_read on public.animal_groups for select to authenticated using ((select private.has_farm_role(farm_id)));
drop policy if exists animal_groups_editor_write on public.animal_groups;
create policy animal_groups_editor_write on public.animal_groups for all to authenticated using ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[]))) with check ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[])));

drop policy if exists farm_animals_member_read on public.farm_animals;
create policy farm_animals_member_read on public.farm_animals for select to authenticated using ((select private.has_farm_role(farm_id)));
drop policy if exists farm_animals_editor_write on public.farm_animals;
create policy farm_animals_editor_write on public.farm_animals for all to authenticated using ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[]))) with check ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[])));

drop policy if exists farm_zones_member_read on public.farm_zones;
create policy farm_zones_member_read on public.farm_zones for select to authenticated using ((select private.has_farm_role(farm_id)));
drop policy if exists farm_zones_editor_write on public.farm_zones;
create policy farm_zones_editor_write on public.farm_zones for all to authenticated using ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[]))) with check ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[])));

drop policy if exists devices_member_read on public.sensor_devices;
create policy devices_member_read on public.sensor_devices for select to authenticated using ((select private.has_farm_role(farm_id)));
drop policy if exists telemetry_member_read on public.telemetry_events;
create policy telemetry_member_read on public.telemetry_events for select to authenticated using ((select private.has_farm_role(farm_id)));
drop policy if exists animal_tracking_member_read on public.animal_tracking_points;
create policy animal_tracking_member_read on public.animal_tracking_points for select to authenticated using ((select private.has_farm_role(farm_id)));
drop policy if exists snapshots_member_read on public.camera_snapshots;
create policy snapshots_member_read on public.camera_snapshots for select to authenticated using ((select private.has_farm_role(farm_id)));

drop policy if exists alert_rules_member_read on public.alert_rules;
create policy alert_rules_member_read on public.alert_rules for select to authenticated using ((select private.has_farm_role(farm_id)));
drop policy if exists alert_rules_editor_write on public.alert_rules;
create policy alert_rules_editor_write on public.alert_rules for all to authenticated using ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[]))) with check ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[])));

drop policy if exists alerts_member_read on public.farm_alerts;
create policy alerts_member_read on public.farm_alerts for select to authenticated using ((select private.has_farm_role(farm_id)));
drop policy if exists alerts_member_ack on public.farm_alerts;
create policy alerts_member_ack on public.farm_alerts for update to authenticated using ((select private.has_farm_role(farm_id))) with check ((select private.has_farm_role(farm_id)) and (acknowledged_by is null or acknowledged_by = (select auth.uid())));

drop policy if exists notification_owner_read on public.notification_preferences;
create policy notification_owner_read on public.notification_preferences for select to authenticated using (user_id = (select auth.uid()) and (select private.has_farm_role(farm_id)));
drop policy if exists notification_owner_insert on public.notification_preferences;
create policy notification_owner_insert on public.notification_preferences for insert to authenticated with check (user_id = (select auth.uid()) and (select private.has_farm_role(farm_id)));
drop policy if exists notification_owner_update on public.notification_preferences;
create policy notification_owner_update on public.notification_preferences for update to authenticated using (user_id = (select auth.uid()) and (select private.has_farm_role(farm_id))) with check (user_id = (select auth.uid()) and (select private.has_farm_role(farm_id)));
drop policy if exists notification_owner_delete on public.notification_preferences;
create policy notification_owner_delete on public.notification_preferences for delete to authenticated using (user_id = (select auth.uid()) and (select private.has_farm_role(farm_id)));

drop policy if exists reports_member_read on public.farm_reports;
create policy reports_member_read on public.farm_reports for select to authenticated using ((select private.has_farm_role(farm_id)));
drop policy if exists subscriptions_member_read on public.farm_subscriptions;
create policy subscriptions_member_read on public.farm_subscriptions for select to authenticated using ((select private.has_farm_role(farm_id)));

-- Installation enquiries are accessed only by trusted server-side functions.
revoke all on public.installation_requests from anon, authenticated;

-- Private Storage bucket. Clients can view objects within farms they belong to;
-- uploads/deletions are intentionally left to a trusted Edge Function/device flow.
insert into storage.buckets (id, name, public)
values ('farm-media', 'farm-media', false)
on conflict (id) do update set public = false;
drop policy if exists farm_media_member_read on storage.objects;
create policy farm_media_member_read on storage.objects for select to authenticated
using (
  bucket_id = 'farm-media'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and (select private.has_farm_role(((storage.foldername(name))[1])::uuid))
);

-- Add tables to Supabase Realtime if the publication exists and the tables are
-- not already members. The UI should subscribe only after authenticated login.
do $$ declare t text; begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      foreach t in array array['telemetry_events','animal_tracking_points','farm_alerts','camera_snapshots'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

commit;

-- Bootstrap (run separately after creating/inviting the first user):
-- 1. Create the farm row using the SQL Editor, then copy its returned id.
--    insert into public.farms (name, county) values ('Kijani Farm', 'Kiambu') returning id;
-- 2. Look up the invited auth user's UUID in Authentication > Users, then:
--    insert into public.farm_members (farm_id, user_id, role)
--    values ('<FARM_UUID>', '<AUTH_USER_UUID>', 'owner');
-- 3. Add initial groups, zones, and devices as an owner/admin/operator in the app
--    (or via SQL Editor). ESP32 ingestion must use a server-side Edge Function.

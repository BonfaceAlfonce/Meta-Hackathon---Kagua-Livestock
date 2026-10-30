-- Outbreak Shield: daily flock health logs, per-zone outbreak risk assessments,
-- and anonymised county-level regional signals.
--
-- Depends on 20261026000000_farm_monitoring_schema.sql (farms, farm_zones,
-- private.has_farm_role, set_updated_at). Safe to re-apply.
--
-- Write model:
--   * flock_health_logs     -> farm owners/admins/operators (via the app)
--   * outbreak_assessments  -> the outbreak-shield Edge Function only (service role)
--   * regional_signals      -> the outbreak-shield Edge Function only (service role)
-- Kagua flags patterns for follow-up; it never stores or presents a diagnosis.

begin;

do $$ begin
  create type public.outbreak_risk_level as enum ('none', 'low', 'medium', 'high');
exception when duplicate_object then null; end $$;

-- One row per zone per day. Intake percentages are relative to the flock's
-- normal intake (100 = normal), so they work for any flock size or feeder type.
create table if not exists public.flock_health_logs (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  zone_id uuid not null,
  log_date date not null,
  flock_size integer check (flock_size is null or flock_size > 0),
  deaths integer not null default 0 check (deaths >= 0),
  sick_count integer not null default 0 check (sick_count >= 0),
  feed_intake_pct numeric(5,2) check (feed_intake_pct is null or feed_intake_pct between 0 and 200),
  water_intake_pct numeric(5,2) check (water_intake_pct is null or water_intake_pct between 0 and 200),
  respiratory_signs boolean not null default false,
  notes text check (notes is null or char_length(notes) <= 1000),
  source text not null default 'farmer' check (source in ('farmer', 'camera', 'sensor', 'demo')),
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (zone_id, log_date),
  check (flock_size is null or deaths + sick_count <= flock_size),
  foreign key (farm_id, zone_id) references public.farm_zones(farm_id, id) on delete cascade
);
create index if not exists flock_health_logs_farm_date_idx on public.flock_health_logs(farm_id, log_date desc);

-- Deterministic risk result per zone per day. The unique key makes reruns idempotent (upsert).
create table if not exists public.outbreak_assessments (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  zone_id uuid not null,
  assessed_on date not null,
  risk_level public.outbreak_risk_level not null,
  score numeric(5,2) not null check (score >= 0),
  signals jsonb not null default '{}'::jsonb check (jsonb_typeof(signals) = 'object'),
  is_spreading boolean not null default false,
  ai_status text not null default 'pending' check (ai_status in ('pending', 'generated', 'fallback')),
  ai_summary text,
  ai_farmer_message text,
  ai_vet_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (zone_id, assessed_on),
  foreign key (farm_id, zone_id) references public.farm_zones(farm_id, id) on delete cascade
);
create index if not exists outbreak_assessments_farm_date_idx on public.outbreak_assessments(farm_id, assessed_on desc);

-- Aggregates only: no farm or zone identifiers. The farms_affected >= 3 check
-- enforces k-anonymity in the database itself, not just in application code.
create table if not exists public.regional_signals (
  id uuid primary key default gen_random_uuid(),
  country_code char(2) not null,
  county text not null,
  window_start date not null,
  window_end date not null,
  farms_affected integer not null check (farms_affected >= 3),
  farms_high integer not null default 0 check (farms_high >= 0 and farms_high <= farms_affected),
  risk_level public.outbreak_risk_level not null,
  ai_status text not null default 'pending' check (ai_status in ('pending', 'generated', 'fallback')),
  ai_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (country_code, county, window_end),
  check (window_end >= window_start)
);
create index if not exists regional_signals_window_idx on public.regional_signals(window_end desc);

-- Updated-at maintenance (reuses the baseline trigger function).
do $$ declare t text; begin
  foreach t in array array['flock_health_logs', 'outbreak_assessments', 'regional_signals'] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- Row Level Security.
alter table public.flock_health_logs enable row level security;
alter table public.outbreak_assessments enable row level security;
alter table public.regional_signals enable row level security;

revoke all on public.flock_health_logs, public.outbreak_assessments, public.regional_signals from anon, authenticated;
grant select, insert, update, delete on public.flock_health_logs to authenticated;
grant select on public.outbreak_assessments, public.regional_signals to authenticated;
-- Explicit so the Edge Function does not depend on project default privileges.
grant select, insert, update, delete on public.flock_health_logs, public.outbreak_assessments,
  public.regional_signals to service_role;

drop policy if exists flock_logs_member_read on public.flock_health_logs;
create policy flock_logs_member_read on public.flock_health_logs for select to authenticated
  using ((select private.has_farm_role(farm_id)));

drop policy if exists flock_logs_editor_insert on public.flock_health_logs;
create policy flock_logs_editor_insert on public.flock_health_logs for insert to authenticated
  with check (
    (select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[]))
    and (recorded_by is null or recorded_by = (select auth.uid()))
  );

drop policy if exists flock_logs_editor_update on public.flock_health_logs;
create policy flock_logs_editor_update on public.flock_health_logs for update to authenticated
  using ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[])))
  with check ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[])));

drop policy if exists flock_logs_admin_delete on public.flock_health_logs;
create policy flock_logs_admin_delete on public.flock_health_logs for delete to authenticated
  using ((select private.has_farm_role(farm_id, array['owner','admin']::public.farm_member_role[])));

drop policy if exists outbreak_assessments_member_read on public.outbreak_assessments;
create policy outbreak_assessments_member_read on public.outbreak_assessments for select to authenticated
  using ((select private.has_farm_role(farm_id)));

-- Regional signals contain only aggregates of 3+ farms, so any signed-in user may read them.
drop policy if exists regional_signals_authenticated_read on public.regional_signals;
create policy regional_signals_authenticated_read on public.regional_signals for select to authenticated
  using (true);

-- Realtime: the dashboard updates as soon as the Edge Function writes results.
do $$ declare t text; begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['outbreak_assessments', 'regional_signals'] loop
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

# Supabase SQL Editor run order

## Important

Run the **entire** file `migrations/20261026000000_farm_monitoring_schema.sql` in one SQL Editor query, starting at the top. Do not run only the policy section pasted into the Editor: those statements depend on all tables, enum types, and the `private.has_farm_role()` helper having already been created.

The migration is ordered as follows:

1. Schemas and enum types.
2. Core identity and tenant tables (`profiles`, `farms`, `farm_members`) and their membership helper.
3. Animal, zone, device, telemetry, camera, alert, notification, subscription, and report tables.
4. Triggers, RLS, grants, and policies.
5. Private Storage bucket and Realtime publication setup.

## Foundation SQL (prerequisites)

This is the minimum foundation. The full migration file contains this setup plus all the other tables and policies. You normally do not need to run this separately.

```sql
create schema if not exists private;

do $$ begin
  create type public.farm_member_role as enum ('owner', 'admin', 'operator', 'viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.animal_species as enum ('cattle', 'horse', 'poultry', 'sheep', 'goat', 'pig', 'other');
exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  phone_e164 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
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
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.farm_members (
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.farm_member_role not null default 'viewer',
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  primary key (farm_id, user_id)
);

create or replace function private.has_farm_role(
  p_farm_id uuid,
  p_roles public.farm_member_role[] default null
)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.farm_members m
    where m.farm_id = p_farm_id
      and m.user_id = (select auth.uid())
      and (p_roles is null or m.role = any(p_roles))
  );
$$;
```

If you already ran fragments and see `already exists`, stop and run the full migration instead; `IF NOT EXISTS` protects tables, but it does not repair an existing table with the wrong columns. If the full migration still errors, send the complete error including its `ERROR:` code and `LINE` number.

## Manual form submissions (run second)

After the base migration above, run the **entire** file `migrations/20261028000000_farmer_manual_submissions.sql`. It grants farmer roles (owner/admin/operator) insert access for manual readings, snapshots, and photo uploads. Without it, the dashboard's Fill out data form is rejected by Row Level Security.

## Demo farm locations and photos (data update)

Run the **entire** file `update_farm_locations_and_demo_photos.sql` to place Jean Farm in Seattle, USA and Das Farm in India, and to repoint demo snapshots at verified poultry photos. Re-run the demo seed afterwards only on a fresh project; on a live project this update file is enough.

## Das Farm vision and advisory

After the foundation and manual-submission migrations, run these entire files in order:

1. `migrations/20261028000001_farm_image_analyses.sql`
2. `migrations/20261029000000_das_farm_advisory.sql`

The vision migration was renamed from `20261028000000_farm_image_analyses.sql` during integration because main already uses version `20261028000000` for manual submissions. Its SQL is unchanged. Both migrations now have unique versions.

If you previously ran the old vision file through SQL Editor, its tables and reservation function already exist; the renamed file is safe to reapply. Existing advisory history is retained. Apply any missing manual-submission/advisory migration as well. Do not rerun demo seeds on a populated farm.

If you previously used the Supabase CLI to apply either migration at version `20261028000000`, inspect `supabase migration list` against the actual database objects before using `db push`. The old shared version alone cannot identify which migration ran. Reconcile the recorded versions with the database administrator; do not blindly repair history or reset the database.

Deploy `analyse-farm-image` and `farm-advisory` separately from the frontend, with the configuration in `../docs/DAS_FARM_VISION.md` and `../docs/DAS_FARM_ADVISORY.md`. Main's manual photo check uses a separate function, `analyze-photo`, and its own `AI_API_URL`, `AI_API_KEY`, and `AI_MODEL` configuration. The advisory's `META_*` settings do not configure that function.

The advisory keeps its existing four inputs (temperature, humidity, ammonia, ground moisture). Main's CO₂ display and manual form remain available, but CO₂ is not added to advisory rules. Advisory processing still requires a zone-linked reading; a manual entry saved at "Farm level" remains visible in the dashboard but is not eligible for this advisory. Select an existing zone in the manual form to make that reading eligible. A missing ground-moisture measurement is shown as unavailable.

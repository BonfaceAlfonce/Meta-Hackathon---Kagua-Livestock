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

## Outbreak Shield (run after the files above)

Run each file in full, in this order: `migrations/20261028120000_outbreak_shield.sql`, `migrations/20261029000000_outbreak_shield_schedule.sql`, `migrations/20261030000000_outbreak_farm_checks.sql`. Then set the function secrets, deploy `outbreak-shield`, and add the two Vault secrets; see the Outbreak Shield section of the README.

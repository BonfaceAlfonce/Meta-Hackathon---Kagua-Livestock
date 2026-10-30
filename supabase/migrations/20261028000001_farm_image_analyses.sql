-- Run after 20261026000000_farm_monitoring_schema.sql. No existing rows are modified.
begin;
create table if not exists public.farm_image_analyses (
  id uuid primary key,
  farm_id uuid not null references public.farms(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  image_id text not null,
  image_revision integer not null,
  image_title text not null,
  image_path text not null,
  mode text not null check (mode in ('sample','meta')),
  status text not null default 'pending' check (status in ('pending','complete','failed')),
  model text,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((mode = 'sample' and model is null) or (mode = 'meta' and model is not null)),
  check (status <> 'complete' or (result is not null and jsonb_typeof(result) = 'object'))
);
create index if not exists farm_image_analyses_history on public.farm_image_analyses(farm_id, created_at desc);
alter table public.farm_image_analyses enable row level security;
revoke all on public.farm_image_analyses from anon, authenticated;
grant select on public.farm_image_analyses to authenticated;
grant select, insert, update on public.farm_image_analyses to service_role;
drop policy if exists farm_image_analyses_member_read on public.farm_image_analyses;
create policy farm_image_analyses_member_read on public.farm_image_analyses
  for select to authenticated using (private.has_farm_role(farm_id));

-- Serialize reservation per farm to prevent concurrent requests bypassing the cost limit.
create or replace function public.reserve_farm_image_analysis(
  p_id uuid, p_farm_id uuid, p_user_id uuid, p_image_id text, p_image_title text,
  p_image_path text, p_revision integer, p_mode text, p_model text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_farm_id::text, 0));
  if (select count(*) from public.farm_image_analyses
      where farm_id = p_farm_id and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'Farm analysis rate limit reached';
  end if;
  insert into public.farm_image_analyses(id, farm_id, created_by, image_id, image_title, image_path, image_revision, mode, model)
  values (p_id, p_farm_id, p_user_id, p_image_id, p_image_title, p_image_path, p_revision, p_mode, p_model);
end;
$$;
revoke all on function public.reserve_farm_image_analysis(uuid,uuid,uuid,text,text,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.reserve_farm_image_analysis(uuid,uuid,uuid,text,text,text,integer,text,text) to service_role;
commit;

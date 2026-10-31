-- Outbreak Shield: when each farm was last checked.
--
-- outbreak_assessments.updated_at only moves when a result changes (unchanged
-- results are not rewritten), so it cannot show that the hourly check ran.
-- The outbreak-shield function upserts one row per farm on every successful run.

begin;

create table if not exists public.outbreak_farm_checks (
  farm_id uuid primary key references public.farms(id) on delete cascade,
  last_checked_at timestamptz not null default now(),
  last_mode text not null check (last_mode in ('scheduled', 'user'))
);

alter table public.outbreak_farm_checks enable row level security;

revoke all on public.outbreak_farm_checks from anon, authenticated;
grant select on public.outbreak_farm_checks to authenticated;
grant select, insert, update, delete on public.outbreak_farm_checks to service_role;

drop policy if exists outbreak_farm_checks_member_read on public.outbreak_farm_checks;
create policy outbreak_farm_checks_member_read on public.outbreak_farm_checks for select to authenticated
  using ((select private.has_farm_role(farm_id)));

-- Realtime, so an open page shows "Checked just now" after each hourly run.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'outbreak_farm_checks'
     ) then
    alter publication supabase_realtime add table public.outbreak_farm_checks;
  end if;
end $$;

commit;

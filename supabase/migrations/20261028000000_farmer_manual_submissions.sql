-- Kagua Livestock: let farmers submit manual readings + photos from the app.
-- Run AFTER migrations/20261026000000_farm_monitoring_schema.sql
-- (Supabase SQL Editor, or `supabase db push`). Safe to re-apply.
-- Browser inserts are limited to owner/admin/operator members of the target farm.

begin;

grant insert on public.telemetry_events to authenticated;
grant insert on public.camera_snapshots to authenticated;

drop policy if exists telemetry_editor_insert on public.telemetry_events;
create policy telemetry_editor_insert on public.telemetry_events for insert to authenticated
with check ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[])));

drop policy if exists snapshots_editor_insert on public.camera_snapshots;
create policy snapshots_editor_insert on public.camera_snapshots for insert to authenticated
with check ((select private.has_farm_role(farm_id, array['owner','admin','operator']::public.farm_member_role[])));

-- Manual photo uploads land under "<farm-uuid>/manual/...", matching the
-- folder rule of the existing farm_media_member_read policy.
drop policy if exists farm_media_member_upload on storage.objects;
create policy farm_media_member_upload on storage.objects for insert to authenticated
with check (
  bucket_id = 'farm-media'
  and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and (select private.has_farm_role(((storage.foldername(name))[1])::uuid, array['owner','admin','operator']::public.farm_member_role[]))
);

commit;

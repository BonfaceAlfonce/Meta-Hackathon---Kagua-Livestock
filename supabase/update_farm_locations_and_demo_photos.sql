-- Kagua Livestock: set demo farm locations + fix demo snapshot photos.
-- Run in Supabase SQL Editor as project owner. Safe to re-run.
-- Jean Farm -> Seattle, USA (America/Los_Angeles).
-- Das Farm  -> India (Asia/Kolkata, whole country shares one zone).
-- Demo snapshots -> verified local poultry photos (replaces wrong externals).

begin;

update public.farms
set timezone = 'America/Los_Angeles', country_code = 'US',
    county = 'King County', locality = 'Seattle', updated_at = now()
where name = 'Jean Farm';

update public.farms
set timezone = 'Asia/Kolkata', country_code = 'IN',
    county = null, locality = 'India', updated_at = now()
where name = 'Das Farm';

update public.camera_snapshots
set ai_summary = 'DEMO IMAGE: sample photo of free-range hens. It is not a Jean Farm or ESP32 camera capture.',
    ai_labels = jsonb_build_array('demo', 'poultry', 'hens reference'),
    metadata = jsonb_build_object('demo', true, 'demo_image_url', '/images/free-range-hens.jpg', 'demo_image_source_credit', 'Kagua sample photo')
where storage_path like 'demo/%/jean-heat-stress.jpg';

update public.camera_snapshots
set ai_summary = 'DEMO IMAGE: sample photo of young chicks. It is not a Das Farm or ESP32 camera capture.',
    ai_labels = jsonb_build_array('demo', 'poultry', 'chicks reference'),
    metadata = jsonb_build_object('demo', true, 'demo_image_url', '/images/chicks-free-range.jpg', 'demo_image_source_credit', 'Kagua sample photo')
where storage_path like 'demo/%/das-wet-ground.jpg';

commit;

-- Verify: two farms with new zones, two demo snapshots with local photos.
select name, timezone, country_code, county, locality
from public.farms
where name in ('Jean Farm', 'Das Farm')
order by name;

select storage_path, metadata ->> 'demo_image_url' as demo_image_url
from public.camera_snapshots
where storage_path like 'demo/%'
order by storage_path;

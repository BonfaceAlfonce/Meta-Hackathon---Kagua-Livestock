# Farm advisory

Real-data flock advisory. A completed advisory is published as an ordinary
farm_alerts row, so the existing Overview/Records/Alerts displays pick it up
without changes. No messaging provider or communication preference is touched.

## Inputs and behaviour

- Select a zone-linked telemetry record from the selected farm. The default is
  the latest available record; a zone filter traces records per zone.
  Temperature, humidity, ammonia and `measurements.co2_ppm` are the only
  environmental inputs. Zero is preserved; missing values stay unavailable.
- The server pairs the record with the farm's own camera photo: first the
  snapshot linked to that telemetry event, otherwise the latest snapshot in
  the same zone. No photo is ever invented; without one the advisory is a
  labelled readings-only result.
- SAM 3.1 (`META_SAM_MODEL`, default `sam-3.1`) segments candidate chicken
  regions in the photo over the Meta Responses API. The documented
  segmentation token output is validated into bounding boxes. Masks are not
  decoded; regions are supporting evidence, never a verified flock count.
- Muse Spark vision (`META_VISION_MODEL`, default `muse-spark-1.3`) reads the
  same photo over Chat Completions with a strict JSON schema: visible chicken
  distribution across feeders, brooders and free-roam areas, behaviour flags,
  and the four advisory sections plus a `normal`/`attention` verdict combined
  with the readings.
- Applicable enabled alert_rules and recognized existing environmental alerts
  tied to that exact record supply the risk flag and severity. Unrelated
  zones, other farms, resolved alerts and previous advisories are excluded.
- Every model output passes validation in code, including a guardrail that
  rejects disease, pathogen and treatment wording. A failed or rejected model
  call degrades to a labelled template (readings plus whatever stage did
  succeed); it never invents visual findings. The result records which stages
  ran (`ok`, `skipped`, or the failure reason).
- The advisory generates no disease names, diagnoses, medicines, vaccine
  recommendations or treatment instructions.

## Use locally

1. Sign in as any farm member and choose one of its farms.
2. Submit real data from Fill out data: pick a zone (not "Farm level"), enter
   readings, attach a photo, then Submit.
3. Open Farm Advisory (under Outbreak Shield). The latest record is preselected;
   change the zone or record to trace another telemetry event.
4. Click Run advisory. Review the verdict, flock distribution, observations,
   risk flags, inspection checks and evidence limits.
5. Open Alerts or Records to see the published advisory alert. Photos shows
   only the farm's photos; each photo links back to its advisory.

## Server setup (not executed by this code change)

1. Apply foundation migrations in order, including
   `20261028000001_farm_image_analyses.sql`,
   `20261029000001_das_farm_advisory.sql`, then
   `20261101000000_farm_advisory_real_data.sql` in Supabase SQL Editor.
2. Confirm farm membership and existing zone-linked telemetry for each farm.
3. In Supabase Dashboard > Edge Functions > Secrets, set the server-only
   secrets from `supabase/functions/vision-secrets.example`:
   - `VISION_SITE_ORIGIN`: this app's origin, e.g. `http://localhost:5173`
     for local testing or the deployed HTTPS origin (no subpath or slash).
   - `META_API_KEY`: your Meta Model API key. Required.
   - `META_VISION_MODEL` (default `muse-spark-1.3`) and
     `META_SAM_MODEL` (default `sam-3.1`).
   Standard SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
   provided by hosted Supabase functions. Never place service or Meta keys in
   VITE variables or GitHub.
4. Deploy from this project after linking it, keeping JWT verification on:
   `supabase functions deploy farm-advisory`. Its `_shared` modules deploy
   with it. If the retired `analyse-farm-image` or `analyze-photo` functions
   were ever deployed, delete them from the dashboard; nothing calls them now.
5. To clear demo rows so the app shows real data only, run the entire file
   `supabase/cleanup_demo_data.sql` in the SQL Editor.

## Storage and access

The server validates the selected farm UUID and verifies authenticated
membership before retrieving telemetry, rules, warnings, photos or invoking
Meta. Client-supplied readings, model messages or image URLs are ignored. The
hash of the selected record, values, snapshot, applicable warning/rule IDs and
configured models identifies completed evidence. Repeated evidence reuses the
existing advisory without another model call or duplicate alert. Farm-wide
request reservation limits are reused. Abandoned pending requests can recover
after two minutes; active pending requests return a clear busy state.

The additive migrations extend farm_image_analyses with advisory, advisory_key
and alert_id. A server-only RPC writes the ordinary farm_alerts record and
completes the analysis in one transaction. Acknowledgements and prior alerts
are preserved. No original telemetry is updated. Failures leave a failed
analysis; a timed-out client cannot change a completed analysis to failed.

## Verification and limits

Run `npm test` and `npm run build` to verify tests and frontend compilation.
In each selected farm, check advisory generation on the latest Fill-out-data
record, zone filtering, missing-value labels, shared history, publication to
dashboard alerts and reuse of repeated evidence. Database SQL, deployment and
live Meta access still need an integration check in your Supabase project with
a real key. No claim of verified poultry model accuracy is made.

Official references: https://dev.meta.ai/docs/sam/overview and
https://dev.meta.ai/docs/image-understanding

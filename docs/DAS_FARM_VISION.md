# Das Farm image analysis

## Presentation workflow (no Meta key or new Supabase deployment required)
1. Sign into the existing seeded Das account and choose Das Farm.
2. Open Photos. The image investigation panel appears above the existing gallery.
3. Choose an image and click **Show sample result**.
4. Review observations, possible concerns, suggested checks and limitations.
5. Reload and reopen an entry in Analysis history. Samples are stored per user and farm in this browser, with at most 20 entries. They are not ground captures or model results.

The default account mapping uses the Das auth user UUID already in demo_seed_jean_das.sql and resolves its unique owned Das Farm to an ID. For other members or a differently seeded account, add `VITE_DAS_FARM_ID=<actual farm UUID>` to the existing local .env and your hosting environment, then rebuild. It is a public identifier, not a secret. Backend access always verifies the exact DAS_FARM_ID secret and authenticated membership; the UI check is not an authorization boundary.

## Add your images later
Edit `supabase/functions/_shared/vision.js`. This catalogue is shared by the frontend and function. Place your files in `public/images/`, register a unique ID, revision, path, title, zone, original source URL, attribution and manually reviewed sample result. Increment revision when replacing an asset or sample. Rebuild the website and redeploy the function after catalogue changes. Files in public are publicly accessible. Two existing project images are registered as placeholders; their original attribution is still pending.

The four result arrays are observations, concerns, next_checks and limitations. Samples must be labelled as prepared observations. Do not invent temporal trends, disease diagnoses, sensor measurements or confidence percentages. Separate photos are independent examples, never a timeline.

## Enable shared history and Meta later
1. Run `supabase/migrations/20261028000000_farm_image_analyses.sql` in Supabase SQL Editor after the existing foundation migration. This creates a separate history table and server-only request reservation RPC. No existing farm data is changed.
2. Find the actual Das farm UUID in the farms table. Set VITE_DAS_FARM_ID for the frontend as above.
3. In Supabase Dashboard > Edge Functions > Secrets, set these server-only secrets:
   - `DAS_FARM_ID`: the same actual farm UUID.
   - `VISION_SITE_ORIGIN`: the deployed HTTPS website origin, e.g. https://your-site.example (no subpath or trailing slash). Only that browser origin is accepted. The reference paths must be publicly reachable at this origin.
   - `META_API_KEY`: your valid Meta key. Leave unset until available.
   - `META_VISION_MODEL`: an image-capable model your account can access, e.g. muse-spark-1.3.
   Standard SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by hosted Supabase functions. Never place service or Meta keys in VITE variables or GitHub.
4. Deploy the complete function and its shared modules using `supabase functions deploy analyse-farm-image` from this project after linking your Supabase project. Leave JWT verification enabled. A project with a different JWT setup must still preserve the function's getUser authentication.
5. Use **Save sample to farm history** to test shared persistence without a Meta key. Use **Load shared history** to retrieve the most recent 20 completed entries.
6. When the Meta key is configured, select **Meta · actual image analysis** and click **Analyse with Meta**. The backend sends only the registered image from the configured website to https://api.meta.ai/v1/chat/completions. It validates the response and saves it before returning.

The function rejects other farm IDs, missing memberships, unknown catalogue IDs and invalid requests before model calls. The browser cannot supply arbitrary image URLs or sample findings. The database allows members to read history; only the function can write it. Requests are idempotent by UUID and limited to ten reservations per farm per minute, including failed attempts. Model requests time out after 45 seconds. Failed inference never falls back to sample output.

Meta output is qualitative image understanding, not a trained poultry detector, segmentation, tracking or clinical assessment. SAM overlays and video behaviour measurements are outside this first version.

## Verification
Run `node --test tests/vision.test.js` and `npm run build`. The tests exercise access restrictions, sample provenance, model request construction, invalid model output, failures, and request reuse with mocked external services. Real deployment, SQL execution, account access and Meta inference must be verified once credentials and deployment are available.

Official image request format: https://dev.meta.ai/docs/image-understanding

## Additional two-image environmental advisory
The separate Farm advisory panel now appears above the individual image-analysis controls on Photos. It uses the first two owner-supplied gallery URLs and existing Das Farm telemetry. Original image-analysis features are retained. See `docs/DAS_FARM_ADVISORY.md` for the additive migration, separate farm-advisory function, SAM configuration and publishing to the existing dashboard alerts. WhatsApp and all other communication code are unchanged.

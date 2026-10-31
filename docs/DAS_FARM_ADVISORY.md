# Das Farm environmental advisory

## Scope
The advisory is an addition inside the existing Photos image-analysis area. The existing gallery, individual image analysis, sample history, all other tabs and all WhatsApp/communication code remain intact. A completed advisory is published as an ordinary farm_alerts row. The existing Overview/Records subscriptions display that row without any UI changes to those tabs. No messaging provider or communication preference is touched.

## Inputs and behaviour
- `supabase/functions/_shared/demo-images.js` holds the same three owner-supplied image URLs, in their original order. The first two are registered as simulated advisory feed inputs. The third remains in the gallery. They are independent images, not temporal frames.
- Select a zone-linked Das Farm telemetry record in the advisory. The default is the latest available record. Temperature, humidity, ammonia and `measurements.ground_moisture_pct` are the only environmental inputs; there are no new sensor values, thresholds or substituted defaults. Zero is preserved; missing/non-numeric values show Unavailable.
- Applicable enabled rules from alert_rules and recognized existing environmental alerts tied to that exact record supply the risk flag and severity. Unrelated zones, other farms, resolved alerts and previous advisories are excluded. Existing alert messages and titles are not copied into advisory wording.
- The two images are explicitly paired to the selected zone/record for demonstration, not asserted to be synchronized captures. A still does not establish movement, intake, disease, water flow or changes over time.
- Sample mode uses prepared visual-context statements and existing database readings. It runs without a Meta key. No segmentation, visual condition or bird count is fabricated. The result is saved in this browser and publication to the backend is attempted. Failed publication is clearly labelled browser-only and does not claim an Overview update.
- SAM mode makes one non-streaming Meta Responses API request per registered image, using the concept chicken and META_SAM_MODEL (default sam-3.1). The documented segmentation token output is validated into bounding-box regions. No model-written medical text enters the advisory. A zero-match result is valid and does not prove birds are absent. The prototype stores candidate boxes, not decoded masks or tracking. A failure of either image prevents publishing the combined result; it never falls back silently to samples.
- Both modes use a closed set of environmental inspection templates, with recorded readings and provenance. The advisory contains observations, risk flags, inspection checks and contact-your-vet escalation. It generates no disease names, diagnoses, medicines, vaccine recommendations or treatment instructions.

## Use locally
1. Sign in as Das, open Das Farm > Photos, and find Farm advisory above the previous image-analysis panel.
2. Select an existing telemetry record. If the reading/rule/warning query fails, retry Refresh readings. No fabricated telemetry is used.
3. Choose Prepared sample and click Run sample advisory. Review the recorded values, observation provenance, checks and evidence limits.
4. If the service is not deployed, the result remains available here with a clear publication error. Browser history retains ten advisories per user/farm. Existing individual image-analysis history is unchanged and filters out paired advisory entries.
5. Once publishing is configured, the same action atomically saves analysis history and a dashboard alert. Navigate to Overview or Records to see the existing display pick up that alert.

## Server setup (not executed by this code change)
1. Apply foundation migrations in order, including `20261028000001_farm_image_analyses.sql`, then `20261029000001_das_farm_advisory.sql` in Supabase SQL Editor.
2. Use the same actual farm UUID for frontend VITE_DAS_FARM_ID and the server DAS_FARM_ID. Existing seeded Das-owner mapping remains available for local sample access.
3. In Supabase Edge Function Secrets, configure DAS_FARM_ID and VISION_SITE_ORIGIN. Hosted Supabase supplies its standard URL/anon/service-role credentials. Do not commit actual credentials.
4. Deploy `supabase functions deploy farm-advisory` after linking the project. Its _shared modules must be included. Keep authentication enabled. No new communication service is deployed.
5. Sample publication works without a Meta key. To enable actual segmentation, set META_API_KEY and optionally META_SAM_MODEL=sam-3.1. The old META_VISION_MODEL setting remains in use by individual image analysis, not this SAM endpoint.
6. Both image URLs must be reachable by Meta; a failed or inaccessible URL is an inference error, not a successful sample. Third-party thumbnail URLs may need replacement later.

## Storage and access
The server verifies the exact Das Farm ID and authenticated membership before retrieving telemetry, rules, warnings or invoking Meta. Client-supplied readings, model messages or image URLs are ignored. The hash of the selected record, values, applicable warning/rule IDs, configured model and registered feed revisions identifies completed evidence. Repeated evidence reuses the existing advisory without another SAM call or duplicate alert. Farm-wide request reservation limits are reused. Abandoned pending requests can recover after two minutes; active pending requests return a clear busy state.

The additive migration extends farm_image_analyses with advisory, advisory_key and alert_id. A server-only RPC writes the ordinary farm_alerts record and completes the analysis in one transaction. Acknowledgements and prior alerts are preserved. The payload includes demo provenance and the selected telemetry/image evidence. No original telemetry is updated. Failures leave a failed analysis; a timed-out client cannot change a completed analysis to failed.

## Verification and limits
Run `npm run build` to verify frontend compilation. In Das Farm > Photos, check sample advisory generation, missing-value labels, shared history, publication to dashboard alerts and reuse of repeated evidence. Database SQL, deployment, third-party image retrieval and live Meta access still need an integration check in your Supabase project. No claim of verified poultry model accuracy is made.

Official SAM request/response reference: https://dev.meta.ai/docs/sam/overview

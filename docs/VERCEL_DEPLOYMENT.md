# Deploy Kagua on Vercel

## What is configured in the repository
- Vite frontend, output directory dist, Node 22.x.
- Exact pnpm 10.33.0 installer with the existing frozen lockfile; dependency versions are unchanged.
- Vercel-specific build checks for public Supabase environment configuration before bundling.
- SPA fallback for extensionless frontend routes; assets/images remain actual static files.
- Ignored local env files, dependency caches and generated output for CLI uploads. Shared JavaScript in supabase/functions/_shared MUST remain in the repository: the browser imports pure helpers from it.

## Deploy the frontend
1. Commit the full feature changes to your branch, including new src/components, src/lib, supabase/functions/_shared, scripts, migrations, docs, tests and vercel.json. Committing only tracked edits will leave missing imports. Keep pnpm-lock.yaml.
2. Import the Git repository in Vercel. Set the Root Directory to the repository root, not src. Framework is Vite; vercel.json supplies the install command, build command and dist output directory. Do not override those with npm ci.
3. Add these variables in Vercel Project Settings > Environment Variables for each environment you intend to deploy:
   - VITE_SUPABASE_URL: your hosted Supabase HTTPS project URL.
   - VITE_SUPABASE_PUBLISHABLE_KEY: its publishable/anon key, never a service-role or server secret.
   - VITE_DAS_FARM_ID: actual Das Farm UUID, recommended for deployment. Leave blank only if intentionally using the existing seeded Das-account fallback.
4. Deploy. Missing/invalid frontend configuration will fail with variable names, without printing their values. Environment changes require a new deployment because Vite embeds public configuration at build time.
5. Sign in using an existing farm account. Check Overview, Photos, sample results and existing readings. Browser history created on localhost does not transfer to the new domain.

Existing populated .env.example settings were preserved in ignored .env.local (when that file did not already exist). The tracked .env.example is a blank configuration template. These files are not a substitute for Vercel project variables.

## Supabase remains a separate deployment
Vercel serves the website. It does not execute the Supabase migrations or deploy the Deno Edge Functions.

For shared history and publishing advisory alerts, apply these in order to the existing Supabase project (do not rerun the demo seeds to deploy the frontend):
1. Original foundation migration, if not already applied.
2. supabase/migrations/20261028000000_farm_image_analyses.sql.
3. supabase/migrations/20261029000000_das_farm_advisory.sql.

Configure Supabase function secrets DAS_FARM_ID (matching the frontend ID) and VISION_SITE_ORIGIN (the actual production origin, e.g. https://your-project.vercel.app; no trailing slash or path). Deploy analyse-farm-image and farm-advisory with their shared modules using your linked Supabase project. Do not disable server authentication/membership checks to work around a deployment failure.

The current backend intentionally allows one exact browser origin. Vercel preview domains or a new custom domain require the matching backend origin configuration, or a separate staging Supabase environment. A preview is not automatically authorized to use production functions. If you use Supabase auth redirect flows, configure the production site/allowed redirects in Supabase Authentication settings as well.

Sample visual outputs do not require a Meta key. Advisory sample mode still reads the existing Das Farm telemetry/rules/warnings. It can show a local result, but publishing to Overview requires the Supabase setup above. Missing readings will not be fabricated.

Later, set META_API_KEY in Supabase function secrets only. META_VISION_MODEL configures individual image understanding; META_SAM_MODEL (default sam-3.1) configures the advisory's two-image SAM processing. Existing third-party reference images must be reachable by the browser and by Meta. Never use a VITE_ variable for Meta credentials, messaging tokens or service-role credentials.

## Verification and unchanged behaviour
`npm test` covers both existing vision/advisory tests and deployment configuration checks. `npm run build:vercel` validates public configuration and builds the site. `npm run build` remains the original Vite build.

The sample-publication retry now uses a fresh transport request UUID; server-side evidence deduplication still prevents repeated advisories. Matching local history entries are merged on successful publication. Advisory wording, input readings, mode selection, alert ordering, tabs and communication logic are unchanged.

A newer informational alert can still occupy Overview's existing newest-alert card ahead of an older critical alert. This existing display rule was deliberately not altered. Advisory processing remains button-triggered; this deployment change adds no background jobs or messaging.

Real Vercel deployment, hosted SQL execution and live Meta requests still need verification with the respective accounts. A successful local build alone does not confirm those external steps.

References: https://vercel.com/docs/frameworks/frontend/vite and https://vercel.com/docs/package-managers

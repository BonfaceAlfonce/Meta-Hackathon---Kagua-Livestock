-- Outbreak Shield: run the check automatically every hour (Supabase Cron + pg_net).
--
-- No URL or secret is stored in this migration. The job reads two Vault secrets,
-- which each project sets once in the SQL Editor:
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'outbreak_shield_url');
--   select vault.create_secret('<same value as OUTBREAK_CRON_SECRET>', 'outbreak_cron_secret');
--
-- Until both secrets exist the job does nothing (the select returns no row).
-- Each run only calls Muse Spark for results that changed, so hourly runs stay cheap.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- cron.schedule with an existing job name replaces it, so re-running is safe.
-- Minute 7 avoids the top-of-the-hour rush.
select cron.schedule(
  'outbreak-shield-hourly',
  '7 * * * *',
  $job$
  select net.http_post(
    url := url.decrypted_secret || '/functions/v1/outbreak-shield',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret.decrypted_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  from vault.decrypted_secrets url, vault.decrypted_secrets secret
  where url.name = 'outbreak_shield_url'
    and secret.name = 'outbreak_cron_secret';
  $job$
);

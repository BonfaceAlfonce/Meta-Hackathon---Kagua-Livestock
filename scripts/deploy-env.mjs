
export function validateDeploymentEnv(env) {
  const errors = [];
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url) errors.push('Set VITE_SUPABASE_URL in Vercel project environment variables.');
  else {
    try { if (new URL(url).protocol !== 'https:') errors.push('VITE_SUPABASE_URL must be an HTTPS Supabase URL for deployment.'); }
    catch { errors.push('VITE_SUPABASE_URL is not a valid URL.'); }
  }
  if (!key) errors.push('Set VITE_SUPABASE_PUBLISHABLE_KEY in Vercel project environment variables.');
  else {
    let role;
    try { role = JSON.parse(Buffer.from(key.split('.')[1] || '', 'base64url').toString()).role; } catch { /* Publishable keys are not JWTs. */ }
    if (key.startsWith('sb_secret_') || role === 'service_role') errors.push('Use a publishable/anon key, never a server secret or service-role key, in VITE_SUPABASE_PUBLISHABLE_KEY.');
  }
  if (env.VITE_DAS_FARM_ID?.trim() && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.VITE_DAS_FARM_ID.trim())) errors.push('VITE_DAS_FARM_ID must be the actual farm UUID, or left empty for the existing seeded-account fallback.');
  return errors;
}

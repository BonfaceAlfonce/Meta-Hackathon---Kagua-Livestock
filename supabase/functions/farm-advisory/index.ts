import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createAdvisoryHandler } from '../_shared/advisory-handler.js';
const handle = createAdvisoryHandler({ env: name => Deno.env.get(name), createClient });
Deno.serve(async req => {
  try { return await handle(req); }
  catch { return new Response(JSON.stringify({ error: 'Advisory service is unavailable. No sample fallback was performed.' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': Deno.env.get('VISION_SITE_ORIGIN') || '', 'Cache-Control': 'no-store' } }); }
});

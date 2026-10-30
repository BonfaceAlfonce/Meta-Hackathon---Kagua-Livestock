import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import { createVisionHandler } from '../_shared/vision-handler.js';

const handle = createVisionHandler({ env: name => Deno.env.get(name), createClient });
Deno.serve(async request => {
  try { return await handle(request); }
  catch {
    return new Response(JSON.stringify({ error: 'The analysis service encountered an unexpected error. Please try later.' }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': Deno.env.get('VISION_SITE_ORIGIN') || '' }
    });
  }
});

import { advisoryFeeds, advisoryImageId, buildAdvisory, parseSamBoxes, telemetrySelect } from './advisory.js';
const validId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
export function createAdvisoryHandler({ env, createClient, fetchImpl = fetch }) {
  return async req => {
    const origin = env('VISION_SITE_ORIGIN') || '';
    const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return respond({ error: 'Use POST.' }, 405);
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return respond({ error: 'Website origin is not allowed.' }, 403);
    if (!req.headers.get('authorization')?.startsWith('Bearer ')) return respond({ error: 'Sign in to Das Farm.' }, 401);
    const farmId = env('DAS_FARM_ID');
    if (!validId(farmId) || !env('SUPABASE_URL') || !env('SUPABASE_ANON_KEY') || !env('SUPABASE_SERVICE_ROLE_KEY')) return respond({ error: 'Configure the advisory function and Das Farm ID in server secrets.' }, 503);
    const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: req.headers.get('authorization') } }, auth: { persistSession: false } });
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth?.user) return respond({ error: 'Your session has expired.' }, 401);
    let body;
    try { const raw = await req.text(); if (raw.length > 4096) return respond({ error: 'Request too large.' }, 413); body = JSON.parse(raw); }
    catch { return respond({ error: 'Invalid request.' }, 400); }
    if (body?.farm_id !== farmId) return respond({ error: 'Advisory is enabled for Das Farm only.' }, 403);
    const { data: membership, error: membershipError } = await client.from('farm_members').select('farm_id').eq('farm_id', farmId).eq('user_id', auth.user.id).maybeSingle();
    if (membershipError || !membership) return respond({ error: 'You do not have access to Das Farm.' }, 403);
    if (!validId(body.telemetry_event_id) || !validId(body.request_id) || !['sample','meta'].includes(body.mode)) return respond({ error: 'Select a telemetry record and analysis mode.' }, 400);
    if (body.mode === 'meta' && !env('META_API_KEY')) return respond({ error: 'SAM is awaiting the server-side Meta API key. Select sample mode explicitly for a prepared demonstration.' }, 503);
    const { data: row, error: readingError } = await client.from('telemetry_events').select(telemetrySelect).eq('farm_id', farmId).eq('id', body.telemetry_event_id).maybeSingle();
    if (readingError || !row?.zone_id) return respond({ error: 'No accessible zone-linked telemetry record was found. No readings will be invented.' }, 404);
    const [rulesResponse, alertsResponse] = await Promise.all([
      client.from('alert_rules').select('id,farm_id,zone_id,metric_key,operator,threshold,severity,enabled').eq('farm_id', farmId).eq('enabled', true),
      client.from('farm_alerts').select('id,farm_id,zone_id,telemetry_event_id,alert_type,severity,resolved_at').eq('farm_id', farmId).eq('telemetry_event_id', row.id).neq('alert_type', 'farm_advisory')
    ]);
    if (rulesResponse.error || alertsResponse.error) return respond({ error: 'Could not read existing rules or warnings. Advisory was not generated.' }, 503);
    const rules = rulesResponse.data || [], alerts = alertsResponse.data || [];
    const base = buildAdvisory(row, rules, alerts);
    const model = body.mode === 'meta' ? env('META_SAM_MODEL') || 'sam-3.1' : null;
    const signature = JSON.stringify({ version: base.version, event: row.id, zone_id: row.zone_id, device_id: row.device_id, captured_at: row.captured_at, evidence: base.evidence, feeds: advisoryFeeds, mode: body.mode, model });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature));
    const key = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2,'0')).join('');
    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const { data: cached, error: cacheError } = await admin.from('farm_image_analyses').select('*').eq('farm_id', farmId).eq('advisory_key', key).maybeSingle();
    if (cacheError) return respond({ error: 'Apply the advisory database migration before publishing.' }, 503);
    if (cached?.status === 'complete') return respond({ record: cached, reused: true });
    if (cached) {
      // Recover abandoned reservations after the maximum two-frame processing window.
      const abandoned = cached.status === 'pending' && Date.now() - new Date(cached.created_at).getTime() > 120000;
      if (!abandoned) return respond({ error: 'This evidence is already being processed. Load advisory history shortly.' }, 409);
      const { error: recoveryError } = await admin.from('farm_image_analyses').update({ status: 'failed', advisory_key: null }).eq('id', cached.id).eq('status', 'pending');
      if (recoveryError) return respond({ error: 'Could not recover the previous request. Please try later.' }, 503);
    }
    const { error: reservationError } = await admin.rpc('reserve_farm_image_analysis', { p_id: body.request_id, p_farm_id: farmId, p_user_id: auth.user.id, p_image_id: advisoryImageId, p_image_title: 'Das Farm · two-image advisory', p_image_path: advisoryFeeds[0].url, p_revision: 1, p_mode: body.mode, p_model: model });
    if (reservationError) return respond({ error: 'Request is already reserved or the farm request limit was reached. Load history before retrying.' }, 429);
    const { error: keyError } = await admin.from('farm_image_analyses').update({ advisory_key: key }).eq('id', body.request_id);
    if (keyError) {
      await admin.from('farm_image_analyses').update({ status: 'failed' }).eq('id', body.request_id);
      return respond({ error: 'The same evidence is already reserved. Load history before retrying.' }, 409);
    }
    try {
      const visual = [];
      for (const image of advisoryFeeds) {
        if (body.mode === 'sample') { visual.push({ image_id: image.id, source: 'prepared', boxes: [] }); continue; }
        const response = await fetchImpl('https://api.meta.ai/v1/responses', {
          method: 'POST', headers: { Authorization: `Bearer ${env('META_API_KEY')}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
          body: JSON.stringify({ model, stream: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'chicken' }, { type: 'input_image', image_url: image.url }] }] })
        });
        if (!response.ok) throw new Error([401,403].includes(response.status) ? 'Meta rejected SAM access or the API key.' : 'SAM could not process both feed images. No combined advisory was published.');
        visual.push({ image_id: image.id, source: 'sam', boxes: parseSamBoxes(await response.json()) });
      }
      const advisory = buildAdvisory(row, rules, alerts, visual);
      const { data: published, error: publishError } = await admin.rpc('publish_farm_advisory', { p_analysis_id: body.request_id, p_advisory: advisory });
      if (publishError || !published) throw new Error('The advisory could not be published. Load history before retrying.');
      return respond({ record: published });
    } catch (error) {
      await admin.from('farm_image_analyses').update({ status: 'failed', advisory_key: null }).eq('id', body.request_id).eq('status', 'pending');
      return respond({ error: error?.name === 'TimeoutError' ? 'SAM timed out. No combined advisory was published.' : error.message || 'Advisory processing failed.' }, 502);
    }
  };
}

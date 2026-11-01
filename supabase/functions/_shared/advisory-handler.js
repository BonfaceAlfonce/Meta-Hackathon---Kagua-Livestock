import {
  ADVISORY_MODE,
  DEFAULT_SAM_MODEL,
  DEFAULT_VISION_MODEL,
  MAX_PHOTO_BYTES,
  SIGNED_URL_TTL_SECONDS,
  VISION_SCHEMA,
  advisoryImageRef,
  buildAdvisory,
  buildVisionMessages,
  evaluateEvidence,
  parseSamBoxes,
  snapshotSelect,
  telemetrySelect,
  validateVisionAnalysis,
} from './advisory.js';

const validId = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');

export function createAdvisoryHandler({ env, createClient, fetchImpl = fetch }) {
  return async req => {
    const origin = env('VISION_SITE_ORIGIN') || '';
    const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return respond({ error: 'Use POST.' }, 405);
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return respond({ error: 'Website origin is not allowed. Set VISION_SITE_ORIGIN to this app origin.' }, 403);
    if (!req.headers.get('authorization')?.startsWith('Bearer ')) return respond({ error: 'Sign in to your farm.' }, 401);
    if (!env('SUPABASE_URL') || !env('SUPABASE_ANON_KEY') || !env('SUPABASE_SERVICE_ROLE_KEY')) return respond({ error: 'Configure the advisory function server credentials.' }, 503);
    const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: req.headers.get('authorization') } }, auth: { persistSession: false } });
    const { data: auth, error: authError } = await client.auth.getUser();
    if (authError || !auth?.user) return respond({ error: 'Your session has expired.' }, 401);
    let body;
    try { const raw = await req.text(); if (raw.length > 4096) return respond({ error: 'Request too large.' }, 413); body = JSON.parse(raw); }
    catch { return respond({ error: 'Invalid request.' }, 400); }
    const farmId = body?.farm_id;
    if (typeof farmId !== 'string' || !validId(farmId)) return respond({ error: 'Select a valid farm.' }, 400);
    const { data: membership, error: membershipError } = await client.from('farm_members').select('farm_id').eq('farm_id', farmId).eq('user_id', auth.user.id).maybeSingle();
    if (membershipError || !membership) return respond({ error: 'You do not have access to this farm.' }, 403);
    if (!validId(body.telemetry_event_id) || !validId(body.request_id)) return respond({ error: 'Select a telemetry record to advise on.' }, 400);
    const apiKey = env('META_API_KEY') || '';
    if (!apiKey) return respond({ error: 'Farm Advisory is awaiting the server-side Meta API key. Ask your administrator to set META_API_KEY.' }, 503);
    const visionModel = env('META_VISION_MODEL') || DEFAULT_VISION_MODEL;
    const samModel = env('META_SAM_MODEL') || DEFAULT_SAM_MODEL;
    const { data: row, error: readingError } = await client.from('telemetry_events').select(telemetrySelect).eq('farm_id', farmId).eq('id', body.telemetry_event_id).maybeSingle();
    if (readingError || !row?.zone_id) return respond({ error: 'No accessible zone-linked telemetry record was found. No readings will be invented.' }, 404);
    const [rulesResponse, alertsResponse, zoneResponse] = await Promise.all([
      client.from('alert_rules').select('id,farm_id,zone_id,metric_key,operator,threshold,severity,enabled').eq('farm_id', farmId).eq('enabled', true),
      client.from('farm_alerts').select('id,farm_id,zone_id,telemetry_event_id,alert_type,severity,resolved_at').eq('farm_id', farmId).eq('telemetry_event_id', row.id).neq('alert_type', 'farm_advisory'),
      client.from('farm_zones').select('id,name').eq('farm_id', farmId).eq('id', row.zone_id).maybeSingle(),
    ]);
    if (rulesResponse.error || alertsResponse.error || zoneResponse.error) return respond({ error: 'Could not read existing rules, warnings or zones. Advisory was not generated.' }, 503);
    const rules = rulesResponse.data || [], alerts = alertsResponse.data || [];
    const zoneName = zoneResponse.data?.name || 'Farm zone';

    // The farm's own photo for this record: first the snapshot linked to the
    // telemetry event, otherwise the latest snapshot in the same zone.
    let snapshot = null, photoProblem = '';
    try {
      const { data: linked, error: linkedError } = await client.from('camera_snapshots').select(snapshotSelect).eq('farm_id', farmId).eq('telemetry_event_id', row.id).order('captured_at', { ascending: false }).limit(1);
      if (linkedError) throw new Error(linkedError.message);
      snapshot = linked?.[0] || null;
      if (!snapshot) {
        const { data: zonal, error: zonalError } = await client.from('camera_snapshots').select(snapshotSelect).eq('farm_id', farmId).eq('zone_id', row.zone_id).order('captured_at', { ascending: false }).limit(1);
        if (zonalError) throw new Error(zonalError.message);
        snapshot = zonal?.[0] || null;
      }
    } catch {
      return respond({ error: 'Could not read the farm photo for this record. Advisory was not generated.' }, 503);
    }
    if (snapshot && (snapshot.file_size_bytes || 0) > MAX_PHOTO_BYTES) {
      photoProblem = 'The linked photo is larger than 8 MB, so the models could not read it.';
      snapshot = null;
    }

    const evidence = evaluateEvidence(row, rules, alerts);
    const imageRef = advisoryImageRef(snapshot, row);
    const signature = JSON.stringify({ version: 2, event: row.id, snapshot: snapshot?.id || null, captured_at: row.captured_at, evidence, visionModel, samModel });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature));
    const key = Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const { data: cached, error: cacheError } = await admin.from('farm_image_analyses').select('*').eq('farm_id', farmId).eq('advisory_key', key).maybeSingle();
    if (cacheError) return respond({ error: 'Apply the advisory database migration before running advisories.' }, 503);
    if (cached?.status === 'complete') return respond({ record: cached, reused: true });
    if (cached) {
      const abandoned = cached.status === 'pending' && Date.now() - new Date(cached.created_at).getTime() > 120000;
      if (!abandoned) return respond({ error: 'This evidence is already being processed. Load advisory history shortly.' }, 409);
      const { error: recoveryError } = await admin.from('farm_image_analyses').update({ status: 'failed', advisory_key: null }).eq('id', cached.id).eq('status', 'pending');
      if (recoveryError) return respond({ error: 'Could not recover the previous request. Please try later.' }, 503);
    }
    const { error: reservationError } = await admin.rpc('reserve_farm_image_analysis', { p_id: body.request_id, p_farm_id: farmId, p_user_id: auth.user.id, p_image_id: imageRef.image_id, p_image_title: imageRef.image_title, p_image_path: imageRef.image_path, p_revision: imageRef.revision, p_mode: ADVISORY_MODE, p_model: `${samModel}+${visionModel}` });
    if (reservationError) return respond({ error: 'Request is already reserved or the farm request limit was reached. Load history before retrying.' }, 429);
    const { error: keyError } = await admin.from('farm_image_analyses').update({ advisory_key: key }).eq('id', body.request_id);
    if (keyError) {
      await admin.from('farm_image_analyses').update({ status: 'failed' }).eq('id', body.request_id);
      return respond({ error: 'The same evidence is already reserved. Load history before retrying.' }, 409);
    }

    const fail = async message => {
      await admin.from('farm_image_analyses').update({ status: 'failed', advisory_key: null }).eq('id', body.request_id).eq('status', 'pending');
      return respond({ error: message }, 502);
    };
    try {
      const stages = {};
      const visual = [];
      let vision = null, samCount = null, imageUrl = '';
      if (snapshot) {
        const { data: signed, error: signError } = await admin.storage.from(snapshot.storage_bucket || 'farm-media').createSignedUrl(snapshot.storage_path, SIGNED_URL_TTL_SECONDS);
        if (signError || !signed?.signedUrl) {
          stages.sam = 'the photo link could not be opened';
          stages.vision = 'the photo link could not be opened';
        } else {
          imageUrl = signed.signedUrl;
        }
      } else {
        stages.sam = photoProblem ? 'skipped: photo too large' : 'skipped: no photo linked to this record';
        stages.vision = photoProblem ? 'skipped: photo too large' : 'skipped: no photo linked to this record';
      }
      if (imageUrl) {
        try {
          const response = await fetchImpl('https://api.meta.ai/v1/responses', {
            method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
            body: JSON.stringify({ model: samModel, stream: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'chicken' }, { type: 'input_image', image_url: imageUrl }] }] }),
          });
          if (!response.ok) throw new Error([401, 403].includes(response.status) ? 'Meta rejected SAM access or the API key.' : 'SAM could not process the farm photo.');
          const boxes = parseSamBoxes(await response.json());
          visual.push({ image_id: imageRef.image_id, source: 'sam', boxes });
          samCount = boxes.length;
          stages.sam = 'ok';
        } catch (error) {
          visual.push({ image_id: imageRef.image_id, source: 'unavailable' });
          stages.sam = error?.name === 'TimeoutError' ? 'timed out after 45 seconds' : (error.message || 'SAM request failed');
        }
        try {
          const response = await fetchImpl('https://api.meta.ai/v1/chat/completions', {
            method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
            body: JSON.stringify({
              model: visionModel,
              max_completion_tokens: 2500,
              reasoning_effort: 'low',
              response_format: { type: 'json_schema', json_schema: { name: 'flock_advisory', schema: VISION_SCHEMA, strict: true } },
              messages: buildVisionMessages({ zoneName, values: evidence.values, samRegions: samCount, farmerNote: row.animal_observation, imageUrl }),
            }),
          });
          if (!response.ok) {
            if ([401, 403].includes(response.status)) throw new Error('Meta rejected the key or vision model access.');
            if (response.status === 429) throw new Error('Meta is rate-limiting requests right now.');
            throw new Error('The vision model could not read the farm photo.');
          }
          const payload = await response.json();
          const choice = payload?.choices?.[0];
          const content = choice?.message?.content;
          if (!choice || !content) throw new Error('The vision model returned no content.');
          if (choice.finish_reason && choice.finish_reason !== 'stop') throw new Error(`The vision model stopped early (${choice.finish_reason}).`);
          const text = (Array.isArray(content) ? content.map(part => part?.text || '').join(' ') : String(content)).trim();
          let parsed;
          try { parsed = JSON.parse(text); } catch { throw new Error('The vision model returned an unreadable result.'); }
          vision = validateVisionAnalysis(parsed);
          stages.vision = 'ok';
        } catch (error) {
          stages.vision = error?.name === 'TimeoutError' ? 'timed out after 60 seconds' : (error.message || 'vision request failed');
        }
      }
      const advisory = buildAdvisory({ row, zoneName, rules, alerts, snapshot, visual, vision, stages });
      const { data: published, error: publishError } = await admin.rpc('publish_farm_advisory', { p_analysis_id: body.request_id, p_advisory: advisory });
      if (publishError || !published) throw new Error('The advisory could not be published. Load history before retrying.');
      return respond({ record: published });
    } catch (error) {
      return await fail(error.message || 'Advisory processing failed.');
    }
  };
}

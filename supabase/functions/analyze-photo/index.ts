// Kagua Livestock: "analyze-photo" Edge Function (draft for review).
//
// The Fill-out-data form calls this BEFORE anything is saved. It sends the
// farmer's photo plus the readings typed on the form, and this function asks
// the configured Meta model (default SAM-3.1) to look at the photo together
// with those readings and draft a short analysis. The farmer reviews and edits
// the draft in the app; only the reviewed text is stored, on
// camera_snapshots.ai_summary, when the farmer submits the form.
//
// Deploy:  supabase functions deploy analyze-photo
// Secrets: supabase secrets set AI_API_URL="https://..." AI_API_KEY="..." AI_MODEL="SAM-3.1"
//   AI_API_URL  Chat-completions-compatible endpoint that serves the model
//               (request shape below matches the OpenAI-compatible format used
//               by most hosted inference providers).
//   AI_API_KEY  Provider API key.
//   AI_MODEL    Model id, e.g. SAM-3.1 (default).
//
// NOTE: SAM-family models segment images; this function expects the endpoint
// to return analysis TEXT. If your SAM deployment returns masks only, point
// AI_API_URL at a vision-language endpoint (or add a captioning step there)
// and keep AI_MODEL as the id it serves.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'POST only.' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
    const authHeader = req.headers.get('Authorization') || '';
    if (!supabaseUrl || !anonKey || !authHeader) return json({ error: 'Not authenticated.' }, 401);

    const sb = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await sb.auth.getUser();
    if (userError || !user) return json({ error: 'Not authenticated.' }, 401);

    const body = await req.json().catch(() => ({}));
    const farmId = String(body?.farmId || '');
    const imageBase64 = String(body?.imageBase64 || '');
    if (!farmId || !imageBase64) return json({ error: 'farmId and imageBase64 are required.' }, 400);

    const { data: membership } = await sb
      .from('farm_members')
      .select('role')
      .eq('farm_id', farmId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!membership) return json({ error: 'You are not a member of this farm.' }, 403);

    const apiUrl = Deno.env.get('AI_API_URL') || '';
    const apiKey = Deno.env.get('AI_API_KEY') || '';
    const model = Deno.env.get('AI_MODEL') || 'SAM-3.1';
    if (!apiUrl || !apiKey) return json({ error: 'Photo analysis is not configured yet.' }, 503);

    const readings = body?.readings && typeof body.readings === 'object' ? body.readings : {};
    const zoneName = String(body?.zoneName || 'Farm level');
    const contentType = String(body?.contentType || 'image/jpeg');
    const lines: string[] = [];
    const add = (label: string, value: unknown, unit: string) => {
      if (value !== null && value !== undefined && value !== '') lines.push(`${label}: ${value}${unit}`);
    };
    add('Temperature', readings.temperature_c, ' °C');
    add('Humidity', readings.humidity_pct, ' %');
    add('Ammonia', readings.ammonia_ppm, ' ppm');
    add('CO2', readings.co2_ppm, ' ppm');
    if (readings.observation) lines.push(`Farmer note: ${readings.observation}`);
    if (readings.isNight) lines.push('Taken at night.');
    const readingBlock = lines.length ? lines.join('\n') : 'No sensor readings were entered with this photo.';

    const system =
      'You are a livestock farm assistant. Look at the farm photo and connect what you SEE ' +
      '(animals, housing, bedding, feed, water, crowding, visible health signs) with the sensor ' +
      'readings provided. Write for a farmer in plain language.';
    const prompt =
      `Zone: ${zoneName}\n${readingBlock}\n\n` +
      'Reply with ONE JSON object only, no other text:\n' +
      '{"summary": "2-4 sentences: what the photo shows, how it connects with the readings, and any concern.", ' +
      '"suggested_title": "short alert title or empty string", ' +
      '"severity": "info, warning or critical"}';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);
    let apiRes: Response;
    try {
      apiRes = await fetch(apiUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 700,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${contentType};base64,${imageBase64}` } },
              ],
            },
          ],
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!apiRes.ok) {
      const detail = await apiRes.text().catch(() => '');
      return json({ error: `Analysis service error (${apiRes.status}). ${detail.slice(0, 200)}` }, 502);
    }
    const payload = await apiRes.json().catch(() => ({}));
    const content = payload?.choices?.[0]?.message?.content;
    const text = (
      Array.isArray(content) ? content.map(part => part?.text || '').join(' ') : String(content || '')
    ).trim();
    if (!text) return json({ error: 'The analysis service returned no summary.' }, 502);

    let summary = text;
    let suggestedTitle = '';
    let suggestedSeverity = '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) {
          summary = parsed.summary.trim();
          suggestedTitle = String(parsed.suggested_title || '').slice(0, 120);
          const sev = String(parsed.severity || '').toLowerCase();
          suggestedSeverity = ['info', 'warning', 'critical'].includes(sev) ? sev : '';
        }
      } catch {
        // Not JSON: keep the whole reply as the summary.
      }
    }
    return json({ summary: summary.slice(0, 2000), suggestedTitle, suggestedSeverity, model });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed.';
    return json({ error: /abort/i.test(message) ? 'Analysis timed out. Try again.' : message }, 500);
  }
});

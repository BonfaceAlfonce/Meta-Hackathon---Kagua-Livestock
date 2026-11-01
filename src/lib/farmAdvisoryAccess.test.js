import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdvisoryHandler } from '../../supabase/functions/_shared/advisory-handler.js';

const farmA = '10000000-0000-4000-8000-000000000001';
const farmB = '10000000-0000-4000-8000-000000000002';
const user = '20000000-0000-4000-8000-000000000001';
const readingId = '30000000-0000-4000-8000-000000000001';
const requestId = '40000000-0000-4000-8000-000000000001';
const origin = 'https://farm.example';

const samPayload = { status: 'completed', output_text: '<0f>0<|box;x1=1;y1=2;x2=5;y2=6;w=10;h=10|>' };
const visionResult = {
  distribution: { total_visible: 12, at_feeders: 5, in_brooders: 0, free_roam: 7 },
  behavior_flags: ['evenly_spread'],
  observations: ['Birds are spread across the feeder line and open ground.'],
  concerns: [],
  next_checks: ['Recheck the feeder line at the next round.'],
  limitations: ['A still photo cannot show movement over time.'],
  verdict: 'normal',
  verdict_reason: 'Birds look evenly spread and the readings sit near the usual range.',
};
const visionPayload = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(visionResult) } }] };

function setup({ memberships = [farmA, farmB], readingFarm = farmB, existing = [], meta = false, snapshots = null, samFails = false, visionContent = null } = {}) {
  const analyses = [...existing];
  const calls = { admin: 0, reservations: [], publications: [], provider: [] };
  const tables = {
    farm_members: memberships.map(farm_id => ({ farm_id, user_id: user })),
    telemetry_events: [{ id: readingId, farm_id: readingFarm, zone_id: 'zone-1', device_id: null, captured_at: '2026-11-01T10:00:00Z', temperature_c: 31.5, humidity_pct: 64, ammonia_ppm: 12, measurements: { co2_ppm: 900 }, raw_payload: { source: 'manual-form' }, animal_observation: 'Birds active' }],
    farm_zones: [{ id: 'zone-1', farm_id: readingFarm, name: 'Brooder A' }],
    camera_snapshots: snapshots ?? [{ id: '50000000-0000-4000-8000-000000000001', farm_id: readingFarm, zone_id: 'zone-1', telemetry_event_id: readingId, captured_at: '2026-11-01T10:00:00Z', storage_bucket: 'farm-media', storage_path: 'farm/manual/x.jpg', file_size_bytes: 500000 }],
    alert_rules: [], farm_alerts: [], farm_image_analyses: analyses,
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.sort = null; this.max = null; }
    select() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    neq(key, value) { this.filters.push(row => row[key] !== value); return this; }
    order(key, { ascending }) { this.sort = { key, ascending }; return this; }
    limit(n) { this.max = n; return this; }
    update(values) { this.values = values; return this; }
    result(single = false) {
      let rows = tables[this.table].filter(row => this.filters.every(filter => filter(row)));
      if (this.sort) rows = [...rows].sort((a, b) => String(a[this.sort.key]).localeCompare(String(b[this.sort.key])) * (this.sort.ascending ? 1 : -1));
      if (this.max !== null) rows = rows.slice(0, this.max);
      if (this.values) rows.forEach(row => Object.assign(row, this.values));
      return { data: single ? rows[0] || null : rows, error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    single() { return Promise.resolve(this.result(true)); }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
  }
  const env = name => ({
    SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'public', SUPABASE_SERVICE_ROLE_KEY: 'server',
    VISION_SITE_ORIGIN: origin,
    ...(meta ? { META_API_KEY: 'test-only' } : {}),
  })[name];
  const createClient = (_url, key) => {
    if (key === 'server') calls.admin++;
    return {
      auth: { getUser: async () => ({ data: { user: { id: user } }, error: null }) },
      from: table => new Query(table),
      storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/photo.jpg' }, error: null }) }) },
      async rpc(name, args) {
        if (name === 'reserve_farm_image_analysis') {
          calls.reservations.push(args);
          analyses.push({ id: args.p_id, farm_id: args.p_farm_id, created_by: args.p_user_id, image_id: args.p_image_id, mode: args.p_mode, status: 'pending' });
          return { data: null, error: null };
        }
        assert.equal(name, 'publish_farm_advisory');
        calls.publications.push(args.p_advisory);
        const analysis = analyses.find(row => row.id === args.p_analysis_id);
        Object.assign(analysis, { advisory: args.p_advisory, result: args.p_advisory.result, status: 'complete' });
        return { data: analysis, error: null };
      },
    };
  };
  const handler = createAdvisoryHandler({ env, createClient, fetchImpl: async (url) => {
    calls.provider.push(url);
    if (String(url).includes('/responses')) {
      return samFails ? new Response('sam down', { status: 500 }) : new Response(JSON.stringify(samPayload));
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: visionContent ?? JSON.stringify(visionResult) } }] }));
  } });
  const request = (body = {}, signedIn = true) => handler(new Request(origin, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(signedIn ? { Authorization: 'Bearer [REDACTED]' } : {}) },
    body: JSON.stringify({ farm_id: farmB, telemetry_event_id: readingId, request_id: requestId, ...body }),
  }));
  return { calls, request, analyses };
}

test('advisory accepts both member farms and publishes a real-data advisory', async () => {
  for (const farm_id of [farmA, farmB]) {
    const { request, calls } = setup({ readingFarm: farm_id, meta: true });
    const response = await request({ farm_id });
    assert.equal(response.status, 200);
    const record = (await response.json()).record;
    assert.equal(record.farm_id, farm_id);
    assert.equal(calls.reservations[0].p_farm_id, farm_id);
    assert.deepEqual(calls.provider, ['https://api.meta.ai/v1/responses', 'https://api.meta.ai/v1/chat/completions']);
    const advisory = calls.publications[0];
    assert.equal(advisory.farm_id, farm_id);
    assert.equal(advisory.evidence.values.co2_ppm, 900);
    assert.match(advisory.title, /Brooder A/);
    assert.doesNotMatch(`${advisory.title} ${advisory.message}`, /demo|sample|simulated|prepared|ground moisture/i);
  }
});

test('advisory rejects a farm the signed-in user does not belong to before privileged work', async () => {
  const { request, calls } = setup({ memberships: [farmA], meta: true });
  assert.equal((await request()).status, 403);
  assert.equal(calls.admin, 0);
  assert.equal(calls.reservations.length, 0);
  assert.equal(calls.provider.length, 0);
});

test('advisory rejects invalid farm IDs and unsigned requests', async () => {
  const { request, calls } = setup({ meta: true });
  for (const farm_id of [null, '', 'Das Farm', [], {}]) assert.equal((await request({ farm_id })).status, 400);
  assert.equal((await request({}, false)).status, 401);
  assert.equal(calls.admin, 0);
});

test('advisory stays unavailable without a Meta key instead of substituting findings', async () => {
  const { request, calls } = setup();
  const response = await request();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /META_API_KEY/);
  assert.equal(calls.reservations.length, 0);
  assert.equal(calls.provider.length, 0);
});

test('advisory rejects telemetry from another farm even when the user belongs to both', async () => {
  const { request, calls } = setup({ readingFarm: farmA, meta: true });
  assert.equal((await request({ farm_id: farmB })).status, 404);
  assert.equal(calls.reservations.length, 0);
});

test('advisory cache lookup never returns another farm history entry', async () => {
  const first = setup({ meta: true });
  assert.equal((await first.request()).status, 200);
  const otherFarmEntry = { ...first.analyses[0], id: 'other', farm_id: farmA };
  // Deliberately use the exact same evidence hash, so the farm filter is essential.
  assert.ok(otherFarmEntry.advisory_key);
  const { request, calls } = setup({ meta: true, existing: [otherFarmEntry] });
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).record.farm_id, farmB);
  assert.equal(calls.publications.length, 1);
});

test('advisory without a linked photo still publishes a labelled readings-only result', async () => {
  const { request, calls } = setup({ meta: true, snapshots: [] });
  const response = await request();
  assert.equal(response.status, 200);
  const advisory = calls.publications[0];
  assert.equal(advisory.generated, false);
  assert.equal(advisory.snapshot, null);
  assert.equal(calls.provider.length, 0);
  assert.ok(advisory.result.limitations.some(line => /no photo/i.test(line)));
});

test('SAM failure degrades to vision-only instead of failing the advisory', async () => {
  const { request, calls } = setup({ meta: true, samFails: true });
  const response = await request();
  assert.equal(response.status, 200);
  const advisory = calls.publications[0];
  assert.equal(advisory.generated, true);
  assert.match(advisory.stages.sam, /could not process/);
  assert.equal(advisory.stages.vision, 'ok');
});

test('vision output with forbidden wording falls back to the readings template', async () => {
  const bad = JSON.stringify({ ...visionResult, concerns: ['Possible coccidiosis, consider antibiotics.'] });
  const { request, calls } = setup({ meta: true, visionContent: bad });
  const response = await request();
  assert.equal(response.status, 200);
  const advisory = calls.publications[0];
  assert.equal(advisory.generated, false);
  assert.match(advisory.stages.vision, /forbidden/);
  assert.doesNotMatch(`${advisory.title} ${advisory.message}`, /coccidiosis|antibiotics/i);
});

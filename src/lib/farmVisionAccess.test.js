import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisionHandler } from '../../supabase/functions/_shared/vision-handler.js';
import { createAdvisoryHandler } from '../../supabase/functions/_shared/advisory-handler.js';
import { advisoryImageId } from '../../supabase/functions/_shared/advisory.js';

const farmA = '10000000-0000-4000-8000-000000000001';
const farmB = '10000000-0000-4000-8000-000000000002';
const user = '20000000-0000-4000-8000-000000000001';
const readingId = '30000000-0000-4000-8000-000000000001';
const requestId = '40000000-0000-4000-8000-000000000001';
const origin = 'https://farm.example';

function setup(handlerFactory, { memberships = [farmA, farmB], readingFarm = farmB, existing = [], meta = false } = {}) {
  const analyses = [...existing];
  const calls = { admin: 0, reservations: [], publications: [], provider: [] };
  const tables = {
    farm_members: memberships.map(farm_id => ({ farm_id, user_id: user })),
    telemetry_events: [{ id: readingId, farm_id: readingFarm, zone_id: 'zone-1', device_id: null, captured_at: '2026-11-01T10:00:00Z', temperature_c: 28, humidity_pct: 80, ammonia_ppm: 12, measurements: { ground_moisture_pct: 40 } }],
    alert_rules: [], farm_alerts: [], farm_image_analyses: analyses,
  };
  class Query {
    constructor(table) { this.table = table; this.filters = []; }
    select() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    neq(key, value) { this.filters.push(row => row[key] !== value); return this; }
    update(values) { this.values = values; return this; }
    result(single = false) {
      const rows = tables[this.table].filter(row => this.filters.every(filter => filter(row)));
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
    // An old deployed setting must no longer restrict access to another member farm.
    DAS_FARM_ID: farmA,
    ...(meta ? { META_API_KEY: 'test-only', META_VISION_MODEL: 'test-model' } : {}),
  })[name];
  const createClient = (_url, key) => {
    if (key === 'server') calls.admin++;
    return {
      auth: { getUser: async () => ({ data: { user: { id: user } }, error: null }) },
      from: table => new Query(table),
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
  const handler = handlerFactory({ env, createClient, fetchImpl: async (url) => {
    calls.provider.push(url);
    return new Response(JSON.stringify({ status: 'completed', output_text: '' }));
  } });
  const request = (body = {}, signedIn = true) => handler(new Request(origin, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(signedIn ? { Authorization: 'Bearer user-token' } : {}) },
    body: JSON.stringify({ farm_id: farmB, image_id: 'das-chicks', telemetry_event_id: readingId, mode: 'sample', request_id: requestId, ...body }),
  }));
  return { calls, request, analyses };
}

for (const [label, factory] of [['image analysis', createVisionHandler], ['advisory', createAdvisoryHandler]]) {
  test(`${label} accepts both member farms without a configured farm allowlist`, async () => {
    for (const farm_id of [farmA, farmB]) {
      const { request, calls } = setup(factory, { readingFarm: farm_id });
      const response = await request({ farm_id });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).record.farm_id, farm_id);
      assert.equal(calls.reservations[0].p_farm_id, farm_id);
      assert.equal(calls.provider.length, 0);
      if (label === 'advisory') assert.equal(calls.publications[0].farm_id, farm_id);
    }
  });
  test(`${label} rejects a farm the signed-in user does not belong to before privileged work`, async () => {
    const { request, calls } = setup(factory, { memberships: [farmA] });
    assert.equal((await request()).status, 403);
    assert.equal(calls.admin, 0);
    assert.equal(calls.reservations.length, 0);
    assert.equal(calls.provider.length, 0);
  });
  test(`${label} rejects invalid farm IDs and unsigned requests`, async () => {
    const { request, calls } = setup(factory);
    for (const farm_id of [null, '', 'Das Farm', [], {}]) assert.equal((await request({ farm_id })).status, 400);
    assert.equal((await request({}, false)).status, 401);
    assert.equal(calls.admin, 0);
  });
  test(`${label} keeps actual mode unavailable without a key instead of substituting samples`, async () => {
    const { request, calls } = setup(factory);
    assert.equal((await request({ mode: 'meta' })).status, 503);
    assert.equal(calls.reservations.length, 0);
    assert.equal(calls.provider.length, 0);
  });
}

test('advisory rejects telemetry from another farm even when the user belongs to both', async () => {
  const { request, calls } = setup(createAdvisoryHandler, { readingFarm: farmA });
  assert.equal((await request({ farm_id: farmB })).status, 404);
  assert.equal(calls.reservations.length, 0);
});
test('advisory cache lookup never returns another farm history entry', async () => {
  const first = setup(createAdvisoryHandler);
  assert.equal((await first.request()).status, 200);
  const otherFarmEntry = { ...first.analyses[0], id: 'other', farm_id: farmA, image_id: advisoryImageId };
  // Deliberately use the exact same evidence hash, so the farm filter is essential.
  assert.ok(otherFarmEntry.advisory_key);
  const { request, calls } = setup(createAdvisoryHandler, { existing: [otherFarmEntry] });
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).record.farm_id, farmB);
  assert.equal(calls.publications.length, 1);
});
test('image request IDs belonging to another farm cannot expose or overwrite its history', async () => {
  const other = { id: requestId, farm_id: farmA, created_by: user, image_id: 'das-chicks', mode: 'sample', status: 'complete' };
  const { request, calls, analyses } = setup(createVisionHandler, { existing: [other] });
  assert.equal((await request()).status, 409);
  assert.equal(calls.reservations.length, 0);
  assert.deepEqual(analyses, [other]);
});
test('SAM path remains available to a member of another farm and processes the registered pair', async () => {
  const { request, calls } = setup(createAdvisoryHandler, { meta: true });
  const response = await request({ mode: 'meta' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).record.farm_id, farmB);
  assert.deepEqual(calls.provider, ['https://api.meta.ai/v1/responses', 'https://api.meta.ai/v1/responses']);
  assert.equal(calls.publications[0].farm_id, farmB);
});

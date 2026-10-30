import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogue, resolveDasFarmId, sampleRecord, validateResult } from '../supabase/functions/_shared/vision.js';
import { createVisionHandler } from '../supabase/functions/_shared/vision-handler.js';
import { existsSync } from 'node:fs';

const farm = '11111111-1111-4111-8111-111111111111';
const user = '6f43ca55-ce1b-46b1-be32-f55c117bc3be';
const requestId = '22222222-2222-4222-8222-222222222222';
const time = '2026-10-28T10:00:00Z';
function setup(options = {}) {
  const calls = { fetch: [], reservations: 0, updates: [] };
  const config = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', DAS_FARM_ID: farm, VISION_SITE_ORIGIN: 'https://farm.example', META_API_KEY: 'server-secret', META_VISION_MODEL: 'vision-model', ...options.env };
  let saved = options.existing || null;
  function createClient(url, key) {
    return {
      auth: { getUser: async () => ({ data: { user: options.noUser ? null : { id: user } }, error: null }) },
      from(table) {
        let action = 'select', patch;
        const query = {
          select() { return this; }, eq() { return this; },
          update(value) { action = 'update'; patch = value; calls.updates.push(value); return this; },
          async maybeSingle() { return table === 'farm_members' ? { data: options.noMembership ? null : { farm_id: farm }, error: null } : { data: saved, error: options.storageError ? {} : null }; },
          async single() { saved = { ...saved, ...patch }; return { data: saved, error: null }; },
          then(resolve, reject) { return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
        };
        return query;
      },
      async rpc(name, args) {
        calls.reservations++;
        if (options.rateLimit) return { error: {} };
        saved = { id: args.p_id, farm_id: args.p_farm_id, created_by: args.p_user_id, image_id: args.p_image_id, image_revision: args.p_revision, image_path: args.p_image_path, image_title: args.p_image_title, mode: args.p_mode, model: args.p_model, status: 'pending', created_at: time };
        return { error: null };
      }
    };
  }
  const handler = createVisionHandler({ env: key => config[key], createClient, now: () => time, fetchImpl: async (url, init) => {
    calls.fetch.push({ url, ...init });
    if (options.timeout) { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; }
    return new Response(JSON.stringify({ choices: [{ message: { content: options.content ?? JSON.stringify(catalogue[0].sample) } }] }), { status: options.providerStatus || 200 });
  } });
  const request = (body = {}, headers = {}) => handler(new Request('https://project.supabase.co/functions/v1/analyse-farm-image', { method: 'POST', headers: { authorization: 'Bearer session', origin: 'https://farm.example', ...headers }, body: JSON.stringify({ farm_id: farm, image_id: catalogue[0].id, mode: 'sample', request_id: requestId, ...body }) }));
  return { calls, request, handler };
}
test('catalogue images exist and samples preserve honest provenance', () => {
  for (const image of catalogue) {
    assert.ok(existsSync(`public${image.path}`));
    const row = sampleRecord(image, farm, user, requestId, time);
    assert.equal(row.mode, 'sample'); assert.equal(row.model, null);
    assert.ok(row.result.limitations.some(x => x.includes('not model-generated')));
  }
});
test('farm resolution rejects Jean, ambiguous names and unassigned configured IDs', () => {
  const memberships = [{ farm_id: farm, role: 'owner', farm: { name: 'Das Farm' } }];
  assert.equal(resolveDasFarmId(memberships, user), farm);
  assert.equal(resolveDasFarmId(memberships, 'jean'), null);
  assert.equal(resolveDasFarmId([...memberships, ...memberships], user), null);
  assert.equal(resolveDasFarmId(memberships, user, 'wrong'), null);
  assert.equal(resolveDasFarmId(memberships, 'member', farm), farm);
});
test('invalid results cannot be accepted as findings', () => {
  for (const value of [null, {}, { ...catalogue[0].sample, observations: [123] }, { ...catalogue[0].sample, concerns: [''] }]) assert.throws(() => validateResult(value));
});
test('auth, farm and membership failures never reach the provider or reservation', async () => {
  for (const [options, body, headers, expected] of [
    [{}, {}, { authorization: '' }, 401], [{ noUser: true }, {}, {}, 401],
    [{}, { farm_id: 'another-farm' }, {}, 403], [{ noMembership: true }, {}, {}, 403],
    [{}, {}, { origin: 'https://untrusted.example' }, 403], [{}, { image_id: 'unknown' }, {}, 400],
    [{}, { mode: 'fake' }, {}, 400], [{}, { request_id: 'bad' }, {}, 400]
  ]) {
    const { request, calls } = setup(options);
    assert.equal((await request(body, headers)).status, expected);
    assert.equal(calls.fetch.length, 0); assert.equal(calls.reservations, 0);
  }
});
test('sample persistence needs no Meta key and ignores client-supplied findings', async () => {
  const { request, calls } = setup({ env: { META_API_KEY: '' } });
  const response = await request({ result: { observations: ['forged'] }, image_url: 'https://evil.example' });
  assert.equal(response.status, 200);
  const { record } = await response.json();
  assert.deepEqual(record.result, catalogue[0].sample);
  assert.equal(record.mode, 'sample'); assert.equal(calls.fetch.length, 0);
});
test('missing key blocks real mode without creating a sample or spending a reservation', async () => {
  const { request, calls } = setup({ env: { META_API_KEY: '' } });
  assert.equal((await request({ mode: 'meta' })).status, 503);
  assert.equal(calls.reservations, 0); assert.equal(calls.updates.length, 0);
});
test('real analysis uses server-selected image and key, validates and persists output', async () => {
  const { request, calls } = setup();
  const response = await request({ mode: 'meta', image_url: 'https://evil.example' });
  assert.equal(response.status, 200);
  const { record } = await response.json();
  assert.equal(record.mode, 'meta'); assert.equal(record.model, 'vision-model');
  assert.equal(record.status, 'complete');
  assert.equal(calls.fetch[0].headers.Authorization, 'Bearer server-secret');
  const payload = JSON.parse(calls.fetch[0].body);
  assert.equal(payload.messages[1].content[1].image_url.url, `https://farm.example${catalogue[0].path}`);
  assert.ok(!JSON.stringify(record).includes('server-secret'));
});
test('malformed output, provider rejection and timeout fail explicitly, without sample fallback', async () => {
  for (const options of [{ content: 'not json' }, { content: '{}' }, { providerStatus: 401 }, { providerStatus: 429 }, { timeout: true }]) {
    const { request, calls } = setup(options);
    const response = await request({ mode: 'meta' });
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error);
    assert.equal(calls.updates.at(-1).status, 'failed');
    assert.equal(calls.updates.some(x => x.status === 'complete'), false);
  }
});
test('repeated completed request is reused and conflicting IDs are rejected', async () => {
  const existing = sampleRecord(catalogue[0], farm, user, requestId, time);
  const { request, calls } = setup({ existing });
  assert.equal((await request()).status, 200);
  assert.equal((await request({ image_id: catalogue[1].id })).status, 409);
  assert.equal(calls.reservations, 0); assert.equal(calls.fetch.length, 0);
});
test('storage and reservation errors prevent provider calls', async () => {
  for (const options of [{ rateLimit: true }, { storageError: true }]) {
    const { request, calls } = setup(options);
    assert.ok((await request({ mode: 'meta' })).status >= 400);
    assert.equal(calls.fetch.length, 0);
  }
});

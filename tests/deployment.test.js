import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeploymentEnv } from '../scripts/deploy-env.mjs';
const valid = { VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example' };
test('Vercel preflight accepts public configuration without requiring Meta credentials', () => assert.deepEqual(validateDeploymentEnv(valid), []));
test('Vercel preflight reports missing configuration without exposing values', () => {
  assert.equal(validateDeploymentEnv({}).length, 2);
  assert.ok(validateDeploymentEnv({ ...valid, VITE_SUPABASE_URL: 'bad-url' }).some(x => x.includes('valid URL')));
  assert.ok(validateDeploymentEnv({ ...valid, VITE_DAS_FARM_ID: 'Das Farm' }).some(x => x.includes('UUID')));
});
test('Vercel preflight rejects server credentials in the browser key field', () => {
  const secret = 'sb_secret_do_not_print';
  const errors = validateDeploymentEnv({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: secret });
  assert.equal(errors.length, 1); assert.ok(!errors.join().includes(secret));
  const jwt = `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`;
  assert.equal(validateDeploymentEnv({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: jwt }).length, 1);
});

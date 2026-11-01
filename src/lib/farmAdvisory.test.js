import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVISORY_MODE,
  DEFAULT_SAM_MODEL,
  DEFAULT_VISION_MODEL,
  advisoryImageRef,
  buildAdvisory,
  evaluateEvidence,
  extractCo2,
  metrics,
  parseSamBoxes,
  readingValues,
  resultKeys,
  validateResult,
  validateVisionAnalysis,
} from '../../supabase/functions/_shared/advisory.js';

const row = (overrides = {}) => ({
  id: '30000000-0000-4000-8000-000000000001',
  farm_id: '10000000-0000-4000-8000-000000000001',
  zone_id: 'zone-1',
  device_id: null,
  captured_at: '2026-11-01T10:00:00Z',
  temperature_c: 31.5,
  humidity_pct: 64,
  ammonia_ppm: 12,
  measurements: { co2_ppm: 900 },
  raw_payload: { source: 'manual-form' },
  ...overrides,
});

const vision = (overrides = {}) => ({
  distribution: { total_visible: 14, at_feeders: 6, in_brooders: 0, free_roam: 8 },
  behavior_flags: ['evenly_spread'],
  observations: ['Birds are spread across the open ground and the feeder line.'],
  concerns: [],
  next_checks: ['Recheck the feeder line at the next round.'],
  limitations: ['A still photo cannot show how the flock moves over time.'],
  verdict: 'normal',
  verdict_reason: 'Birds look evenly spread and the readings sit near the usual range.',
  ...overrides,
});

test('metrics track the real Supabase telemetry: temperature, humidity, ammonia and CO2', () => {
  assert.deepEqual(metrics.map(m => m.key), ['temperature_c', 'humidity_pct', 'ammonia_ppm', 'co2_ppm']);
  assert.ok(!metrics.some(m => /moist/i.test(`${m.key} ${m.label}`)));
});

test('readingValues reads CO2 from measurements and ignores ground moisture leftovers', () => {
  const values = readingValues(row({ measurements: { co2_ppm: 1200, ground_moisture_pct: 99 } }));
  assert.equal(values.co2_ppm, 1200);
  assert.equal(values.ground_moisture_pct, undefined);
  assert.equal(values.temperature_c, 31.5);
});

test('extractCo2 falls back to raw_payload carbon-dioxide spellings', () => {
  assert.equal(extractCo2(row({ measurements: {}, raw_payload: { carbonDioxide: '850' } })), 850);
  assert.equal(extractCo2(row({ measurements: {}, raw_payload: {} })), null);
  assert.equal(extractCo2(row({ measurements: { co2_ppm: 'bad' }, raw_payload: {} })), null);
});

test('evaluateEvidence ignores demo alert types and resolves severity from real matches', () => {
  const rule = { id: 'rule-1', farm_id: row().farm_id, zone_id: null, metric_key: 'ammonia_ppm', operator: 'gt', threshold: 25, severity: 'warning', enabled: true };
  const demoAlert = { id: 'alert-demo', farm_id: row().farm_id, zone_id: null, telemetry_event_id: row().id, alert_type: 'demo_high_ammonia', severity: 'critical', resolved_at: null };
  const calm = evaluateEvidence(row(), [rule], [demoAlert]);
  assert.equal(calm.severity, 'info');
  assert.deepEqual(calm.warning_ids, []);
  const spiked = evaluateEvidence(row({ ammonia_ppm: 40 }), [rule], []);
  assert.equal(spiked.severity, 'warning');
  assert.equal(spiked.checks.length, 1);
});

test('buildAdvisory combines readings, SAM regions and vision into a verdict without sample wording', () => {
  const advisory = buildAdvisory({
    row: row(), zoneName: 'Brooder A', rules: [], alerts: [],
    snapshot: { id: 'snap-1', storage_path: 'farm/manual/x.jpg', captured_at: row().captured_at },
    visual: [{ image_id: 'snapshot:snap-1', source: 'sam', boxes: [{ x1: 1, y1: 1, x2: 5, y2: 5, width: 10, height: 10 }] }],
    vision: vision(), stages: { sam: 'ok', vision: 'ok' },
  });
  assert.equal(advisory.version, 2);
  assert.equal(advisory.generated, true);
  assert.equal(advisory.evidence.values.co2_ppm, 900);
  assert.match(advisory.title, /Brooder A/);
  assert.match(advisory.message, /14/);
  for (const text of [advisory.title, advisory.message, ...advisory.result.observations, ...advisory.result.limitations]) {
    assert.doesNotMatch(text, /demo|sample|simulated|prepared/i);
  }
  assert.deepEqual(Object.keys(advisory.result).sort(), ['concerns', 'limitations', 'next_checks', 'observations']);
});

test('buildAdvisory flags attention when rules match even if vision looks normal', () => {
  const rule = { id: 'rule-1', farm_id: row().farm_id, zone_id: null, metric_key: 'temperature_c', operator: 'gt', threshold: 30, severity: 'warning', enabled: true };
  const advisory = buildAdvisory({ row: row(), zoneName: 'Brooder A', rules: [rule], alerts: [], snapshot: null, visual: [], vision: vision(), stages: { sam: 'skipped', vision: 'ok' } });
  assert.match(advisory.title, /attention/i);
  assert.equal(advisory.evidence.severity, 'warning');
});

test('buildAdvisory without vision still returns a labelled readings-only template', () => {
  const advisory = buildAdvisory({ row: row(), zoneName: 'Brooder A', rules: [], alerts: [], snapshot: null, visual: [], vision: null, stages: { sam: 'skipped', vision: 'unavailable' } });
  assert.equal(advisory.generated, false);
  assert.ok(advisory.result.limitations.some(line => /no photo|unavailable/i.test(line)));
  assert.doesNotMatch(`${advisory.title} ${advisory.message}`, /demo|sample/i);
});

test('buildAdvisory requires a zone-linked reading from the farm', () => {
  assert.throws(() => buildAdvisory({ row: row({ zone_id: null }), zoneName: 'x', rules: [], alerts: [], snapshot: null, visual: [], vision: null, stages: {} }), /zone-linked/);
});

test('validateVisionAnalysis accepts a well-formed verdict and rejects bad shapes', () => {
  assert.equal(validateVisionAnalysis(vision()).verdict, 'normal');
  assert.throws(() => validateVisionAnalysis(vision({ verdict: 'sick' })), /verdict/);
  assert.throws(() => validateVisionAnalysis(vision({ distribution: { total_visible: -1, at_feeders: 0, in_brooders: 0, free_roam: 0 } })), /distribution/);
  assert.throws(() => validateVisionAnalysis(vision({ observations: ['x'.repeat(3000)] })), /observations/);
});

test('validateVisionAnalysis rejects disease and treatment wording', () => {
  assert.throws(() => validateVisionAnalysis(vision({ concerns: ['Looks like coccidiosis, give antibiotics.'] })), /forbidden/);
});

test('parseSamBoxes reads documented box tokens and empty results', () => {
  const boxes = parseSamBoxes({ status: 'completed', output_text: '<0f>0<|box;x1=1;y1=2;x2=5;y2=6;w=10;h=10|><|mask;x=0;y=0;data=1|>' });
  assert.deepEqual(boxes, [{ x1: 1, y1: 2, x2: 5, y2: 6, width: 10, height: 10 }]);
  assert.deepEqual(parseSamBoxes({ status: 'completed', output_text: '' }), []);
  assert.throws(() => parseSamBoxes({ status: 'completed', output_text: '<|box;x1=9;y1=1;x2=2;y2=3;w=10;h=10|>' }), /invalid region/);
  assert.throws(() => parseSamBoxes({ output: [{ content: [{ type: 'refusal' }] }] }), /unsupported/);
});

test('validateResult keeps the four-section history contract', () => {
  assert.deepEqual(resultKeys, ['observations', 'concerns', 'next_checks', 'limitations']);
  const checked = validateResult({ observations: ['a'], concerns: [], next_checks: ['b'], limitations: ['c'] });
  assert.deepEqual(Object.keys(checked).sort(), ['concerns', 'limitations', 'next_checks', 'observations']);
  assert.throws(() => validateResult({ observations: [] }), /invalid analysis/);
});

test('advisory image references point at real snapshots, and Meta is the only mode', () => {
  assert.equal(ADVISORY_MODE, 'meta');
  assert.equal(DEFAULT_VISION_MODEL, 'muse-spark-1.3');
  assert.equal(DEFAULT_SAM_MODEL, 'sam-3.1');
  const ref = advisoryImageRef({ id: 'snap-1', storage_path: 'farm/manual/x.jpg' }, row());
  assert.equal(ref.image_id, 'snapshot:snap-1');
  assert.equal(advisoryImageRef(null, row()).image_id, `reading:${row().id}`);
});

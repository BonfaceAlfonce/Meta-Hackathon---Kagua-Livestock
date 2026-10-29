import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  buildRegionalMessages,
  buildZoneMessages,
  explainRegion,
  explainZone,
  fallbackRegionalExplanation,
  fallbackZoneExplanation,
  findForbiddenTerm,
  needsAi,
  validateZoneExplanation,
  type RegionalContext,
  type ZoneContext,
} from './outbreakExplain.ts';
import { planAssessmentWrites, type AssessmentRow } from './outbreakPipeline.ts';
import type { RiskLevel } from './outbreakScoring.ts';

const zone = (riskLevel: RiskLevel = 'high', overrides: Partial<ZoneContext> = {}): ZoneContext => ({
  zoneName: 'Brooder A',
  riskLevel,
  score: 8,
  isSpreading: true,
  signals: {
    deaths: 12,
    baselineDeaths: 1,
    deathThreshold: 3,
    mortalitySpike: true,
    activityChangePct: -40,
    lowestIntakePct: 60,
    respiratorySigns: true,
    sickCount: 5,
    missingTodayLog: false,
    spreadFirstDetectedOn: '2026-10-28',
    spreadStartedOn: '2026-10-27',
    farmId: 'secret-farm-id',
  },
  ...overrides,
});

const region: RegionalContext = {
  county: 'Kiambu',
  countryCode: 'KE',
  windowStart: '2026-10-22',
  windowEnd: '2026-10-28',
  farmsAffected: 4,
  farmsHigh: 2,
  riskLevel: 'high',
};

const good = {
  explanation: 'Deaths rose to 12 against a usual 1 per day, with lower water intake and less activity.',
  farmerMessage: 'Isolate Brooder A and contact your veterinarian today.',
  vetSummary: 'Brooder A: 12 deaths (usual 1/day), intake 60% of normal, activity -40%, breathing problems reported.',
};

function modelReply(content: unknown) {
  return async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content), refusal: null }, finish_reason: 'stop' }] }), { status: 200 });
}

const client = (fetchImpl: (...args: unknown[]) => Promise<Response>) => ({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });

describe('prompts', () => {
  it('never sends farm identifiers or unexpected signal fields to the model', () => {
    const text = buildZoneMessages(zone()).map((m) => m.content).join('\n');
    assert.ok(!text.includes('secret-farm-id'));
    assert.ok(text?.includes('"deathsToday":12'));
    assert.ok(text?.includes('Never name, suggest or rule out any disease'));
  });

  it('regional prompt contains aggregates only', () => {
    const text = buildRegionalMessages(region).map((m) => m.content).join('\n');
    assert.ok(text?.includes('"farmsWithWarningSigns":4'));
    assert.ok(text?.includes('Do not identify any farm'));
  });
});

describe('guardrails', () => {
  for (const farmerMessage of [
    'This looks like Newcastle disease.',
    'Possible avian influenza outbreak.',
    'Give antibiotics in the water.',
    'Likely a viral infection.',
    'Vaccinate the flock now.',
  ]) {
    it(`rejects forbidden content: ${farmerMessage}`, () => {
      const result = validateZoneExplanation({ ...good, farmerMessage });
      assert.equal(result.ok, false);
    });
  }

  it('accepts a compliant explanation', () => {
    assert.deepEqual(validateZoneExplanation(good), { ok: true, value: good });
  });

  it('rejects missing fields and over-long text', () => {
    assert.equal(validateZoneExplanation({ ...good, vetSummary: '' }).ok, false);
    assert.equal(validateZoneExplanation({ ...good, farmerMessage: 'x'.repeat(321) }).ok, false);
    assert.equal(validateZoneExplanation(null).ok, false);
  });

  it('fallback templates themselves never contain forbidden terms', () => {
    for (const level of ['none', 'low', 'medium', 'high'] as const) {
      const text = Object.values(fallbackZoneExplanation(zone(level))).join(' ');
      assert.equal(findForbiddenTerm(text), null);
    }
    assert.equal(findForbiddenTerm(fallbackRegionalExplanation(region).summary), null);
  });

  it('fallback tells the farmer to contact a vet at high risk and cites the facts', () => {
    const fb = fallbackZoneExplanation(zone('high'));
    assert.match(fb.farmerMessage, /veterinarian/);
    assert.ok(fb.explanation?.includes('Deaths today: 12 (usual level about 1 per day).'));
    assert.ok(fb.explanation?.includes('more than one zone since 2026-10-27'));
  });
});

describe('explainZone / explainRegion', () => {
  it('returns generated text when the model output passes validation', async () => {
    const outcome = await explainZone(zone(), client(modelReply(good)));
    assert.deepEqual(outcome, { status: 'generated', value: good });
  });

  it('falls back when the model names a disease', async () => {
    const outcome = await explainZone(zone(), client(modelReply({ ...good, explanation: 'Probably bird flu.' })));
    assert.equal(outcome.status, 'fallback');
    assert.ok(outcome.reason?.includes('bird flu'));
    assert.deepEqual(outcome.value, fallbackZoneExplanation(zone()));
  });

  it('falls back when the API fails', async () => {
    const failing = mock.fn(async () => new Response('', { status: 401 }));
    const outcome = await explainRegion(region, client(failing));
    assert.equal(outcome.status, 'fallback');
    assert.ok(outcome.value.summary?.includes('4 farms in Kiambu'));
  });

  it('only medium and high results need AI', () => {
    assert.deepEqual(['none', 'low', 'medium', 'high'].map((l) => needsAi(l as RiskLevel)), [false, false, true, true]);
  });
});

describe('planAssessmentWrites', () => {
  const row = (zoneId: string, risk: RiskLevel, score: number, spreading = false): AssessmentRow => ({
    farm_id: 'f',
    zone_id: zoneId,
    assessed_on: '2026-10-28',
    risk_level: risk,
    score,
    signals: {},
    is_spreading: spreading,
    ai_status: 'pending',
    ai_summary: null,
    ai_farmer_message: null,
    ai_vet_summary: null,
  });

  it('keeps AI text for unchanged results and regenerates for changed or new ones', () => {
    const { changed, unchanged } = planAssessmentWrites(
      [row('a', 'high', 8), row('b', 'medium', 4), row('c', 'low', 2), row('d', 'high', 8, true)],
      [
        { zone_id: 'a', risk_level: 'high', score: '8.00', is_spreading: false, signals: {}, ai_status: 'generated' },
        { zone_id: 'b', risk_level: 'high', score: 8, is_spreading: false, signals: {}, ai_status: 'generated' },
        { zone_id: 'd', risk_level: 'high', score: 8, is_spreading: false, signals: {}, ai_status: 'fallback' },
      ],
    );
    assert.deepEqual(unchanged.map((r) => r.zone_id), ['a']);
    assert.equal('ai_status' in unchanged[0], false);
    assert.deepEqual(changed.map((r) => r.zone_id), ['b', 'c', 'd']);
  });

  it('regenerates when the previous AI step never completed', () => {
    const { changed } = planAssessmentWrites([row('a', 'high', 8)], [
      { zone_id: 'a', risk_level: 'high', score: 8, is_spreading: false, signals: {}, ai_status: 'pending' },
    ]);
    assert.equal(changed.length, 1);
  });

  it('regenerates when signal values change even if the risk level and score do not', () => {
    const today = { ...row('a', 'high', 8), signals: { deaths: 20, baselineDeaths: 1 } };
    const { changed } = planAssessmentWrites([today], [
      { zone_id: 'a', risk_level: 'high', score: 8, is_spreading: false, signals: { deaths: 14, baselineDeaths: 1 }, ai_status: 'generated' },
    ]);
    assert.equal(changed.length, 1);
  });

  it('treats signals as equal regardless of key order (jsonb does not preserve it)', () => {
    const today = { ...row('a', 'high', 8), signals: { deaths: 14, nested: { x: 1, y: null }, baselineDeaths: 1 } };
    const { unchanged } = planAssessmentWrites([today], [
      { zone_id: 'a', risk_level: 'high', score: 8, is_spreading: false, signals: { baselineDeaths: 1, nested: { y: null, x: 1 }, deaths: 14 }, ai_status: 'generated' },
    ]);
    assert.equal(unchanged.length, 1);
  });
});

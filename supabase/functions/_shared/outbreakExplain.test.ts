import { describe, expect, it, vi } from 'vitest';
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
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content), refusal: null }, finish_reason: 'stop' }] }), { status: 200 }),
  );
}

const client = (fetchImpl: ReturnType<typeof vi.fn>) => ({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} });

describe('prompts', () => {
  it('never sends farm identifiers or unexpected signal fields to the model', () => {
    const text = buildZoneMessages(zone()).map((m) => m.content).join('\n');
    expect(text).not.toContain('secret-farm-id');
    expect(text).toContain('"deathsToday":12');
    expect(text).toContain('Never name, suggest or rule out any disease');
  });

  it('regional prompt contains aggregates only', () => {
    const text = buildRegionalMessages(region).map((m) => m.content).join('\n');
    expect(text).toContain('"farmsWithWarningSigns":4');
    expect(text).toContain('Do not identify any farm');
  });
});

describe('guardrails', () => {
  it.each([
    'This looks like Newcastle disease.',
    'Possible avian influenza outbreak.',
    'Give antibiotics in the water.',
    'Likely a viral infection.',
    'Vaccinate the flock now.',
  ])('rejects forbidden content: %s', (farmerMessage) => {
    const result = validateZoneExplanation({ ...good, farmerMessage });
    expect(result.ok).toBe(false);
  });

  it('accepts a compliant explanation', () => {
    expect(validateZoneExplanation(good)).toEqual({ ok: true, value: good });
  });

  it('rejects missing fields and over-long text', () => {
    expect(validateZoneExplanation({ ...good, vetSummary: '' }).ok).toBe(false);
    expect(validateZoneExplanation({ ...good, farmerMessage: 'x'.repeat(321) }).ok).toBe(false);
    expect(validateZoneExplanation(null).ok).toBe(false);
  });

  it('fallback templates themselves never contain forbidden terms', () => {
    for (const level of ['none', 'low', 'medium', 'high'] as const) {
      const text = Object.values(fallbackZoneExplanation(zone(level))).join(' ');
      expect(findForbiddenTerm(text)).toBeNull();
    }
    expect(findForbiddenTerm(fallbackRegionalExplanation(region).summary)).toBeNull();
  });

  it('fallback tells the farmer to contact a vet at high risk and cites the facts', () => {
    const fb = fallbackZoneExplanation(zone('high'));
    expect(fb.farmerMessage).toMatch(/veterinarian/);
    expect(fb.explanation).toContain('Deaths today: 12 (usual level about 1 per day).');
    expect(fb.explanation).toContain('more than one zone since 2026-10-27');
  });
});

describe('explainZone / explainRegion', () => {
  it('returns generated text when the model output passes validation', async () => {
    const outcome = await explainZone(zone(), client(modelReply(good)));
    expect(outcome).toEqual({ status: 'generated', value: good });
  });

  it('falls back when the model names a disease', async () => {
    const outcome = await explainZone(zone(), client(modelReply({ ...good, explanation: 'Probably bird flu.' })));
    expect(outcome.status).toBe('fallback');
    expect(outcome.reason).toContain('bird flu');
    expect(outcome.value).toEqual(fallbackZoneExplanation(zone()));
  });

  it('falls back when the API fails', async () => {
    const failing = vi.fn(async () => new Response('', { status: 401 }));
    const outcome = await explainRegion(region, client(failing));
    expect(outcome.status).toBe('fallback');
    expect(outcome.value.summary).toContain('4 farms in Kiambu');
  });

  it('only medium and high results need AI', () => {
    expect(['none', 'low', 'medium', 'high'].map((l) => needsAi(l as RiskLevel))).toEqual([false, false, true, true]);
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
    expect(unchanged.map((r) => r.zone_id)).toEqual(['a']);
    expect(unchanged[0]).not.toHaveProperty('ai_status');
    expect(changed.map((r) => r.zone_id)).toEqual(['b', 'c', 'd']);
  });

  it('regenerates when the previous AI step never completed', () => {
    const { changed } = planAssessmentWrites([row('a', 'high', 8)], [
      { zone_id: 'a', risk_level: 'high', score: 8, is_spreading: false, signals: {}, ai_status: 'pending' },
    ]);
    expect(changed).toHaveLength(1);
  });

  it('regenerates when signal values change even if the risk level and score do not', () => {
    const today = { ...row('a', 'high', 8), signals: { deaths: 20, baselineDeaths: 1 } };
    const { changed } = planAssessmentWrites([today], [
      { zone_id: 'a', risk_level: 'high', score: 8, is_spreading: false, signals: { deaths: 14, baselineDeaths: 1 }, ai_status: 'generated' },
    ]);
    expect(changed).toHaveLength(1);
  });

  it('treats signals as equal regardless of key order (jsonb does not preserve it)', () => {
    const today = { ...row('a', 'high', 8), signals: { deaths: 14, nested: { x: 1, y: null }, baselineDeaths: 1 } };
    const { unchanged } = planAssessmentWrites([today], [
      { zone_id: 'a', risk_level: 'high', score: 8, is_spreading: false, signals: { baselineDeaths: 1, nested: { y: null, x: 1 }, deaths: 14 }, ai_status: 'generated' },
    ]);
    expect(unchanged).toHaveLength(1);
  });
});

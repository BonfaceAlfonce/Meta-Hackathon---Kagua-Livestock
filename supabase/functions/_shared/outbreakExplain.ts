/**
 * Outbreak Shield — AI explanations with enforced guardrails.
 *
 * Muse Spark turns deterministic results into plain-language notes. It never
 * changes a risk level. Every model output passes validateNoDiagnosis(); any
 * output that names a disease or treatment, is too long, or is malformed is
 * replaced by a deterministic template, so the safety rule is enforced in code.
 */
import { callMuseSparkStructured, type ChatMessage, type StructuredCallOptions } from './museSpark.ts';
import type { RiskLevel } from './outbreakScoring.ts';

export interface ZoneExplanation {
  explanation: string;
  farmerMessage: string;
  vetSummary: string;
}

export interface RegionalExplanation {
  summary: string;
}

export interface ZoneContext {
  zoneName: string;
  riskLevel: RiskLevel;
  score: number;
  isSpreading: boolean;
  signals: Record<string, unknown>;
}

export interface RegionalContext {
  county: string;
  countryCode: string;
  windowStart: string;
  windowEnd: string;
  farmsAffected: number;
  farmsHigh: number;
  riskLevel: RiskLevel;
}

const LIMITS = { explanation: 600, farmerMessage: 320, vetSummary: 1200, summary: 600 };

export const ZONE_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string', description: 'Why this zone was flagged, citing the signals. Max 3 sentences.' },
    farmerMessage: { type: 'string', description: 'Plain-language message to the farmer. Max 2 short sentences.' },
    vetSummary: { type: 'string', description: 'Factual summary of the signals for a veterinarian.' },
  },
  required: ['explanation', 'farmerMessage', 'vetSummary'],
  additionalProperties: false,
} as const;

export const REGIONAL_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Plain-language regional early warning. Max 3 sentences.' },
  },
  required: ['summary'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = [
  'You write short notes for poultry farmers and veterinarians in East Africa.',
  'You receive the output of a deterministic flock-monitoring system. It has already decided the risk level.',
  'Rules you must follow:',
  '- Never name, suggest or rule out any disease, pathogen or condition.',
  '- Never recommend medicines, vaccines, doses or treatments.',
  '- Never change, question or soften the given risk level.',
  '- Use only facts and numbers present in the input. Do not estimate losses or costs.',
  '- For medium or high risk, tell the farmer to contact a veterinarian.',
  '- If isSpreading is true, say that similar signs appeared in more than one zone.',
  '- Plain English, short sentences, no jargon, no alarmist language.',
].join('\n');

/** Disease, pathogen and treatment terms that must never appear in generated text. */
const FORBIDDEN_TERMS = [
  'influenza', 'avian flu', 'bird flu', 'h5n1', 'h5n8', 'h7n9', 'hpai', 'newcastle', 'gumboro', 'bursal',
  'marek', 'coccidiosis', 'bronchitis', 'mycoplasma', 'salmonella', 'cholera', 'fowl pox', 'laryngotracheitis',
  'virus', 'viral', 'bacteria', 'bacterial', 'infection', 'infected', 'diagnos', 'pathogen',
  'antibiotic', 'vaccin', 'medicine', 'medication', 'dosage', 'dose', 'mg/', 'oxytetracycline',
  'amoxicillin', 'tylosin', 'enrofloxacin', 'treatment', 'treat ',
];

export function findForbiddenTerm(text: string): string | null {
  const lower = ` ${text.toLowerCase()} `;
  return FORBIDDEN_TERMS.find((term) => lower.includes(term)) ?? null;
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function validateZoneExplanation(value: unknown): { ok: true; value: ZoneExplanation } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'not an object' };
  const v = value as Record<string, unknown>;
  for (const key of ['explanation', 'farmerMessage', 'vetSummary'] as const) {
    if (!isNonEmptyString(v[key], LIMITS[key])) return { ok: false, reason: `${key} missing or too long` };
    const term = findForbiddenTerm(v[key] as string);
    if (term) return { ok: false, reason: `${key} contains forbidden term "${term.trim()}"` };
  }
  return {
    ok: true,
    value: { explanation: (v.explanation as string).trim(), farmerMessage: (v.farmerMessage as string).trim(), vetSummary: (v.vetSummary as string).trim() },
  };
}

export function validateRegionalExplanation(value: unknown): { ok: true; value: RegionalExplanation } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'not an object' };
  const summary = (value as Record<string, unknown>).summary;
  if (!isNonEmptyString(summary, LIMITS.summary)) return { ok: false, reason: 'summary missing or too long' };
  const term = findForbiddenTerm(summary);
  if (term) return { ok: false, reason: `summary contains forbidden term "${term.trim()}"` };
  return { ok: true, value: { summary: summary.trim() } };
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Only the facts the model needs — no farm names, IDs, people or coordinates. */
export function zonePromptPayload(ctx: ZoneContext): Record<string, unknown> {
  const s = ctx.signals;
  return {
    zoneName: ctx.zoneName,
    riskLevel: ctx.riskLevel,
    score: ctx.score,
    isSpreading: ctx.isSpreading,
    spreadStartedOn: s.spreadStartedOn ?? s.spreadFirstDetectedOn ?? null,
    deathsToday: num(s.deaths),
    usualDailyDeaths: num(s.baselineDeaths),
    deathAlertThreshold: num(s.deathThreshold),
    mortalitySpike: s.mortalitySpike ?? null,
    activityChangePct: num(s.activityChangePct),
    lowestIntakePctOfNormal: num(s.lowestIntakePct),
    respiratorySigns: s.respiratorySigns ?? null,
    sickBirds: num(s.sickCount),
    missingTodayLog: Boolean(s.missingTodayLog),
  };
}

export function buildZoneMessages(ctx: ZoneContext): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Write the zone note for this monitoring result:\n${JSON.stringify(zonePromptPayload(ctx))}` },
  ];
}

export function buildRegionalMessages(ctx: RegionalContext): ChatMessage[] {
  const payload = {
    county: ctx.county,
    countryCode: ctx.countryCode,
    window: `${ctx.windowStart} to ${ctx.windowEnd}`,
    farmsWithWarningSigns: ctx.farmsAffected,
    farmsAtHighRisk: ctx.farmsHigh,
    riskLevel: ctx.riskLevel,
  };
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        'Write a regional early warning for farmers in this county. Encourage biosecurity and contacting the county veterinary office. ' +
        `Do not identify any farm.\n${JSON.stringify(payload)}`,
    },
  ];
}

function signalFacts(ctx: ZoneContext): string[] {
  const p = zonePromptPayload(ctx);
  const facts: string[] = [];
  if (p.deathsToday !== null) {
    facts.push(`Deaths today: ${p.deathsToday}${p.usualDailyDeaths !== null ? ` (usual level about ${p.usualDailyDeaths} per day)` : ''}.`);
  }
  if (p.activityChangePct !== null && (p.activityChangePct as number) < 0) {
    facts.push(`Activity is ${Math.abs(p.activityChangePct as number)}% below the 7-day average.`);
  }
  if (p.lowestIntakePctOfNormal !== null && (p.lowestIntakePctOfNormal as number) < 100) {
    facts.push(`Feed or water intake is at ${p.lowestIntakePctOfNormal}% of normal.`);
  }
  if (p.respiratorySigns) facts.push('Breathing problems were reported.');
  if (ctx.isSpreading) facts.push(`Similar signs have appeared in more than one zone since ${p.spreadStartedOn ?? 'recently'}.`);
  if (p.missingTodayLog) facts.push("Today's flock log has not been recorded yet.");
  return facts;
}

/** Deterministic text used when AI is unavailable, unnecessary, or rejected by validation. */
export function fallbackZoneExplanation(ctx: ZoneContext): ZoneExplanation {
  const facts = signalFacts(ctx);
  const zone = ctx.zoneName;
  const farmerMessage: Record<RiskLevel, string> = {
    high: `Unusual losses with other warning signs in ${zone}. Isolate this zone, stop moving birds and people, and contact your veterinarian today.`,
    medium: `Warning signs in ${zone}. Check the birds closely and contact your veterinarian if this continues tomorrow.`,
    low: `One warning sign in ${zone}. Keep watching and record tomorrow's numbers.`,
    none: `No warning signs in ${zone} today.`,
  };
  return {
    explanation: facts.length ? facts.join(' ') : 'All monitored signals are within their usual range.',
    farmerMessage: farmerMessage[ctx.riskLevel],
    vetSummary: [`Zone: ${zone}`, `Risk level: ${ctx.riskLevel} (score ${ctx.score})`, ...facts].join('\n'),
  };
}

export function fallbackRegionalExplanation(ctx: RegionalContext): RegionalExplanation {
  return {
    summary:
      `${ctx.farmsAffected} farms in ${ctx.county} reported warning signs between ${ctx.windowStart} and ${ctx.windowEnd}` +
      `${ctx.farmsHigh ? `, ${ctx.farmsHigh} at high risk` : ''}. Tighten biosecurity, avoid moving birds between farms, ` +
      'and contact the county veterinary office if you see unusual losses.',
  };
}

type ClientOptions = Omit<StructuredCallOptions, 'messages' | 'schemaName' | 'schema'>;

export type ExplainOutcome<T> = { status: 'generated' | 'fallback'; value: T; reason?: string };

export async function explainZone(ctx: ZoneContext, client: ClientOptions): Promise<ExplainOutcome<ZoneExplanation>> {
  try {
    const { data } = await callMuseSparkStructured<unknown>({
      ...client,
      messages: buildZoneMessages(ctx),
      schemaName: 'zone_note',
      schema: ZONE_SCHEMA as unknown as Record<string, unknown>,
    });
    const checked = validateZoneExplanation(data);
    if (checked.ok) return { status: 'generated', value: checked.value };
    return { status: 'fallback', value: fallbackZoneExplanation(ctx), reason: checked.reason };
  } catch (error) {
    return { status: 'fallback', value: fallbackZoneExplanation(ctx), reason: error instanceof Error ? error.message : 'unknown error' };
  }
}

export async function explainRegion(ctx: RegionalContext, client: ClientOptions): Promise<ExplainOutcome<RegionalExplanation>> {
  try {
    const { data } = await callMuseSparkStructured<unknown>({
      ...client,
      messages: buildRegionalMessages(ctx),
      schemaName: 'regional_note',
      schema: REGIONAL_SCHEMA as unknown as Record<string, unknown>,
    });
    const checked = validateRegionalExplanation(data);
    if (checked.ok) return { status: 'generated', value: checked.value };
    return { status: 'fallback', value: fallbackRegionalExplanation(ctx), reason: checked.reason };
  } catch (error) {
    return { status: 'fallback', value: fallbackRegionalExplanation(ctx), reason: error instanceof Error ? error.message : 'unknown error' };
  }
}

/** AI is only worth calling for results a person must act on. */
export function needsAi(riskLevel: RiskLevel): boolean {
  return riskLevel === 'medium' || riskLevel === 'high';
}
